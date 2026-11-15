using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.InputSystem;

// Replays in 3D: watch any recorded match from a third-person camera, scrub a timeline that shows how the
// match went, then take control at any moment. Taking control opens a rewind on the server: you play from
// that exact tick while the opponent repeats what really happened, and once your play diverges the AI takes
// over (the server's ghost, then a clone of that player, then a basic bot past what the clone has seen).
//
// The replay data is the server's own rebuild of the match (GET /api/viewer/matches/:id): both players'
// positions every 2 ticks, shots, kills, plants, flash pops, smokes and the round list. Nothing is simulated
// here; the client only interpolates between recorded frames.

namespace RewindDuel
{
    public partial class DuelClient
    {
        // A frame is [tick, x0, y0, aim0, hp0, blind0, x1, y1, aim1, hp1, blind1].
        object rpDetail;
        List<object> rpFrames, rpEvents, rpSmokes, rpRounds;
        string rpId;
        string[] rpNames = { "?", "?" };
        int rpStep = 2, rpTicks, rpFollow, rpEventIdx;
        float rpTick, rpSpeed = 1f, rpOrbit, rpZoom = 1f;
        bool rpPlaying = true, rpLoading, rpScrubbing;
        Transform[] rpBots;
        Transform[] rpRings; // overhead markers under each player
        Light[] rpLights;
        Vector3 rpCam;
        // Where to come back to after a rewind ends.
        string rpReturnId;
        int rpReturnTick;

        IEnumerator OpenReplay(string id, int startTick = 0)
        {
            if (rpLoading) yield break;
            rpLoading = true;
            status = "Loading the match…";
            object detail = null;
            yield return Get("/api/viewer/matches/" + id, o => detail = o, e => status = "Could not load that match: " + e);
            rpLoading = false;
            if (detail == null) yield break;
            var m = catalog?.Map(Json.Str(detail, "map"));
            if (m == null) { status = "That match was played on a map this server does not have."; yield break; }

            ClearReplayActors();
            rpDetail = detail;
            rpId = id;
            rpFrames = Json.Arr(detail, "frames") ?? new List<object>();
            rpEvents = Json.Arr(detail, "events") ?? new List<object>();
            rpSmokes = Json.Arr(detail, "smokes") ?? new List<object>();
            rpRounds = Json.Arr(detail, "rounds") ?? new List<object>();
            rpStep = Mathf.Max(1, (int)Json.Num(detail, "frameStep", 2));
            rpTicks = (int)Json.Num(detail, "ticks");
            var players = Json.Arr(detail, "players");
            rpNames = new[] { "?", "?" };
            rpFollow = 0;
            if (players != null)
                foreach (var p in players)
                {
                    int s = (int)Json.Num(p, "slot");
                    if (s < 0 || s > 1) continue;
                    rpNames[s] = Json.Str(p, "name") ?? "?";
                    if (string.Equals(rpNames[s], playerName.Trim(), StringComparison.OrdinalIgnoreCase)) rpFollow = s;
                }
            if (rpFrames.Count == 0) { status = "That match has no frames to show."; yield break; }

            BuildArena(m);
            ShowWeapon(-1);
            rpBots = new Transform[2];
            rpLights = new Light[2];
            rpRings = new Transform[2];
            for (int s = 0; s < 2; s++)
            {
                rpBots[s] = MakeBot("Replay " + rpNames[s], Gfx.Ally, out rpLights[s]);
                var ring = GameObject.CreatePrimitive(PrimitiveType.Quad);
                Destroy(ring.GetComponent<Collider>());
                ring.name = "Marker " + rpNames[s];
                ring.transform.SetParent(world, false);
                ring.transform.localScale = Vector3.one * 3.2f;
                ring.GetComponent<Renderer>().sharedMaterial = Gfx.Additive(Color.white, Gfx.Ring);
                rpRings[s] = ring.transform;
            }
            ColourReplayBots();
            SeekReplay(Mathf.Clamp(startTick, 0, Mathf.Max(0, rpTicks - 1)));
            rpPlaying = true;
            rpSpeed = 1f;
            rpOrbit = 0;
            rpCam = Vector3.zero;
            status = "";
            view = View.Replay;
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
        }

        /// The followed player is teal, the other is red, as in a live match.
        void ColourReplayBots()
        {
            if (rpLights == null) return;
            for (int s = 0; s < 2; s++)
            {
                var c = s == rpFollow ? Gfx.Ally : Gfx.Enemy;
                if (rpLights[s]) rpLights[s].color = c;
                if (rpRings != null && rpRings[s]) rpRings[s].GetComponent<Renderer>().sharedMaterial.SetColor("_BaseColor", c * 2.5f);
            }
        }

