#!/usr/bin/env node
/*
  refresh.mjs — the weekly auto-refresh for the Discord Prediction League.

  For each round in config.json it:
    1. fetches that matchday's fixtures + results from football-data.org
    2. fetches the round's published Google Form CSV of predictions
    3. parses predictions (scores per match, banker, joker, featured-game bonuses)
    4. assembles data.json and injects it into index.html (via the DATA markers)

  FEATURED GAME (optional, per round in config.json):
    "featured": "Man Utd v Man City"        -> the marquee fixture that week
    "featuredResult": { "firstTeam": "", "firstScorer": "" }
        -> you fill these in by hand AFTER the game (free API has no scorer data).
           Leave blank until played; the bonuses score once you enter them.

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

/* ---- name merges: if someone enters a different pseudonym one week, map it
   back to their canonical name here so their points stay on one row.
   Key = the typed name (any casing), value = the canonical name to keep.     */
const ALIASES = {
  "an": "Cowan"
};
function canonName(raw){
  const t = (raw||"").trim();
  return ALIASES[t.toLowerCase()] || t;
}

function colIndex(header, name){ return header.findIndex(h=>h.trim()===name); }
// bonus columns are matched loosely by their opening words, so the fixture name
// in the question title (which changes each week) doesn't have to match exactly.
function colStartsWith(header, prefix){
  const p=prefix.toLowerCase();
  return header.findIndex(h=>h.trim().toLowerCase().startsWith(p));
}
// resolve the config "featured" string to a real "Home v Away" from the fixtures
function resolveFeatured(str, fixtures){
  const s=(str||"").trim(); if(!s) return null;
  let f=fixtures.find(f=>`${f.home} v ${f.away}`===s);
  if(!f) f=fixtures.find(f=>s.toLowerCase().startsWith(f.home.toLowerCase()));
  if(!f) f=fixtures.find(f=>s.toLowerCase().includes(f.home.toLowerCase()));
  return f ? `${f.home} v ${f.away}` : s;
}

/* main */
const players = new Map(); // pseudonym -> { name, bankers:{}, jokers:[], picks:{}, bonus:{} }
const rounds = [];

for(const rd of cfg.rounds){
  const fixtures = await fetchFixtures(rd.matchday);
  const featured = rd.featured ? resolveFeatured(rd.featured, fixtures) : null;
  rounds.push({
    id:rd.id, label:rd.label, fixtures,
    featured,
    featuredResult: rd.featuredResult || null
  });

  const csv = await fetchCSV(rd.csvUrl);
  if(!csv || csv.length<2) continue;              // no responses yet
  const header = csv[0];
  const iPseudo = colIndex(header, PSEUDO_COL);
  const iBanker = colIndex(header, BANKER_COL);
  const iJoker  = colIndex(header, JOKER_COL);
  const iFirstTeam   = colStartsWith(header, "first team to score");
  const iFirstScorer = colStartsWith(header, "first goalscorer");
  // pre-find each fixture's two goal columns by exact title
  const cols = fixtures.map(f=>({
    h: colIndex(header, `${f.home} goals — (${f.home} v ${f.away})`),
    a: colIndex(header, `${f.away} goals — (${f.home} v ${f.away})`)
  }));

  for(let r=1;r<csv.length;r++){
    const row=csv[r];
    const name=canonName(row[iPseudo]);
    if(!name) continue;
    const norm=name.toLowerCase();
    if(!players.has(norm)) players.set(norm,{ name, bankers:{}, jokers:[], picks:{}, bonus:{} });
    const p=players.get(norm);
    p.name=name; // keep latest casing

    const g = v => { const n=parseInt(String(v).replace("+",""),10); return isNaN(n)?0:n; };
    p.picks[rd.id] = cols.map(c=>({ hg:g(row[c.h]), ag:g(row[c.a]) }));

    if(iBanker>=0){
      const bval=(row[iBanker]||"").trim();
      let bi=fixtures.findIndex(f=>`${f.home} v ${f.away}`===bval);
      if(bi<0 && bval) bi=fixtures.findIndex(f=>bval.startsWith(f.home));
      if(bi<0 && bval) bi=fixtures.findIndex(f=>bval.toLowerCase().includes(f.home.toLowerCase()));
      if(bi>=0) p.bankers[rd.id]=bi;
    }
    if(iJoker>=0 && (row[iJoker]||"").trim().toLowerCase()==="yes"){
      if(!p.jokers.includes(rd.id)) p.jokers.push(rd.id);
    }
    // featured-game bonus predictions (only if the round has a featured game)
    if(featured && (iFirstTeam>=0 || iFirstScorer>=0)){
      p.bonus[rd.id] = {
        firstTeam:   iFirstTeam>=0   ? (row[iFirstTeam]||"").trim()   : "",
        firstScorer: iFirstScorer>=0 ? (row[iFirstScorer]||"").trim() : ""
      };
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
