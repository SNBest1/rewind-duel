using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.Networking;

// The coach in the replay (C): "what could I have done here?" asks the server's what-if planner
// (POST /api/whatif, then GET /api/whatif/:job) to play every scripted plan five times from this exact tick
// against the rival's clone, and lists what really happened beside the best plans. Picking one plays its
// five seconds as two translucent ghosts over the replay, in 3D and on the tactical map. The futures are
// the server's; the client only draws the frames it gets back.

namespace RewindDuel
{
    public partial class DuelClient
    {
        bool rpCoachOpen;
        string coachState = "idle"; // idle, asking, done, error
        string coachMsg, coachBest;
        int coachDone, coachTotal, coachFork, coachSlot, coachPick = -1;
        object coachResult;
        List<object> coachFrames;
        Transform[] coachGhosts;
        Material[] coachMats;

        void ToggleCoach() => rpCoachOpen = !rpCoachOpen;

        void AskCoach()
        {
            if (coachState == "asking" || rpId == null) return;
            // The planner forks the original recording; an attempt's moves after its fork are not in it.
            if (rpBranch > 0) { coachState = "error"; coachMsg = "The coach plans from the original match. Go back to it first (Enter)."; return; }
            ClearCoachGhosts();
            coachResult = null;
            coachFrames = null;
            coachPick = -1;
            coachFork = Mathf.Clamp(Mathf.RoundToInt(rpTick), 0, Mathf.Max(0, rpTicks - 1));
            coachSlot = rpFollow;
            coachState = "asking";
            coachMsg = null;
            coachDone = 0;
            coachTotal = 1;
            coachBest = "";
            rpPlaying = false;
            StartCoroutine(RunCoach(rpId, coachFork, coachSlot));
        }

        IEnumerator RunCoach(string match, int tick, int slot)
        {
            object job = null;
            string err = null;
            yield return Post("/api/whatif?match=" + UnityWebRequest.EscapeURL(match) + "&tick=" + tick + "&slot=" + slot, o => job = o, e => err = e);
            // Each poll is checked against what is still being asked: a newer question or leaving the replay drops this one.
            bool Stale() => rpId != match || coachFork != tick || coachSlot != slot || coachState != "asking";
            float until = Time.realtimeSinceStartup + 90f;
            while (!Stale())
            {
                if (err != null) { coachState = "error"; coachMsg = err; yield break; }
                string status = Json.Str(job, "status");
                if (status == "error") { coachState = "error"; coachMsg = Json.Str(job, "error") ?? "The planner failed."; yield break; }
                if (status == "done") { coachResult = Json.Obj(job, "result"); coachState = coachResult != null ? "done" : "error"; coachMsg = coachResult != null ? null : "The planner sent no result."; yield break; }
                coachDone = (int)Json.Num(job, "done");
                coachTotal = Mathf.Max(1, (int)Json.Num(job, "total", 1));
                coachBest = Json.Str(job, "best") ?? "";
                if (Time.realtimeSinceStartup > until) { coachState = "error"; coachMsg = "The planner took too long."; yield break; }
                yield return new WaitForSecondsRealtime(0.4f);
                string id = Json.Str(job, "id");
                if (id == null) { coachState = "error"; coachMsg = "The server sent no job id."; yield break; }
                yield return Get("/api/whatif/" + id, o => job = o, e => err = e);
            }
        }

        IEnumerator Post(string path, Action<object> ok, Action<string> fail)
        {
            var b = HttpBase();
            if (b == null) { fail("That server address is not a URL."); yield break; }
            using (var req = new UnityWebRequest(b + path, "POST", new DownloadHandlerBuffer(), null))
            {
                req.timeout = 10;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success) { fail(req.error); yield break; }
                object parsed;
                try { parsed = Json.Parse(req.downloadHandler.text); }
                catch (Exception e) { fail("Bad reply from the server: " + e.Message); yield break; }
                ok(parsed);
            }
        }

        /// What really happened first, then the planner's best plans.
        List<object> CoachRows()
        {
            var rows = new List<object>();
            var b = Json.Obj(coachResult, "baseline");
            if (b != null) rows.Add(b);
            var top = Json.Arr(coachResult, "top");
            if (top != null) rows.AddRange(top);
            return rows;
        }

