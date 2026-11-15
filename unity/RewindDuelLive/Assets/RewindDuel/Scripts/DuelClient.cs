using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Networking;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

// Rewind Duel, first person. A live client of the Node server, like the browser client: it sends one Input per
// tick and draws only the Observation the server sends back. It never runs the game, so every match played
// here is recorded and works with replays, rewinds, the AI's memory and the evals (Rewind DECISIONS D49).
//
// This file is the client: lobby state, the socket, input, prediction and the 3D actors. DuelHud.cs draws the
// 2D layer. Arena.cs builds the map, Fx.cs the effects, Gfx.cs the procedural textures, sky and sounds.
// Map (x, y) is world (x, -y). Aim is the camera yaw; pitch is cosmetic (shots travel in the 2D plane).

namespace RewindDuel
{
    public partial class DuelClient : MonoBehaviour
    {
        [Header("Template art and sound (wired by DuelSceneBuilder)")]
        public GameObject weaponPrefab;
        public GameObject enemyPrefab;
        public Material floorMat, wallMat, siteMat;
        public AudioClip shotClip, hitClip, hurtClip, killClip, roundStartClip, roundEndClip, dashClip, smokeClip, plantClip;
        [Tooltip("Materials saved as assets so their shaders survive a standalone build.")]
        public Material[] shaderKeepers;

        [Header("Feel")]
        public float mouseDegPerPixel = 0.09f;
        public float eyeHeight = 1.6f;

        const float SmokeRadius = 2.5f, DefuseRange = 1.5f;
        const int PlantTicks = 64, DefuseTicks = 128, FlashBlindFull = 72;

        enum View { Lobby, Connecting, Playing, Ended, Replay }
        View view = View.Lobby;

        // ---- lobby
        string serverUrl = "ws://localhost:8080", playerName = "", roomCode = "", status = "";
        int mode; // 0 vs AI, 1 vs yourself (mirror), 2 vs a friend, 3 rewind a recorded round
        static readonly string[] ModeNames = { "VS AI", "VS YOURSELF", "VS FRIEND", "REPLAYS" };
        string mapVote = "random";
        string difficulty = "adaptive";
        int rankPick = -1; // -1: use `difficulty`; otherwise play a fixed rank
        Catalog catalog;
        string catalogError;
        bool catalogLoading;
        readonly List<object> replays = new List<object>();
        bool replaysLoading;

        // ---- match
        Net net;
        int slot;
        string[] names = { "you", "rival" };
        MapDef map;
        Arena arena;
        Fx fx;
        Dictionary<string, object> obs;
        readonly Predictor predictor = new Predictor();
        string endMatchId, endWhy;
        object endRewind; // the server's verdict on a rewind attempt: outcome, attempts and wins from this moment, handoff
        object endBrain;
        int coachCount;
        object coachData;
        int lastRoundWinner = -1;
        string lastRoundReason = "";
        object aiInfo, rewindInfo;
        int? aiLevel;
        object ranks;
        int lastYouRank = -1, lastAiRank = -1;
        byte[] mindBytes;
        int mindCols, mindRows;
        Texture2D mindMini;
        bool showMind, showTrace = true, buyOpen = true, studio;
        // Studio counters and the AI's best guess of your position (map units).
        int inputsSent, obsCount, eventCount;
        Vector2 mindGuess;
        readonly List<object> trace = new List<object>();

        // ---- local view
        float yaw, pitch, sendClock;
        bool pressedDash, pressedSmoke, pressedReload, pressedFlash;
        int pendingBuy = -1, pendingEquip = -1;
        Vector3 selfDraw, enemyDraw;
        bool enemyDrawValid;
        float hurtFlash, hitFlash, recoil, warpFlash, killFlash, blindFade;
        float lastHeardAt;
        Vector2 lastHeard = new Vector2(-99, -99);

        // ---- world actors
        Transform world, weapon, muzzle, enemy, ghost, spike;
        Light spikeLight, enemyLight;
        Material ghostMat;
        int shownWeapon = int.MinValue;
        Camera cam;
        AudioSource voice;
        int weaponLayer = -1;
        Volume volume;
        ColorAdjustments grade;
        ChromaticAberration aberration;
        Vignette vignette;
        float lobbyOrbit;
        int lobbyMapIndex;
        float lobbyMapSince;

        static Vector3 W(double x, double y, float h) => Arena.W(x, y, h);
        static float YawFromAim(double a) => (float)(Math.Atan2(Math.Cos(a), -Math.Sin(a)) * Mathf.Rad2Deg);
        static double AimFromYaw(float yawDeg) { double t = yawDeg * Mathf.Deg2Rad; return Math.Atan2(-Math.Cos(t), Math.Sin(t)); }
        int TickRate => catalog?.tickRate ?? 32;

        // ================================================================ setup

        void Awake()
        {
            Gfx.Init(shaderKeepers);
            playerName = PlayerPrefs.GetString("rd-name", "");
            serverUrl = PlayerPrefs.GetString("rd-server", serverUrl);
#if UNITY_WEBGL && !UNITY_EDITOR
            // In the browser, play on the server that served this page (the tunnel link, or localhost).
            serverUrl = NetUrl.PageServer(Application.absoluteURL) ?? serverUrl;
#endif
            mode = PlayerPrefs.GetInt("rd-mode", 0);
            cam = Camera.main;
            if (!cam)
            {
                cam = new GameObject("Main Camera").AddComponent<Camera>();
                cam.tag = "MainCamera";
                cam.gameObject.AddComponent<AudioListener>();
            }
            cam.nearClipPlane = 0.03f;
            cam.farClipPlane = 300f;
            cam.allowHDR = true;
            var camData = cam.GetUniversalAdditionalCameraData();
            camData.renderPostProcessing = true;
            camData.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            camData.antialiasingQuality = AntialiasingQuality.High;

            // The weapon is drawn by an overlay camera on the FirstPersonWeapon layer, so it never sinks into a wall.
            weaponLayer = LayerMask.NameToLayer("FirstPersonWeapon");
            if (weaponLayer >= 0)
            {
                cam.cullingMask &= ~(1 << weaponLayer);
                var wc = new GameObject("WeaponCamera").AddComponent<Camera>();
                wc.transform.SetParent(cam.transform, false);
                wc.cullingMask = 1 << weaponLayer;
                wc.fieldOfView = 60;
                wc.nearClipPlane = 0.01f;
                wc.GetUniversalAdditionalCameraData().renderType = CameraRenderType.Overlay;
                camData.cameraStack.Add(wc);
            }
            voice = cam.gameObject.AddComponent<AudioSource>();
            voice.spatialBlend = 0;
            SetupStage();
            SetFov();
            world = new GameObject("World").transform;
            fx = new Fx(world);
            StartCoroutine(LoadCatalog());
        }