        void ClearReplayActors()
        {
            if (rpBots != null) foreach (var b in rpBots) if (b) Destroy(b.gameObject);
            if (rpRings != null) foreach (var r in rpRings) if (r) { Destroy(r.GetComponent<Renderer>().sharedMaterial); Destroy(r.gameObject); }
            rpBots = null;
            rpRings = null;
            rpLights = null;
        }

        void SeekReplay(float tick)
        {
            rpTick = Mathf.Clamp(tick, 0, Mathf.Max(0, rpTicks - 1));
            // The next event to play is the first one after this tick; scrubbing never replays effects.
            rpEventIdx = 0;
            while (rpEventIdx < rpEvents.Count && Json.Num(rpEvents[rpEventIdx], "tick") <= rpTick) rpEventIdx++;
        }

        /// Frame values at a tick, interpolated between the two recorded frames around it.
        double[] FrameAt(float tick)
        {
            float f = tick / rpStep;
            int i = Mathf.Clamp(Mathf.FloorToInt(f), 0, rpFrames.Count - 1);
            int j = Mathf.Min(i + 1, rpFrames.Count - 1);
            float k = Mathf.Clamp01(f - i);
            var a = (List<object>)rpFrames[i];
            var b = (List<object>)rpFrames[j];
            var r = new double[a.Count];
            for (int n = 0; n < a.Count; n++)
            {
                // A short or damaged next frame holds the current value instead of crashing playback.
                double va = (double)a[n], vb = n < b.Count ? (double)b[n] : va;
                // Aims interpolate the short way round; health and blind snap.
                if (n == 3 || n == 8) r[n] = va + Math.Atan2(Math.Sin(vb - va), Math.Cos(vb - va)) * k;
                else if (n == 4 || n == 9 || n == 5 || n == 10) r[n] = va;
                else r[n] = va + (vb - va) * k;
            }
            return r;
        }

        int RoundAt(float tick)
        {
            // The latest round that has started, so the pause after a round still belongs to it.
            int at = 0;
            for (int i = 0; i < rpRounds.Count; i++)
                if (tick >= Json.Num(rpRounds[i], "startTick")) at = i;
            return at;
        }

        int[] ScoreAt(float tick)
        {
            var sc = new int[2];
            foreach (var r in rpRounds)
                if (Json.Num(r, "endTick") <= tick && !Json.IsNull(r, "winner")) sc[(int)Json.Num(r, "winner")]++;
            return sc;
        }

        // ================================================================ per frame

