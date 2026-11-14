// Exports the map geometry and a recorded match's per-tick snapshots to JSON for the Unity 3D viewer.
// Unity is a RENDERER: it reads these files and draws them in 3D. It never simulates — the Node engine
// stays the single deterministic source of truth (hard rule 3), exactly like the three.js FPV (DECISIONS D31).
//
// Run: npm run export:unity -- [matchId]   (defaults to the duel-straight demo preset's match)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getMap, type MatchFile } from '@rewind/engine';
import { buildSnapshots, DEMO_PRESETS } from '@rewind/rewind';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../unity/RewindDuel3D/Assets/StreamingAssets/', import.meta.url));

const matchId = process.argv[2] ?? DEMO_PRESETS[0].matchId;

// --- map.json: walls, sites, spawns, size -------------------------------------------------------
const map = getMap('duel');
const mapOut = {
  id: map.id,
  width: map.width,
  height: map.height,
  walls: map.walls.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })),
  sites: {
    A: map.sites.A,
    B: map.sites.B,
  },
  spawns: map.spawns,
};

// --- match.json: both-sides per-tick snapshots (the same payload the replay viewer uses) --------
const file = JSON.parse(readFileSync(`${DATA_DIR}${matchId}.json`, 'utf8')) as MatchFile;
const snapshots = buildSnapshots(file);

// JsonUtility in Unity cannot deserialize a top-level array, so both files wrap their list in an object.
const matchOut = {
  id: file.id,
  map: file.map,
  players: file.players.map((p) => ({ slot: p.slot, name: p.name })),
  ticks: file.ticks,
  tickRate: 32,
  // Flatten each snapshot's two players into p0/p1 so JsonUtility (no nested arrays of objects via tuples) is happy.
  frames: snapshots.map((s) => ({
    tick: s.tick,
    round: s.round,
    phase: s.phase,
    p0x: s.players[0].x, p0y: s.players[0].y, p0aim: s.players[0].aim, p0hp: s.players[0].hp, p0move: s.players[0].moveState,
    p1x: s.players[1].x, p1y: s.players[1].y, p1aim: s.players[1].aim, p1hp: s.players[1].hp, p1move: s.players[1].moveState,
    spikeState: s.spike.state, spikeX: s.spike.x, spikeY: s.spike.y,
    // smokes vary in count; encode as a flat list Unity can read.
    smokes: s.smokes.map((k) => ({ x: k.x, y: k.y, r: 2.5 })),
  })),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}map.json`, JSON.stringify(mapOut));
writeFileSync(`${OUT_DIR}match.json`, JSON.stringify(matchOut));

console.log(`wrote ${OUT_DIR}map.json (${map.walls.length} walls)`);
console.log(`wrote ${OUT_DIR}match.json (${snapshots.length} frames, ${file.players.map((p) => p.name).join(' vs ')})`);
