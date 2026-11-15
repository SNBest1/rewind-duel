using System;
using System.Collections.Generic;

// Own-movement prediction, the C# twin of web/predict.ts. DISPLAY ONLY: nothing here is sent or recorded,
// and every server observation overwrites it, so a mistake here can only make the camera wobble, never
// change the match (Rewind DECISIONS D16, D49).
//
// ApplyMovement and MoveCircle are line-for-line ports of engine/engine.ts. They use double, not float,
// so the arithmetic rounds exactly like JavaScript and a prediction with no packet loss equals the server.
// If the engine's movement rule or constants change, change this file too.

namespace RewindDuel
{
    public struct Rect2 { public double x, y, w, h; }

    public struct InputMsg
    {
        public int mx, my;
        public bool walk, fire, reload, smoke, dash, use, flash;
        public double aim;
        public int buy;   // weapon or shield id to buy this tick, -1 for none
        public int equip; // 0 primary, 1 secondary, -1 for no change
    }

    public class MoverState
    {
        public double x, y, dashX, dashY;
        public int dashes, dashTicks, moveState;
        public MoverState Copy() => (MoverState)MemberwiseClone();
    }

    public static class Mover
    {
        // engine/constants.ts
        public const int TickRate = 32;
        public const double Radius = 0.4;
        const double Run = 5.0 / TickRate;
        const double Walk = 2.5 / TickRate;
        const int DashTicks = 6;
        const double DashDist = 4;

        static void MoveCircle(MoverState p, double dx, double dy, List<Rect2> walls)
        {
            int n = (int)Math.Ceiling(Math.Sqrt(dx * dx + dy * dy) / 0.2);
            for (int i = 0; i < n; i++)
            {
                p.x += dx / n;
                p.y += dy / n;
                for (int pass = 0; pass < 2; pass++)
                {
                    foreach (var w in walls)
                    {
                        double cx = Math.Min(Math.Max(p.x, w.x), w.x + w.w);
                        double cy = Math.Min(Math.Max(p.y, w.y), w.y + w.h);
                        double ex = p.x - cx;
                        double ey = p.y - cy;
                        double d2 = ex * ex + ey * ey;
                        if (d2 < Radius * Radius && d2 > 0)
                        {
                            double d = Math.Sqrt(d2);
                            p.x = cx + (ex / d) * Radius;
                            p.y = cy + (ey / d) * Radius;
                        }
                    }
                }
            }
        }

        public static void ApplyMovement(MoverState p, InputMsg inp, List<Rect2> walls)
        {
            double dx = 0, dy = 0;
            if (p.dashTicks > 0)
            {
                p.dashTicks--;
                dx = p.dashX;
                dy = p.dashY;
                p.moveState = 2;
            }
            else
            {
                double len = Math.Sqrt(inp.mx * inp.mx + inp.my * inp.my);
                if (len == 0)
                {
                    p.moveState = 0;
                }
                else if (inp.dash && p.dashes > 0)
                {
                    p.dashes--;
                    p.dashTicks = DashTicks - 1;
                    p.dashX = dx = ((inp.mx / len) * DashDist) / DashTicks;
                    p.dashY = dy = ((inp.my / len) * DashDist) / DashTicks;
                    p.moveState = 2;
                }
                else
                {
                    double speed = inp.walk ? Walk : Run;
                    dx = (inp.mx / len) * speed;
                    dy = (inp.my / len) * speed;
                    p.moveState = inp.walk ? 1 : 2;
                }
            }
            if (dx != 0 || dy != 0) MoveCircle(p, dx, dy, walls);
        }
    }

    /// Same contract as web/predict.ts: authoritative self + every unacknowledged input, one tick each.
    public class Predictor
    {
        int seq;
        readonly List<(int seq, InputMsg input)> pending = new List<(int, InputMsg)>();
        public MoverState Pos; // null until the first observation
        public MapDef Map;
        public int Unacked => pending.Count;

        /// One tick exactly as the server does it: move, then teleport (which cancels a dash). engine/engine.ts applyTeleport.
        void Advance(MoverState p, InputMsg input)
        {
            if (Map == null) return;
            Mover.ApplyMovement(p, input, Map.walls);
            foreach (var tp in Map.teleporters)
            {
                var r = tp.pad;
                if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
                {
                    p.x = tp.exitX;
                    p.y = tp.exitY;
                    p.dashTicks = 0;
                    break;
                }
            }
        }

        public int Send(InputMsg input, bool live)
        {
            seq++;
            pending.Add((seq, input));
            if (Pos != null && live) Advance(Pos, input);
            return seq;
        }

        public void Reconcile(MoverState self, int ack, bool live)
        {
            pending.RemoveAll(p => p.seq <= ack);
            var p2 = self.Copy();
            if (live) foreach (var (_, input) in pending) Advance(p2, input);
            Pos = p2;
        }

        public void Reset() { pending.Clear(); Pos = null; }
    }
}
