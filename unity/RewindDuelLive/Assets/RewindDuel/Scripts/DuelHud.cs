using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

// The 2D layer of the Unity client, drawn with IMGUI: lobby, HUD, buy menu, minimap with the AI's mind,
// trace panel, kill feed, banners and the end screen. Names and numbers all come from the server.

namespace RewindDuel
{
    public partial class DuelClient
    {
        // ---- transient HUD items
        readonly List<(string killer, string gun, string victim, Color c, float at)> feed = new List<(string, string, string, Color, float)>();
        readonly List<(string text, Color c, float at)> toasts = new List<(string, Color, float)>();
        readonly List<(Vector3 pos, string text, Color c, float at)> popups = new List<(Vector3, string, Color, float)>();
        string bannerTitle, bannerSub;
        Color bannerColor;
        float bannerAt = -99, bannerDur;

        void Banner(string title, string sub, Color c, float dur) { bannerTitle = title; bannerSub = sub; bannerColor = c; bannerAt = Time.time; bannerDur = dur; }
        void Toast(string text, Color c) { toasts.Add((text, c, Time.time)); if (toasts.Count > 5) toasts.RemoveAt(0); }
        void Popup(Vector3 pos, string text, Color c) { popups.Add((pos, text, c, Time.time)); if (popups.Count > 12) popups.RemoveAt(0); }

        // ---- styles
        float S; // UI scale: 1 at 900 px tall
        Font display, body;
        bool ownFonts; // true when the fonts were created here and must be destroyed with the client
        GUIStyle panelStyle;
        readonly Dictionary<string, GUIStyle> styles = new Dictionary<string, GUIStyle>();
        readonly Dictionary<string, Texture2D> thumbs = new Dictionary<string, Texture2D>();
        Vector2 replayScroll;

        GUIStyle St(int size, bool bold, TextAnchor anchor, bool displayFont = false, bool wrap = false)
        {
            int px = Mathf.Max(8, Mathf.RoundToInt(size * S));
            string key = px + (bold ? "b" : "") + (int)anchor + (displayFont ? "d" : "") + (wrap ? "w" : "");
            if (styles.TryGetValue(key, out var st)) return st;
            st = new GUIStyle(GUI.skin.label)
            {
                font = displayFont ? display : body,
                fontSize = px,
                fontStyle = bold ? FontStyle.Bold : FontStyle.Normal,
                alignment = anchor,
                wordWrap = wrap,
                clipping = TextClipping.Overflow,
                richText = false,
            };
            st.normal.textColor = Color.white;
            styles[key] = st;
            return st;
        }

        void EnsureStyle()
        {
            if (display == null)
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                // A browser has no system fonts Unity can load, so the WebGL build uses Unity's built-in font.
                display = body = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
#else
                display = Font.CreateDynamicFontFromOSFont(new[] { "Avenir Next Condensed", "Futura", "Helvetica Neue", "Arial" }, 32);
                body = Font.CreateDynamicFontFromOSFont(new[] { "Avenir Next", "Helvetica Neue", "Arial" }, 16);
                ownFonts = true;
#endif
            }
            float s = UnityEngine.Screen.height / 900f;
            if (Mathf.Abs(s - S) > 0.001f) { S = s; styles.Clear(); }
            if (panelStyle == null)
            {
                panelStyle = new GUIStyle { border = new RectOffset(16, 16, 16, 16) };
                panelStyle.normal.background = Gfx.Rounded;
            }
        }

        static void Fill(Rect r, Color c) { var o = GUI.color; GUI.color = c; GUI.DrawTexture(r, Texture2D.whiteTexture); GUI.color = o; }

        void Panel(Rect r, Color c)
        {
            if (Event.current.type != EventType.Repaint) return;
            var o = GUI.color;
            GUI.color = c;
            panelStyle.Draw(r, false, false, false, false);
            GUI.color = o;
        }

        /// Soft glows were part of the old neon look; the grounded HUD stays crisp, so this draws nothing.
        static void Glow(Rect r, Color c) { }

        void Text(Rect r, string s, GUIStyle st, Color c, bool shadow = true)
        {
            if (shadow)
            {
                st.normal.textColor = new Color(0, 0, 0, c.a * 0.7f);
                GUI.Label(new Rect(r.x + 1.5f * S, r.y + 1.5f * S, r.width, r.height), s, st);
            }
            st.normal.textColor = c;
            GUI.Label(r, s, st);
        }

        /// A clickable chip. Returns true when clicked.
        bool Chip(Rect r, string label, bool on, Color accent, bool enabled = true)
        {
            bool hover = r.Contains(Event.current.mousePosition) && enabled;
            Panel(r, on ? new Color(accent.r, accent.g, accent.b, 0.92f) : hover ? new Color(1, 1, 1, 0.16f) : new Color(1, 1, 1, 0.07f));
            Text(r, label, St(13, true, TextAnchor.MiddleCenter, true), on ? Gfx.Ink : enabled ? Gfx.Label : new Color(1, 1, 1, 0.3f), false);
            if (enabled && Event.current.type == EventType.MouseDown && r.Contains(Event.current.mousePosition)) { Event.current.Use(); return true; }
            return false;
        }

        Vector2? ToGui(Vector3 world)
        {
            var sp = cam.WorldToScreenPoint(world);
            if (sp.z < 0.1f) return null;
            return new Vector2(sp.x, UnityEngine.Screen.height - sp.y);
        }

        // ---- GL helpers (screen space, y down like GUI)

        void GLBegin(int mode)
        {
            GL.PushMatrix();
            Gfx.GLMat().SetPass(0);
            GL.LoadPixelMatrix(0, UnityEngine.Screen.width, UnityEngine.Screen.height, 0);
            GL.Begin(mode);
        }

        static void GLEnd() { GL.End(); GL.PopMatrix(); }

        // ================================================================ OnGUI

        void OnGUI()
        {
            EnsureStyle();
            float w = UnityEngine.Screen.width, h = UnityEngine.Screen.height;
            if (view == View.Replay) { DrawReplay(w, h); return; }
            if (view == View.Lobby || view == View.Connecting) { DrawLobby(w, h); return; }
            if (obs != null) { SetFov(); DrawHud(w, h); }
            DrawBanner(w, h);
            if (view == View.Ended) DrawEnd(w, h);
        }

        // ================================================================ lobby

        Texture2D Thumb(MapDef m)
        {
            if (thumbs.TryGetValue(m.id, out var t) && t) return t;
            const int P = 5;
            int W0 = Mathf.CeilToInt((float)m.width * P), H0 = Mathf.CeilToInt((float)m.height * P);
            t = new Texture2D(W0, H0, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[W0 * H0];
            for (int i = 0; i < px.Length; i++) px[i] = new Color32(52, 50, 47, 255);
            void Rect(Rect2 r, Color32 c)
            {
                int x0 = Mathf.Max(0, Mathf.FloorToInt((float)r.x * P)), x1 = Mathf.Min(W0, Mathf.CeilToInt((float)(r.x + r.w) * P));
                int y0 = Mathf.Max(0, Mathf.FloorToInt((float)r.y * P)), y1 = Mathf.Min(H0, Mathf.CeilToInt((float)(r.y + r.h) * P));
                for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) px[(H0 - 1 - y) * W0 + x] = c;
            }
            foreach (var s in m.sites) Rect(s.rect, new Color32(120, 58, 52, 255));
            foreach (var tp in m.teleporters) Rect(tp.pad, new Color32(90, 170, 200, 255));
            foreach (var wl in m.walls)
            {
                Rect(wl, new Color32(214, 206, 192, 255));
            }
            t.SetPixels32(px);
            t.Apply(false);
            thumbs[m.id] = t;
            return t;
        }