        void ReplayUpdate(Keyboard kb, Mouse mouse)
        {
            if (rpFrames == null || rpBots == null) return;
            if (kb != null)
            {
                if (kb.spaceKey.wasPressedThisFrame) rpPlaying = !rpPlaying;
                if (kb.leftArrowKey.wasPressedThisFrame) SeekReplay(rpTick - 3 * TickRate);
                if (kb.rightArrowKey.wasPressedThisFrame) SeekReplay(rpTick + 3 * TickRate);
                if (kb.upArrowKey.wasPressedThisFrame) rpSpeed = Mathf.Min(8f, rpSpeed * 2f);
                if (kb.downArrowKey.wasPressedThisFrame) rpSpeed = Mathf.Max(0.25f, rpSpeed / 2f);
                if (kb.tabKey.wasPressedThisFrame) { rpFollow = 1 - rpFollow; ColourReplayBots(); }
                if (kb.vKey.wasPressedThisFrame) CycleCamera();
                if (kb.mKey.wasPressedThisFrame) rpTacMap = !rpTacMap;
                if (kb.leftBracketKey.wasPressedThisFrame) JumpRound(-1);
                if (kb.rightBracketKey.wasPressedThisFrame) JumpRound(+1);
                if (kb.commaKey.wasPressedThisFrame) JumpKill(-1);
                if (kb.periodKey.wasPressedThisFrame) JumpKill(+1);
                if (kb.enterKey.wasPressedThisFrame || kb.numpadEnterKey.wasPressedThisFrame) { TakeControl(); return; }
                if (kb.escapeKey.wasPressedThisFrame) { LeaveReplay(); return; }
            }
            if (mouse != null)
            {
                if (rpCamMode == 0 && mouse.rightButton.isPressed) rpOrbit += mouse.delta.ReadValue().x * 0.25f;
                float wheel = mouse.scroll.ReadValue().y;
                if (Mathf.Abs(wheel) > 0.01f) rpZoom = Mathf.Clamp(rpZoom - Mathf.Sign(wheel) * 0.1f, 0.5f, 2.5f);
            }

            float before = rpTick;
            if (rpPlaying && !rpScrubbing)
            {
                rpTick += Time.deltaTime * TickRate * rpSpeed;
                if (rpTick >= rpTicks - 1) { rpTick = rpTicks - 1; rpPlaying = false; }
            }
            // Effects for what happened since the last frame, only during normal playback.
            if (rpTick > before && rpTick - before < TickRate)
                while (rpEventIdx < rpEvents.Count && Json.Num(rpEvents[rpEventIdx], "tick") <= rpTick) ReplayEvent(rpEvents[rpEventIdx++]);
            else if (rpTick < before || rpTick - before >= TickRate) SeekReplay(rpTick);

            var fr = FrameAt(rpTick);
            for (int s = 0; s < 2; s++)
            {
                double x = fr[1 + s * 5], y = fr[2 + s * 5], aim = fr[3 + s * 5], hp = fr[4 + s * 5];
                var b = rpBots[s];
                bool alive = hp > 0;
                if (b.gameObject.activeSelf != alive) b.gameObject.SetActive(alive);
                if (alive) b.SetPositionAndRotation(W(x, y, 0) + Vector3.up * Mathf.Sin(Time.time * 3f + s) * 0.05f, Quaternion.Euler(0, YawFromAim(aim), 0));
                // Overhead, a player is a dot from that height, so a ring in their colour marks them.
                var ring = rpRings[s];
                bool showRing = alive && rpCamMode == 3;
                if (ring.gameObject.activeSelf != showRing) ring.gameObject.SetActive(showRing);
                if (showRing) ring.SetPositionAndRotation(W(x, y, 0.06f), Quaternion.Euler(90, 0, 0));
            }

            // Smokes alive at this frame.
            int fi = Mathf.Clamp(Mathf.FloorToInt(rpTick / rpStep), 0, rpFrames.Count - 1);
            var centers = new List<Vector3>();
            var left = new List<float>();
            foreach (var sm in rpSmokes)
            {
                var a = (List<object>)sm;
                if ((int)(double)a[0] == fi) { centers.Add(W((double)a[1], (double)a[2], 0)); left.Add(5f); }
            }
            fx.SyncSmokes(centers, left, SmokeRadius);
            fx.SyncFlashes(new List<Vector3>(), new List<bool>());

            double fx0 = fr[1 + rpFollow * 5], fy0 = fr[2 + rpFollow * 5], faim = fr[3 + rpFollow * 5];
            switch (rpCamMode)
            {
                case 1: PovCamera(fx0, fy0, faim); break;
                case 2: FreeCamera(kb, mouse); break;
                case 3: OverheadCamera(); break;
                default: ThirdPersonCamera(fx0, fy0, faim); break;
            }
            // In POV the camera is inside the watched player's body, so it is hidden.
            if (rpCamMode == 1 && rpBots[rpFollow]) rpBots[rpFollow].gameObject.SetActive(false);
        }

        /// Distance along a ray (map units) to the first wall it enters, or `max` if none: the slab test per rectangle.
        float WallHit(float ox, float oy, Vector2 dir, float max)
        {
            float best = max;
            if (map == null) return best;
            foreach (var w in map.walls)
            {
                float t0 = 0f, t1 = best;
                if (!Slab(ox, dir.x, (float)w.x, (float)(w.x + w.w), ref t0, ref t1)) continue;
                if (!Slab(oy, dir.y, (float)w.y, (float)(w.y + w.h), ref t0, ref t1)) continue;
                if (t0 < best) best = t0;
            }
            return best;
        }

        static bool Slab(float o, float d, float lo, float hi, ref float t0, ref float t1)
        {
            if (Mathf.Abs(d) < 1e-6f) return o >= lo && o <= hi;
            float a = (lo - o) / d, b = (hi - o) / d;
            if (a > b) { var tmp = a; a = b; b = tmp; }
            t0 = Mathf.Max(t0, a);
            t1 = Mathf.Min(t1, b);
            return t0 <= t1;
        }

        // ================================================================ cameras

        static readonly string[] CamNames = { "THIRD PERSON", "POV", "FREE", "OVERHEAD" };
        int rpCamMode;
        Vector3 freePos;
        float freeYaw, freePitch = 20f;

        void CycleCamera()
        {
            rpCamMode = (rpCamMode + 1) % CamNames.Length;
            // The free camera starts wherever the camera is now, so switching never jumps the view.
            if (rpCamMode == 2)
            {
                freePos = cam.transform.position;
                var e = cam.transform.rotation.eulerAngles;
                freeYaw = e.y;
                freePitch = e.x > 180 ? e.x - 360 : e.x;
            }
            rpCam = Vector3.zero;
        }

