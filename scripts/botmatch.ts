// Plays one full match through the real WebSocket server with two scripted bots.
// It exists to produce a recorded match for `npm run replay` without two humans.
// Run with the server up: npm run botmatch
import WebSocket from 'ws';
import { IDLE, rand, type Input, type Observation } from '@rewind/engine';

const URL = `ws://localhost:${process.env.PORT ?? 8080}`;
const room = `bots${process.pid}`;

// A route through mid that clears the cover box, the pillar and the door. Defenders walk it backwards.
const ROUTE = [{ x: 3, y: 16 }, { x: 13, y: 13 }, { x: 31, y: 13 }, { x: 33, y: 16 }, { x: 45, y: 16 }];

function bot(name: string, seed: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const r = { rng: seed };
    let leg = 1;
    let round = 0;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'end') return resolve(msg.matchId);
      if (msg.t !== 'obs') return;
      const o: Observation = msg.obs;
      if (o.round !== round) {
        round = o.round;
        leg = 1;
      }
      const route = o.attacker === o.slot ? ROUTE : [...ROUTE].reverse();
      const input: Input = { ...IDLE, move: { x: 0, y: 0 } };
      if (o.enemy) {
        input.aim = Math.atan2(o.enemy.y - o.self.y, o.enemy.x - o.self.x) + (rand(r) - 0.5) * 0.1;
        input.fire = true;
        input.move.y = rand(r) < 0.3 ? 1 : 0; // sometimes strafe, so spread and misses show up in the recording
      } else {
        const target = route[Math.min(leg, route.length - 1)];
        const dx = target.x - o.self.x;
        const dy = target.y - o.self.y;
        if (Math.hypot(dx, dy) < 0.5 && leg < route.length - 1) leg++;
        input.move = { x: Math.abs(dx) > 0.2 ? (Math.sign(dx) as 1 | -1) : 0, y: Math.abs(dy) > 0.2 ? (Math.sign(dy) as 1 | -1) : 0 };
        input.aim = Math.atan2(dy, dx);
        input.smoke = rand(r) < 0.01;
        input.dash = rand(r) < 0.01;
      }
      input.reload = o.self.ammo === 0;
      ws.send(JSON.stringify({ t: 'input', input }));
    });
  });
}

const [id] = await Promise.all([bot('bot-one', 1), bot('bot-two', 2)]);
console.log(`match finished: data/${id}.json`);
