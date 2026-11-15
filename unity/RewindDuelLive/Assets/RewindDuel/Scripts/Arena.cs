using System.Collections.Generic;
using UnityEngine;

// The 3D arena for one map, built from the server's map data: a sunlit tactical arena of plaster, stone,
// concrete and wood. Map (x, y) is world (x, -y) so the layout is not mirrored relative to the 2D client.
//
// Every engine wall is drawn at least wall height, because the server treats every wall as blocking sight
// completely: a low crate you could see over would show you a world the server says you cannot see.
// Buildings outside the border are dressing only and stand beyond the playable area.

namespace RewindDuel
{
    public class Arena
    {
        public const float WallHeight = 3.2f;
        public readonly Transform root;
        public readonly MapDef map;

        readonly List<Transform> spinners = new List<Transform>();
        readonly List<(Light l, float baseI)> pulsers = new List<(Light, float)>();
        Texture2D mindTex;
        Renderer mindQuad;
        ReflectionProbe probe;
        int probeFrames;
        readonly System.Random rng;

        public static Vector3 W(double x, double y, float h) => new Vector3((float)x, h, -(float)y);

        public Arena(MapDef map, Transform parent)
        {
            this.map = map;
            rng = new System.Random(map.id.GetHashCode());
            root = new GameObject("Arena " + map.id).transform;
            root.SetParent(parent, false);
            BuildFloor();
            BuildWalls();
            foreach (var s in map.sites) BuildSite(s);
            foreach (var tp in map.teleporters) BuildTeleporter(tp);
            SpawnMark(map.atkX, map.atkY, Gfx.Ally);
            SpawnMark(map.defX, map.defY, Gfx.Enemy);
            BuildSkyline();
            BuildMindOverlay();
            BuildProbe();
        }

        Transform Quad(string name, Vector3 center, Vector2 size, Material m, float yaw = 0)
        {
            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Object.Destroy(q.GetComponent<Collider>());
            q.name = name;
            q.transform.SetParent(root, false);
            q.transform.position = center;
            q.transform.rotation = Quaternion.Euler(90, yaw, 0);
            q.transform.localScale = new Vector3(size.x, size.y, 1);
            var r = q.GetComponent<Renderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return q.transform;
        }

        Transform Box(string name, Vector3 center, Vector3 size, Material m, bool shadows = true, Vector2? tiling = null, float yaw = 0)
        {
            var b = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Object.Destroy(b.GetComponent<Collider>());
            b.name = name;
            b.transform.SetParent(root, false);
            b.transform.position = center;
            b.transform.rotation = Quaternion.Euler(0, yaw, 0);
            b.transform.localScale = size;
            var r = b.GetComponent<Renderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = shadows ? UnityEngine.Rendering.ShadowCastingMode.On : UnityEngine.Rendering.ShadowCastingMode.Off;
            if (tiling.HasValue)
            {
                // Per-object tiling so textures keep a constant world size whatever the object's size.
                var block = new MaterialPropertyBlock();
                block.SetVector("_BaseMap_ST", new Vector4(tiling.Value.x, tiling.Value.y, 0, 0));
                r.SetPropertyBlock(block);
            }
            return b.transform;
        }

        // ---------------------------------------------------------------- floor

        void BuildFloor()
        {
            // 4x4 tiles: each is lit by its own nearest lights, and the stone texture covers 2x2 units.
            var mat = Gfx.LitMat(Color.white, 0.22f, 0f, Gfx.Stone);
            mat.SetTextureScale("_BaseMap", new Vector2(2, 2));
            const float T = 4f;
            for (float x = 0; x < map.width - 0.01f; x += T)
                for (float y = 0; y < map.height - 0.01f; y += T)
                {
                    float w = Mathf.Min(T, (float)map.width - x), h = Mathf.Min(T, (float)map.height - y);
                    var t = Quad("Floor", W(x + w / 2, y + h / 2, 0), new Vector2(w, h), mat);
                    t.GetComponent<Renderer>().receiveShadows = true;
                }
            // Paved ground around the arena, under the buildings.
            var street = Gfx.LitMat(new Color(0.42f, 0.4f, 0.37f), 0.15f, 0f, Gfx.Concrete);
            street.SetTextureScale("_BaseMap", new Vector2(((float)map.width + 80) / 4f, ((float)map.height + 80) / 4f));
            Quad("Ground", W(map.width / 2, map.height / 2, -0.02f), new Vector2((float)map.width + 80, (float)map.height + 80), street)
                .GetComponent<Renderer>().receiveShadows = true;
        }