        void PickPlan(int i)
        {
            var rows = CoachRows();
            if (i < 0 || i >= rows.Count) return;
            // Picking the plan already shown goes back to what really happened.
            if (i == coachPick) { coachPick = -1; coachFrames = null; ClearCoachGhosts(); return; }
            coachPick = i;
            coachFrames = Json.Arr(rows[i], "frames");
            EnsureCoachGhosts();
            SeekReplay(coachFork);
            rpPlaying = true;
        }

        void EnsureCoachGhosts()
        {
            if (coachGhosts != null) return;
            coachGhosts = new Transform[2];
            coachMats = new Material[2];
            for (int s = 0; s < 2; s++)
            {
                var g = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                g.name = "Coach ghost " + s;
                Destroy(g.GetComponent<Collider>());
                g.transform.SetParent(world, false);
                g.transform.localScale = new Vector3(0.9f, 1.0f, 0.9f);
                coachMats[s] = Gfx.Additive(Color.white);
                g.GetComponent<Renderer>().sharedMaterial = coachMats[s];
                g.SetActive(false);
                coachGhosts[s] = g.transform;
            }
        }

        void ClearCoachGhosts()
        {
            if (coachGhosts != null) foreach (var g in coachGhosts) if (g) Destroy(g.gameObject);
            if (coachMats != null) foreach (var m in coachMats) if (m) Destroy(m);
            coachGhosts = null;
            coachMats = null;
        }

        /// Forgets the coach entirely: a new match, or leaving the replay.
        void ClearCoach()
        {
            ClearCoachGhosts();
            coachState = "idle";
            coachResult = null;
            coachFrames = null;
            coachPick = -1;
        }

        /// The picked plan's frame at this replay tick, or null outside its five seconds.
        double[] CoachFrameAt(float tick)
        {
            if (coachFrames == null || coachFrames.Count == 0) return null;
            var first = (List<object>)coachFrames[0];
            var last = (List<object>)coachFrames[coachFrames.Count - 1];
            if (tick < (double)first[0] || tick > (double)last[0]) return null;
            // Plan frames are every 2 ticks from the fork, except the last, which is the tick the plan ended on;
            // so the pair around `tick` is found by tick, not by index arithmetic.
            int i = Mathf.Clamp(Mathf.FloorToInt((tick - (float)(double)first[0]) / 2f), 0, coachFrames.Count - 1);
            while (i > 0 && (double)((List<object>)coachFrames[i])[0] > tick) i--;
            while (i + 1 < coachFrames.Count && (double)((List<object>)coachFrames[i + 1])[0] <= tick) i++;
            int j = Mathf.Min(i + 1, coachFrames.Count - 1);
            var a = (List<object>)coachFrames[i];
            var b = (List<object>)coachFrames[j];
            double ta = (double)a[0], tb = (double)b[0];
            float k = tb > ta ? Mathf.Clamp01((float)((tick - ta) / (tb - ta))) : 0f;
            var r = new double[a.Count];
            for (int n = 0; n < a.Count; n++)
            {
                double va = (double)a[n], vb = n < b.Count ? (double)b[n] : va;
                r[n] = n == 4 || n == 9 || n == 5 || n == 10 ? va : va + (vb - va) * k;
            }
            return r;
        }

        float coachLastTick;

        /// The chosen plan's frame while it plays, or null (no plan picked, or outside its five seconds).
        double[] PlanFrameAt(float tick) => coachPick >= 0 ? CoachFrameAt(tick) : null;

        /// While a plan plays, its own shots, kills and flash pops play too.
        void PlanEvents(float from, float to)
        {
            if (coachPick < 0) return;
            var evs = Json.Arr(CoachRows()[coachPick], "events");
            if (evs == null) return;
            foreach (var e in evs)
            {
                double t = Json.Num(e, "tick");
                if (t > from && t <= to) ReplayEvent(e);
            }
        }