        /// Behind and above the followed player, looking where they look, kept out of walls.
        void ThirdPersonCamera(double fx0, double fy0, double faim)
        {
        var target = W(fx0, fy0, 0);
        float yawDeg = YawFromAim(faim) + rpOrbit;
        var rot = Quaternion.Euler(0, yawDeg, 0);
        var want = target + rot * new Vector3(0.9f, 2.7f * rpZoom, -4.6f * rpZoom);
        // Keep the camera on the player's side of any wall behind them, so it never sits inside one.
        float pulled = 0f; // 0 when the camera sits where it wants to, towards 1 as a wall pulls it in
        var flat = new Vector2(want.x - target.x, -(want.z - target.z));
        float len = flat.magnitude;
        if (len > 0.01f)
        {
            float hit = WallHit((float)fx0, (float)fy0, flat / len, len);
            if (hit < len)
            {
                float keep = Mathf.Max(0.35f, hit - 0.35f) / len;
                pulled = 1f - keep;
                // Pulled in close, it rises, so it looks over the shoulder instead of into the player's back.
                want = new Vector3(target.x + (want.x - target.x) * keep, want.y + pulled * 0.7f, target.z + (want.z - target.z) * keep);
            }
        }
        rpCam = rpCam == Vector3.zero || (rpCam - want).sqrMagnitude > 100 ? want : Vector3.Lerp(rpCam, want, Chase(0.12f));
        var look = target + Vector3.up * 1.2f + rot * Vector3.forward * (2.5f + pulled * 4f);
        cam.transform.SetPositionAndRotation(rpCam, Quaternion.LookRotation(look - rpCam));
        }

        /// Their eyes and their aim: exactly what that player was looking at, cone and all.
        void PovCamera(double x, double y, double aim)
        {
            var eye = W(x, y, eyeHeight);
            cam.transform.SetPositionAndRotation(eye, Quaternion.Euler(0, YawFromAim(aim), 0));
        }

        /// Fly anywhere: WASD to move, Q and E for down and up, Shift for speed, right-drag to look.
        void FreeCamera(Keyboard kb, Mouse mouse)
        {
            if (mouse != null && mouse.rightButton.isPressed)
            {
                var d = mouse.delta.ReadValue() * 0.15f;
                freeYaw += d.x;
                freePitch = Mathf.Clamp(freePitch - d.y, -85f, 85f);
            }
            var rot = Quaternion.Euler(freePitch, freeYaw, 0);
            if (kb != null)
            {
                var move = Vector3.zero;
                if (kb.wKey.isPressed) move += rot * Vector3.forward;
                if (kb.sKey.isPressed) move -= rot * Vector3.forward;
                if (kb.dKey.isPressed) move += rot * Vector3.right;
                if (kb.aKey.isPressed) move -= rot * Vector3.right;
                if (kb.eKey.isPressed) move += Vector3.up;
                if (kb.qKey.isPressed) move -= Vector3.up;
                float speed = kb.shiftKey.isPressed ? 22f : 8f;
                freePos += move * speed * Time.unscaledDeltaTime;
                freePos.y = Mathf.Clamp(freePos.y, 0.4f, 60f);
            }
            cam.transform.SetPositionAndRotation(freePos, rot);
        }

        /// The whole map from above, north up, for reading positions and rotations.
        void OverheadCamera()
        {
            if (map == null) return;
            float span = (float)System.Math.Max(map.width, map.height);
            var center = W(map.width / 2, map.height / 2, 0);
            var want = center + new Vector3(0, span * 0.95f, -span * 0.12f);
            rpCam = rpCam == Vector3.zero ? want : Vector3.Lerp(rpCam, want, Chase(0.2f));
            cam.transform.SetPositionAndRotation(rpCam, Quaternion.LookRotation(center - rpCam, Vector3.forward));
        }

        void ReplayEvent(object e)
        {
            int who = (int)Json.Num(e, "slot", -1);
            switch (Json.Str(e, "type"))
            {
                case "shot":
                {
                    var from = W(Json.Num(e, "x"), Json.Num(e, "y"), 1.35f);
                    var to = W(Json.Num(e, "toX"), Json.Num(e, "toY"), 1.3f);
                    bool hit = Json.Bool(e, "hit"), head = Json.Bool(e, "head");
                    fx.Tracer(from, to, Bullet, 0.014f);
                    fx.Muzzle(from, Bullet);
                    if (hit) fx.Sparks(to, head ? Gfx.Gold : Gfx.Rec, 10, 4f);
                    if (who == rpFollow) { voice.pitch = 1f; voice.PlayOneShot(shotClip, 0.35f); }
                    else AudioSource.PlayClipAtPoint(shotClip, from, 0.6f);
                    break;
                }
                case "kill":
                {
                    int victim = (int)Json.Num(e, "victim");
                    if (rpBots != null && victim >= 0 && victim < 2 && rpBots[victim]) fx.Burst(rpBots[victim].position, victim == rpFollow ? Gfx.Ally : Gfx.Enemy);
                    voice.PlayOneShot(killClip, 0.6f);
                    bool head = Json.Bool(e, "head");
                    Banner(victim == rpFollow ? rpNames[rpFollow].ToUpperInvariant() + " IS DOWN" : (head ? "HEADSHOT" : "ELIMINATED"),
                        rpNames[(int)Json.Num(e, "killer")] + " → " + rpNames[victim], victim == rpFollow ? Gfx.Rec : Gfx.Ally, 1.4f);
                    break;
                }
                case "flashPop":
                    fx.FlashPop(W(Json.Num(e, "x"), Json.Num(e, "y"), 1.3f));
                    break;
                case "plant":
                    Banner("SPIKE PLANTED", "", Gfx.Rec, 1.6f);
                    break;
                case "roundStart":
                    Banner("ROUND " + (int)Json.Num(e, "round"), "", Gfx.Label, 1.4f);
                    break;
            }
        }