        // ---------------------------------------------------------------- walls

        /// The plaster tint by side: warm sand on the attackers' half, cool grey on the defenders' half.
        Color Plaster(double x)
        {
            float k = Mathf.Clamp01((float)(x / map.width));
            return Color.Lerp(new Color(1f, 0.92f, 0.8f), new Color(0.86f, 0.9f, 0.95f), Mathf.SmoothStep(0.25f, 0.75f, k));
        }

        void BuildWalls()
        {
            var concrete = Gfx.LitMat(new Color(0.9f, 0.9f, 0.9f), 0.12f, 0f, Gfx.Concrete);
            var wood = Gfx.LitMat(Color.white, 0.18f, 0f, Gfx.Wood);
            var plasterMats = new Dictionary<int, Material>();
            Material PlasterMat(double x)
            {
                int key = Mathf.RoundToInt((float)(x / map.width) * 8);
                if (!plasterMats.TryGetValue(key, out var m)) plasterMats[key] = m = Gfx.LitMat(Plaster(key / 8.0 * map.width), 0.1f, 0f, Gfx.Plaster);
                return m;
            }
            int i = 0;
            foreach (var w in map.walls)
            {
                bool border = w.x < 0 || w.y < 0 || w.x + w.w > map.width || w.y + w.h > map.height;
                float cx = (float)(w.x + w.w / 2), cy = (float)(w.y + w.h / 2), ww = (float)w.w, wh = (float)w.h;
                if (!border && ww <= 2.2f && wh <= 2.2f && ww >= 1f && wh >= 1f)
                {
                    // Cover: two stacked crates, the top one slightly smaller and turned, so it reads as a prop.
                    Box("Crate" + i, W(cx, cy, 0.8f), new Vector3(ww, 1.6f, wh), wood, true, new Vector2(1, 1));
                    float top = Mathf.Min(ww, wh) * 0.86f;
                    float topH = Mathf.Max(top, WallHeight - 1.6f);
                    Box("Crate" + i + "b", W(cx, cy, 1.6f + topH * 0.5f), new Vector3(top, topH, top), wood, true, new Vector2(1, 1), (float)rng.NextDouble() * 14f - 7f);
                    i++;
                    continue;
                }
                float h = border ? WallHeight + 1.6f : WallHeight;
                float len = Mathf.Max(ww, wh);
                Box("Wall" + i, W(cx, cy, h / 2), new Vector3(ww, h, wh), PlasterMat(cx), true, new Vector2(Mathf.Max(1, len / 3f), h / 3f));
                // Concrete skirting at the floor and coping on top give the walls weight and a clean silhouette.
                Box("Skirt" + i, W(cx, cy, 0.18f), new Vector3(ww + 0.06f, 0.36f, wh + 0.06f), concrete, false, new Vector2(Mathf.Max(1, len / 2f), 0.2f));
                Box("Coping" + i, W(cx, cy, h + 0.06f), new Vector3(ww + 0.16f, 0.12f, wh + 0.16f), concrete, true, new Vector2(Mathf.Max(1, len / 2f), 0.1f));
                i++;
            }
        }

        // ---------------------------------------------------------------- sites, teleporters, spawns

