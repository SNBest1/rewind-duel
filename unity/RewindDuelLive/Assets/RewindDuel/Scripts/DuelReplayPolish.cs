using System.Collections.Generic;
using UnityEngine;

// Replay polish: name tags and health over the players, an X on the floor where each death of this round
// happened, a zoomed strip of the current round under the timeline, and the site signs as camera obstacles.

namespace RewindDuel
{
    public partial class DuelClient
    {
        // ---------------------------------------------------------------- camera vs. site signs

        /// Distance along a map-space ray to the first site sign board, or `max`. The boards stand at the camera's
        /// height but are not in map.walls (players walk under them), so the camera checks them on its own.
        /// The placement mirrors Arena.BuildSite: a 0.9-wide board at the site corner nearest the attackers.
        float SignHit(float ox, float oy, Vector2 dir, float max)
        {
            float best = max;
            if (map == null) return best;
            foreach (var site in map.sites)
            {
                var r = site.rect;
                float cx = (float)r.x + 0.4f, cy = (float)(r.y + (map.atkY < r.y + r.h / 2 ? 0.4 : r.h - 0.4));
                float t0 = 0f, t1 = best;
                // A margin around the board so the near clip plane stays clear of it.
                if (!Slab(ox, dir.x, cx - 0.35f, cx + 0.35f, ref t0, ref t1)) continue;
                if (!Slab(oy, dir.y, cy - 0.8f, cy + 0.8f, ref t0, ref t1)) continue;
                if (t0 < best) best = t0;
            }
            return best;
        }

        // ---------------------------------------------------------------- name tags

        /// A name and a health bar over each player the camera can see.
        void DrawWorldTags()
        {
            if (rpBots == null || cam == null || Event.current.type != EventType.Repaint) return;
            var fr = FrameAt(rpTick);
            for (int s = 0; s < 2; s++)
            {
                var b = rpBots[s];
                if (!b || !b.gameObject.activeSelf) continue;
                double hp = fr[4 + s * 5];
                var sp = cam.WorldToScreenPoint(W(fr[1 + s * 5], fr[2 + s * 5], 2.05f));
                if (sp.z <= 0.2f) continue;
                float x = sp.x, y = UnityEngine.Screen.height - sp.y;
                // Smaller with distance, within limits, so far tags never crowd the view.
                float k = Mathf.Clamp(9f / sp.z, 0.55f, 1.1f);
                float bw = 74 * S * k, bh = 5 * S * k;
                var c = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                // A tag behind a wall or crate stays, faded: replays may see through cover, but should say so.
                var cp = cam.transform.position;
                float px = (float)fr[1 + s * 5], py = (float)fr[2 + s * 5];
                var d = new Vector2(px - cp.x, py + cp.z);
                float dist = d.magnitude;
                if (dist > 0.5f && WallHit(cp.x, -cp.z, d / dist, dist + 1f) < dist - 0.6f) c.a = 0.4f;
                Text(new Rect(x - 80 * S, y - 22 * S * k - bh, 160 * S, 18 * S * k), rpNames[s], St(Mathf.RoundToInt(12 * k), true, TextAnchor.LowerCenter), c);
                var bar = new Rect(x - bw / 2, y - bh, bw, bh);
                Fill(new Rect(bar.x - 1, bar.y - 1, bar.width + 2, bar.height + 2), new Color(0, 0, 0, 0.55f));
                var hc = hp <= 30 ? Gfx.Rec : c;
                hc.a = c.a;
                Fill(new Rect(bar.x, bar.y, bar.width * Mathf.Clamp01((float)hp / 100f), bar.height), hc);
            }
        }

        // ---------------------------------------------------------------- death marks

        readonly List<Transform> deathMarks = new List<Transform>();
        Material[] deathMats;