        // ================================================================ rounds and kills

        /// Kills are a moment worth seeing build up: jumping to one lands this many ticks before it.
        int KillLead => 3 * TickRate;

        List<object> Kills()
        {
            var list = new List<object>();
            foreach (var e in rpEvents) if (Json.Str(e, "type") == "kill") list.Add(e);
            return list;
        }

        void JumpRound(int dir)
        {
            if (rpRounds == null || rpRounds.Count == 0) return;
            int ri = RoundAt(rpTick);
            // Going back from inside a round first returns to its start, like a track skip.
            if (dir < 0 && rpTick - Json.Num(rpRounds[ri], "startTick") > TickRate) { SeekReplay((float)Json.Num(rpRounds[ri], "startTick")); return; }
            int to = Mathf.Clamp(ri + dir, 0, rpRounds.Count - 1);
            SeekReplay((float)Json.Num(rpRounds[to], "startTick"));
        }

        void JumpKill(int dir)
        {
            var kills = Kills();
            if (kills.Count == 0) return;
            // The kill whose lead-in we are in counts as the current one.
            float now = rpTick + KillLead;
            object pick = null;
            if (dir > 0) { foreach (var k in kills) if (Json.Num(k, "tick") > now + 1) { pick = k; break; } }
            else for (int i = kills.Count - 1; i >= 0; i--) if (Json.Num(kills[i], "tick") < now - 1) { pick = kills[i]; break; }
            if (pick != null) SeekReplay((float)Json.Num(pick, "tick") - KillLead);
        }

        /// The round a kill belongs to. A kill that ends a round lands on its last tick, which RoundAt
        /// already counts as the next round, so look one tick earlier.
        int KillRound(object kill) => RoundAt((float)Json.Num(kill, "tick") - 1);

        static string HowRoundEnded(string reason, bool won)
        {
            switch (reason)
            {
                case "kill": return won ? "eliminated them" : "eliminated";
                case "time": return "time ran out";
                case "defuse": return "spike defused";
                case "detonation": return "spike detonated";
                default: return "in progress";
            }
        }