        void CoachUpdate()
        {
            if (coachGhosts == null) return;
            if (rpTick > coachLastTick && rpTick - coachLastTick < TickRate) PlanEvents(coachLastTick, rpTick);
            // Crossing the plan's last frame in playback says how it ended.
            if (coachFrames != null && coachFrames.Count > 0 && coachPick >= 0)
            {
                double end = (double)((List<object>)coachFrames[coachFrames.Count - 1])[0];
                if (coachLastTick < end && rpTick >= end && rpTick - coachLastTick < TickRate)
                {
                    var row = CoachRows()[coachPick];
                    Banner(coachPick == 0 ? "WHAT REALLY HAPPENED" : (Json.Str(row, "name") ?? "PLAN").ToUpperInvariant(), Json.Str(row, "reason") ?? "", Gfx.Ally, 2.2f);
                    // Stop on the plan's result, so it is read before the recording takes over again.
                    rpPlaying = false;
                    rpTick = (float)end;
                }
            }
            coachLastTick = rpTick;
            var gf = PlanFrameAt(rpTick) != null ? RealFrameAt(rpTick) : null;
            for (int s = 0; s < 2; s++)
            {
                bool show = gf != null && gf[4 + s * 5] > 0;
                // Right at the camera a ghost would only fill the screen.
                if (show && (W(gf[1 + s * 5], gf[2 + s * 5], 0.9f) - cam.transform.position).sqrMagnitude < 25f) show = false;
                if (coachGhosts[s].gameObject.activeSelf != show) coachGhosts[s].gameObject.SetActive(show);
                if (!show) continue;
                coachGhosts[s].position = W(gf[1 + s * 5], gf[2 + s * 5], 0.9f);
                var c = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                coachMats[s].SetColor("_BaseColor", new Color(c.r, c.g, c.b, 1f) * (0.45f + 0.15f * Mathf.Sin(Time.time * 4f)));
            }
        }

        /// Ghost dots on the tactical map, hollow so they never read as the real players.
        void DrawCoachOnMap(Func<double, double, Vector2> M)
        {
            // The plan is drawn as the players; the hollow marks are where they really were.
            var gf = PlanFrameAt(rpTick) != null ? RealFrameAt(rpTick) : null;
            if (gf == null) return;
            for (int s = 0; s < 2; s++)
            {
                if (gf[4 + s * 5] <= 0) continue;
                var p = M(gf[1 + s * 5], gf[2 + s * 5]);
                var c = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                float d = 12 * S, t = 2 * S;
                Fill(new Rect(p.x - d / 2, p.y - d / 2, d, t), c);
                Fill(new Rect(p.x - d / 2, p.y + d / 2 - t, d, t), c);
                Fill(new Rect(p.x - d / 2, p.y - d / 2, t, d), c);
                Fill(new Rect(p.x + d / 2 - t, p.y - d / 2, t, d), c);
            }
        }

