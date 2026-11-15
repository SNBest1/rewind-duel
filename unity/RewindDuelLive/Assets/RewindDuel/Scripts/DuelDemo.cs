#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;

// Editor only: records the footage for the demo video. Started from a script eval (DemoRun); it plays a scripted
// tour of the real replay features against the running server and saves every frame, as it is drawn (3D view and
// IMGUI HUD), to JPGs with the real time of each frame, plus scene markers. scripts/demo-video.py cuts and narrates it.
// Nothing here is compiled into a build.

namespace RewindDuel
{
    public partial class DuelClient
    {
        string demoDir;
        bool demoRecording;
        int demoFrame, demoPending;
        readonly List<string> demoLog = new List<string>();
        RenderTexture demoFull, demoOut;
        /// While set, rewrites the live input before it is sent: the director plays the "take control" scene with it.
        Func<InputMsg, InputMsg> demoDrive;

        void DemoRun(string dir, string matchId, string attemptsMatch) => StartCoroutine(DemoShow(dir, matchId, attemptsMatch));

        void DemoMark(string name)
        {
            lock (demoLog) demoLog.Add("# " + name + " " + Time.realtimeSinceStartupAsDouble.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
            Debug.Log("[demo] " + name);
        }

        IEnumerator DemoCapture()
        {
            var eof = new WaitForEndOfFrame();
            while (demoRecording)
            {
                yield return eof;
                int w = UnityEngine.Screen.width, h = UnityEngine.Screen.height;
                if (demoFull == null || demoFull.width != w || demoFull.height != h)
                {
                    if (demoFull) demoFull.Release();
                    demoFull = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32);
                }
                if (demoOut == null) demoOut = new RenderTexture(1920, 1080, 0, RenderTextureFormat.ARGB32);
                ScreenCapture.CaptureScreenshotIntoRenderTexture(demoFull);
                // Centre-crop to 16:9, flipped: the capture comes back upside down.
                float aspect = (float)w / h, sx = 1f, sy = 1f;
                if (aspect < 16f / 9f) sy = aspect / (16f / 9f); else sx = (16f / 9f) / aspect;
                Graphics.Blit(demoFull, demoOut, new Vector2(sx, -sy), new Vector2((1 - sx) / 2, 1 - (1 - sy) / 2));
                int idx = demoFrame++;
                double t = Time.realtimeSinceStartupAsDouble;
                lock (demoLog) demoLog.Add(idx + " " + t.ToString("F4", System.Globalization.CultureInfo.InvariantCulture));
                Interlocked.Increment(ref demoPending);
                string path = Path.Combine(demoDir, "f" + idx.ToString("D6") + ".jpg");
                AsyncGPUReadback.Request(demoOut, 0, TextureFormat.RGBA32, req =>
                {
                    if (req.hasError) { Interlocked.Decrement(ref demoPending); return; }
                    var data = req.GetData<byte>().ToArray();
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        var jpg = ImageConversion.EncodeArrayToJPG(data, GraphicsFormat.R8G8B8A8_SRGB, 1920, 1080, 0, 92);
                        File.WriteAllBytes(path, jpg);
                        Interlocked.Decrement(ref demoPending);
                    });
                });
            }
        }

        IEnumerator Wait(float s) { yield return new WaitForSecondsRealtime(s); }

        /// Plays the replay in real time for `s` seconds.
        IEnumerator Play(float s) { rpPlaying = true; rpSpeed = 1f; yield return Wait(s); }

        IEnumerator DemoShow(string dir, string matchId, string attemptsMatch)
        {
            demoDir = dir;
            Directory.CreateDirectory(dir);
            demoFrame = 0;
            lock (demoLog) demoLog.Clear();
            AudioListener.volume = 0;
            showTrace = true;
            playerName = "nipun"; // take control as the recorded player

            yield return OpenReplay(matchId, 0, 0);
            if (rpRounds == null || rpRounds.Count < 4) { Debug.LogError("[demo] the match did not open"); yield break; }
            rpCamMode = 0;
            rpCoachOpen = false;
            rpFog = false;
            rpTacMap = true;
            float r3end = (float)Json.Num(rpRounds[2], "endTick"), r4end = (float)Json.Num(rpRounds[3], "endTick");
            // Round 3 is the one nipun lost: the story. Contact is about 2 s before his death.
            float fork = r3end - 2.4f * TickRate;
            rpFollow = 0;
            ColourReplayBots();

            demoRecording = true;
            StartCoroutine(DemoCapture());

            // 1. The replay: a round playing, the round list, timeline, map and stats around it.
            SeekReplay(r4end - 13 * TickRate);
            DemoMark("replay");
            yield return Play(7f);

            // 2. Cameras: their eyes, a free camera flying round the fight, the whole map from above.
            DemoMark("cameras");
            SeekReplay(r4end - 4.5f * TickRate);
            rpPlaying = false;
            CycleCamera(); // POV
            yield return Play(2.6f);
            rpPlaying = false;
            CycleCamera(); // free
            SetFreeLook(false);
            for (float t = 0; t < 3.2f; t += Time.unscaledDeltaTime)
            {
                var fr = FrameAt(rpTick);
                var target = W(fr[1], fr[2], 1f);
                freePos = target + Quaternion.Euler(0, 220f + t * 22f, 0) * new Vector3(0, 6.5f, -9f);
                var look = Quaternion.LookRotation(target - freePos).eulerAngles;
                freeYaw = look.y;
                freePitch = look.x > 180 ? look.x - 360 : look.x;
                yield return null;
            }
            CycleCamera(); // overhead
            SetFreeLook(false);
            yield return Play(3f);
            CycleCamera(); // back to third person
            SetFreeLook(false);

            // 3. What they saw: the rival exists only while nipun could see him.
            DemoMark("fog");
            SeekReplay(r4end - 3.8f * TickRate);
            rpFog = true;
            yield return Play(4.5f);
            rpFog = false;

            // 4. Round 3: nipun loses the duel.
            DemoMark("loss");
            SeekReplay(r3end - 3.4f * TickRate);
            yield return Play(4.4f);

            // 5. The coach, from just before that fight: what would have won it?
            DemoMark("coach");
            SeekReplay(fork);
            rpPlaying = false;
            rpCoachOpen = true;
            yield return Wait(1.2f);
            AskCoach();
            float until = Time.realtimeSinceStartup + 30f;
            while (coachState == "asking" && Time.realtimeSinceStartup < until) yield return null;
            yield return Wait(2.4f);
            DemoMark("plan");
            if (coachState == "done") PickPlan(1);
            yield return Wait(4.5f);
            if (coachState == "done") PickPlan(1); // back to what happened
            rpCoachOpen = false;

            // 6. Take control at that moment. Tries until an attempt wins (each try is a marked take; the edit keeps the win).
            demoDrive = input =>
            {
                var self = Json.Obj(obs, "self");
                var e = Json.Obj(obs, "enemy");
                if (self == null) return input;
                if (e == null)
                {
                    // Before contact: walk nipun's recorded path and look where he looked, so the fight still happens.
                    float tick = (float)Json.Num(obs, "tick");
                    var rec = RealFrameAt(tick + 3);
                    double dx = rec[1] - Json.Num(self, "x"), dy = rec[2] - Json.Num(self, "y");
                    double len = Math.Sqrt(dx * dx + dy * dy);
                    if (len > 0.2)
                    {
                        double a = Math.Round(Math.Atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
                        input.mx = (int)Math.Round(Math.Cos(a));
                        input.my = (int)Math.Round(Math.Sin(a));
                    }
                    else { input.mx = 0; input.my = 0; }
                    yaw = Mathf.MoveTowardsAngle(yaw, YawFromAim(rec[3]), 10f);
                    input.aim = AimFromYaw(yaw);
                    return input;
                }
                double aim = Math.Atan2(Json.Num(e, "y") - Json.Num(self, "y"), Json.Num(e, "x") - Json.Num(self, "x"));
                float want = YawFromAim(aim);
                yaw = Mathf.MoveTowardsAngle(yaw, want, 14f);
                input.aim = AimFromYaw(yaw);
                input.fire = Mathf.Abs(Mathf.DeltaAngle(yaw, want)) < 3f;
                return input;
            };
            bool wonOne = false;
            for (int attempt = 1; attempt <= 4 && !wonOne; attempt++)
            {
                if (view != View.Replay) { yield return OpenReplay(matchId, (int)fork, 0); }
                SeekReplay(fork);
                rpPlaying = false;
                DemoMark("control-" + attempt);
                yield return Wait(1.2f);
                TakeControl();
                until = Time.realtimeSinceStartup + 10f;
                while (view != View.Playing && Time.realtimeSinceStartup < until) yield return null;
                DemoMark("live-" + attempt);
                until = Time.realtimeSinceStartup + 16f;
                while (view == View.Playing && Time.realtimeSinceStartup < until) yield return null;
                wonOne = view == View.Ended && Json.Str(endRewind, "outcome") == "won";
                DemoMark((wonOne ? "won-" : "lost-") + attempt);
                yield return Wait(4f);
                net?.Dispose();
                net = null;
                obs = null;
                yield return OpenReplay(matchId, (int)fork, 0);
                rpPlaying = false;
            }
            demoDrive = null;

            // 7. Back in the replay, the attempts are on the timeline: watch the last one.
            DemoMark("attempts");
            yield return Wait(2.2f);
            int n = rpBranches?.Count ?? 0;
            if (n > 0)
            {
                WatchAttempt(n);
                yield return Wait(1.5f);
                yield return Play(5f);
            }
            DemoMark("end");
            yield return Wait(0.5f);

            demoRecording = false;
            until = Time.realtimeSinceStartup + 20f;
            while (demoPending > 0 && Time.realtimeSinceStartup < until) yield return null;
            lock (demoLog) File.WriteAllLines(Path.Combine(dir, "frames.txt"), demoLog);
            AudioListener.volume = 1;
            Debug.Log("[demo] done: " + demoFrame + " frames");
        }
    }
}
#endif