        /// An X on the floor in the victim's colour for every kill of the latest round that has started.
        void SyncDeathMarks()
        {
            if (rpEvents == null || world == null) return;
            if (deathMats == null)
                deathMats = new[] { Gfx.Cutout(Gfx.Ally, Gfx.LetterTex("X")), Gfx.Cutout(Gfx.Enemy, Gfx.LetterTex("X")) };
            float roundStart = 0;
            foreach (var rd in rpRounds) if (Json.Num(rd, "startTick") <= rpTick) roundStart = (float)Json.Num(rd, "startTick");
            int used = 0;
            foreach (var e in rpEvents)
            {
                double et = Json.Num(e, "tick");
                if (et > rpTick) break;
                if (et < roundStart || Json.Str(e, "type") != "kill") continue;
                int v = (int)Json.Num(e, "victim");
                if (v < 0 || v > 1) continue;
                var f = FrameAt((float)System.Math.Max(0, et - 1));
                if (used == deathMarks.Count)
                {
                    var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
                    Destroy(q.GetComponent<Collider>());
                    q.name = "DeathMark";
                    q.transform.SetParent(world, false);
                    q.transform.localScale = Vector3.one * 1.4f;
                    deathMarks.Add(q.transform);
                }
                var m = deathMarks[used++];
                m.gameObject.SetActive(true);
                m.SetPositionAndRotation(W(f[1 + v * 5], f[2 + v * 5], 0.03f), Quaternion.Euler(90, 0, 0));
                m.GetComponent<Renderer>().sharedMaterial = deathMats[v == rpFollow ? 0 : 1];
            }
            for (int i = used; i < deathMarks.Count; i++) if (deathMarks[i]) deathMarks[i].gameObject.SetActive(false);
        }

        void ClearDeathMarks()
        {
            foreach (var m in deathMarks) if (m) Destroy(m.gameObject);
            deathMarks.Clear();
            if (deathMats != null) foreach (var m in deathMats) if (m) Destroy(m);
            deathMats = null;
        }

        // ---------------------------------------------------------------- round zoom

        /// The current round alone, stretched across the timeline: every shot, kill and plant in it, and the
        /// playhead. Click or drag to move within the round.
        void DrawRoundZoom(Rect r, int ri)
        {
            if (rpRounds == null || rpRounds.Count == 0) return;
            float start = (float)Json.Num(rpRounds[ri], "startTick"), end = (float)Json.Num(rpRounds[ri], "endTick");
            if (end <= start) return;
            float X(double t) => r.x + Mathf.Clamp01((float)((t - start) / (end - start))) * r.width;
            Fill(r, new Color(1, 1, 1, 0.06f));
            Fill(new Rect(r.x, r.y, X(rpTick) - r.x, r.height), new Color(1, 1, 1, 0.1f));
            foreach (var e in rpEvents)
            {
                double t = Json.Num(e, "tick");
                if (t < start) continue;
                if (t > end) break;
                string type = Json.Str(e, "type");
                if (type == "shot")
                {
                    var c = (int)Json.Num(e, "slot") == rpFollow ? Gfx.Ally : Gfx.Enemy;
                    bool hit = Json.Bool(e, "hit");
                    Fill(new Rect(X(t) - 0.5f * S, r.y + (hit ? 0 : r.height * 0.5f), 1 * S, hit ? r.height : r.height * 0.5f), new Color(c.r, c.g, c.b, hit ? 0.95f : 0.45f));
                }
                else if (type == "kill")
                    Fill(new Rect(X(t) - 1.5f * S, r.y - 3 * S, 3 * S, r.height + 6 * S), (int)Json.Num(e, "victim") == rpFollow ? Gfx.Rec : Gfx.Label);
                else if (type == "plant")
                    Fill(new Rect(X(t) - 3 * S, r.y + r.height / 2 - 3 * S, 6 * S, 6 * S), Gfx.Gold);
            }
            Fill(new Rect(X(rpTick) - 1 * S, r.y - 4 * S, 2 * S, r.height + 8 * S), Color.white);

            var ev = Event.current;
            var hitR = new Rect(r.x, r.y - 6 * S, r.width, r.height + 12 * S);
            if (ev.type == EventType.MouseDown && ev.button == 0 && hitR.Contains(ev.mousePosition)) { zoomScrub = true; ev.Use(); }
            if (zoomScrub && (ev.type == EventType.MouseDrag || ev.type == EventType.MouseDown || ev.type == EventType.Repaint))
                SeekReplay(start + Mathf.Clamp01((ev.mousePosition.x - r.x) / r.width) * (end - start));
            if (ev.rawType == EventType.MouseUp) zoomScrub = false;
        }

        bool zoomScrub;
    }
}
