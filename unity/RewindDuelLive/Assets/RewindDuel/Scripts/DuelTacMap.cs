using System;
using System.Collections.Generic;
using UnityEngine;

// The replay's 2D tactical map (M): the whole map from above with both players, their view cones, where they
// have just been, shots of the last moment, smokes, the planted spike and where each death of this round
// happened. Everything comes from the replay data the 3D view already uses; nothing is simulated.

namespace RewindDuel
{
    public partial class DuelClient
    {
        bool rpTacMap = true;

        // The engine's sight rule: a 100 degree cone. The cone is drawn 30 units long, as on the live minimap.
        const float ConeHalfDeg = 50f, ConeLen = 30f;
        // How far back the trail and the shot lines reach, in ticks.
        int TrailTicks => 3 * TickRate;
        int ShotTicks => TickRate / 2;

        void DrawTacMap(float w, float h)
        {
            if (!rpTacMap || map == null || rpFrames == null) return;
            // Left column, between the top bar and the timeline panel.
            float top = 86 * S, bottom = h - 230 * S;
            float mw = Mathf.Min(440 * S, w * 0.3f), mh = mw * (float)(map.height / map.width);
            if (mh > bottom - top) { mh = Mathf.Max(80 * S, bottom - top); mw = mh * (float)(map.width / map.height); }
            var r = new Rect(18 * S, top + 24 * S, mw, mh);
            Panel(new Rect(r.x - 8 * S, r.y - 30 * S, r.width + 16 * S, r.height + 38 * S), new Color(0.04f, 0.045f, 0.06f, 0.86f));
            Text(new Rect(r.x, r.y - 26 * S, r.width, 20 * S), "TACTICAL MAP · M", St(10, true, TextAnchor.MiddleLeft, true), new Color(1, 1, 1, 0.6f), false);
            // The lobby thumbnail, dimmed so cones and shots read over it.
            var g = GUI.color; GUI.color = new Color(0.62f, 0.62f, 0.66f, 1f);
            GUI.DrawTexture(r, Thumb(map));
            GUI.color = g;

            float k = r.width / (float)map.width;
            Vector2 M(double x, double y) => new Vector2(r.x + (float)x * k, r.y + (float)y * k);
            // The latest round that has started: its kill X marks stay up through the pause after it ends.
            float roundStart = 0;
            foreach (var rd in rpRounds) if (Json.Num(rd, "startTick") <= rpTick) roundStart = (float)Json.Num(rd, "startTick");

            // Smokes alive now: soft grey discs at their real radius.
            int fi = Mathf.Clamp(Mathf.FloorToInt(rpTick / rpStep), 0, rpFrames.Count - 1);
            foreach (var sm in rpSmokes)
            {
                var a = (List<object>)sm;
                if ((int)(double)a[0] != fi) continue;
                var c = M((double)a[1], (double)a[2]);
                float rad = SmokeRadius * k;
                var o = GUI.color; GUI.color = new Color(0.82f, 0.84f, 0.88f, 0.75f);
                GUI.DrawTexture(new Rect(c.x - rad, c.y - rad, rad * 2, rad * 2), Gfx.Dot);
                GUI.color = o;
            }

            var fr = FrameAt(rpTick);
            bool rivalHidden = RivalHidden(fr);
            Text(new Rect(r.x, r.y - 26 * S, r.width, 20 * S), rpFog ? "FOG ON · F" : "FOG OFF · F", St(10, true, TextAnchor.MiddleRight, true), rpFog ? Gfx.Ally : new Color(1, 1, 1, 0.45f), false);
            if (Event.current.type == EventType.Repaint)
            {
                // Clip GL to the map: everything below is drawn in screen pixels.
                GL.PushMatrix();
                var vp = new Rect(r.x, UnityEngine.Screen.height - r.yMax, r.width, r.height);
                GL.Viewport(vp);
                GL.LoadPixelMatrix(r.x, r.xMax, r.yMax, r.y);
                Gfx.GLMat().SetPass(0);

                for (int s = 0; s < 2; s++)
                {
                    if (fr[4 + s * 5] <= 0 || (s != rpFollow && rivalHidden)) continue;
                    var col = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                    var p = M(fr[1 + s * 5], fr[2 + s * 5]);
                    double aim = fr[3 + s * 5];
                    bool blind = fr[5 + s * 5] > 0;
                    // View cone; a blinded player's cone is shrunk to show they see nothing.
                    float len = (blind ? 3f : ConeLen) * k;
                    GL.Begin(GL.TRIANGLES);
                    for (int i = 0; i < 20; i++)
                    {
                        double a0 = aim + (-ConeHalfDeg + i * ConeHalfDeg * 2 / 20) * Mathf.Deg2Rad;
                        double a1 = aim + (-ConeHalfDeg + (i + 1) * ConeHalfDeg * 2 / 20) * Mathf.Deg2Rad;
                        GL.Color(new Color(col.r, col.g, col.b, 0.42f));
                        GL.Vertex3(p.x, p.y, 0);
                        GL.Color(new Color(col.r, col.g, col.b, 0f));
                        GL.Vertex3(p.x + (float)Math.Cos(a0) * len, p.y + (float)Math.Sin(a0) * len, 0);
                        GL.Vertex3(p.x + (float)Math.Cos(a1) * len, p.y + (float)Math.Sin(a1) * len, 0);
                    }
                    GL.End();

                    // Trail: where they were over the last few seconds of this round, fading out.
                    GL.Begin(GL.QUADS);
                    float t0 = Mathf.Max(roundStart, rpTick - TrailTicks);
                    Vector2 prev = Vector2.zero;
                    bool first = true;
                    for (float t = t0; t <= rpTick; t += rpStep)
                    {
                        var f = FrameAt(t);
                        if (f[4 + s * 5] <= 0) { first = true; continue; }
                        var q = M(f[1 + s * 5], f[2 + s * 5]);
                        if (!first) Seg(prev, q, 1.3f * S, new Color(col.r, col.g, col.b, 0.7f * (t - t0) / Mathf.Max(1, rpTick - t0)));
                        prev = q;
                        first = false;
                    }
                    GL.End();
                }

                // Shots fired in the last half second, fading.
                GL.Begin(GL.QUADS);
                foreach (var e in rpEvents)
                {
                    double et = Json.Num(e, "tick");
                    if (et > rpTick) break;
                    if (et < rpTick - ShotTicks || Json.Str(e, "type") != "shot") continue;
                    int who = (int)Json.Num(e, "slot");
                    if (who != rpFollow && rivalHidden && !Json.Bool(e, "hit")) continue;
                    var col = who == rpFollow ? Gfx.Ally : Gfx.Enemy;
                    float fade = 1f - (float)(rpTick - et) / ShotTicks;
                    Seg(M(Json.Num(e, "x"), Json.Num(e, "y")), M(Json.Num(e, "toX"), Json.Num(e, "toY")), 1.2f * S,
                        Json.Bool(e, "hit") ? new Color(1f, 0.95f, 0.7f, fade) : new Color(col.r, col.g, col.b, 0.6f * fade));
                }
                GL.End();

                GL.PopMatrix();
                GL.Viewport(new Rect(0, 0, UnityEngine.Screen.width, UnityEngine.Screen.height));
            }

            // Deaths so far this round: an X where the victim fell, in the victim's colour.
            foreach (var e in rpEvents)
            {
                double et = Json.Num(e, "tick");
                if (et > rpTick) break;
                if (et < roundStart || Json.Str(e, "type") != "kill") continue;
                int v = (int)Json.Num(e, "victim");
                var f = FrameAt((float)Math.Max(0, et - 1));
                var at = M(f[1 + v * 5], f[2 + v * 5]);
                Text(new Rect(at.x - 10 * S, at.y - 10 * S, 20 * S, 20 * S), "✕", St(16, true, TextAnchor.MiddleCenter, true), v == rpFollow ? Gfx.Ally : Gfx.Enemy);
            }

            // The spike, once planted this round.
            foreach (var e in rpEvents)
            {
                double et = Json.Num(e, "tick");
                if (et > rpTick) break;
                if (et < roundStart || Json.Str(e, "type") != "plant") continue;
                var at = M(Json.Num(e, "x"), Json.Num(e, "y"));
                float pulse = 9 * S * (1 + 0.25f * Mathf.Sin(Time.time * 8));
                Fill(new Rect(at.x - pulse / 2, at.y - pulse / 2, pulse, pulse), Gfx.Rec);
            }

            DrawCoachOnMap((x, y) => M(x, y));

            // Site letters under the players, so a name never hides behind one.
            foreach (var site in map.sites)
            {
                var c = M(site.rect.x + site.rect.w / 2, site.rect.y + site.rect.h / 2);
                Text(new Rect(c.x - 12 * S, c.y - 12 * S, 24 * S, 24 * S), site.label, St(14, true, TextAnchor.MiddleCenter, true), new Color(1, 0.6f, 0.55f, 0.9f));
            }

            // Players on top: a dot in their colour and a short aim tick; the name of the one you watch.
            // Under fog a hidden rival is a faded mark where they were last seen, with how long ago.
            if (rivalHidden && fr[4 + (1 - rpFollow) * 5] > 0 && LastSeen(out var ls, out var ago))
            {
                var q = M(ls.x, ls.y);
                float d = 9 * S;
                Fill(new Rect(q.x - d / 2, q.y - d / 2, d, d), new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, 0.35f));
                Text(new Rect(q.x - 60 * S, q.y + 6 * S, 120 * S, 16 * S), (ago / TickRate).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "s ago", St(10, true, TextAnchor.UpperCenter), new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, 0.6f));
            }
            for (int s = 0; s < 2; s++)
            {
                if (fr[4 + s * 5] <= 0 || (s != rpFollow && rivalHidden)) continue;
                var col = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                var p = M(fr[1 + s * 5], fr[2 + s * 5]);
                float d = 9 * S;
                Fill(new Rect(p.x - d / 2 - S, p.y - d / 2 - S, d + 2 * S, d + 2 * S), Gfx.Ink);
                Fill(new Rect(p.x - d / 2, p.y - d / 2, d, d), col);
                Text(new Rect(p.x - 60 * S, p.y + 6 * S, 120 * S, 16 * S), rpNames[s], St(10, true, TextAnchor.UpperCenter), col);
            }

        }

        /// A thick line as one quad, inside an open GL.QUADS block.
        static void Seg(Vector2 a, Vector2 b, float thick, Color c)
        {
            var n = new Vector2(-(b.y - a.y), b.x - a.x);
            if (n.sqrMagnitude < 1e-6f) return;
            n = n.normalized * thick;
            GL.Color(c);
            GL.Vertex3(a.x + n.x, a.y + n.y, 0); GL.Vertex3(b.x + n.x, b.y + n.y, 0);
            GL.Vertex3(b.x - n.x, b.y - n.y, 0); GL.Vertex3(a.x - n.x, a.y - n.y, 0);
        }
    }
}
