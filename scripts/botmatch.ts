// Plays one full match through the real WebSocket server with two scripted bots.
// It exists to produce a recorded match for `npm run replay` without two humans.
// Run with the server up: npm run botmatch
import WebSocket from 'ws';
import { IDLE, rand, type Input, type Observation } from '@rewind/engine';

const URL = `ws://localhost:${process.env.PORT ?? 8080}`;
const room = `bots${process.pid}`;

// A route through mid that clears the cover box, the pillar and the door. Defenders walk it backwards.
const ROUTE = [{ x: 3, y: 16 }, { x: 13, y: 13 }, { x: 31, y: 13 }, { x: 33, y: 16 }, { x: 45, y: 16 }];

// Step toward a target, returning the discrete move axes.
function moveToward(sx: number, sy: number, tx: number, ty: number): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const dx = tx - sx;
  const dy = ty - sy;
  return {
    x: (Math.abs(dx) > 0.2 ? Math.sign(dx) : 0) as -1 | 0 | 1,
    y: (Math.abs(dy) > 0.2 ? Math.sign(dy) : 0) as -1 | 0 | 1,
  };
}

function bot(name: string, seed: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const r = { rng: seed };
    let leg = 1;
    let round = 0;
    // Memory of where the enemy was last seen, so the bot hunts instead of
    // forgetting the instant line of sight breaks.
    let huntX = 0;
    let huntY = 0;
    let huntTicks = 0; // how many ticks the bot keeps pushing a stale sighting
    let strafeSign: 1 | -1 = 1;
    // ROUTE is drawn for the Duel map, so both bots vote for it.
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room, mode: 'pvp', map: 'duel' })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'end') return resolve(msg.matchId);
      if (msg.t !== 'obs') return;
      const o: Observation = msg.obs;
      if (o.round !== round) {
        round = o.round;
        leg = 1;
        huntTicks = 0;
      }
      const route = o.attacker === o.slot ? ROUTE : [...ROUTE].reverse();
      const input: Input = { ...IDLE, move: { x: 0, y: 0 } };
      const lowAmmo = o.self.ammo <= 2;

      if (o.enemy) {
        // --- In a fight: hold still, aim tight, micro-strafe between shots ---
        const aim = Math.atan2(o.enemy.y - o.self.y, o.enemy.x - o.self.x);
        input.aim = aim + (rand(r) - 0.5) * 0.04; // small, since standing still
        // Remember this sighting to chase if they break away.
        huntX = o.enemy.x;
        huntY = o.enemy.y;
        huntTicks = 48; // ~1.5 s of pushing the last position
        // Only fire when nearly stopped, so spread stays tight (still = 1deg).
        const nearlyStill = Math.abs(o.self.x) >= 0 && (input.move.x === 0 && input.move.y === 0);
        input.fire = !lowAmmo && nearlyStill;
        input.reload = lowAmmo;
        // Occasional jiggle-peek so the bot is not a static target.
        if (rand(r) < 0.08) strafeSign = (strafeSign === 1 ? -1 : 1) as 1 | -1;
        if (rand(r) < 0.25) input.move.x = strafeSign;
        input.walk = true; // walk-peek: quieter and tighter if it does move
        // Dash away when hurt and under pressure.
        if (o.self.hp <= 40 && o.self.dashes > 0 && rand(r) < 0.04) input.dash = true;
      } else if (huntTicks > 0 && Math.hypot(huntX - o.self.x, huntY - o.self.y) > 0.6) {
        // --- Hunt: push the last place the enemy was seen ---
        huntTicks--;
        input.move = moveToward(o.self.x, o.self.y, huntX, huntY);
        input.aim = Math.atan2(huntY - o.self.y, huntX - o.self.x);
        input.walk = Math.hypot(huntX - o.self.x, huntY - o.self.y) < 6; // slow, quiet approach when close
        input.reload = lowAmmo; // top up while repositioning
      } else {
        // --- Rotate along the route to the objective ---
        huntTicks = 0;
        const target = route[Math.min(leg, route.length - 1)];
        const dx = target.x - o.self.x;
        const dy = target.y - o.self.y;
        if (Math.hypot(dx, dy) < 0.5 && leg < route.length - 1) leg++;
        input.move = moveToward(o.self.x, o.self.y, target.x, target.y);
        input.aim = Math.atan2(dy, dy === 0 && dx === 0 ? 1 : dx);
        input.reload = lowAmmo; // reload in transit, never mid-fight
        // Throw smoke toward the next corner occasionally to screen the push.
        input.smoke = rand(r) < 0.02;
        input.dash = rand(r) < 0.015;
      }
      ws.send(JSON.stringify({ t: 'input', input }));
    });
  });
}

const [id] = await Promise.all([bot('bot-one', 1), bot('bot-two', 2)]);
console.log(`match finished: data/${id}.json`);