        void DrawLobby(float w, float h)
        {
            // A left-hand column over the live 3D preview of the selected map.
            float pw = Mathf.Min(560 * S, w * 0.5f);
            Fill(new Rect(0, 0, pw + 40 * S, h), new Color(0.02f, 0.02f, 0.05f, 0.72f));
            Fill(new Rect(pw + 40 * S, 0, 2 * S, h), new Color(Gfx.Ally.r, Gfx.Ally.g, Gfx.Ally.b, 0.6f));
            float x = 36 * S, y = 28 * S, cw = pw - 32 * S;

            // Title: a stacked wordmark with a tape-stripe underline.
            Glow(new Rect(x - 40 * S, y - 30 * S, 420 * S, 180 * S), new Color(1f, 0.5f, 0.2f, 0.18f));
            Text(new Rect(x, y, cw, 60 * S), "REWIND", St(56, true, TextAnchor.UpperLeft, true), Gfx.Label);
            Text(new Rect(x, y + 48 * S, cw, 60 * S), "DUEL", St(56, true, TextAnchor.UpperLeft, true), Gfx.Rec);
            float sx = x;
            Fill(new Rect(sx, y + 110 * S, 120 * S, 4 * S), Gfx.Rec);
            Text(new Rect(x, y + 120 * S, cw, 40 * S), "One on one, first person. First to five rounds. Every tick is recorded, and the AI learns how you play.", St(13, false, TextAnchor.UpperLeft, false, true), new Color(1, 1, 1, 0.7f), false);
            y += 166 * S;

            bool busy = view == View.Connecting;
            GUI.enabled = !busy;
            float tw = (cw - 3 * 8 * S) / 4;
            for (int i = 0; i < ModeNames.Length; i++)
                if (Chip(new Rect(x + i * (tw + 8 * S), y, tw, 34 * S), ModeNames[i], mode == i, Gfx.Ally, !busy))
                {
                    mode = i;
                    status = "";
                    if (mode == 3) StartCoroutine(LoadReplays());
                }
            y += 48 * S;
            string blurb = mode == 0 ? "The AI tracks where you probably are, calls your play before it sees you, learns your habits and plays at your rank."
                : mode == 1 ? "Fight a clone of yourself, built from every match you have recorded under this name."
                : mode == 2 ? "Pick a room code and send it to a friend. You both vote for a map."
                : "Watch any recorded match in 3D, scrub to any moment, and take control from there. The AI takes over your opponent once you change what happened.";
            Text(new Rect(x, y, cw, 40 * S), blurb, St(12, false, TextAnchor.UpperLeft, false, true), new Color(1, 1, 1, 0.62f), false);
            y += 44 * S;

            Text(new Rect(x, y, cw, 18 * S), "YOUR NAME", St(11, true, TextAnchor.UpperLeft), Gfx.Ally, false);
            playerName = Field(new Rect(x, y + 18 * S, cw * 0.5f - 6 * S, 30 * S), playerName, 16);
            if (mode == 2)
            {
                Text(new Rect(x + cw * 0.5f + 6 * S, y, cw, 18 * S), "ROOM CODE", St(11, true, TextAnchor.UpperLeft), Gfx.Ally, false);
                roomCode = Field(new Rect(x + cw * 0.5f + 6 * S, y + 18 * S, cw * 0.5f - 6 * S, 30 * S), roomCode, 16);
            }
            y += 62 * S;

            if (catalog == null)
            {
                Text(new Rect(x, y, cw, 60 * S), catalogLoading ? "Reaching the server…" : catalogError ?? "", St(13, false, TextAnchor.UpperLeft, false, true), catalogLoading ? Gfx.Label : Gfx.Rec, false);
                if (!catalogLoading && Chip(new Rect(x, y + 64 * S, 140 * S, 32 * S), "RETRY", false, Gfx.Ally)) StartCoroutine(LoadCatalog());
                y += 110 * S;
            }
            else if (mode == 3) y = DrawReplays(x, y, cw, h);
            else
            {
                Text(new Rect(x, y, cw, 18 * S), "MAP", St(11, true, TextAnchor.UpperLeft), Gfx.Ally, false);
                y += 20 * S;
                int cols = 3;
                float mw = (cw - (cols - 1) * 10 * S) / cols, mh = mw * 0.48f + 34 * S;
                var cards = new List<MapDef> { null };
                cards.AddRange(catalog.maps);
                for (int i = 0; i < cards.Count; i++)
                {
                    var r = new Rect(x + (i % cols) * (mw + 10 * S), y + (i / cols) * (mh + 10 * S), mw, mh);
                    var m = cards[i];
                    string id = m?.id ?? "random";
                    bool on = mapVote == id, hover = r.Contains(Event.current.mousePosition);
                    Panel(r, on ? new Color(Gfx.Ally.r, Gfx.Ally.g, Gfx.Ally.b, 0.95f) : hover ? new Color(1, 1, 1, 0.2f) : new Color(1, 1, 1, 0.08f));
                    var img = new Rect(r.x + 4 * S, r.y + 4 * S, r.width - 8 * S, r.width * 0.48f - 8 * S);
                    if (m != null) GUI.DrawTexture(img, Thumb(m), ScaleMode.ScaleToFit);
                    else { Fill(img, new Color(0.06f, 0.07f, 0.12f)); Text(img, "?", St(40, true, TextAnchor.MiddleCenter, true), Gfx.Ally); }
                    Color tc = on ? Gfx.Ink : Gfx.Label;
                    Text(new Rect(r.x + 8 * S, img.yMax + 2 * S, r.width, 18 * S), (m?.name ?? "Random").ToUpperInvariant(), St(13, true, TextAnchor.UpperLeft, true), tc, false);
                    Text(new Rect(r.x + 8 * S, img.yMax + 17 * S, r.width, 14 * S), m == null ? "any map" : m.sites.Count + " sites" + (m.teleporters.Count > 0 ? " · teleporters" : ""), St(10, false, TextAnchor.UpperLeft), new Color(tc.r, tc.g, tc.b, 0.7f), false);
                    if (!busy && Event.current.type == EventType.MouseDown && hover) { mapVote = id; Event.current.Use(); ShowLobbyMap(); }
                }
                y += ((cards.Count + cols - 1) / cols) * (mh + 10 * S) + 4 * S;

                if (mode == 0)
                {
                    Text(new Rect(x, y, cw, 18 * S), "DIFFICULTY", St(11, true, TextAnchor.UpperLeft), Gfx.Ally, false);
                    y += 20 * S;
                    float dw = (cw - (catalog.difficulties.Count - 1) * 6 * S) / catalog.difficulties.Count;
                    for (int i = 0; i < catalog.difficulties.Count; i++)
                    {
                        var d = catalog.difficulties[i];
                        if (Chip(new Rect(x + i * (dw + 6 * S), y, dw, 30 * S), d.ToUpperInvariant(), rankPick < 0 && difficulty == d, d == "adaptive" ? Gfx.Violet : Gfx.Ally, !busy)) { difficulty = d; rankPick = -1; }
                    }
                    y += 38 * S;
                    if (catalog.ranks.Count > 0)
                    {
                        string rl = rankPick >= 0 ? "OR A FIXED RANK:  " + catalog.ranks[rankPick].label.ToUpperInvariant() : "OR PICK A FIXED RANK";
                        Text(new Rect(x, y, cw, 18 * S), rl, St(11, true, TextAnchor.UpperLeft), rankPick >= 0 ? catalog.ranks[rankPick].color : new Color(1, 1, 1, 0.55f), false);
                        float v = GUI.HorizontalSlider(new Rect(x, y + 22 * S, cw, 16 * S), rankPick < 0 ? -1 : rankPick, -1, catalog.ranks.Count - 1);
                        int nv = Mathf.RoundToInt(v);
                        if (nv != rankPick) rankPick = nv;
                        y += 44 * S;
                    }
                }
            }

            Text(new Rect(x, y, cw, 18 * S), "SERVER  (ws://… or a pasted https:// tunnel link)", St(10, true, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.45f), false);
            string before = serverUrl;
            serverUrl = Field(new Rect(x, y + 16 * S, cw, 26 * S), serverUrl, 200);
            if (serverUrl != before) catalog = null;
            if (catalog == null && !catalogLoading && serverUrl != before) StartCoroutine(LoadCatalog());
            y += 52 * S;

            GUI.enabled = true;
            if (mode != 3)
            {
                var go = new Rect(x, y, cw, 52 * S);
                bool hover = go.Contains(Event.current.mousePosition);
                Glow(new Rect(go.x - 30 * S, go.y - 26 * S, go.width + 60 * S, go.height + 52 * S), new Color(1f, 0.55f, 0.15f, hover ? 0.45f : 0.25f));
                Panel(go, busy ? new Color(1, 1, 1, 0.15f) : hover ? new Color(1f, 0.75f, 0.35f) : Gfx.Ally);
                string label = busy ? (mode == 2 ? "WAITING…" : "CONNECTING…") : mode == 0 ? "PLAY THE AI" : mode == 1 ? "FIGHT YOURSELF" : "JOIN ROOM";
                Text(go, label, St(24, true, TextAnchor.MiddleCenter, true), Gfx.Ink, false);
                bool enter = Event.current.type == EventType.KeyDown && (Event.current.keyCode == KeyCode.Return || Event.current.keyCode == KeyCode.KeypadEnter);
                if (!busy && catalog != null && ((Event.current.type == EventType.MouseDown && hover) || enter)) { Event.current.Use(); Join(); }
                if (busy && Chip(new Rect(go.xMax - 110 * S, go.yMax + 8 * S, 110 * S, 26 * S), "CANCEL", false, Gfx.Rec)) LeaveToLobby();
                y += 62 * S;
            }
            Text(new Rect(x, y, cw - 120 * S, 60 * S), status ?? "", St(12, false, TextAnchor.UpperLeft, false, true), status != null && status.StartsWith("In room") ? Gfx.Enemy : Gfx.Rec, false);

            // Right side: what the preview shows.
            if (map != null)
            {
                Text(new Rect(pw + 80 * S, h - 140 * S, w - pw - 120 * S, 60 * S), map.name.ToUpperInvariant(), St(54, true, TextAnchor.LowerRight, true), Gfx.Label);
                Text(new Rect(pw + 80 * S, h - 78 * S, w - pw - 120 * S, 24 * S), map.blurb, St(14, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.7f));
                Text(new Rect(pw + 80 * S, h - 52 * S, w - pw - 120 * S, 20 * S), "WASD move · Shift walk · Mouse aim & fire · R reload · Q smoke · E dash · C flash · F plant/defuse · B buy · 1/2 swap · F1 studio · I AI mind · T trace", St(11, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.45f));
            }
        }

        string Field(Rect r, string value, int max)
        {
            Panel(r, new Color(1, 1, 1, 0.1f));
            var st = new GUIStyle(GUI.skin.textField) { font = body, fontSize = Mathf.RoundToInt(15 * S), alignment = TextAnchor.MiddleLeft, padding = new RectOffset((int)(10 * S), 6, 2, 2) };
            st.normal.background = st.focused.background = st.hover.background = null;
            st.normal.textColor = st.focused.textColor = st.hover.textColor = Gfx.Label;
            return GUI.TextField(r, value ?? "", max, st);
        }