        void DrawCoach(float w, float h)
        {
            float pw = 320 * S, x = w - pw - 16 * S, y = 88 * S;
            var rows = coachState == "done" ? CoachRows() : new List<object>();
            float rowH = 62 * S;
            float ph = 120 * S + rows.Count * (rowH + 4 * S);
            var panel = new Rect(x, y, pw, ph);
            Panel(panel, new Color(0.04f, 0.045f, 0.06f, 0.86f));
            string who = rpNames[rpFollow].ToUpperInvariant();
            Text(new Rect(x + 14 * S, y + 8 * S, pw, 18 * S), "COACH", St(12, true, TextAnchor.UpperLeft, true), Gfx.Label, false);
            Text(new Rect(x, y + 8 * S, pw - 14 * S, 18 * S), "C rounds", St(10, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.4f), false);
            var ev = Event.current;

            bool fresh = coachState == "done" && Mathf.Abs(rpTick - coachFork) < TickRate && coachSlot == rpFollow;
            string ask = coachState == "asking" ? "THINKING… " + Mathf.RoundToInt(100f * coachDone / coachTotal) + "%"
                : fresh ? "ASKED AT " + Clock(coachFork - RoundStartTick())
                : "WHAT COULD " + who + " HAVE DONE?";
            var btn = new Rect(x + 12 * S, y + 32 * S, pw - 24 * S, 38 * S);
            bool hover = btn.Contains(ev.mousePosition) && coachState != "asking";
            Panel(btn, coachState == "asking" ? new Color(1, 1, 1, 0.1f) : hover ? new Color(0.45f, 0.95f, 0.88f) : Gfx.Ally);
            Text(btn, ask, St(13, true, TextAnchor.MiddleCenter, true), coachState == "asking" ? Gfx.Label : Gfx.Ink, false);
            if (coachState == "asking") Fill(new Rect(btn.x, btn.yMax - 3 * S, btn.width * coachDone / coachTotal, 3 * S), Gfx.Ally);
            if (ev.type == EventType.MouseDown && ev.button == 0 && hover) { ev.Use(); AskCoach(); }

            string sub = coachState == "asking" ? (coachBest.Length > 0 ? "best so far: " + coachBest : "playing every plan five times against " + rpNames[1 - rpFollow] + "'s clone")
                : coachState == "error" ? coachMsg
                : coachState == "done" ? (int)Json.Num(coachResult, "futures") + " futures in " + (Json.Num(coachResult, "ms") / 1000).ToString("0.0", CultureInfo.InvariantCulture) + " s · pick one to watch its ghost"
                : "Tries every plan from this exact moment, five times each.";
            Text(new Rect(x + 14 * S, y + 74 * S, pw - 28 * S, 36 * S), sub, St(10, false, TextAnchor.UpperLeft, false, true), coachState == "error" ? Gfx.Rec : new Color(1, 1, 1, 0.6f), false);

            float ry = y + 112 * S;
            for (int i = 0; i < rows.Count; i++)
            {
                var r = rows[i];
                var row = new Rect(x + 8 * S, ry, pw - 16 * S, rowH);
                bool rh = row.Contains(ev.mousePosition);
                Fill(row, i == coachPick ? new Color(1, 1, 1, 0.14f) : rh ? new Color(1, 1, 1, 0.07f) : new Color(1, 1, 1, 0.03f));
                Color c = i == 0 ? new Color(1, 1, 1, 0.55f) : Gfx.Ally;
                Fill(new Rect(row.x, row.y + 6 * S, 4 * S, row.height - 12 * S), c);
                string name = i == 0 ? "WHAT REALLY HAPPENED" : Json.Str(r, "name")?.ToUpperInvariant() ?? "?";
                Text(new Rect(row.x + 14 * S, row.y + 6 * S, row.width - 80 * S, 18 * S), name, St(12, true, TextAnchor.MiddleLeft, true), i == 0 ? Gfx.Label : Gfx.Ally, false);
                Text(new Rect(row.x, row.y + 6 * S, row.width - 10 * S, 18 * S), Json.Num(r, "score").ToString("0.0", CultureInfo.InvariantCulture), St(12, true, TextAnchor.MiddleRight, true), new Color(1, 1, 1, 0.7f), false);
                int runs = (int)Json.Num(r, "runs");
                string odds = i == 0 ? "" : "won the fight " + (int)Json.Num(r, "fightsWon") + "/" + runs + " · survived " + (int)Json.Num(r, "survived") + "/" + runs + "  ·  ";
                Text(new Rect(row.x + 14 * S, row.y + 26 * S, row.width - 24 * S, 32 * S), odds + (Json.Str(r, "reason") ?? ""), St(10, false, TextAnchor.UpperLeft, false, true), new Color(1, 1, 1, 0.72f), false);
                if (ev.type == EventType.MouseDown && ev.button == 0 && rh) { ev.Use(); PickPlan(i); }
                ry += rowH + 4 * S;
            }
        }

        /// While a plan plays: whose plan, and how to get back.
        void DrawPlanBanner(float w, float y)
        {
            if (PlanFrameAt(rpTick) == null) return;
            var row = CoachRows()[coachPick];
            string name = coachPick == 0 ? "WHAT YOU DID, REPLAYED AGAINST THE CLONE" : "PLAN · " + (Json.Str(row, "name") ?? "?").ToUpperInvariant();
            var r = new Rect(w / 2 - 260 * S, y, 520 * S, 26 * S);
            Panel(r, new Color(Gfx.Ally.r * 0.3f, Gfx.Ally.g * 0.3f, Gfx.Ally.b * 0.3f, 0.92f));
            Text(r, name + "  ·  faint shapes are what really happened  ·  click the plan again to return", St(11, true, TextAnchor.MiddleCenter, true), Gfx.Label, false);
        }

        float RoundStartTick()
        {
            float start = 0;
            foreach (var rd in rpRounds) if (Json.Num(rd, "startTick") <= coachFork) start = (float)Json.Num(rd, "startTick");
            return start;
        }
    }
}