        void BuildSite(SiteDef s)
        {
            var r = s.rect;
            var center = W(r.x + r.w / 2, r.y + r.h / 2, 0);
            // A darker paved plant zone with a painted border, like a marked area on a real map.
            var pave = Gfx.LitMat(new Color(0.5f, 0.47f, 0.43f), 0.2f, 0f, Gfx.Concrete);
            pave.SetTextureScale("_BaseMap", new Vector2((float)r.w / 2f, (float)r.h / 2f));
            Quad("SiteFloor " + s.label, center + Vector3.up * 0.005f, new Vector2((float)r.w, (float)r.h), pave).GetComponent<Renderer>().receiveShadows = true;
            var paint = Gfx.LitMat(new Color(0.95f, 0.78f, 0.25f), 0.3f);
            const float t = 0.12f;
            Box("SiteLine", W(r.x + r.w / 2, r.y, 0.01f), new Vector3((float)r.w, 0.012f, t), paint, false);
            Box("SiteLine", W(r.x + r.w / 2, r.y + r.h, 0.01f), new Vector3((float)r.w, 0.012f, t), paint, false);
            Box("SiteLine", W(r.x, r.y + r.h / 2, 0.01f), new Vector3(t, 0.012f, (float)r.h), paint, false);
            Box("SiteLine", W(r.x + r.w, r.y + r.h / 2, 0.01f), new Vector3(t, 0.012f, (float)r.h), paint, false);

            // The letter painted on the floor, readable from the attackers' side.
            float size = Mathf.Min((float)r.w, (float)r.h) * 0.6f;
            Quad("FloorLetter " + s.label, center + Vector3.up * 0.015f, new Vector2(size, size), Gfx.Cutout(new Color(0.95f, 0.78f, 0.25f), Gfx.LetterTex(s.label)), -90);

            // A sign on a post at the site's corner nearest the attackers' spawn, readable from both sides.
            var corner = W(r.x + 0.4f, r.y + (map.atkY < r.y + r.h / 2 ? 0.4f : r.h - 0.4f), 0);
            var post = Gfx.LitMat(new Color(0.18f, 0.18f, 0.2f), 0.5f, 0.6f);
            Box("SignPost", corner + Vector3.up * 1.3f, new Vector3(0.08f, 2.6f, 0.08f), post);
            Box("SignBoard", corner + Vector3.up * 2.55f, new Vector3(0.06f, 0.9f, 0.9f), Gfx.LitMat(Gfx.Rec, 0.35f));
            var letterMat = Gfx.Cutout(Color.white, Gfx.LetterTex(s.label));
            foreach (var side in new[] { -1f, 1f })
            {
                var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
                Object.Destroy(q.GetComponent<Collider>());
                q.transform.SetParent(root, false);
                q.transform.position = corner + Vector3.up * 2.55f + new Vector3(side * 0.035f, 0, 0);
                q.transform.rotation = Quaternion.Euler(0, side > 0 ? -90 : 90, 0);
                q.transform.localScale = Vector3.one * 0.8f;
                q.GetComponent<Renderer>().sharedMaterial = letterMat;
            }
        }

        void BuildTeleporter(TeleporterDef tp)
        {
            var p = tp.pad;
            var pc = W(p.x + p.w / 2, p.y + p.h / 2, 0);
            var ex = W(tp.exitX, tp.exitY, 0);
            // A raised metal plate with an inset light ring: clearly a device, not decoration.
            var metal = Gfx.LitMat(new Color(0.35f, 0.37f, 0.4f), 0.65f, 0.8f);
            Box("Pad", pc + Vector3.up * 0.04f, new Vector3((float)p.w, 0.08f, (float)p.h), metal, false);
            var ring = Quad("PadRing", pc + Vector3.up * 0.09f, Vector2.one * (float)System.Math.Min(p.w, p.h) * 0.9f, Gfx.Additive(new Color(0.4f, 0.85f, 1f) * 1.4f, Gfx.Ring));
            spinners.Add(ring);
            var l = Fx.PointLight(root, pc + Vector3.up * 0.6f, new Color(0.5f, 0.85f, 1f), 1.6f, 3f);
            pulsers.Add((l, 1.6f));
            // The exit: a matching floor marker so you can see where a pad sends you.
            Box("Exit", ex + Vector3.up * 0.02f, new Vector3(1.2f, 0.04f, 1.2f), metal, false);
            Quad("ExitRing", ex + Vector3.up * 0.05f, Vector2.one * 1.1f, Gfx.Additive(new Color(0.4f, 0.85f, 1f) * 0.8f, Gfx.Ring));
        }

        void SpawnMark(double x, double y, Color c)
        {
            var paint = Gfx.LitMat(Color.Lerp(c, Color.white, 0.25f), 0.3f);
            const float half = 1.6f, t = 0.1f;
            Box("SpawnLine", W(x, y - half, 0.01f), new Vector3(half * 2, 0.012f, t), paint, false);
            Box("SpawnLine", W(x, y + half, 0.01f), new Vector3(half * 2, 0.012f, t), paint, false);
            Box("SpawnLine", W(x - half, y, 0.01f), new Vector3(t, 0.012f, half * 2), paint, false);
            Box("SpawnLine", W(x + half, y, 0.01f), new Vector3(t, 0.012f, half * 2), paint, false);
        }

        // ---------------------------------------------------------------- dressing outside the arena

