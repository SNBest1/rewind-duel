using System;
using System.Collections.Generic;
using UnityEngine;

// "What they saw" (F): the replay with the followed player's fog of war. The rival is shown only while the
// followed player could see them, by a port of the engine's one sight rule (engine/vision.ts canSeePoint and
// engine/geometry.ts sightBlocked). Replay frames are every 2 ticks and rounded to 0.01, so on the exact
// edge of a wall or the cone this can differ from the server for a frame; it is a viewing aid, never a rule.

namespace RewindDuel
{
    public partial class DuelClient
    {
        bool rpFog;

        // engine/constants.ts
        const float VisionRange = 30f, NearRange = 3f, VisionHalfCone = 50f * Mathf.Deg2Rad;

        /// Could `from` see `to` at this frame? Dead or blind players see nothing.
        bool CouldSee(double[] fr, int from, int to, float tick)
        {
            if (fr[4 + from * 5] <= 0 || fr[5 + from * 5] > 0 || fr[4 + to * 5] <= 0) return false;
            double ax = fr[1 + from * 5], ay = fr[2 + from * 5], bx = fr[1 + to * 5], by = fr[2 + to * 5];
            double dx = bx - ax, dy = by - ay, dist = Math.Sqrt(dx * dx + dy * dy);
            if (dist > NearRange)
            {
                if (dist > VisionRange) return false;
                double d = Math.Atan2(dy, dx) - fr[3 + from * 5];
                if (Math.Abs(Math.Atan2(Math.Sin(d), Math.Cos(d))) > VisionHalfCone) return false;
            }
            if (dist == 0) return true;
            var dir = new Vector2((float)(dx / dist), (float)(dy / dist));
            // Cast a unit past the target: WallHit returns its max when nothing is hit, and a float max
            // compared with the double distance would otherwise read as blocked.
            if (WallHit((float)ax, (float)ay, dir, (float)dist + 1f) < dist) return false;
            int fi = Mathf.Clamp(Mathf.FloorToInt(tick / rpStep), 0, rpFrames.Count - 1);
            foreach (var sm in rpSmokes)
            {
                var a = (List<object>)sm;
                if ((int)(double)a[0] != fi) continue;
                if (RayCircle(ax, ay, dir.x, dir.y, (double)a[1], (double)a[2], SmokeRadius) < dist) return false;
            }
            return true;
        }

        /// engine/geometry.ts rayCircle: distance along a unit ray to a circle, 0 if inside, infinity if missed.
        static double RayCircle(double ox, double oy, double dx, double dy, double cx, double cy, double rad)
        {
            double ex = cx - ox, ey = cy - oy, d2 = ex * ex + ey * ey;
            if (d2 <= rad * rad) return 0;
            double proj = ex * dx + ey * dy;
            if (proj < 0) return double.PositiveInfinity;
            double perp2 = d2 - proj * proj;
            if (perp2 > rad * rad) return double.PositiveInfinity;
            return proj - Math.Sqrt(rad * rad - perp2);
        }

        /// With the fog on, is the rival out of the followed player's sight right now?
        bool RivalHidden(double[] fr) => rpFog && !CouldSee(fr, rpFollow, 1 - rpFollow, rpTick);

        /// Where the followed player last saw the rival in the last 5 seconds, and how long ago (ticks), if at all.
        bool LastSeen(out Vector2 at, out float ago)
        {
            at = Vector2.zero;
            ago = 0;
            for (float t = rpTick - rpStep; t >= Mathf.Max(0, rpTick - 5 * TickRate); t -= rpStep)
            {
                var f = FrameAt(t);
                if (!CouldSee(f, rpFollow, 1 - rpFollow, t)) continue;
                int o = 1 - rpFollow;
                at = new Vector2((float)f[1 + o * 5], (float)f[2 + o * 5]);
                ago = rpTick - t;
                return true;
            }
            return false;
        }
    }
}