        float DrawReplays(float x, float y, float cw, float h)
        {
            Text(new Rect(x, y, cw, 18 * S), "RECORDINGS  ·  click a match or a round to watch it", St(11, true, TextAnchor.UpperLeft), Gfx.Ally, false);
            if (Chip(new Rect(x + cw - 90 * S, y - 4 * S, 90 * S, 22 * S), replaysLoading ? "…" : "REFRESH", false, Gfx.Ally)) StartCoroutine(LoadReplays());
            y += 24 * S;
            var box = new Rect(x, y, cw, Mathf.Min(h - y - 160 * S, 420 * S));
            float rowH = 64 * S;
            var content = new Rect(0, 0, cw - 16 * S, Mathf.Max(box.height, replays.Count * (rowH + 6 * S)));
            replayScroll = GUI.BeginScrollView(box, replayScroll, content);
            for (int i = 0; i < replays.Count; i++)
            {
                var m = replays[i];
                var r = new Rect(0, i * (rowH + 6 * S), content.width, rowH);
                Panel(r, new Color(1, 1, 1, 0.07f));
                var players = Json.Arr(m, "players");
                string vs = players != null && players.Count == 2 ? Json.Str(players[0], "name") + "  vs  " + Json.Str(players[1], "name") : Json.Str(m, "id");
                var score = Json.Arr(m, "score");
                string mapName = catalog?.Map(Json.Str(m, "map"))?.name ?? Json.Str(m, "map");
                Text(new Rect(r.x + 10 * S, r.y + 4 * S, r.width, 20 * S), vs, St(13, true, TextAnchor.UpperLeft, true), Gfx.Label, false);
                Text(new Rect(r.x + 10 * S, r.y + 4 * S, r.width - 20 * S, 20 * S), (mapName ?? "").ToUpperInvariant() + (score != null ? "   " + score[0] + " – " + score[1] : ""), St(11, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.6f), false);
                if (Event.current.type == EventType.MouseDown && new Rect(r.x, r.y, r.width, 28 * S).Contains(Event.current.mousePosition))
                {
                    Event.current.Use();
                    StartCoroutine(OpenReplay(Json.Str(m, "id"), 0));
                }
                var rounds = Json.Arr(m, "rounds");
                if (rounds == null) continue;
                float bx = r.x + 10 * S;
                foreach (var rd in rounds)
                {
                    if (bx > r.xMax - 40 * S) break;
                    var br = new Rect(bx, r.y + 30 * S, 32 * S, 26 * S);
                    if (Chip(br, ((int)Json.Num(rd, "round")).ToString(), false, Gfx.Ally)) StartCoroutine(OpenReplay(Json.Str(m, "id"), (int)Json.Num(rd, "startTick")));
                    bx += 36 * S;
                }
            }
            if (replays.Count == 0) Text(new Rect(0, 0, content.width, 40 * S), replaysLoading ? "Loading…" : "No recordings yet. Play a match first.", St(12, false, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.5f), false);
            GUI.EndScrollView();
            return y + box.height + 12 * S;
        }

        // ================================================================ in-match HUD

        void DrawHud(float w, float h)
        {
            var self = Json.Obj(obs, "self");
            var score = Json.Arr(obs, "score");
            int me = slot, them = 1 - slot;
            bool attacking = (int)Json.Num(obs, "attacker") == me;
            string phase = Json.Str(obs, "phase");
            bool alive = Json.Num(self, "hp") > 0;
            float t = Time.time;

            // Screen-wide washes: blind, damage, warp, kill.
            if (hurtFlash > 0) { var o = GUI.color; GUI.color = new Color(1, 0.1f, 0.12f, hurtFlash * 0.5f); GUI.DrawTexture(new Rect(-w * 0.25f, -h * 0.25f, w * 1.5f, h * 1.5f), Gfx.Ring); GUI.color = o; }
            if (warpFlash > 0) Fill(new Rect(0, 0, w, h), new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, warpFlash * 0.45f));

            DrawWorldMarks(w, h, self);
            DrawCrosshair(w, h, self, alive);
            DrawHurtArc(w, h);
            DrawMinimap(self);
            DrawTopBar(w, h, score, me, them, attacking);
            DrawBottom(w, h, self, alive);
            DrawFeed(w, h);
            DrawToasts(w, h);
            bool menuUp = BuyPhase() && HasEconomy() && buyOpen;
            if (studio && view == View.Playing && !menuUp) DrawStudio(w, h, self);
            else if (showTrace && view == View.Playing && !menuUp) DrawTrace(w, h);

            // Plant / defuse prompts and progress.
            var sk = Json.Obj(obs, "spike");
            bool planted = Json.Str(sk, "state") == "planted";
            double sxp = Json.Num(self, "x"), syp = Json.Num(self, "y");
            string hint = null;
            var site = map?.SiteAt(sxp, syp);
            if (attacking && Json.Str(sk, "state") == "carried" && site != null) hint = "HOLD F TO PLANT ON " + site.label;
            if (!attacking && planted && Math.Sqrt((sxp - Json.Num(sk, "x")) * (sxp - Json.Num(sk, "x")) + (syp - Json.Num(sk, "y")) * (syp - Json.Num(sk, "y"))) <= DefuseRange) hint = "HOLD F TO DEFUSE";
            if (hint != null && phase == "live" && alive) Text(new Rect(0, h / 2 + 70 * S, w, 26 * S), hint, St(16, true, TextAnchor.MiddleCenter, true), Gfx.Ally);
            int use = (int)Json.Num(self, "useTicks");
            if (use > 0)
            {
                float frac = Mathf.Clamp01(use / (float)(attacking ? PlantTicks : DefuseTicks));
                var bar = new Rect(w / 2 - 140 * S, h / 2 + 100 * S, 280 * S, 8 * S);
                Panel(new Rect(bar.x - 4 * S, bar.y - 4 * S, bar.width + 8 * S, bar.height + 8 * S), new Color(0, 0, 0, 0.5f));
                Fill(new Rect(bar.x, bar.y, bar.width * frac, bar.height), attacking ? Gfx.Rec : Gfx.Enemy);
            }

            if (!alive && phase == "live") Text(new Rect(0, h * 0.68f, w, 30 * S), "YOU ARE DOWN · THE ROUND PLAYS OUT", St(16, true, TextAnchor.MiddleCenter, true), Gfx.Rec);
            if (phase == "roundEnd" && lastRoundWinner >= 0)
            {
                bool won = lastRoundWinner == me;
                Glow(new Rect(w / 2 - 420 * S, h * 0.42f - 120 * S, 840 * S, 240 * S), new Color(won ? 1 : 1, won ? 0.6f : 0.15f, won ? 0.2f : 0.2f, 0.35f));
                Text(new Rect(0, h * 0.42f - 50 * S, w, 80 * S), won ? "ROUND WON" : "ROUND LOST", St(64, true, TextAnchor.MiddleCenter, true), won ? Gfx.Ally : Gfx.Rec);
                Text(new Rect(0, h * 0.42f + 26 * S, w, 26 * S), Reason(lastRoundReason, won), St(15, false, TextAnchor.MiddleCenter), Gfx.Label);
            }

            // Buy menu.
            if (BuyPhase() && HasEconomy() && buyOpen && alive) DrawBuy(w, h, self);
            else if (BuyPhase() && HasEconomy() && alive) Text(new Rect(0, h * 0.2f, w, 24 * S), "BUY PHASE · press B to open the buy menu", St(14, true, TextAnchor.MiddleCenter, true), Gfx.Gold);

            // Blind: pure white, fading with the server's countdown.
            if (blindFade > 0.01f) Fill(new Rect(0, 0, w, h), new Color(1, 1, 1, Mathf.Clamp01(blindFade * 1.05f)));