        /// A ring of low buildings beyond the border walls, so the arena sits in a place instead of a void.
        void BuildSkyline()
        {
            var facade = Gfx.LitMat(Color.white, 0.12f, 0f, Gfx.Facade);
            var roof = Gfx.LitMat(new Color(0.55f, 0.32f, 0.24f), 0.2f);
            float W0 = (float)map.width, H0 = (float)map.height;
            void Row(Vector3 start, Vector3 dir, float length, Vector3 outward)
            {
                float d = 0;
                while (d < length)
                {
                    float bw = 4f + (float)rng.NextDouble() * 6f;
                    float bh = 6f + (float)rng.NextDouble() * 9f;
                    float depth = 5f + (float)rng.NextDouble() * 4f;
                    var c = start + dir * (d + bw / 2) + outward * (2.5f + depth / 2);
                    var size = Mathf.Abs(dir.x) > 0.5f ? new Vector3(bw, bh, depth) : new Vector3(depth, bh, bw);
                    Box("Building", new Vector3(c.x, bh / 2, c.z), size, facade, true, new Vector2(Mathf.Max(1, bw / 4f), bh / 4f));
                    Box("Roof", new Vector3(c.x, bh + 0.15f, c.z), new Vector3(size.x + 0.3f, 0.3f, size.z + 0.3f), roof, false);
                    d += bw + 0.4f;
                }
            }
            Row(W(-12, -1, 0), Vector3.right, W0 + 24, Vector3.forward);
            Row(W(-12, H0 + 1, 0), Vector3.right, W0 + 24, Vector3.back);
            Row(W(-1, 0, 0), Vector3.back, H0, Vector3.left);
            Row(W(W0 + 1, 0, 0), Vector3.back, H0, Vector3.right);
        }

        void BuildProbe()
        {
            probe = new GameObject("Reflections").AddComponent<ReflectionProbe>();
            probe.transform.SetParent(root, false);
            probe.transform.position = W(map.width / 2, map.height / 2, 1.6f);
            probe.mode = UnityEngine.Rendering.ReflectionProbeMode.Realtime;
            probe.refreshMode = UnityEngine.Rendering.ReflectionProbeRefreshMode.ViaScripting;
            probe.timeSlicingMode = UnityEngine.Rendering.ReflectionProbeTimeSlicingMode.NoTimeSlicing;
            probe.size = new Vector3((float)map.width + 4, 10, (float)map.height + 4);
            probe.boxProjection = true;
            probe.resolution = 128;
            probe.intensity = 0.6f;
        }

        // ---------------------------------------------------------------- the AI's mind

        void BuildMindOverlay()
        {
            var m = Gfx.Fade(Color.white);
            mindQuad = Quad("Mind", W(map.width / 2, map.height / 2, 0.03f), new Vector2((float)map.width, (float)map.height), m).GetComponent<Renderer>();
            mindQuad.gameObject.SetActive(false);
        }

        /// Paints the AI's belief of where you are onto the floor. `bytes` is cols x rows, row 0 at map y 0.
        public void SetMind(byte[] bytes, int cols, int rows, bool visible)
        {
            mindQuad.gameObject.SetActive(visible && bytes != null);
            if (bytes == null) return;
            if (!mindTex || mindTex.width != cols || mindTex.height != rows)
            {
                mindTex = new Texture2D(cols, rows, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
                mindQuad.sharedMaterial.SetTexture("_BaseMap", mindTex);
            }
            var px = new Color32[cols * rows];
            for (int cy = 0; cy < rows; cy++)
                for (int cx = 0; cx < cols; cx++)
                {
                    float v = bytes[cy * cols + cx] / 255f;
                    // Texture row 0 is the quad's -z edge, which is map y = height, so rows flip.
                    px[(rows - 1 - cy) * cols + cx] = new Color32(150, 110, 255, (byte)(Mathf.Pow(v, 1.2f) * 120));
                }
            mindTex.SetPixels32(px);
            mindTex.Apply(false);
        }

        // ---------------------------------------------------------------- animation

        public void Update(float pulse)
        {
            float t = Time.time;
            foreach (var s in spinners) if (s) s.Rotate(0, 0, 25f * Time.deltaTime, Space.Self);
            foreach (var (l, i) in pulsers) if (l) l.intensity = i * (0.85f + 0.15f * Mathf.Sin(t * 2.4f)) * pulse;
            // Bake reflections a couple of frames after the arena exists, once lights and sky are in place.
            if (probe && probeFrames < 3 && ++probeFrames == 3) probe.RenderProbe();
        }

        public void Destroy() { if (root) Object.Destroy(root.gameObject); if (mindTex) Object.Destroy(mindTex); }
    }
}