        /// The right-hand column: every round, and the kills of the one being watched, all clickable.
        void DrawRoundList(float w, float h)
        {
            if (rpRounds == null || rpRounds.Count == 0) return;
            int me = rpFollow, cur = RoundAt(rpTick);
            float pw = 320 * S, x = w - pw - 16 * S, y = 88 * S, bottom = h - 230 * S;
            var kills = Kills();
            int curKills = 0;
            foreach (var k in kills) if (KillRound(k) == cur) curKills++;
            float rowH = 34 * S, killH = 26 * S;
            float ph = Mathf.Min(bottom - y, 34 * S + rpRounds.Count * (rowH + 3 * S) + curKills * killH + 8 * S);
            var panel = new Rect(x, y, pw, ph);
            Panel(panel, new Color(0.04f, 0.045f, 0.06f, 0.84f));
            Text(new Rect(x + 14 * S, y + 8 * S, pw, 18 * S), "ROUNDS", St(12, true, TextAnchor.UpperLeft, true), Gfx.Label, false);
            Text(new Rect(x, y + 8 * S, pw - 14 * S, 18 * S), "[ ]  , .", St(10, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.4f), false);
            float ry = y + 32 * S;
            var ev = Event.current;
            for (int i = 0; i < rpRounds.Count && ry + rowH <= panel.yMax; i++)
            {
                var r = rpRounds[i];
                bool done = !Json.IsNull(r, "winner");
                bool won = done && (int)Json.Num(r, "winner") == me;
                var row = new Rect(x + 8 * S, ry, pw - 16 * S, rowH);
                bool hover = row.Contains(ev.mousePosition);
                Fill(row, i == cur ? new Color(1, 1, 1, 0.12f) : hover ? new Color(1, 1, 1, 0.07f) : new Color(0, 0, 0, 0));
                Color c = !done ? new Color(1, 1, 1, 0.4f) : won ? Gfx.Ally : Gfx.Enemy;
                Fill(new Rect(row.x, row.y + 4 * S, 4 * S, row.height - 8 * S), c);
                Text(new Rect(row.x + 12 * S, row.y, 30 * S, row.height), (i + 1).ToString(), St(16, true, TextAnchor.MiddleLeft, true), Gfx.Label, false);
                Text(new Rect(row.x + 40 * S, row.y, 70 * S, row.height), !done ? "—" : won ? "WON" : "LOST", St(12, true, TextAnchor.MiddleLeft, true), c, false);
                Text(new Rect(row.x + 92 * S, row.y, 150 * S, row.height), HowRoundEnded(Json.Str(r, "reason"), won), St(11, false, TextAnchor.MiddleLeft), new Color(1, 1, 1, 0.7f), false);
                double len = Json.Num(r, "endTick") - Json.Num(r, "startTick");
                Text(new Rect(row.x, row.y, row.width - 8 * S, row.height), Clock((float)len), St(11, true, TextAnchor.MiddleRight, true), new Color(1, 1, 1, 0.55f), false);
                if (ev.type == EventType.MouseDown && ev.button == 0 && hover) { ev.Use(); SeekReplay((float)Json.Num(r, "startTick")); }
                ry += rowH + 3 * S;

                if (i != cur) continue;
                // The watched round's kills, each a jump to just before it happened.
                foreach (var k in kills)
                {
                    float kt = (float)Json.Num(k, "tick");
                    if (KillRound(k) != cur || ry + killH > panel.yMax) continue;
                    int killer = (int)Json.Num(k, "killer"), victim = (int)Json.Num(k, "victim");
                    bool mine = killer == me;
                    var kr = new Rect(x + 24 * S, ry, pw - 40 * S, killH);
                    bool kh = kr.Contains(ev.mousePosition);
                    if (kh) Fill(kr, new Color(1, 1, 1, 0.07f));
                    bool past = rpTick >= kt;
                    float alpha = past ? 1f : 0.55f;
                    string gun = catalog?.WeaponName((int)Json.Num(k, "weapon", 0)) ?? "";
                    Text(new Rect(kr.x + 4 * S, kr.y, 50 * S, kr.height), Clock(kt - (float)Json.Num(rpRounds[cur], "startTick")), St(10, true, TextAnchor.MiddleLeft, true), new Color(1, 1, 1, 0.5f * alpha), false);
                    Text(new Rect(kr.x + 46 * S, kr.y, kr.width - 46 * S, kr.height),
                        rpNames[killer] + "  ›  " + rpNames[victim] + "   " + gun + (Json.Bool(k, "head") ? "  · head" : ""),
                        St(11, true, TextAnchor.MiddleLeft), mine ? new Color(Gfx.Ally.r, Gfx.Ally.g, Gfx.Ally.b, alpha) : new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, alpha), false);
                    if (ev.type == EventType.MouseDown && ev.button == 0 && kh) { ev.Use(); SeekReplay(kt - KillLead); }
                    ry += killH;
                }
            }
        }

        // ================================================================ taking control

        /// Opens a rewind on the server at the current moment, as the followed player.
        void TakeControl()
        {
            if (rpDetail == null || rpRounds == null || rpRounds.Count == 0) return;
            if (playerName.Trim() == "") { status = "Enter your name in the lobby first."; return; }
            int ri = RoundAt(rpTick);
            if (ri < 0) return;
            var round = rpRounds[ri];
            int start = (int)Json.Num(round, "startTick"), end = (int)Json.Num(round, "endTick");
            // The fork has to land inside a live round, and not on its very last tick.
            int tick = Mathf.Clamp(Mathf.RoundToInt(rpTick), start + 1, Mathf.Max(start + 1, end - 2));
            rpReturnId = rpId;
            rpReturnTick = tick;
            ClearReplayActors();
            Connect("{\"t\":\"join\",\"mode\":\"rewind\",\"name\":" + Json.Quote(playerName.Trim()) + ",\"match\":" + Json.Quote(rpId) +
                    ",\"tick\":" + tick + ",\"slot\":" + rpFollow + "}");
            status = "Taking control at " + Clock(tick) + "…";
        }

        void LeaveReplay()
        {
            ClearReplayActors();
            rpDetail = null;
            rpFrames = null;
            LeaveToLobby();
        }

        string Clock(float tick)
        {
            int s = Mathf.Max(0, (int)(tick / TickRate));
            return (s / 60) + ":" + (s % 60).ToString("00");
        }

