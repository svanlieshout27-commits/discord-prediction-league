#!/usr/bin/env node
/*
  refresh.mjs — the weekly auto-refresh for the Discord Prediction League.

  For each round in config.json it:
    1. fetches that matchday's fixtures + results from football-data.org
    2. fetches the round's published Google Form CSV of predictions
    3. parses predictions (scores per match, banker, joker) keyed by pseudonym
    4. assembles data.json and injects it into index.html (via the DATA markers)

  Needs the token in env:  FOOTBALL_DATA_TOKEN
  Run:  FOOTBALL_DATA_TOKEN=xxx node refresh.mjs
*/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) { console.error("Missing FOOTBALL_DATA_TOKEN env var"); process.exit(1); }

/* ---------- tiny CSV parser (handles quotes, commas, newlines) ---------- */
function parseCSV(text){
  const rows=[]; let row=[], field="", i=0, q=false;
  text=text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  while(i<text.length){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; }
      else field+=c;
    } else {
      if(c==='"') q=true;
      else if(c===',') { row.push(field); field=""; }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else field+=c;
    }
    i++;
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.length>1 || (r.length===1 && r[0].trim()!==""));
}

async function fetchFixtures(matchday){
  const url=`https://api.football-data.org/v4/competitions/PL/matches?matchday=${matchday}&season=${cfg.season}`;
  const r=await fetch(url,{headers:{"X-Auth-Token":TOKEN}});
  if(!r.ok) throw new Error("football-data "+r.status+" for matchday "+matchday);
  const d=await r.json();
  return d.matches
    .sort((a,b)=> a.utcDate.localeCompare(b.utcDate))
    .map(m=>{
      const home=m.homeTeam.shortName||m.homeTeam.name;
      const away=m.awayTeam.shortName||m.awayTeam.name;
      const ft=m.score.fullTime;
      const played=m.status==="FINISHED";
      return { home, away, hg: played?ft.home:null, ag: played?ft.away:null, played };
    });
}

async function fetchCSV(url){
  if(!url || url.includes("PASTE_YOUR")) return null;
  const r=await fetch(url);
  if(!r.ok) throw new Error("CSV fetch "+r.status);
  return parseCSV(await r.text());
}

const PSEUDO_COL = "Your pseudonym / player code";
const BANKER_COL = "BANKER — which match are you most confident about? (it scores DOUBLE)";
const JOKER_COL  = "Play your JOKER this week? (doubles your WHOLE coupon — limited uses per season)";

function colIndex(header, name){ return header.findIndex(h=>h.trim()===name); }

/* main */
const players = new Map(); // pseudonym -> { name, bankers:{}, jokers:[], picks:{} }
const rounds = [];

for(const rd of cfg.rounds){
  const fixtures = await fetchFixtures(rd.matchday);
  rounds.push({ id:rd.id, label:rd.label, fixtures });

  const csv = await fetchCSV(rd.csvUrl);
  if(!csv || csv.length<2) continue;              // no responses yet
  const header = csv[0];
  const iPseudo = colIndex(header, PSEUDO_COL);
  const iBanker = colIndex(header, BANKER_COL);
  const iJoker  = colIndex(header, JOKER_COL);
  // pre-find each fixture's two goal columns by exact title
  const cols = fixtures.map(f=>({
    h: colIndex(header, `${f.home} goals — (${f.home} v ${f.away})`),
    a: colIndex(header, `${f.away} goals — (${f.home} v ${f.away})`)
  }));

  for(let r=1;r<csv.length;r++){
    const row=csv[r];
    const name=(row[iPseudo]||"").trim();
    if(!name) continue;
    const norm=name.toLowerCase();
    if(!players.has(norm)) players.set(norm,{ name, bankers:{}, jokers:[], picks:{} });
    const p=players.get(norm);
    p.name=name; // keep latest casing

    const g = v => { const n=parseInt(String(v).replace("+",""),10); return isNaN(n)?0:n; };
    p.picks[rd.id] = cols.map(c=>({ hg:g(row[c.h]), ag:g(row[c.a]) }));

    if(iBanker>=0){
      const bval=(row[iBanker]||"").trim();
      // match the banker choice to a fixture. Accepts "Home v Away", "Home - Away",
      // or anything that starts with the (unique) home-team name.
      let bi=fixtures.findIndex(f=>`${f.home} v ${f.away}`===bval);
      if(bi<0 && bval) bi=fixtures.findIndex(f=>bval.startsWith(f.home));
      if(bi<0 && bval) bi=fixtures.findIndex(f=>bval.toLowerCase().includes(f.home.toLowerCase()));
      if(bi>=0) p.bankers[rd.id]=bi;
    }
    if(iJoker>=0 && (row[iJoker]||"").trim().toLowerCase()==="yes"){
      if(!p.jokers.includes(rd.id)) p.jokers.push(rd.id);
    }
  }
}

const predictions=[...players.values()];
const data={
  lastUpdated: new Date().toISOString().slice(0,16).replace("T"," ")+" UTC",
  rounds, predictions
};

/* write data.json + inject into index.html */
writeFileSync(join(here,"data.json"), JSON.stringify(data,null,2));
const htmlPath=join(here,"index.html");
let html=readFileSync(htmlPath,"utf8");
const marker=/\/\*__DATA_START__\*\/[\s\S]*?\/\*__DATA_END__\*\//;
if(marker.test(html)){
  html=html.replace(marker,"/*__DATA_START__*/"+JSON.stringify(data,null,2)+"/*__DATA_END__*/");
  writeFileSync(htmlPath,html);
}
console.log(`Refreshed: ${rounds.length} round(s), ${predictions.length} player(s). Updated ${data.lastUpdated}`);