            if (Cursor.lockState != CursorLockMode.Locked && !(BuyPhase() && buyOpen) && view == View.Playing)
                Text(new Rect(0, h * 0.62f, w, 30 * S), "CLICK TO AIM · ESC FREES THE MOUSE", St(15, true, TextAnchor.MiddleCenter, true), Gfx.Label);
        }

        void DrawWorldMarks(float w, float h, Dictionary<string, object> self)
        {
            // The rival's health over their head, only while they are visible.
            var e = Json.Obj(obs, "enemy");
            if (e != null && enemyDrawValid)
            {
                var g = ToGui(enemyDraw + Vector3.up * 2.05f);
                if (g.HasValue)
                {
                    float hp = (float)Json.Num(e, "hp");
                    var bar = new Rect(g.Value.x - 34 * S, g.Value.y, 68 * S, 6 * S);
                    Fill(new Rect(bar.x - 1, bar.y - 1, bar.width + 2, bar.height + 2), new Color(0, 0, 0, 0.6f));
                    Fill(new Rect(bar.x, bar.y, bar.width * Mathf.Clamp01(hp / 100f), bar.height), Gfx.Enemy);
                    Text(new Rect(g.Value.x - 100 * S, g.Value.y - 18 * S, 200 * S, 16 * S), NameOf(1 - slot).ToUpperInvariant(), St(11, true, TextAnchor.MiddleCenter, true), Gfx.Enemy);
                }
            }

            // Footsteps or shots heard through a wall: a pulsing marker clamped to the screen edge.
            var heard = Json.Obj(obs, "heard");
            if (heard != null)
            {
                var wp = W(Json.Num(heard, "x"), Json.Num(heard, "y"), 1f);
                bool shot = Json.Str(heard, "kind") == "shot";
                var sp = cam.WorldToScreenPoint(wp);
                var p = new Vector2(sp.x, h - sp.y);
                if (sp.z < 0) p = new Vector2(w - p.x, h - p.y);
                bool off = sp.z < 0 || p.x < 40 * S || p.x > w - 40 * S || p.y < 40 * S || p.y > h - 40 * S;
                p = new Vector2(Mathf.Clamp(p.x, 40 * S, w - 40 * S), Mathf.Clamp(p.y, 40 * S, h - 40 * S));
                float pulse = 0.6f + 0.4f * Mathf.Sin(Time.time * 10f);
                var c = shot ? Gfx.Rec : Gfx.Violet;
                Glow(new Rect(p.x - 36 * S, p.y - 36 * S, 72 * S, 72 * S), new Color(c.r, c.g, c.b, 0.5f * pulse));
                var o = GUI.color; GUI.color = new Color(c.r, c.g, c.b, pulse); GUI.DrawTexture(new Rect(p.x - 16 * S, p.y - 16 * S, 32 * S, 32 * S), Gfx.Ring); GUI.color = o;
                Text(new Rect(p.x - 80 * S, p.y + 16 * S, 160 * S, 16 * S), shot ? "GUNFIRE" : off ? "STEPS ›" : "STEPS", St(10, true, TextAnchor.MiddleCenter, true), c);
            }

            // Damage numbers rising off the rival.
            for (int i = popups.Count - 1; i >= 0; i--)
            {
                var pp = popups[i];
                float k = (Time.time - pp.at) / 0.9f;
                if (k >= 1) { popups.RemoveAt(i); continue; }
                var g = ToGui(pp.pos + Vector3.up * k * 0.8f);
                if (!g.HasValue) continue;
                Text(new Rect(g.Value.x - 60 * S, g.Value.y - 20 * S, 120 * S, 40 * S), pp.text, St(pp.c == Gfx.Gold ? 30 : 22, true, TextAnchor.MiddleCenter, true), new Color(pp.c.r, pp.c.g, pp.c.b, 1 - k * k));
            }
        }

        void DrawCrosshair(float w, float h, Dictionary<string, object> self, bool alive)
        {
            if (!alive) return;
            // The gap is the real spread for the gun in hand, how you are moving and how long you have sprayed.
            int ms = (int)Json.Num(self, "moveState");
            int gun = (int)Json.Num(self, "equipped") == 1 ? (int)Json.Num(self, "secondary", 1) : (int)Json.Num(self, "primary", 0);
            var wd = catalog?.Weapon(gun);
            float deg = wd != null ? wd.spread[ms] + Mathf.Min(wd.bloomCap, wd.bloom * (float)Json.Num(self, "spray")) : new[] { 1f, 4f, 10f }[ms];
            float gap = 5 * S + Mathf.Tan(deg * Mathf.Deg2Rad) / Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad) * h / 2;
            var c = hitFlash > 0 ? Color.Lerp(Gfx.Label, Gfx.Rec, hitFlash) : Gfx.Label;
            float len = 9 * S, th = Mathf.Max(2, 2 * S);
            Fill(new Rect(w / 2 - gap - len, h / 2 - th / 2, len, th), c);
            Fill(new Rect(w / 2 + gap, h / 2 - th / 2, len, th), c);
            Fill(new Rect(w / 2 - th / 2, h / 2 - gap - len, th, len), c);
            Fill(new Rect(w / 2 - th / 2, h / 2 + gap, th, len), c);
            Fill(new Rect(w / 2 - 1, h / 2 - 1, 2, 2), c);
            // A hit marker: an X that flashes on every hit, gold on a headshot.
            if (hitFlash > 0 && Event.current.type == EventType.Repaint)
            {
                GLBegin(GL.QUADS);
                GL.Color(new Color(1f, 1f, 1f, hitFlash));
                float a = 8 * S, b = 16 * S, tt = 1.6f * S;
                foreach (var (dx, dy) in new[] { (1, 1), (-1, 1), (1, -1), (-1, -1) })
                {
                    Vector2 p0 = new Vector2(w / 2 + dx * a, h / 2 + dy * a), p1 = new Vector2(w / 2 + dx * b, h / 2 + dy * b);
                    var n = new Vector2(-dy, dx).normalized * tt;
                    GL.Vertex3(p0.x + n.x, p0.y + n.y, 0); GL.Vertex3(p1.x + n.x, p1.y + n.y, 0); GL.Vertex3(p1.x - n.x, p1.y - n.y, 0); GL.Vertex3(p0.x - n.x, p0.y - n.y, 0);
                }
                GLEnd();
            }
        }

        /// A red arc around the crosshair pointing at whoever just hit you.
        void DrawHurtArc(float w, float h)
        {
            float k = (Time.time - hurtAt) / 1.2f;
            if (k >= 1 || Event.current.type != EventType.Repaint || obs == null) return;
            var self = Json.Obj(obs, "self");
            double dx = hurtFrom.x - Json.Num(self, "x"), dy = hurtFrom.y - Json.Num(self, "y");
            // Angle of the shooter relative to where you look, clockwise from screen-up.
            float rel = YawFromAim(Math.Atan2(dy, dx)) - yaw;
            float r0 = 120 * S, r1 = 134 * S;
            GLBegin(GL.TRIANGLES);
            for (int i = 0; i < 16; i++)
            {
                float a0 = (rel - 22 + i * 44f / 16) * Mathf.Deg2Rad, a1 = (rel - 22 + (i + 1) * 44f / 16) * Mathf.Deg2Rad;
                float fade = (1 - k) * (1 - Mathf.Abs(i - 7.5f) / 8f);
                GL.Color(new Color(1f, 0.15f, 0.18f, fade));
                Vector2 P(float a, float r) => new Vector2(w / 2 + Mathf.Sin(a) * r, h / 2 - Mathf.Cos(a) * r);
                var q0 = P(a0, r0); var q1 = P(a0, r1); var q2 = P(a1, r1); var q3 = P(a1, r0);
                GL.Vertex3(q0.x, q0.y, 0); GL.Vertex3(q1.x, q1.y, 0); GL.Vertex3(q2.x, q2.y, 0);
                GL.Vertex3(q0.x, q0.y, 0); GL.Vertex3(q2.x, q2.y, 0); GL.Vertex3(q3.x, q3.y, 0);
            }
            GLEnd();
        }

        void DrawMinimap(Dictionary<string, object> self)
        {
            if (map == null) return;
            float mw = 250 * S, mh = mw * (float)(map.height / map.width);
            var r = new Rect(18 * S, 18 * S, mw, mh);
            Panel(new Rect(r.x - 6 * S, r.y - 6 * S, r.width + 12 * S, r.height + 30 * S), new Color(0.02f, 0.02f, 0.05f, 0.72f));
            GUI.DrawTexture(r, Thumb(map));
            if (mindMini && mindBytes != null) GUI.DrawTexture(r, mindMini);
            Vector2 M(double x, double y) => new Vector2(r.x + (float)(x / map.width) * r.width, r.y + (float)(y / map.height) * r.height);

            var p = predictor.Pos != null ? new Vector2((float)predictor.Pos.x, (float)predictor.Pos.y) : new Vector2((float)Json.Num(self, "x"), (float)Json.Num(self, "y"));
            if (Event.current.type == EventType.Repaint)
            {
                // Your view cone: 100 degrees, 30 units, the same rule the server uses for what you can see.
                double aim = AimFromYaw(yaw);
                float scale = r.width / (float)map.width;
                var c0 = M(p.x, p.y);
                GLBegin(GL.TRIANGLES);
                for (int i = 0; i < 20; i++)
                {
                    double a0 = aim - 50 * Mathf.Deg2Rad + i * (100 * Mathf.Deg2Rad) / 20, a1 = aim - 50 * Mathf.Deg2Rad + (i + 1) * (100 * Mathf.Deg2Rad) / 20;
                    GL.Color(new Color(1f, 0.7f, 0.3f, 0.16f));
                    GL.Vertex3(c0.x, c0.y, 0);
                    GL.Color(new Color(1f, 0.7f, 0.3f, 0.0f));
                    GL.Vertex3(c0.x + (float)Math.Cos(a0) * 30 * scale, c0.y + (float)Math.Sin(a0) * 30 * scale, 0);
                    GL.Vertex3(c0.x + (float)Math.Cos(a1) * 30 * scale, c0.y + (float)Math.Sin(a1) * 30 * scale, 0);
                }
                GLEnd();
            }
            void Dot(Vector2 at, Color c, float size)
            {
                Glow(new Rect(at.x - size * 2, at.y - size * 2, size * 4, size * 4), new Color(c.r, c.g, c.b, 0.6f));
                Fill(new Rect(at.x - size / 2, at.y - size / 2, size, size), c);
            }
            Dot(M(p.x, p.y), Gfx.Ally, 7 * S);
            var e = Json.Obj(obs, "enemy");
            if (e != null) Dot(M(Json.Num(e, "x"), Json.Num(e, "y")), Gfx.Enemy, 7 * S);
            var ls = Json.Obj(obs, "lastSeenEnemy");
            if (e == null && ls != null && Json.Num(ls, "ticksAgo") < 5 * TickRate) Dot(M(Json.Num(ls, "x"), Json.Num(ls, "y")), new Color(Gfx.Enemy.r, Gfx.Enemy.g, Gfx.Enemy.b, 0.4f), 6 * S);
            var heard = Json.Obj(obs, "heard");
            if (heard != null) Dot(M(Json.Num(heard, "x"), Json.Num(heard, "y")), Gfx.Violet, 6 * S);
            var sk = Json.Obj(obs, "spike");
            if (Json.Str(sk, "state") == "planted") Dot(M(Json.Num(sk, "x"), Json.Num(sk, "y")), Gfx.Rec, 7 * S * (1 + 0.3f * Mathf.Sin(Time.time * 10)));
            foreach (var s in map.sites)
                Text(new Rect(M(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2).x - 10 * S, M(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2).y - 10 * S, 20 * S, 20 * S), s.label, St(12, true, TextAnchor.MiddleCenter, true), new Color(1, 0.5f, 0.5f));
            string mindLabel = mindBytes == null ? map.name.ToUpperInvariant() : (showMind ? "AI MIND ON FLOOR · I" : "AI MIND · I TO PROJECT");
            Text(new Rect(r.x, r.yMax + 4 * S, r.width, 16 * S), mindLabel, St(10, true, TextAnchor.UpperLeft, true), mindBytes == null ? new Color(1, 1, 1, 0.5f) : Gfx.Violet, false);
        }

        void DrawTopBar(float w, float h, List<object> score, int me, int them, bool attacking)
        {
            float bw = 520 * S, bx = w / 2 - bw / 2, by = 14 * S;
            Panel(new Rect(bx, by, bw, 58 * S), new Color(0.02f, 0.02f, 0.05f, 0.72f));
            Fill(new Rect(bx + 16 * S, by + 54 * S, bw / 2 - 30 * S, 3 * S), Gfx.Ally);
            Fill(new Rect(w / 2 + 14 * S, by + 54 * S, bw / 2 - 30 * S, 3 * S), Gfx.Enemy);
            Text(new Rect(bx + 10 * S, by, 70 * S, 54 * S), ((double)score[me]).ToString("0"), St(40, true, TextAnchor.MiddleCenter, true), Gfx.Ally);
            Text(new Rect(bx + 74 * S, by + 4 * S, 150 * S, 24 * S), NameOf(me).ToUpperInvariant(), St(14, true, TextAnchor.MiddleLeft, true), Gfx.Label);
            Text(new Rect(bx + 74 * S, by + 26 * S, 150 * S, 20 * S), attacking ? "ATTACK" : "DEFEND", St(11, true, TextAnchor.MiddleLeft), attacking ? Gfx.Ally : Gfx.Enemy);
            Text(new Rect(bx + bw - 224 * S, by + 4 * S, 150 * S, 24 * S), NameOf(them).ToUpperInvariant(), St(14, true, TextAnchor.MiddleRight, true), Gfx.Label);
            Text(new Rect(bx + bw - 224 * S, by + 26 * S, 150 * S, 20 * S), "ROUND " + (int)Json.Num(obs, "round"), St(11, true, TextAnchor.MiddleRight), new Color(1, 1, 1, 0.55f));
            Text(new Rect(bx + bw - 80 * S, by, 70 * S, 54 * S), ((double)score[them]).ToString("0"), St(40, true, TextAnchor.MiddleCenter, true), Gfx.Enemy);

            var sk = Json.Obj(obs, "spike");
            bool planted = Json.Str(sk, "state") == "planted";
            int left = Mathf.Max(0, (int)Json.Num(obs, "roundTicksLeft") / TickRate);
            if (planted) left = (int)Json.Num(sk, "ticksLeft") / TickRate;
            bool buying = BuyPhase() && HasEconomy();
            var clockR = new Rect(w / 2 - 60 * S, by + 2 * S, 120 * S, 50 * S);
            if (planted) Glow(new Rect(clockR.x - 30 * S, clockR.y - 30 * S, clockR.width + 60 * S, clockR.height + 60 * S), new Color(1, 0.1f, 0.15f, 0.4f + 0.3f * Mathf.Sin(Time.time * 8)));
            string clock = planted ? "◆ " + left : (left / 60) + ":" + (left % 60).ToString("00");
            Text(clockR, clock, St(34, true, TextAnchor.MiddleCenter, true), planted || left <= 10 ? Gfx.Rec : Gfx.Label);
            if (buying)
            {
                float bt = (catalog.buyTicks - (catalog.roundTicks - (float)Json.Num(obs, "roundTicksLeft"))) / TickRate;
                Text(new Rect(w / 2 - 100 * S, by + 60 * S, 200 * S, 18 * S), "BUY " + bt.ToString("0.0", CultureInfo.InvariantCulture) + "s", St(12, true, TextAnchor.MiddleCenter, true), Gfx.Gold);
            }

            // The AI's rank and level, your rank, and how often it has called your play.
            float cx = bx + bw + 14 * S;
            var aiR = Json.Obj(ranks, "ai") ?? Json.Obj(aiInfo, "rank");
            if (aiR != null) cx = RankChip(cx, by + 4 * S, "AI", Json.Str(aiR, "label"), Catalog.Hex(Json.Str(aiR, "color"), Gfx.Violet), aiLevel.HasValue ? aiLevel.Value.ToString() : null);
            var youR = Json.Obj(ranks, "you");
            if (youR != null) cx = RankChip(cx, by + 4 * S, "YOU", Json.Str(youR, "label"), Catalog.Hex(Json.Str(youR, "color"), Gfx.Ally), null);
            var reads = Json.Obj(ranks, "reads");
            if (reads != null && Json.Num(reads, "made") > 0)
                RankChip(cx, by + 4 * S, "READS", (int)Json.Num(reads, "correct") + "/" + (int)Json.Num(reads, "made"), Gfx.Violet, null);
            if (rewindInfo != null)
            {
                var rr = new Rect(bx - 190 * S, by + 4 * S, 176 * S, 50 * S);
                Panel(rr, new Color(Gfx.Rec.r, Gfx.Rec.g, Gfx.Rec.b, 0.85f));
                Text(new Rect(rr.x, rr.y + 4 * S, rr.width, 22 * S), "◀◀ REWIND", St(16, true, TextAnchor.MiddleCenter, true), Gfx.Ink, false);
                string orig = Json.Str(rewindInfo, "originalOutcome");
                Text(new Rect(rr.x, rr.y + 26 * S, rr.width, 18 * S), "round " + (int)Json.Num(rewindInfo, "round") + (orig != null ? " · originally " + orig : ""), St(10, true, TextAnchor.MiddleCenter), Gfx.Ink, false);
            }
        }

        float RankChip(float x, float y, string who, string label, Color c, string extra)
        {
            string text = label + (extra != null ? "  ·  " + extra : "");
            float cw = Mathf.Max(96 * S, St(13, true, TextAnchor.MiddleCenter, true).CalcSize(new GUIContent(text)).x + 24 * S);
            var r = new Rect(x, y, cw, 50 * S);
            Panel(r, new Color(0.02f, 0.02f, 0.05f, 0.72f));
            Fill(new Rect(r.x + 10 * S, r.yMax - 6 * S, r.width - 20 * S, 2 * S), c);
            Text(new Rect(r.x, r.y + 3 * S, r.width, 16 * S), who, St(10, true, TextAnchor.MiddleCenter), new Color(1, 1, 1, 0.55f), false);
            Text(new Rect(r.x, r.y + 18 * S, r.width, 22 * S), text, St(13, true, TextAnchor.MiddleCenter, true), c);
            return r.xMax + 8 * S;
        }

        void DrawBottom(float w, float h, Dictionary<string, object> self, bool alive)
        {
            // Health and shields.
            float hp = (float)Json.Num(self, "hp"), armor = (float)Json.Num(self, "armor");
            var hr = new Rect(18 * S, h - 92 * S, 300 * S, 74 * S);
            Panel(hr, new Color(0.02f, 0.02f, 0.05f, 0.72f));
            Text(new Rect(hr.x + 14 * S, hr.y + 4 * S, 110 * S, 50 * S), hp.ToString("0"), St(44, true, TextAnchor.MiddleLeft, true), hp <= 30 ? Gfx.Rec : Gfx.Label);
            Text(new Rect(hr.x + 14 * S, hr.y + 50 * S, 120 * S, 16 * S), "HEALTH", St(10, true, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.5f), false);
            var bar = new Rect(hr.x + 120 * S, hr.y + 22 * S, 164 * S, 8 * S);
            Fill(bar, new Color(1, 1, 1, 0.08f));
            Fill(new Rect(bar.x, bar.y, bar.width * Mathf.Clamp01(hp / 100f), bar.height), hp <= 30 ? Gfx.Rec : Gfx.Label);
            var abar = new Rect(hr.x + 120 * S, hr.y + 40 * S, 164 * S, 6 * S);
            Fill(abar, new Color(1, 1, 1, 0.06f));
            Fill(new Rect(abar.x, abar.y, abar.width * Mathf.Clamp01(armor / 50f), abar.height), Gfx.Enemy);
            Text(new Rect(abar.x, abar.y + 8 * S, abar.width, 14 * S), armor > 0 ? "SHIELD " + armor.ToString("0") : "NO SHIELD", St(9, true, TextAnchor.UpperLeft), armor > 0 ? Gfx.Enemy : new Color(1, 1, 1, 0.35f), false);

            // Credits.
            if (HasEconomy())
            {
                var cr = new Rect(hr.xMax + 10 * S, h - 60 * S, 130 * S, 42 * S);
                Panel(cr, new Color(0.02f, 0.02f, 0.05f, 0.72f));
                Text(cr, "¤ " + ((int)Json.Num(self, "credits")).ToString("N0", CultureInfo.InvariantCulture), St(20, true, TextAnchor.MiddleCenter, true), Gfx.Gold);
            }

            // Weapon and ammo, centre bottom.
            int equipped = (int)Json.Num(self, "equipped");
            int gun = equipped == 1 ? (int)Json.Num(self, "secondary", 1) : (int)Json.Num(self, "primary", 0);
            int other = equipped == 1 ? (int)Json.Num(self, "primary", 0) : (int)Json.Num(self, "secondary", 1);
            var wd = catalog?.Weapon(gun);
            int ammo = (int)Json.Num(self, "ammo");
            int mag = wd?.mag ?? 10;
            bool reloading = Json.Num(self, "reloadTicks") > 0;
            var wr = new Rect(w - 360 * S, h - 92 * S, 342 * S, 74 * S);
            Panel(wr, new Color(0.02f, 0.02f, 0.05f, 0.72f));
            Text(new Rect(wr.x + 14 * S, wr.y + 4 * S, 140 * S, 50 * S), gun < 0 ? "—" : reloading ? "··" : ammo.ToString(), St(44, true, TextAnchor.MiddleLeft, true), ammo == 0 && gun >= 0 ? Gfx.Rec : Gfx.Label);
            Text(new Rect(wr.x + 14 * S, wr.y + 50 * S, 140 * S, 16 * S), gun < 0 ? "UNARMED" : reloading ? "RELOADING" : "/ " + mag, St(10, true, TextAnchor.UpperLeft), reloading ? Gfx.Ally : new Color(1, 1, 1, 0.5f), false);
            Text(new Rect(wr.x + 100 * S, wr.y + 8 * S, 228 * S, 26 * S), (catalog?.WeaponName(gun) ?? "").ToUpperInvariant(), St(20, true, TextAnchor.MiddleRight, true), Gfx.Ally);
            Text(new Rect(wr.x + 100 * S, wr.y + 34 * S, 228 * S, 16 * S), (equipped == 1 ? "1 · " : "2 · ") + (catalog?.WeaponName(other) ?? "").ToUpperInvariant(), St(10, true, TextAnchor.MiddleRight), new Color(1, 1, 1, 0.5f), false);
            float pip = Mathf.Min(8 * S, (228 * S) / Mathf.Max(1, mag) - 2 * S);
            for (int i = 0; i < mag && gun >= 0; i++)
                Fill(new Rect(wr.xMax - 14 * S - (mag - i) * (pip + 2 * S), wr.y + 56 * S, pip, 8 * S), i < ammo && !reloading ? Gfx.Ally : new Color(1, 1, 1, 0.1f));

            // Abilities.
            float ax = w / 2 - 170 * S, ay = h - 70 * S;
            Ability(new Rect(ax, ay, 104 * S, 52 * S), "Q", "SMOKE", (int)Json.Num(self, "smokes"), Gfx.Label);
            Ability(new Rect(ax + 116 * S, ay, 104 * S, 52 * S), "E", "DASH", (int)Json.Num(self, "dashes"), Gfx.Ally);
            Ability(new Rect(ax + 232 * S, ay, 104 * S, 52 * S), "C", "FLASH", (int)Json.Num(self, "flashes"), new Color(0.85f, 0.92f, 1f));

            // Prediction: how far ahead of the server your movement is drawn.
            Text(new Rect(w - 300 * S, h - 116 * S, 282 * S, 18 * S), "predicting " + predictor.Unacked + " ticks · ~" + (predictor.Unacked * 1000 / TickRate) + " ms", St(10, false, TextAnchor.MiddleRight), new Color(1, 1, 1, 0.35f), false);
        }

        void Ability(Rect r, string key, string name, int charges, Color c)
        {
            bool on = charges > 0;
            Panel(r, new Color(0.02f, 0.02f, 0.05f, on ? 0.78f : 0.45f));
            var kr = new Rect(r.x + 8 * S, r.y + 10 * S, 30 * S, 30 * S);
            Panel(kr, on ? new Color(c.r, c.g, c.b, 0.95f) : new Color(1, 1, 1, 0.1f));
            Text(kr, key, St(16, true, TextAnchor.MiddleCenter, true), on ? Gfx.Ink : new Color(1, 1, 1, 0.4f), false);
            Text(new Rect(r.x + 44 * S, r.y + 8 * S, r.width - 48 * S, 18 * S), name, St(12, true, TextAnchor.MiddleLeft, true), on ? Gfx.Label : new Color(1, 1, 1, 0.35f), false);
            Text(new Rect(r.x + 44 * S, r.y + 26 * S, r.width - 48 * S, 16 * S), "×" + charges, St(11, true, TextAnchor.MiddleLeft), on ? c : new Color(1, 1, 1, 0.3f), false);
        }

        void DrawFeed(float w, float h)
        {
            float y = 90 * S;
            for (int i = feed.Count - 1; i >= 0; i--)
            {
                var f = feed[i];
                float age = Time.time - f.at;
                if (age > 7f) continue;
                float a = Mathf.Clamp01(7f - age);
                string line = f.killer.ToUpperInvariant() + "   " + f.gun.ToUpperInvariant() + "   " + f.victim.ToUpperInvariant();
                var st = St(12, true, TextAnchor.MiddleRight, true);
                float lw = st.CalcSize(new GUIContent(line)).x + 26 * S;
                var r = new Rect(w - lw - 18 * S, y, lw, 28 * S);
                Panel(r, new Color(0.02f, 0.02f, 0.05f, 0.72f * a));
                Fill(new Rect(r.x, r.y + 4 * S, 3 * S, r.height - 8 * S), new Color(f.c.r, f.c.g, f.c.b, a));
                Text(new Rect(r.x, r.y, r.width - 12 * S, r.height), line, st, new Color(f.c.r, f.c.g, f.c.b, a));
                y += 32 * S;
            }
        }

        void DrawToasts(float w, float h)
        {
            float y = h * 0.42f;
            for (int i = toasts.Count - 1; i >= 0; i--)
            {
                var tt = toasts[i];
                float age = Time.time - tt.at;
                if (age > 2.4f) { toasts.RemoveAt(i); continue; }
                float a = Mathf.Clamp01((2.4f - age) * 2f) * Mathf.Clamp01(age * 8f);
                float slide = (1 - Mathf.Clamp01(age * 6f)) * 30 * S;
                Text(new Rect(w / 2 + 70 * S + slide, y, 420 * S, 22 * S), tt.text, St(14, true, TextAnchor.MiddleLeft, true), new Color(tt.c.r, tt.c.g, tt.c.b, a));
                y -= 24 * S;
            }
        }

        void DrawTrace(float w, float h)
        {
            if (trace.Count == 0) return;
            int n = Mathf.Min(6, trace.Count);
            float pw = 380 * S, ph = 30 * S + n * 34 * S;
            var r = new Rect(w - pw - 18 * S, h * 0.5f - ph / 2, pw, ph);
            Panel(r, new Color(0.04f, 0.02f, 0.08f, 0.7f));
            Fill(new Rect(r.x, r.y + 8 * S, 3 * S, r.height - 16 * S), Gfx.Violet);
            Text(new Rect(r.x + 14 * S, r.y + 6 * S, pw, 18 * S), "WHAT THE OPPONENT IS THINKING  ·  T", St(10, true, TextAnchor.UpperLeft, true), Gfx.Violet, false);
            for (int i = 0; i < n; i++)
            {
                var t = trace[trace.Count - n + i];
                float y = r.y + 26 * S + i * 34 * S;
                string head = (Json.Str(t, "actor") ?? "") + " · " + (Json.Str(t, "type") ?? "");
                Text(new Rect(r.x + 14 * S, y, pw - 24 * S, 14 * S), head, St(10, true, TextAnchor.UpperLeft, true), Gfx.Violet, false);
                Text(new Rect(r.x + 14 * S, y + 13 * S, pw - 24 * S, 18 * S), Json.Str(t, "reason") ?? "", St(11, false, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.82f), false);
            }
        }

        // ================================================================ studio: how the AI works, live

        /// F1. The developer's view of the match, for showing a studio how Rewind works while it plays:
        /// how close the AI's belief is to the truth, what it is deciding and why, and what flows over the wire.
        void DrawStudio(float w, float h, Dictionary<string, object> self)
        {
            float pw = 400 * S, x = w - pw - 18 * S, y = 90 * S;
            float ph = h - y - 120 * S;
            var r = new Rect(x, y, pw, ph);
            Panel(r, new Color(0.04f, 0.045f, 0.06f, 0.86f));
            Fill(new Rect(r.x, r.y, r.width, 3 * S), Gfx.Violet);
            float ix = r.x + 16 * S, iw = pw - 32 * S, cy = r.y + 12 * S;
            Text(new Rect(ix, cy, iw, 22 * S), "STUDIO", St(18, true, TextAnchor.UpperLeft, true), Gfx.Label, false);
            Text(new Rect(ix, cy + 2 * S, iw, 22 * S), "F1 closes", St(10, false, TextAnchor.UpperRight), new Color(1, 1, 1, 0.45f), false);
            cy += 30 * S;

            // 1. Belief: where the AI thinks you are, against where you are.
            Section(ix, ref cy, iw, "THE AI'S BELIEF OF WHERE YOU ARE", Gfx.Violet);
            if (mindBytes == null) Line(ix, ref cy, iw, aiInfo == null ? "Only an AI opponent publishes its belief." : "Waiting for the first snapshot…", 0.55f);
            else
            {
                double sx = Json.Num(self, "x"), sy = Json.Num(self, "y");
                float err = Vector2.Distance(mindGuess, new Vector2((float)sx, (float)sy));
                Stat(ix, ref cy, iw, "best guess is off by", err.ToString("0.0", CultureInfo.InvariantCulture) + " m", err < 3 ? Gfx.Rec : err < 8 ? Gfx.Gold : Gfx.Ally);
                Stat(ix, ref cy, iw, "belief within 3 m of you", (MindNear(sx, sy, 3) * 100).ToString("0") + "%", Gfx.Violet);
                Line(ix, ref cy, iw, "Built only from what it could see or hear, never your real position. I paints it on the floor.", 0.55f);
            }
            var reads = Json.Obj(ranks, "reads");
            if (reads != null)
                Stat(ix, ref cy, iw, "plays called before it saw you", (int)Json.Num(reads, "correct") + " right of " + (int)Json.Num(reads, "made"), Gfx.Violet);
            if (aiLevel.HasValue) Stat(ix, ref cy, iw, "adaptive skill now", aiLevel.Value + " / 100", Gfx.Violet);
            cy += 8 * S;

            // 2. Its reasoning, the same trace a designer would read to tune it.
            Section(ix, ref cy, iw, "WHAT IT IS DECIDING, AND WHY", Gfx.Violet);
            int n = Mathf.Min(6, trace.Count);
            if (n == 0) Line(ix, ref cy, iw, "No decisions yet this match.", 0.55f);
            for (int i = 0; i < n && cy < r.yMax - 150 * S; i++)
            {
                var t = trace[trace.Count - n + i];
                Text(new Rect(ix, cy, iw, 14 * S), (Json.Str(t, "actor") ?? "") + " · " + (Json.Str(t, "type") ?? ""), St(10, true, TextAnchor.UpperLeft, true), Gfx.Violet, false);
                cy += 13 * S;
                Text(new Rect(ix, cy, iw, 30 * S), Json.Str(t, "reason") ?? "", St(11, false, TextAnchor.UpperLeft, false, true), new Color(1, 1, 1, 0.85f), false);
                cy += 30 * S;
            }
            cy += 4 * S;

            // 3. The wire: what a game sends and gets back.
            Section(ix, ref cy, iw, "THE WIRE, THIS MATCH", Gfx.Label);
            Stat(ix, ref cy, iw, "inputs sent (one per tick, 32/s)", inputsSent.ToString("N0", CultureInfo.InvariantCulture), Gfx.Label);
            Stat(ix, ref cy, iw, "fog-limited observations received", obsCount.ToString("N0", CultureInfo.InvariantCulture), Gfx.Label);
            Stat(ix, ref cy, iw, "events you were allowed to see", eventCount.ToString("N0", CultureInfo.InvariantCulture), Gfx.Label);
            Stat(ix, ref cy, iw, "server tick", ((int)Json.Num(obs, "tick")).ToString("N0", CultureInfo.InvariantCulture), Gfx.Label);
            cy += 6 * S;
            Section(ix, ref cy, iw, "WHAT A STUDIO PLUGS IN", Gfx.Label);
            Line(ix, ref cy, iw, "1  Send each player's input every tick; get back only what they may see.", 0.8f);
            Line(ix, ref cy, iw, "2  Record seed + inputs: every match replays bit for bit.", 0.8f);
            Line(ix, ref cy, iw, "3  Bots play from the same fog, learn each player, call their plays.", 0.8f);
            Line(ix, ref cy, iw, "4  After the match: rewind any round, coach from simulated futures.", 0.8f);
        }

        void Section(float x, ref float y, float w, string title, Color c)
        {
            Text(new Rect(x, y, w, 16 * S), title, St(10, true, TextAnchor.UpperLeft, true), c, false);
            y += 15 * S;
            Fill(new Rect(x, y, w, 1), new Color(1, 1, 1, 0.12f));
            y += 5 * S;
        }

        void Stat(float x, ref float y, float w, string label, string value, Color c)
        {
            Text(new Rect(x, y, w, 20 * S), label, St(12, false, TextAnchor.MiddleLeft), new Color(1, 1, 1, 0.7f), false);
            Text(new Rect(x, y, w, 20 * S), value, St(14, true, TextAnchor.MiddleRight, true), c, false);
            y += 22 * S;
        }

        void Line(float x, ref float y, float w, string text, float alpha)
        {
            Text(new Rect(x, y, w, 30 * S), text, St(11, false, TextAnchor.UpperLeft, false, true), new Color(1, 1, 1, alpha), false);
            y += 30 * S;
        }

        void DrawBuy(float w, float h, Dictionary<string, object> self)
        {
            if (catalog == null) return;
            int credits = (int)Json.Num(self, "credits");
            int primary = (int)Json.Num(self, "primary"), secondary = (int)Json.Num(self, "secondary");
            float armor = (float)Json.Num(self, "armor");
            var classes = new[] { ("sidearm", "SIDEARMS"), ("smg", "SMGS"), ("shotgun", "SHOTGUNS"), ("rifle", "RIFLES"), ("sniper", "SNIPERS"), ("heavy", "HEAVIES") };
            float colW = 200 * S, cardH = 54 * S, gap = 8 * S;
            int maxRows = 0;
            foreach (var (cls, _) in classes) { int c = 0; foreach (var wd in catalog.weapons.Values) if (wd.cls == cls) c++; maxRows = Mathf.Max(maxRows, c); }
            float pw = classes.Length * (colW + gap) + colW + gap * 3, ph = 110 * S + Mathf.Max(maxRows, catalog.shields.Count + 1) * (cardH + gap);
            var r = new Rect(w / 2 - pw / 2, h / 2 - ph / 2 + 20 * S, pw, ph);
            Glow(new Rect(r.x - 60 * S, r.y - 60 * S, r.width + 120 * S, r.height + 120 * S), new Color(1f, 0.6f, 0.2f, 0.12f));
            Panel(r, new Color(0.02f, 0.02f, 0.05f, 0.88f));
            float bt = (catalog.buyTicks - (catalog.roundTicks - (float)Json.Num(obs, "roundTicksLeft"))) / TickRate;
            Text(new Rect(r.x + 20 * S, r.y + 12 * S, 300 * S, 36 * S), "ARMORY", St(30, true, TextAnchor.MiddleLeft, true), Gfx.Label);
            Text(new Rect(r.x + 20 * S, r.y + 12 * S, r.width - 40 * S, 36 * S), "¤ " + credits.ToString("N0", CultureInfo.InvariantCulture) + "     " + bt.ToString("0.0", CultureInfo.InvariantCulture) + "s", St(24, true, TextAnchor.MiddleRight, true), Gfx.Gold);
            Text(new Rect(r.x + 20 * S, r.y + 50 * S, r.width - 40 * S, 18 * S), "Click to buy · number keys quick-buy · B hides · movement still works", St(11, false, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.5f), false);
            Fill(new Rect(r.x + 20 * S, r.y + 72 * S, r.width - 40 * S, 1), new Color(1, 1, 1, 0.12f));

            var quick = QuickBuy();
            float cx = r.x + 20 * S;
            foreach (var (cls, title) in classes)
            {
                float cy = r.y + 82 * S;
                Text(new Rect(cx, cy, colW, 16 * S), title, St(10, true, TextAnchor.UpperLeft), Gfx.Ally, false);
                cy += 18 * S;
                var list = new List<WeaponDef>();
                foreach (var wd in catalog.weapons.Values) if (wd.cls == cls) list.Add(wd);
                list.Sort((a, b) => a.price.CompareTo(b.price));
                foreach (var wd in list)
                {
                    bool owned = wd.id == primary || wd.id == secondary;
                    BuyCard(new Rect(cx, cy, colW, cardH), wd.id, wd.name, wd.price, wd.blurb, owned, credits >= wd.price, quick.IndexOf(wd.id));
                    cy += cardH + gap;
                }
                cx += colW + gap;
            }
            float sy = r.y + 82 * S;
            Text(new Rect(cx + gap, sy, colW, 16 * S), "SHIELDS", St(10, true, TextAnchor.UpperLeft), Gfx.Enemy, false);
            sy += 18 * S;
            foreach (var s in catalog.shields)
            {
                BuyCard(new Rect(cx + gap, sy, colW, cardH), s.id, s.name, s.price, "+" + s.amount + " shield, taken before health", armor >= s.amount, credits >= s.price, quick.IndexOf(s.id));
                sy += cardH + gap;
            }
        }

        void BuyCard(Rect r, int id, string name, int price, string blurb, bool owned, bool afford, int quickIndex)
        {
            bool hover = r.Contains(Event.current.mousePosition);
            Panel(r, owned ? new Color(Gfx.Ally.r, Gfx.Ally.g, Gfx.Ally.b, 0.85f) : hover && afford ? new Color(1, 1, 1, 0.2f) : new Color(1, 1, 1, afford ? 0.08f : 0.03f));
            Color tc = owned ? Gfx.Ink : afford ? Gfx.Label : new Color(1, 1, 1, 0.3f);
            Text(new Rect(r.x + 10 * S, r.y + 5 * S, r.width - 20 * S, 22 * S), (name ?? "").ToUpperInvariant(), St(15, true, TextAnchor.UpperLeft, true), tc, false);
            Text(new Rect(r.x + 10 * S, r.y + 5 * S, r.width - 20 * S, 22 * S), price == 0 ? "FREE" : "¤" + price, St(12, true, TextAnchor.UpperRight, true), owned ? Gfx.Ink : afford ? Gfx.Gold : new Color(1, 0.4f, 0.4f, 0.5f), false);
            Text(new Rect(r.x + 10 * S, r.y + 28 * S, r.width - 20 * S, 22 * S), blurb ?? "", St(10, false, TextAnchor.UpperLeft, false, true), new Color(tc.r, tc.g, tc.b, tc.a * 0.75f), false);
            if (quickIndex >= 0 && quickIndex < 9)
            {
                var k = new Rect(r.xMax - 20 * S, r.yMax - 20 * S, 16 * S, 16 * S);
                Fill(k, new Color(1, 1, 1, 0.14f));
                Text(k, (quickIndex + 1).ToString(), St(9, true, TextAnchor.MiddleCenter), tc, false);
            }
            if (afford && !owned && Event.current.type == EventType.MouseDown && hover) { Event.current.Use(); Buy(id); }
        }

        void DrawBanner(float w, float h)
        {
            float k = (Time.time - bannerAt) / bannerDur;
            if (k < 0 || k >= 1 || bannerTitle == null) return;
            float a = Mathf.Clamp01(k * 10f) * Mathf.Clamp01((1 - k) * 4f);
            float slide = (1 - Mathf.Clamp01(k * 5f));
            float y = h * 0.16f;
            Glow(new Rect(w / 2 - 460 * S, y - 90 * S, 920 * S, 230 * S), new Color(bannerColor.r, bannerColor.g, bannerColor.b, 0.3f * a));
            float lineW = 520 * S * Mathf.Clamp01(k * 4f);
            Fill(new Rect(w / 2 - lineW / 2, y + 70 * S, lineW, 2 * S), new Color(bannerColor.r, bannerColor.g, bannerColor.b, a));
            Text(new Rect(slide * 80 * S, y - 10 * S, w, 80 * S), bannerTitle, St(62, true, TextAnchor.MiddleCenter, true), new Color(bannerColor.r, bannerColor.g, bannerColor.b, a));
            Text(new Rect(-slide * 80 * S, y + 74 * S, w, 26 * S), bannerSub ?? "", St(16, true, TextAnchor.MiddleCenter, true), new Color(Gfx.Label.r, Gfx.Label.g, Gfx.Label.b, a));
        }

        static string Reason(string reason, bool won)
        {
            switch (reason)
            {
                case "kill": return won ? "You took the duel." : "You were eliminated.";
                case "time": return "Time ran out.";
                case "defuse": return "The spike was defused.";
                case "detonation": return "The spike went off.";
                default: return "";
            }
        }

        // ================================================================ end screen

        void DrawEnd(float w, float h)
        {
            Fill(new Rect(0, 0, w, h), new Color(0.01f, 0.01f, 0.03f, 0.78f));
            int winner = obs != null && !Json.IsNull(obs, "winner") ? (int)Json.Num(obs, "winner") : -1;
            bool won = winner == slot;
            string title = endWhy == "disconnect" ? "ENDED" : endWhy == "rewind" ? "BRANCH OVER" : won ? "VICTORY" : "DEFEAT";
            Color tc = endWhy == "disconnect" ? Gfx.Label : won ? Gfx.Ally : Gfx.Rec;
            float pw = Mathf.Min(900 * S, w - 60 * S);
            var r = new Rect(w / 2 - pw / 2, h * 0.08f, pw, h * 0.84f);
            Glow(new Rect(r.x - 100 * S, r.y - 80 * S, r.width + 200 * S, 360 * S), new Color(tc.r, tc.g, tc.b, 0.25f));
            Text(new Rect(r.x, r.y, r.width, 110 * S), title, St(96, true, TextAnchor.MiddleCenter, true), tc);
            var score = obs != null ? Json.Arr(obs, "score") : null;
            if (score != null) Text(new Rect(r.x, r.y + 104 * S, r.width, 40 * S), ((double)score[slot]).ToString("0") + "  –  " + ((double)score[1 - slot]).ToString("0") + "     vs " + NameOf(1 - slot), St(24, true, TextAnchor.MiddleCenter, true), Gfx.Label);
            Text(new Rect(r.x, r.y + 144 * S, r.width, 20 * S), (endWhy == "disconnect" ? "A player left. " : "") + "Saved as data/" + endMatchId + ".json — rewind any round from the lobby.", St(12, false, TextAnchor.MiddleCenter), new Color(1, 1, 1, 0.55f), false);

            float y = r.y + 184 * S;
            var insights = Json.Arr(endBrain, "insights");
            if (insights != null && insights.Count > 0)
            {
                Text(new Rect(r.x, y, r.width, 20 * S), "WHAT THE AI LEARNED ABOUT YOU", St(12, true, TextAnchor.UpperLeft, true), Gfx.Violet, false);
                y += 24 * S;
                foreach (var ins in insights)
                {
                    if (y > r.yMax - 200 * S) break;
                    Panel(new Rect(r.x, y, r.width, 34 * S), new Color(Gfx.Violet.r, Gfx.Violet.g, Gfx.Violet.b, 0.12f));
                    Text(new Rect(r.x + 14 * S, y, r.width - 28 * S, 34 * S), ins as string ?? "", St(13, false, TextAnchor.MiddleLeft, false, true), Gfx.Label, false);
                    y += 40 * S;
                }
            }

            if (coachCount > 0)
            {
                y += 8 * S;
                Text(new Rect(r.x, y, r.width, 20 * S), "COACH · WHAT YOU COULD HAVE DONE", St(12, true, TextAnchor.UpperLeft, true), Gfx.Ally, false);
                y += 24 * S;
                var items = Json.Arr(coachData, "items");
                if (items == null) Text(new Rect(r.x, y, r.width, 20 * S), "Simulating your last deaths against their clone…", St(12, false, TextAnchor.UpperLeft), new Color(1, 1, 1, 0.6f), false);
                else
                    foreach (var it in items)
                    {
                        if (y > r.yMax - 90 * S) break;
                        string st = Json.Str(it, "status");
                        var res = Json.Obj(it, "result");
                        var top = Json.Arr(res, "top");
                        var best = top != null && top.Count > 0 ? top[0] : null;
                        var actual = Json.Obj(res, "baseline");
                        // What happened, then the best plan the simulator found from the same moment.
                        string line = "Round " + (int)Json.Num(it, "round") + ":  " + (st == "done" && best != null
                            ? "you " + (Json.Str(actual, "reason") ?? "?") + "   →   " + (Json.Str(best, "name") ?? "") + ": " + (Json.Str(best, "reason") ?? "")
                            : st == "error" ? "could not simulate" : "simulating 20 plans against their clone…");
                        Panel(new Rect(r.x, y, r.width, 34 * S), new Color(Gfx.Ally.r, Gfx.Ally.g, Gfx.Ally.b, 0.1f));
                        Text(new Rect(r.x + 14 * S, y, r.width - 28 * S, 34 * S), line, St(13, false, TextAnchor.MiddleLeft, false, true), Gfx.Label, false);
                        y += 40 * S;
                    }
            }

            if (rpReturnId != null)
            {
                var back = new Rect(w / 2 - 170 * S, r.yMax - 126 * S, 340 * S, 50 * S);
                bool hb = back.Contains(Event.current.mousePosition);
                Panel(back, hb ? new Color(1, 1, 1, 0.25f) : new Color(1, 1, 1, 0.12f));
                Text(back, "BACK TO THE REPLAY", St(20, true, TextAnchor.MiddleCenter, true), Gfx.Label, false);
                if (Event.current.type == EventType.MouseDown && hb)
                {
                    Event.current.Use();
                    string id = rpReturnId;
                    int tick = rpReturnTick;
                    net?.Dispose();
                    net = null;
                    obs = null;
                    StartCoroutine(OpenReplay(id, tick));
                    return;
                }
            }
            var again = new Rect(w / 2 - 170 * S, r.yMax - 64 * S, 340 * S, 54 * S);
            bool hover = again.Contains(Event.current.mousePosition);
            Glow(new Rect(again.x - 30 * S, again.y - 26 * S, again.width + 60 * S, again.height + 52 * S), new Color(1f, 0.55f, 0.15f, hover ? 0.45f : 0.25f));
            Panel(again, hover ? new Color(1f, 0.75f, 0.35f) : Gfx.Ally);
            Text(again, "PLAY AGAIN", St(24, true, TextAnchor.MiddleCenter, true), Gfx.Ink, false);
            if (Event.current.type == EventType.MouseDown && hover) { Event.current.Use(); LeaveToLobby(); }
        }
    }
}