        /// Sky, sun and a restrained post stack: a sunlit tactical arena. Bloom only catches real highlights
        /// (muzzle flashes, flash pops); colour stays natural so the enemy's red and your teal stay readable.
        void SetupStage()
        {
            RenderSettings.skybox = Gfx.SkyMaterial();
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.74f, 0.8f, 0.9f);
            RenderSettings.ambientEquatorColor = new Color(0.66f, 0.62f, 0.56f);
            RenderSettings.ambientGroundColor = new Color(0.4f, 0.36f, 0.32f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogStartDistance = 40f;
            RenderSettings.fogEndDistance = 160f;
            RenderSettings.fogColor = new Color(0.74f, 0.78f, 0.84f);
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;

            foreach (var l in FindObjectsByType<Light>())
                if (l.type == LightType.Directional)
                {
                    l.color = new Color(1f, 0.94f, 0.84f);
                    l.intensity = 1.55f;
                    l.shadows = LightShadows.Soft;
                    l.shadowStrength = 0.75f;
                    l.transform.rotation = Quaternion.Euler(47, -38, 0);
                    RenderSettings.sun = l;
                }

            var go = new GameObject("PostFX");
            volume = go.AddComponent<Volume>();
            volume.isGlobal = true;
            volume.priority = 10;
            var p = ScriptableObject.CreateInstance<VolumeProfile>();
            var bloom = p.Add<Bloom>(true);
            bloom.threshold.value = 1.15f;
            bloom.intensity.value = 0.35f;
            bloom.scatter.value = 0.6f;
            var tone = p.Add<Tonemapping>(true);
            tone.mode.value = TonemappingMode.ACES;
            grade = p.Add<ColorAdjustments>(true);
            grade.postExposure.value = 0.15f;
            grade.contrast.value = 10f;
            grade.saturation.value = BaseSaturation;
            vignette = p.Add<Vignette>(true);
            vignette.intensity.value = BaseVignette;
            vignette.smoothness.value = 0.4f;
            vignette.color.value = Color.black;
            aberration = p.Add<ChromaticAberration>(true);
            aberration.intensity.value = 0f;
            var ao = p.Add<ShadowsMidtonesHighlights>(true);
            ao.shadows.value = new Vector4(0.96f, 0.98f, 1.06f, 0);
            volume.sharedProfile = p;
        }

        const float BaseSaturation = 6f, BaseVignette = 0.2f;
        static readonly Color Bullet = new Color(1f, 0.86f, 0.62f);

        /// The engine's vision cone is 100 degrees wide, so the horizontal field of view matches it:
        /// the rival shows up on screen exactly when the server says you can see them.
        void SetFov()
        {
            float aspect = Mathf.Max(1f, (float)UnityEngine.Screen.width / Mathf.Max(1, UnityEngine.Screen.height));
            cam.fieldOfView = Camera.HorizontalToVerticalFieldOfView(100f, aspect);
        }

        void OnDestroy()
        {
            net?.Dispose();
            // The HUD's OS fonts would otherwise outlive play mode (this project skips the domain reload).
            if (ownFonts && display) Destroy(display);
            if (ownFonts && body) Destroy(body);
        }
        void OnDisable() => net?.Dispose();

#if UNITY_EDITOR
        // This project enters play mode without a domain reload, so the socket must be closed before scripts reload.
        void OnEnable() => UnityEditor.AssemblyReloadEvents.beforeAssemblyReload += CloseNet;
        void CloseNet()
        {
            UnityEditor.AssemblyReloadEvents.beforeAssemblyReload -= CloseNet;
            net?.Dispose();
        }
#endif

        // ================================================================ http: catalog and replays

        string HttpBase()
        {
            try
            {
                var u = Net.ToWsUri(serverUrl);
                return (u.Scheme == "wss" ? "https://" : "http://") + u.Authority;
            }
            catch { return null; }
        }

        IEnumerator Get(string path, Action<object> ok, Action<string> fail)
        {
            var b = HttpBase();
            if (b == null) { fail("That server address is not a URL."); yield break; }
            using (var req = UnityWebRequest.Get(b + path))
            {
                req.timeout = 6;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success) { fail(req.error); yield break; }
                object parsed;
                try { parsed = Json.Parse(req.downloadHandler.text); }
                catch (Exception e) { fail("Bad reply from the server: " + e.Message); yield break; }
                ok(parsed);
            }
        }

        IEnumerator LoadCatalog()
        {
            if (catalogLoading) yield break;
            catalogLoading = true;
            catalogError = null;
            yield return Get("/api/catalog", o =>
            {
                try { catalog = Catalog.Parse(o); }
                catch (Exception e) { catalogError = "The server's catalog could not be read (" + e.Message + ")."; }
            }, e => catalogError = "Could not reach the server at " + HttpBase() + " (" + e + "). Start it with: npm run server");
            catalogLoading = false;
            if (catalog != null && view == View.Lobby) ShowLobbyMap();
        }

        IEnumerator LoadReplays()
        {
            if (replaysLoading) yield break;
            replaysLoading = true;
            yield return Get("/api/viewer/matches", o =>
            {
                replays.Clear();
                if (o is List<object> l) for (int i = 0; i < l.Count && replays.Count < 12; i++) replays.Add(l[i]);
            }, e => status = "Could not load recordings: " + e);
            replaysLoading = false;
        }

        IEnumerator PollCoach(string matchId)
        {
            for (int i = 0; i < 120 && view == View.Ended && endMatchId == matchId; i++)
            {
                bool done = false;
                yield return Get("/api/coach/" + matchId, o =>
                {
                    coachData = o;
                    var items = Json.Arr(o, "items");
                    done = items != null && items.TrueForAll(it => { var s = Json.Str(it, "status"); return s == "done" || s == "error"; });
                }, _ => { });
                if (done) yield break;
                yield return new WaitForSeconds(1.5f);
            }
        }

        // ================================================================ lobby world

        /// Behind the lobby: the selected map (or each map in turn, for Random), slowly orbiting.
        void ShowLobbyMap()
        {
            if (catalog == null || catalog.maps.Count == 0) return;
            var m = mapVote == "random" ? catalog.maps[lobbyMapIndex % catalog.maps.Count] : catalog.Map(mapVote) ?? catalog.maps[0];
            if (arena != null && arena.map.id == m.id) return;
            BuildArena(m);
            lobbyMapSince = Time.time;
        }

        void BuildArena(MapDef m)
        {
            arena?.Destroy();
            fx.Clear();
            DestroyActors();
            map = m;
            predictor.Map = m;
            arena = new Arena(m, world);
            BuildActors();
        }