        // ================================================================ the replay screen

        void DrawReplay(float w, float h)
        {
            if (rpDetail == null) return;
            var fr = FrameAt(rpTick);
            int ri = RoundAt(rpTick);
            var sc = ScoreAt(rpTick);
            int me = rpFollow, them = 1 - rpFollow;
            string mapName = map?.name ?? Json.Str(rpDetail, "map");

            // Top: what you are watching.
            float bw = 640 * S, bx = w / 2 - bw / 2, by = 14 * S;
            Panel(new Rect(bx, by, bw, 58 * S), new Color(0.04f, 0.045f, 0.06f, 0.82f));
            Fill(new Rect(bx + 16 * S, by + 54 * S, bw / 2 - 30 * S, 3 * S), Gfx.Ally);
            Fill(new Rect(w / 2 + 14 * S, by + 54 * S, bw / 2 - 30 * S, 3 * S), Gfx.Enemy);
            Text(new Rect(bx + 10 * S, by, 70 * S, 54 * S), sc[me].ToString(), St(40, true, TextAnchor.MiddleCenter, true), Gfx.Ally);
            Text(new Rect(bx + 74 * S, by + 4 * S, 200 * S, 24 * S), rpNames[me].ToUpperInvariant(), St(14, true, TextAnchor.MiddleLeft, true), Gfx.Label);
            Text(new Rect(bx + 74 * S, by + 26 * S, 200 * S, 20 * S), "HP " + (int)fr[4 + me * 5], St(11, true, TextAnchor.MiddleLeft), fr[4 + me * 5] > 0 ? Gfx.Ally : Gfx.Rec);
            Text(new Rect(bx + bw - 274 * S, by + 4 * S, 200 * S, 24 * S), rpNames[them].ToUpperInvariant(), St(14, true, TextAnchor.MiddleRight, true), Gfx.Label);
            Text(new Rect(bx + bw - 274 * S, by + 26 * S, 200 * S, 20 * S), "HP " + (int)fr[4 + them * 5], St(11, true, TextAnchor.MiddleRight), fr[4 + them * 5] > 0 ? Gfx.Enemy : Gfx.Rec);
            Text(new Rect(bx + bw - 80 * S, by, 70 * S, 54 * S), sc[them].ToString(), St(40, true, TextAnchor.MiddleCenter, true), Gfx.Enemy);
            Text(new Rect(w / 2 - 80 * S, by + 4 * S, 160 * S, 26 * S), "REPLAY", St(20, true, TextAnchor.MiddleCenter, true), Gfx.Label);
            Text(new Rect(w / 2 - 120 * S, by + 28 * S, 240 * S, 20 * S), mapName.ToUpperInvariant() + " · ROUND " + (ri + 1), St(11, true, TextAnchor.MiddleCenter), new Color(1, 1, 1, 0.6f));

            DrawBanner(w, h);

            DrawRoundList(w, h);
            DrawTacMap(w, h);

            // Bottom: the timeline of the whole match, then the controls.
            float pw = Mathf.Min(1180 * S, w - 40 * S), px = w / 2 - pw / 2, ph = 150 * S, py = h - ph - 18 * S;
            Panel(new Rect(px, py, pw, ph), new Color(0.04f, 0.045f, 0.06f, 0.86f));
            var bar = new Rect(px + 20 * S, py + 34 * S, pw - 40 * S, 22 * S);
            Text(new Rect(bar.x, py + 8 * S, bar.width, 20 * S), "HOW THE MATCH WENT  ·  rounds " + rpNames[me] + " won are teal, lost are red", St(10, true, TextAnchor.MiddleLeft, true), new Color(1, 1, 1, 0.6f), false);
            Text(new Rect(bar.x, py + 8 * S, bar.width, 20 * S), Clock(rpTick) + " / " + Clock(rpTicks), St(12, true, TextAnchor.MiddleRight, true), Gfx.Label, false);
            float X(double tick) => bar.x + (float)(tick / Math.Max(1, rpTicks)) * bar.width;

            Fill(bar, new Color(1, 1, 1, 0.06f));
            for (int i = 0; i < rpRounds.Count; i++)
            {
                var r = rpRounds[i];
                float x0 = X(Json.Num(r, "startTick")), x1 = X(Json.Num(r, "endTick"));
                Color c = Json.IsNull(r, "winner") ? new Color(1, 1, 1, 0.2f) : (int)Json.Num(r, "winner") == me ? Gfx.Ally : Gfx.Enemy;
                Fill(new Rect(x0 + 1, bar.y, Mathf.Max(1, x1 - x0 - 2), bar.height), new Color(c.r, c.g, c.b, i == ri ? 0.85f : 0.45f));
                if (x1 - x0 > 18 * S) Text(new Rect(x0, bar.y, x1 - x0, bar.height), (i + 1).ToString(), St(10, true, TextAnchor.MiddleCenter, true), Gfx.Ink, false);
                // Kills: a tick above the bar; deaths of the followed player in red.
                var kills = Json.Arr(r, "kills");
                if (kills != null)
                    foreach (var k in kills)
                    {
                        bool died = (int)Json.Num(k, "victim") == me;
                        float kx = X(Json.Num(k, "tick"));
                        Fill(new Rect(kx - 1.5f * S, bar.y - 9 * S, 3 * S, 7 * S), died ? Gfx.Rec : Gfx.Label);
                    }
            }
            foreach (var e in rpEvents)
                if (Json.Str(e, "type") == "plant") Fill(new Rect(X(Json.Num(e, "tick")) - 3 * S, bar.yMax + 3 * S, 6 * S, 6 * S), Gfx.Gold);
            // The playhead.
            float hx = X(rpTick);
            Fill(new Rect(hx - 1.5f * S, bar.y - 12 * S, 3 * S, bar.height + 24 * S), Color.white);

            // Click or drag anywhere on the strip to move through the match.
            var hit = new Rect(bar.x, bar.y - 14 * S, bar.width, bar.height + 28 * S);
            var ev = Event.current;
            if (ev.type == EventType.MouseDown && ev.button == 0 && hit.Contains(ev.mousePosition)) { rpScrubbing = true; ev.Use(); }
            if (rpScrubbing && bar.width > 0 && (ev.type == EventType.MouseDrag || ev.type == EventType.MouseDown || ev.type == EventType.Repaint))
                SeekReplay(Mathf.Clamp01((ev.mousePosition.x - bar.x) / bar.width) * Mathf.Max(0, rpTicks - 1));
            if (ev.rawType == EventType.MouseUp) rpScrubbing = false;

            // Controls.
            float cy = py + ph - 52 * S, cx = px + 20 * S;
            if (Chip(new Rect(cx, cy, 110 * S, 36 * S), rpPlaying ? "PAUSE" : "PLAY", rpPlaying, Gfx.Label)) rpPlaying = !rpPlaying;
            cx += 118 * S;
            if (Chip(new Rect(cx, cy, 80 * S, 36 * S), rpSpeed.ToString("0.##", CultureInfo.InvariantCulture) + "×", false, Gfx.Label)) rpSpeed = rpSpeed >= 8f ? 0.5f : rpSpeed * 2f;
            cx += 88 * S;
            if (Chip(new Rect(cx, cy, 230 * S, 36 * S), "WATCHING " + rpNames[me].ToUpperInvariant() + " · TAB", false, Gfx.Ally)) { rpFollow = 1 - rpFollow; ColourReplayBots(); }
            cx += 238 * S;
            if (Chip(new Rect(cx, cy, 190 * S, 36 * S), CamNames[rpCamMode] + " · V", false, Gfx.Label)) CycleCamera();
            cx += 198 * S;
            if (Chip(new Rect(cx, cy, 110 * S, 36 * S), "LOBBY", false, Gfx.Label)) { LeaveReplay(); return; }

            var go = new Rect(px + pw - 340 * S, cy - 6 * S, 320 * S, 46 * S);
            bool hover = go.Contains(ev.mousePosition);
            Panel(go, hover ? new Color(1f, 0.45f, 0.42f) : Gfx.Rec);
            Text(go, "TAKE CONTROL AS " + rpNames[me].ToUpperInvariant(), St(17, true, TextAnchor.MiddleCenter, true), Color.white, false);
            if (ev.type == EventType.MouseDown && hover) { ev.Use(); TakeControl(); return; }

            Text(new Rect(px, py - 46 * S, pw, 40 * S),
                "Take control and you play from this exact moment. " + rpNames[them] + " repeats what really happened until you change it, then the AI takes over.",
                St(13, false, TextAnchor.LowerCenter, false, true), new Color(1, 1, 1, 0.85f));
            Text(new Rect(16 * S, h - 22 * S, w - 32 * S, 18 * S), "Space play/pause · ← → 3 s · ↑ ↓ speed · [ ] round · , . kill · Tab switch player · V camera · M map · right-drag orbit or look · WASD QE free camera · scroll zoom · Enter take control · Esc lobby",
                St(10, false, TextAnchor.MiddleLeft), new Color(1, 1, 1, 0.45f), false);
            if (!string.IsNullOrEmpty(status)) Text(new Rect(0, py - 72 * S, w, 22 * S), status, St(13, true, TextAnchor.MiddleCenter), Gfx.Rec);
        }
    }
}