        void LobbyCamera()
        {
            if (map == null) return;
            lobbyOrbit += Time.deltaTime * 6f;
            var center = W(map.width / 2, map.height / 2, 0);
            float r = (float)Math.Max(map.width, map.height) * 0.62f;
            var pos = center + Quaternion.Euler(0, lobbyOrbit, 0) * new Vector3(0, 0, -r) + Vector3.up * r * 0.55f;
            cam.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(center + Vector3.up * 1.5f - pos));
            if (mapVote == "random" && Time.time - lobbyMapSince > 9f) { lobbyMapIndex++; ShowLobbyMap(); }
        }

        // ================================================================ joining

        void Join()
        {
            if (!Application.isPlaying) return; // a socket opened in edit mode would never be ticked or closed
            if (playerName.Trim() == "") { status = "Enter your name. The AI remembers you by it."; return; }
            if (mode == 2 && roomCode.Trim() == "") { status = "Enter a room code and give it to your friend."; return; }
            PlayerPrefs.SetString("rd-name", playerName.Trim());
            PlayerPrefs.SetString("rd-server", serverUrl);
            PlayerPrefs.SetInt("rd-mode", mode);
            string msg = "{\"t\":\"join\",\"name\":" + Json.Quote(playerName.Trim()) + ",\"map\":" + Json.Quote(mapVote);
            if (mode == 0) msg += ",\"mode\":\"ai\",\"difficulty\":" + Json.Quote(rankPick >= 0 ? "rank:" + rankPick : difficulty);
            else if (mode == 1) msg += ",\"mode\":\"mirror\"";
            else msg += ",\"mode\":\"pvp\",\"room\":" + Json.Quote(roomCode.Trim().ToLowerInvariant());
            Connect(msg + "}");
        }

        void JoinRewind(object match, object round)
        {
            if (playerName.Trim() == "") { status = "Enter your name first."; return; }
            int human = 0;
            var players = Json.Arr(match, "players");
            if (players != null)
                foreach (var p in players)
                    if (string.Equals(Json.Str(p, "name"), playerName.Trim(), StringComparison.OrdinalIgnoreCase)) human = (int)Json.Num(p, "slot");
            int start = (int)Json.Num(round, "startTick"), end = (int)Json.Num(round, "endTick");
            int tick = Mathf.Clamp(start + 16, start, Mathf.Max(start, end - 1));
            Connect("{\"t\":\"join\",\"mode\":\"rewind\",\"name\":" + Json.Quote(playerName.Trim()) + ",\"match\":" + Json.Quote(Json.Str(match, "id")) +
                    ",\"tick\":" + tick + ",\"slot\":" + human + "}");
        }

        void Connect(string firstMessage)
        {
            Uri uri;
            try { uri = Net.ToWsUri(serverUrl); }
            catch { status = "That server address is not a URL."; return; }
            net?.Dispose();
            net = new Net();
            net.Connect(uri, firstMessage);
            status = "Connecting…";
            view = View.Connecting;
        }

        void LeaveToLobby(string why = "")
        {
            ClearReplayActors();
            rpReturnId = null;
            net?.Dispose();
            net = null;
            obs = null;
            predictor.Reset();
            lastRoundWinner = -1;
            aiInfo = rewindInfo = ranks = null;
            aiLevel = null;
            mindBytes = null;
            trace.Clear();
            feed.Clear();
            toasts.Clear();
            view = View.Lobby;
            status = why;
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
            if (grade != null) grade.saturation.value = BaseSaturation;
            arena = null; // force a rebuild of the lobby map
            ShowLobbyMap();
        }

        // ================================================================ messages

        void Drain()
        {
            if (net == null) return;
            net.Pump();
            while (net.Inbox.TryDequeue(out var text))
            {
                object msg;
                try { msg = Json.Parse(text); } catch { continue; }
                switch (Json.Str(msg, "t"))
                {
                    case "joined":
                        slot = (int)Json.Num(msg, "slot");
                        status = mode == 2 ? "In room \"" + roomCode.Trim().ToLowerInvariant() + "\". Waiting for your friend to join with the same code…" : "Starting…";
                        break;
                    case "error":
                        status = Json.Str(msg, "msg");
                        net?.Dispose();
                        net = null;
                        view = View.Lobby;
                        return;
                    case "start": OnStart(msg); break;
                    case "obs": obsCount++; OnObs(msg); break;
                    case "end":
                        endMatchId = Json.Str(msg, "matchId");
                        endWhy = Json.Str(msg, "why");
                        endRewind = Json.Obj(msg, "rewind");
                        endBrain = Json.Obj(msg, "brain");
                        coachCount = (int)Json.Num(msg, "coach");
                        coachData = null;
                        view = View.Ended;
                        Cursor.lockState = CursorLockMode.None;
                        Cursor.visible = true;
                        if (coachCount > 0) StartCoroutine(PollCoach(endMatchId));
                        break;
                }
            }
            if (net != null && net.Error != null && view != View.Ended)
            {
                string why = view == View.Playing ? "Lost the connection to the server." : "Could not reach the server (" + net.Error + ").";
                LeaveToLobby(why);
            }
        }

        void OnStart(object msg)
        {
            var n = Json.Arr(msg, "names");
            names = new[] { n[0] as string, n[1] as string };
            var md = Json.Obj(msg, "mapData");
            MapDef m = md != null ? MapDef.Parse(md) : catalog?.Map(Json.Str(msg, "map"));
            if (m == null) { LeaveToLobby("This server does not send map data. Restart it from the unity-pr branch."); return; }
            BuildArena(m);
            aiInfo = Json.Obj(msg, "ai");
            rewindInfo = Json.Obj(msg, "rewind");
            obs = null;
            predictor.Reset();
            inputsSent = obsCount = eventCount = 0;
            view = View.Playing;
            buyOpen = true;
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
            if (grade != null) grade.saturation.value = BaseSaturation;
            string sub = m.name + (aiInfo != null ? "  ·  vs AI " + (Json.Str(Json.Obj(aiInfo, "rank"), "label") ?? "") : rewindInfo != null ? "  ·  REWIND" : "  ·  vs " + names[1 - slot]);
            Banner(rewindInfo != null ? "REWIND" : "MATCH START", sub, Gfx.Ally, 3f);
        }

        void OnObs(object msg)
        {
            var o = Json.Obj(msg, "obs");
            if (o == null) return;
            bool newRound = obs == null || Json.Num(o, "round") != Json.Num(obs, "round");
            obs = o;
            var self = Json.Obj(o, "self");
            predictor.Reconcile(ReadSelf(self), (int)Json.Num(msg, "ack"), Json.Str(o, "phase") == "live");
            if (newRound) yaw = YawFromAim(Json.Num(self, "aim"));

            if (Json.Obj(msg, "aiLevel") == null && !Json.IsNull(msg, "aiLevel")) aiLevel = (int)Json.Num(msg, "aiLevel");
            var r = Json.Obj(msg, "ranks");
            if (r != null) OnRanks(r);
            var mind = Json.Obj(msg, "mind");
            if (mind != null) OnMind(mind);
            var tr = Json.Arr(msg, "trace");
            if (tr != null) foreach (var t in tr) { trace.Add(t); if (trace.Count > 40) trace.RemoveAt(0); }
            var events = Json.Arr(msg, "events");
            if (events != null) { eventCount += events.Count; foreach (var e in events) OnEvent(e as Dictionary<string, object>); }

            var heard = Json.Obj(o, "heard");
            if (heard != null)
            {
                var hp = new Vector2((float)Json.Num(heard, "x"), (float)Json.Num(heard, "y"));
                if ((hp - lastHeard).sqrMagnitude > 0.5f || Time.time - lastHeardAt > 0.8f)
                {
                    var wp = W(hp.x, hp.y, 0);
                    fx.Ring(wp, Json.Str(heard, "kind") == "shot" ? Gfx.Rec : Gfx.Violet, 0.4f, 3.2f, 0.9f);
                    AudioSource.PlayClipAtPoint(Json.Str(heard, "kind") == "shot" ? Gfx.Ping : Gfx.Thud, wp + Vector3.up, 0.9f);
                    lastHeard = hp;
                    lastHeardAt = Time.time;
                }
            }
        }

        void OnRanks(object r)
        {
            ranks = r;
            int you = (int)Json.Num(Json.Obj(r, "you"), "index", -1), ai = (int)Json.Num(Json.Obj(r, "ai"), "index", -1);
            if (lastYouRank >= 0 && you > lastYouRank) Banner("RANK UP", Json.Str(Json.Obj(r, "you"), "label"), Catalog.Hex(Json.Str(Json.Obj(r, "you"), "color"), Gfx.Gold), 2.6f);
            if (lastAiRank >= 0 && ai != lastAiRank) Toast("AI ADAPTS → " + Json.Str(Json.Obj(r, "ai"), "label"), Catalog.Hex(Json.Str(Json.Obj(r, "ai"), "color"), Gfx.Violet));
            lastYouRank = you;
            lastAiRank = ai;
        }

        void OnMind(object mind)
        {
            try
            {
                mindBytes = Convert.FromBase64String(Json.Str(mind, "data"));
                mindCols = (int)Json.Num(mind, "cols");
                mindRows = (int)Json.Num(mind, "rows");
                if (mindBytes.Length != mindCols * mindRows) { mindBytes = null; return; }
            }
            catch { mindBytes = null; return; }
            int best = 0;
            for (int i = 1; i < mindBytes.Length; i++) if (mindBytes[i] > mindBytes[best]) best = i;
            float cell = map != null ? (float)(map.width / mindCols) : 1f;
            mindGuess = new Vector2((best % mindCols + 0.5f) * cell, (best / mindCols + 0.5f) * cell);
            arena?.SetMind(mindBytes, mindCols, mindRows, showMind);
            if (!mindMini || mindMini.width != mindCols || mindMini.height != mindRows)
                mindMini = new Texture2D(mindCols, mindRows, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear };
            var px = new Color32[mindCols * mindRows];
            for (int cy = 0; cy < mindRows; cy++)
                for (int cx = 0; cx < mindCols; cx++)
                {
                    float v = mindBytes[cy * mindCols + cx] / 255f;
                    px[(mindRows - 1 - cy) * mindCols + cx] = new Color32(230, 90, 255, (byte)(Mathf.Pow(v, 0.7f) * 220));
                }
            mindMini.SetPixels32(px);
            mindMini.Apply(false);
        }

        /// The share of the AI's belief that lies within `radius` map units of (x, y).
        float MindNear(double x, double y, float radius)
        {
            if (mindBytes == null || map == null) return 0;
            float cell = (float)(map.width / mindCols);
            double total = 0, near = 0;
            for (int i = 0; i < mindBytes.Length; i++)
            {
                double cx = (i % mindCols + 0.5) * cell, cy = (i / mindCols + 0.5) * cell;
                total += mindBytes[i];
                if ((cx - x) * (cx - x) + (cy - y) * (cy - y) <= radius * radius) near += mindBytes[i];
            }
            return total > 0 ? (float)(near / total) : 0;
        }

        static MoverState ReadSelf(Dictionary<string, object> s) => new MoverState
        {
            x = Json.Num(s, "x"), y = Json.Num(s, "y"),
            dashes = (int)Json.Num(s, "dashes"), dashTicks = (int)Json.Num(s, "dashTicks"),
            dashX = Json.Num(s, "dashX"), dashY = Json.Num(s, "dashY"), moveState = (int)Json.Num(s, "moveState"),
        };

        string NameOf(int s) => s >= 0 && s < names.Length ? names[s] : "?";

        void OnEvent(Dictionary<string, object> e)
        {
            if (e == null) return;
            int me = slot;
            int who = (int)Json.Num(e, "slot", -1);
            switch (Json.Str(e, "type"))
            {
                case "shot":
                {
                    bool mine = who == me;
                    var w = catalog?.Weapon((int)Json.Num(e, "weapon", 0));
                    var from = mine && muzzle ? muzzle.position : W(Json.Num(e, "x"), Json.Num(e, "y"), 1.35f);
                    var to = W(Json.Num(e, "toX"), Json.Num(e, "toY"), 1.3f);
                    bool hit = Json.Bool(e, "hit"), head = Json.Bool(e, "head");
                    fx.Tracer(from, to, Bullet, w != null && w.cls == "sniper" ? 0.03f : 0.012f);
                    fx.Muzzle(from, Bullet);
                    fx.Sparks(to, hit ? (head ? Gfx.Gold : Gfx.Rec) : new Color(1f, 0.8f, 0.55f), hit ? 10 : 5, hit ? 4f : 2.5f);
                    float pitchShift = w == null ? 1f : w.cls == "sniper" ? 0.62f : w.cls == "shotgun" ? 0.75f : w.cls == "smg" ? 1.25f : w.cls == "sidearm" ? 1.12f : w.cls == "heavy" ? 0.88f : 1f;
                    if (w != null && w.silenced) pitchShift *= 1.35f;
                    if (mine)
                    {
                        voice.pitch = pitchShift * UnityEngine.Random.Range(0.96f, 1.04f);
                        voice.PlayOneShot(shotClip, w != null && w.silenced ? 0.28f : 0.5f);
                        voice.pitch = 1;
                        recoil = Mathf.Min(1.6f, recoil + (w != null && w.cls == "sniper" ? 1.6f : 0.6f));
                    }
                    else AudioSource.PlayClipAtPoint(shotClip, from, w != null && w.silenced ? 0.35f : 0.85f);
                    if (hit && mine)
                    {
                        hitFlash = 1;
                        voice.PlayOneShot(head ? Gfx.Ding : hitClip, head ? 0.9f : 0.6f);
                        int dmg = (int)Json.Num(e, "damage", 0);
                        if (dmg > 0) Popup(to + Vector3.up * 0.6f, dmg.ToString(), head ? Gfx.Gold : Gfx.Label);
                    }
                    else if (hit)
                    {
                        hurtFlash = 1;
                        hurtFrom = new Vector2((float)Json.Num(e, "x"), (float)Json.Num(e, "y"));
                        hurtAt = Time.time;
                        voice.PlayOneShot(hurtClip);
                    }
                    break;
                }
                case "kill":
                {
                    int killer = (int)Json.Num(e, "killer"), victim = (int)Json.Num(e, "victim");
                    bool head = Json.Bool(e, "head");
                    string gun = catalog?.WeaponName((int)Json.Num(e, "weapon", 0)) ?? "";
                    feed.Add((NameOf(killer), gun + (head ? "  ◎" : ""), NameOf(victim), killer == me ? Gfx.Ally : Gfx.Enemy, Time.time));
                    if (feed.Count > 5) feed.RemoveAt(0);
                    voice.PlayOneShot(killClip, 0.8f);
                    if (victim != me)
                    {
                        fx.Burst(enemyDrawValid ? enemyDraw : W(Json.Num(e, "x"), Json.Num(e, "y"), 0), Gfx.Enemy);
                        killFlash = 1;
                        Banner(head ? "HEADSHOT" : "ELIMINATED", NameOf(victim) + "  ·  " + gun, head ? Gfx.Gold : Gfx.Ally, 1.6f);
                    }
                    else Banner("YOU ARE DOWN", "by " + NameOf(killer) + "  ·  " + gun + (head ? "  ·  headshot" : ""), Gfx.Rec, 2.4f);
                    break;
                }
                case "buy":
                    if (who == me)
                    {
                        int id = (int)Json.Num(e, "weapon");
                        var sh = catalog?.shields.Find(s => s.id == id);
                        Toast("BOUGHT " + (sh != null ? sh.name : catalog?.WeaponName(id) ?? "?").ToUpperInvariant(), Gfx.Gold);
                        voice.PlayOneShot(Gfx.Coin, 0.7f);
                    }
                    break;
                case "credits":
                    if (who == me) Toast("+¤" + (int)Json.Num(e, "amount") + "  " + (Json.Str(e, "reason") ?? "").ToUpperInvariant(), Gfx.Gold);
                    break;
                case "smoke":
                    AudioSource.PlayClipAtPoint(smokeClip, W(Json.Num(e, "x"), Json.Num(e, "y"), 1), 0.8f);
                    break;
                case "dash":
                    if (who == me) voice.PlayOneShot(dashClip, 0.6f);
                    break;
                case "flash":
                    if (who == me) Toast("FLASH OUT", new Color(0.85f, 0.92f, 1f));
                    break;
                case "flashPop":
                {
                    var p = W(Json.Num(e, "x"), Json.Num(e, "y"), 1.3f);
                    fx.FlashPop(p);
                    AudioSource.PlayClipAtPoint(Gfx.Pop, p, 1f);
                    break;
                }
                case "blinded":
                    if (who == me) { voice.PlayOneShot(Gfx.Tinnitus, 0.8f); blindFade = 1f; }
                    else if ((int)Json.Num(e, "by") == me) Toast("FLASHED " + NameOf(who).ToUpperInvariant() + "  " + (Json.Num(e, "ticks") / TickRate).ToString("0.0", CultureInfo.InvariantCulture) + "s", Gfx.Gold);
                    break;
                case "flashDodged":
                    Toast(who == me ? "DODGED THE FLASH" : NameOf(who).ToUpperInvariant() + " TURNED AWAY", who == me ? Gfx.Enemy : new Color(0.7f, 0.7f, 0.75f));
                    break;
                case "teleport":
                {
                    fx.TeleportBurst(W(Json.Num(e, "fromX"), Json.Num(e, "fromY"), 0));
                    fx.TeleportBurst(W(Json.Num(e, "x"), Json.Num(e, "y"), 0));
                    if (who == me) { warpFlash = 1; voice.PlayOneShot(Gfx.Warp, 0.7f); selfDraw = W(Json.Num(e, "x"), Json.Num(e, "y"), eyeHeight); }
                    break;
                }
                case "plant":
                    voice.PlayOneShot(plantClip, 0.8f);
                    Banner("SPIKE PLANTED", map?.SiteAt(Json.Num(e, "x"), Json.Num(e, "y")) is SiteDef s ? "site " + s.label : "", Gfx.Rec, 2.2f);
                    break;
                case "defuse":
                    Banner("SPIKE DEFUSED", "", Gfx.Enemy, 2f);
                    break;
                case "detonate":
                    fx.Burst(spike ? spike.position : W(map.width / 2, map.height / 2, 0), Gfx.Rec);
                    break;
                case "roundStart":
                {
                    bool atk = (int)Json.Num(e, "attacker") == me;
                    voice.PlayOneShot(roundStartClip);
                    Banner("ROUND " + (int)Json.Num(e, "round"), (atk ? "ATTACK" : "DEFEND") + "  ·  " + (map?.name ?? ""), atk ? Gfx.Ally : Gfx.Enemy, 2.4f);
                    buyOpen = true;
                    break;
                }
                case "roundEnd":
                    lastRoundWinner = (int)Json.Num(e, "winner");
                    lastRoundReason = Json.Str(e, "reason");
                    voice.PlayOneShot(roundEndClip);
                    break;
            }
        }

        // ================================================================ input

        bool BuyPhase()
        {
            if (obs == null || catalog == null || Json.Str(obs, "phase") != "live") return false;
            return catalog.roundTicks - Json.Num(obs, "roundTicksLeft") < catalog.buyTicks;
        }

        /// Buys are only for the rules that have an economy (every live match on this server).
        bool HasEconomy() => obs != null && Json.Str(obs, "rules") == "valorant";

        void Update()
        {
            Drain();
            var kb = Keyboard.current;
            var mouse = Mouse.current;

            if (view == View.Lobby || (view == View.Connecting && rpReturnId == null)) { LobbyCamera(); }
            if (view == View.Replay) ReplayUpdate(kb, mouse);
            if (view == View.Playing && kb != null && mouse != null) PlayingInput(kb, mouse);
            if (view == View.Ended && kb != null && kb.enterKey.wasPressedThisFrame) LeaveToLobby();

            if (view == View.Playing || view == View.Ended) DrawActors();
            fx.Update();
            arena?.Update(SpikePlanted() ? 1.4f + 0.6f * Mathf.Sin(Time.time * 9f) : 1f);
            EffectsDecay();
        }

        void PlayingInput(Keyboard kb, Mouse mouse)
        {
            bool buying = BuyPhase() && HasEconomy();
            bool menu = buying && buyOpen;
            if (kb.escapeKey.wasPressedThisFrame) { Cursor.lockState = CursorLockMode.None; Cursor.visible = true; }
            if (kb.bKey.wasPressedThisFrame) buyOpen = !buyOpen;
            if (kb.iKey.wasPressedThisFrame) { showMind = !showMind; arena?.SetMind(mindBytes, mindCols, mindRows, showMind); }
            if (kb.tKey.wasPressedThisFrame) showTrace = !showTrace;
            if (kb.f1Key.wasPressedThisFrame)
            {
                studio = !studio;
                showMind = studio;
                arena?.SetMind(mindBytes, mindCols, mindRows, showMind);
            }
            if (kb.mKey.wasPressedThisFrame) AudioListener.volume = AudioListener.volume > 0 ? 0 : 1;

            // The buy menu frees the mouse to click; outside it, a click captures the mouse for aiming.
            if (menu && Cursor.lockState == CursorLockMode.Locked) { Cursor.lockState = CursorLockMode.None; Cursor.visible = true; }
            if (!menu && Cursor.lockState != CursorLockMode.Locked && mouse.leftButton.wasPressedThisFrame && GUIUtility.hotControl == 0)
            {
                Cursor.lockState = CursorLockMode.Locked;
                Cursor.visible = false;
            }

            // Digits: quick-buy in the buy phase, otherwise 1 = primary, 2 = secondary.
            var digits = new[] { kb.digit1Key, kb.digit2Key, kb.digit3Key, kb.digit4Key, kb.digit5Key, kb.digit6Key, kb.digit7Key, kb.digit8Key, kb.digit9Key };
            for (int i = 0; i < digits.Length; i++)
                if (digits[i].wasPressedThisFrame)
                {
                    if (buying) { var q = QuickBuy(); if (i < q.Count) pendingBuy = q[i]; }
                    else if (i < 2) pendingEquip = i;
                }

            bool aiming = Cursor.lockState == CursorLockMode.Locked;
            if (aiming)
            {
                var d = mouse.delta.ReadValue() * mouseDegPerPixel;
                yaw = Mathf.Repeat(yaw + d.x, 360f);
                pitch = Mathf.Clamp(pitch - d.y, -60f, 60f);
            }
            if (aiming || menu)
            {
                pressedDash |= kb.eKey.wasPressedThisFrame;
                pressedSmoke |= kb.qKey.wasPressedThisFrame;
                pressedReload |= kb.rKey.wasPressedThisFrame;
                pressedFlash |= kb.cKey.wasPressedThisFrame;
            }

            // One input per server tick. If a frame runs long, catch up by at most two.
            sendClock += Time.unscaledDeltaTime;
            if (sendClock > 3f / TickRate) sendClock = 3f / TickRate;
            while (sendClock >= 1f / TickRate)
            {
                sendClock -= 1f / TickRate;
                SendInput(kb, mouse, aiming, aiming || menu);
            }
        }

        /// The quick-buy order: the best-value buy of each class, then shields. Built from the catalog, not names.
        List<int> QuickBuy()
        {
            var list = new List<int>();
            if (catalog == null) return list;
            foreach (var cls in new[] { "rifle", "sniper", "smg", "shotgun", "heavy" })
            {
                WeaponDef best = null;
                foreach (var w in catalog.weapons.Values) if (w.cls == cls && w.price > 0 && (best == null || w.price > best.price)) best = w;
                if (best != null) list.Add(best.id);
            }
            WeaponDef pistol = null;
            foreach (var w in catalog.weapons.Values) if (w.cls == "sidearm" && w.price > 0 && (pistol == null || w.price > pistol.price)) pistol = w;
            if (pistol != null) list.Add(pistol.id);
            foreach (var s in catalog.shields) list.Add(s.id);
            return list;
        }

        /// WASD is relative to where you look, but the engine moves in 8 map directions, so the wish direction
        /// snaps to the nearest one (DECISIONS D49).
        InputMsg CurrentInput(Keyboard kb, Mouse mouse, bool aiming, bool keys)
        {
            int f = keys ? (kb.wKey.isPressed ? 1 : 0) - (kb.sKey.isPressed ? 1 : 0) : 0;
            int r = keys ? (kb.dKey.isPressed ? 1 : 0) - (kb.aKey.isPressed ? 1 : 0) : 0;
            int mx = 0, my = 0;
            if (f != 0 || r != 0)
            {
                double t = yaw * Mathf.Deg2Rad;
                double wx = Math.Sin(t) * f + Math.Cos(t) * r;
                double wz = Math.Cos(t) * f - Math.Sin(t) * r;
                double snapped = Math.Round(Math.Atan2(-wz, wx) / (Math.PI / 4)) * (Math.PI / 4);
                mx = (int)Math.Round(Math.Cos(snapped));
                my = (int)Math.Round(Math.Sin(snapped));
            }
            var input = new InputMsg
            {
                mx = mx, my = my,
                walk = keys && kb.shiftKey.isPressed,
                aim = AimFromYaw(yaw),
                fire = aiming && mouse.leftButton.isPressed,
                reload = keys && (kb.rKey.isPressed || pressedReload),
                smoke = keys && (kb.qKey.isPressed || pressedSmoke),
                dash = keys && (kb.eKey.isPressed || pressedDash),
                flash = keys && (kb.cKey.isPressed || pressedFlash),
                use = keys && kb.fKey.isPressed,
                buy = pendingBuy,
                equip = pendingEquip,
            };
            pressedDash = pressedSmoke = pressedReload = pressedFlash = false;
            pendingBuy = pendingEquip = -1;
#if UNITY_EDITOR
            if (demoDrive != null) input = demoDrive(input); // the demo recorder's scripted player (DuelDemo.cs)
#endif
            return input;
        }

        void SendInput(Keyboard kb, Mouse mouse, bool aiming, bool keys)
        {
            if (net == null || !net.Open || obs == null) return;
            var input = CurrentInput(kb, mouse, aiming, keys);
            var self = Json.Obj(obs, "self");
            int seq = predictor.Send(input, Json.Str(obs, "phase") == "live" && Json.Num(self, "hp") > 0);
            inputsSent++;
            string B(bool b) => b ? "true" : "false";
            var extra = (input.buy >= 0 ? ",\"buy\":" + input.buy : "") + (input.equip >= 0 ? ",\"equip\":" + input.equip : "");
            net.Send(string.Format(CultureInfo.InvariantCulture,
                "{{\"t\":\"input\",\"seq\":{0},\"input\":{{\"move\":{{\"x\":{1},\"y\":{2}}},\"walk\":{3},\"aim\":{4:R},\"fire\":{5},\"reload\":{6},\"smoke\":{7},\"dash\":{8},\"use\":{9},\"flash\":{10}{11}}}}}",
                seq, input.mx, input.my, B(input.walk), input.aim, B(input.fire), B(input.reload), B(input.smoke), B(input.dash), B(input.use), B(input.flash), extra));
        }

        /// Clicked in the buy menu.
        void Buy(int id) => pendingBuy = id;

        // ================================================================ 3D actors

        static bool Keep(Component c) => c is Transform || c is MeshFilter || c is Renderer || c is Animator || c is ParticleSystem || c is LODGroup;

        /// Removes every non-visual component, only ever removing one nothing left on the object still requires.
        static void StripObject(GameObject go)
        {
            var left = new List<Component>();
            foreach (var c in go.GetComponents<Component>()) if (c && !Keep(c)) left.Add(c);
            bool progress = true;
            while (left.Count > 0 && progress)
            {
                progress = false;
                foreach (var c in left.ToArray())
                {
                    bool needed = false;
                    foreach (var other in go.GetComponents<Component>())
                    {
                        if (!other || other == c) continue;
                        foreach (RequireComponent rc in Attribute.GetCustomAttributes(other.GetType(), typeof(RequireComponent), true))
                            if ((rc.m_Type0 != null && rc.m_Type0.IsInstanceOfType(c)) || (rc.m_Type1 != null && rc.m_Type1.IsInstanceOfType(c)) || (rc.m_Type2 != null && rc.m_Type2.IsInstanceOfType(c)))
                                needed = true;
                    }
                    if (needed) continue;
                    left.Remove(c);
                    DestroyImmediate(c);
                    progress = true;
                }
            }
        }

        /// Instantiates art with every script stripped, under an inactive parent so no Awake runs first.
        static Transform Art(GameObject prefab, Transform parent)
        {
            var holder = new GameObject("holder");
            holder.SetActive(false);
            var go = Instantiate(prefab, holder.transform);
            foreach (var t in go.GetComponentsInChildren<Transform>(true)) StripObject(t.gameObject);
            foreach (var ps in go.GetComponentsInChildren<ParticleSystemRenderer>(true)) ps.enabled = false;
            foreach (var rend in go.GetComponentsInChildren<Renderer>(true)) rend.gameObject.layer = 0;
            go.transform.SetParent(parent, false);
            Destroy(holder);
            return go.transform;
        }

        static Bounds RenderBounds(Transform t)
        {
            var rs = Array.FindAll(t.GetComponentsInChildren<Renderer>(), r => r is MeshRenderer || r is SkinnedMeshRenderer);
            if (rs.Length == 0) return new Bounds(t.position, Vector3.one);
            var b = rs[0].bounds;
            foreach (var r in rs) b.Encapsulate(r.bounds);
            return b;
        }

        void DestroyActors()
        {
            foreach (var t in new[] { weapon, enemy, ghost, spike }) if (t) Destroy(t.gameObject);
            weapon = enemy = ghost = spike = null;
            if (ghostMat) Destroy(ghostMat);
            shownWeapon = int.MinValue;
        }

        /// A player body: the hover bot sized to the engine's hitbox (radius 0.4) and hovering at chest height,
        /// with a rim light in its side's colour and a shadow disc so it reads as hovering.
        Transform MakeBot(string name, Color rim, out Light light)
        {
            var root = new GameObject(name).transform;
            root.SetParent(world, false);
            if (enemyPrefab)
            {
                var art = Art(enemyPrefab, root);
                var b = RenderBounds(art);
                art.localScale *= 1.0f / Mathf.Max(0.01f, Mathf.Max(b.size.x, b.size.z));
                b = RenderBounds(art);
                art.localPosition -= b.center - root.position - new Vector3(0, 1.3f, 0);
            }
            light = Fx.PointLight(root, root.position + Vector3.up * 1.3f, rim, 2.2f, 3f);
            var disc = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(disc.GetComponent<Collider>());
            disc.transform.SetParent(root, false);
            disc.transform.localPosition = new Vector3(0, 0.03f, 0);
            disc.transform.localRotation = Quaternion.Euler(90, 0, 0);
            disc.transform.localScale = Vector3.one * 1.4f;
            disc.GetComponent<Renderer>().sharedMaterial = Gfx.Fade(new Color(0, 0, 0, 0.45f), Gfx.Dot);
            return root;
        }

        void BuildActors()
        {
            // The rival, with a red rim light: the genre's enemy highlight, so it never blends into a wall.
            var enemyRoot = MakeBot("Rival", Gfx.Enemy, out enemyLight);
            enemy = enemyRoot;
            enemy.gameObject.SetActive(false);
            enemyDrawValid = false;

            // Where you last saw the rival: a fading hologram.
            var g = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            g.name = "LastSeen";
            Destroy(g.GetComponent<Collider>());
            g.transform.SetParent(world, false);
            g.transform.localScale = new Vector3(0.8f, 0.9f, 0.8f);
            ghostMat = Gfx.Additive(new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, 0.3f));
            g.GetComponent<Renderer>().sharedMaterial = ghostMat;
            ghost = g.transform;
            ghost.gameObject.SetActive(false);

            // The spike, once planted: a hot core, a beacon to the sky and a red light that beats faster near the end.
            var sp = new GameObject("Spike").transform;
            sp.SetParent(world, false);
            var core = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Destroy(core.GetComponent<Collider>());
            core.transform.SetParent(sp, false);
            core.transform.localScale = new Vector3(0.35f, 0.5f, 0.35f);
            core.transform.localPosition = Vector3.up * 0.25f;
            core.GetComponent<Renderer>().sharedMaterial = Gfx.Glow(Gfx.Rec, 4f);
            var beam = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            Destroy(beam.GetComponent<Collider>());
            beam.transform.SetParent(sp, false);
            // A short antenna with a red tip: a device, not a beacon.
            beam.transform.localPosition = Vector3.up * 0.75f;
            beam.transform.localScale = new Vector3(0.03f, 0.25f, 0.03f);
            beam.GetComponent<Renderer>().sharedMaterial = Gfx.Glow(Gfx.Rec, 1.6f);
            spikeLight = Fx.PointLight(sp, sp.position + Vector3.up, Gfx.Rec, 4f, 9f);
            spike = sp;
            spike.gameObject.SetActive(false);
        }

        /// The weapon in your hands. One template model, shaped and lit per weapon class.
        void ShowWeapon(int id)
        {
            if (id == shownWeapon) return;
            shownWeapon = id;
            if (weapon) Destroy(weapon.gameObject);
            weapon = null;
            muzzle = null;
            if (!weaponPrefab || id < 0) return;
            var w = catalog?.Weapon(id);
            string cls = w?.cls ?? "legacy";
            weapon = Art(weaponPrefab, cam.transform);
            weapon.localRotation = Quaternion.identity;
            Vector3 scale; Color accent;
            switch (cls)
            {
                case "sidearm": scale = new Vector3(0.55f, 0.55f, 0.5f); accent = Gfx.Ally; break;
                case "smg": scale = new Vector3(0.7f, 0.7f, 0.78f); accent = new Color(0.55f, 1f, 0.45f); break;
                case "shotgun": scale = new Vector3(0.85f, 0.8f, 0.8f); accent = new Color(1f, 0.45f, 0.2f); break;
                case "sniper": scale = new Vector3(0.68f, 0.68f, 1.25f); accent = Gfx.Violet; break;
                case "heavy": scale = new Vector3(0.95f, 0.9f, 0.95f); accent = Gfx.Rec; break;
                case "rifle": scale = new Vector3(0.75f, 0.75f, 0.95f); accent = Gfx.Enemy; break;
                default: scale = Vector3.one * 0.75f; accent = Gfx.Ally; break;
            }
            weapon.localScale = scale;
            if (cls == "sniper")
            {
                var scope = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                Destroy(scope.GetComponent<Collider>());
                scope.transform.SetParent(weapon, false);
                scope.transform.localRotation = Quaternion.Euler(90, 0, 0);
                scope.transform.localPosition = new Vector3(0, 0.62f, 0.05f);
                scope.transform.localScale = new Vector3(0.11f, 0.22f, 0.11f);
                scope.GetComponent<Renderer>().sharedMaterial = Gfx.LitMat(new Color(0.08f, 0.08f, 0.1f), 0.9f, 0.8f);
                var lens = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                Destroy(lens.GetComponent<Collider>());
                lens.transform.SetParent(scope.transform, false);
                lens.transform.localPosition = new Vector3(0, -1f, 0);
                lens.transform.localScale = new Vector3(0.9f, 0.1f, 0.9f);
                lens.GetComponent<Renderer>().sharedMaterial = Gfx.Glow(accent, 3f);
            }
            foreach (var r in weapon.GetComponentsInChildren<Renderer>(true)) r.shadowCastingMode = ShadowCastingMode.Off;
            if (weaponLayer >= 0) foreach (var t in weapon.GetComponentsInChildren<Transform>(true)) t.gameObject.layer = weaponLayer;
            foreach (var c in weapon.GetComponentsInChildren<Transform>(true)) if (c.name.ToLowerInvariant().Contains("muzzle")) { muzzle = c; break; }
            if (!muzzle) muzzle = weapon;
        }

        // Where the FPS template's Player prefab holds its weapon (DefaultWeaponPosition).
        static readonly Vector3 WeaponRest = new Vector3(0.264f, -0.347f, 0.465f);

        static float Chase(float tau) => 1f - Mathf.Exp(-Time.deltaTime / tau);

        bool SpikePlanted() => obs != null && Json.Str(Json.Obj(obs, "spike"), "state") == "planted";

        void DrawActors()
        {
            if (obs == null || map == null) return;
            var self = Json.Obj(obs, "self");
            bool alive = Json.Num(self, "hp") > 0;
            var p = predictor.Pos ?? ReadSelf(self);
            var target = W(p.x, p.y, alive ? eyeHeight : 0.45f);
            selfDraw = (selfDraw - target).sqrMagnitude > 4 ? target : Vector3.Lerp(selfDraw, target, Chase(0.022f));
            float kick = recoil * 2.2f;
            cam.transform.SetPositionAndRotation(selfDraw, Quaternion.Euler(pitch - kick, yaw, alive ? 0 : 22));

            // Weapon in hand: the equipped slot's gun, lowered while swapping, tilted while reloading.
            int equipped = (int)Json.Num(self, "equipped");
            int gun = equipped == 1 ? (int)Json.Num(self, "secondary", 1) : (int)Json.Num(self, "primary", 0);
            ShowWeapon(alive ? gun : -1);
            if (weapon)
            {
                recoil = Mathf.MoveTowards(recoil, 0, Time.deltaTime * 7f);
                float bob = p.moveState == 2 ? Mathf.Sin(Time.time * 12) * 0.012f : p.moveState == 1 ? Mathf.Sin(Time.time * 7) * 0.006f : 0;
                float swap = Mathf.Clamp01((float)Json.Num(self, "switchTicks") / 8f);
                float reload = Json.Num(self, "reloadTicks") > 0 ? 1 : 0;
                reloadTilt = Mathf.Lerp(reloadTilt, reload, Chase(0.08f));
                weapon.localPosition = WeaponRest + new Vector3(0, bob - swap * 0.35f - reloadTilt * 0.08f, -recoil * 0.05f);
                weapon.localRotation = Quaternion.Euler(-recoil * 7 + swap * 30 + reloadTilt * 25, 0, reloadTilt * -20);
            }

            var e = Json.Obj(obs, "enemy");
            if (e != null && enemy)
            {
                var et = W(Json.Num(e, "x"), Json.Num(e, "y"), 0);
                enemyDraw = enemyDrawValid && (enemyDraw - et).sqrMagnitude < 9 ? Vector3.Lerp(enemyDraw, et, Chase(0.035f)) : et;
                enemyDrawValid = true;
                enemy.gameObject.SetActive(true);
                enemy.SetPositionAndRotation(enemyDraw + Vector3.up * Mathf.Sin(Time.time * 3f) * 0.05f, Quaternion.Euler(0, YawFromAim(Json.Num(e, "aim")), 0));
                enemyLight.intensity = 2.2f;
                ghost.gameObject.SetActive(false);
            }
            else if (enemy)
            {
                enemyDrawValid = false;
                enemy.gameObject.SetActive(false);
                var ls = Json.Obj(obs, "lastSeenEnemy");
                bool show = alive && ls != null && Json.Num(ls, "ticksAgo") < 3 * TickRate
                    && (W(Json.Num(ls, "x"), Json.Num(ls, "y"), 0) - new Vector3(selfDraw.x, 0, selfDraw.z)).magnitude > 2.5f;
                ghost.gameObject.SetActive(show);
                if (show)
                {
                    ghost.position = W(Json.Num(ls, "x"), Json.Num(ls, "y"), 0.9f);
                    float a = 0.3f * (1 - (float)Json.Num(ls, "ticksAgo") / (3 * TickRate));
                    ghostMat.SetColor("_BaseColor", new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, a) * 1.5f);
                }
            }

            var smokes = Json.Arr(obs, "smokes");
            var centers = new List<Vector3>();
            var left = new List<float>();
            if (smokes != null) foreach (var s in smokes) { centers.Add(W(Json.Num(s, "x"), Json.Num(s, "y"), 0)); left.Add((float)Json.Num(s, "ticksLeft") / TickRate); }
            fx.SyncSmokes(centers, left, SmokeRadius);

            var flashes = Json.Arr(obs, "flashes");
            var fpos = new List<Vector3>();
            var fmine = new List<bool>();
            if (flashes != null) foreach (var f in flashes) { fpos.Add(W(Json.Num(f, "x"), Json.Num(f, "y"), 0)); fmine.Add(Json.Bool(f, "mine")); }
            fx.SyncFlashes(fpos, fmine);

            var sk = Json.Obj(obs, "spike");
            bool planted = Json.Str(sk, "state") == "planted";
            if (spike)
            {
                spike.gameObject.SetActive(planted);
                if (planted)
                {
                    spike.position = W(Json.Num(sk, "x"), Json.Num(sk, "y"), 0);
                    float leftS = (float)Json.Num(sk, "ticksLeft") / TickRate;
                    float rate = Mathf.Lerp(16f, 3f, Mathf.Clamp01(leftS / 30f));
                    spikeLight.intensity = 4f + 4f * Mathf.Max(0, Mathf.Sin(Time.time * rate));
                    if (Time.time - lastSiren > Mathf.Lerp(0.35f, 1.4f, Mathf.Clamp01(leftS / 30f)))
                    {
                        lastSiren = Time.time;
                        AudioSource.PlayClipAtPoint(Gfx.Siren, spike.position + Vector3.up, 0.6f);
                    }
                }
            }

            // Blind: the server's own countdown drives the white-out, so it ends exactly when you can see again.
            float blind = Mathf.Clamp01((float)Json.Num(self, "blindTicks") / 24f);
            blindFade = Mathf.Max(blindFade * Mathf.Exp(-Time.deltaTime * 2f), blind);

            // Down: the world drains of colour.
            if (grade != null) grade.saturation.value = Mathf.Lerp(grade.saturation.value, alive ? BaseSaturation : -75f, Chase(0.4f));
        }

        float reloadTilt, lastSiren;
        Vector2 hurtFrom;
        float hurtAt = -99;

        void EffectsDecay()
        {
            float dt = Time.deltaTime;
            hurtFlash = Mathf.MoveTowards(hurtFlash, 0, dt * 2.5f);
            hitFlash = Mathf.MoveTowards(hitFlash, 0, dt * 6f);
            warpFlash = Mathf.MoveTowards(warpFlash, 0, dt * 3f);
            killFlash = Mathf.MoveTowards(killFlash, 0, dt * 3f);
            if (aberration != null) aberration.intensity.value = hurtFlash * 0.35f + warpFlash * 0.5f;
            if (vignette != null)
            {
                vignette.intensity.value = BaseVignette + hurtFlash * 0.25f;
                vignette.color.value = Color.Lerp(Color.black, new Color(0.6f, 0, 0.05f), hurtFlash);
            }
            if (grade != null) grade.postExposure.value = 0.15f + blindFade * 4f;
        }
    }

    /// Keeps a label or halo facing the camera.
    public class Billboard : MonoBehaviour
    {
        void LateUpdate()
        {
            var c = Camera.main;
            if (c) transform.rotation = Quaternion.LookRotation(transform.position - c.transform.position);
        }
    }
}
