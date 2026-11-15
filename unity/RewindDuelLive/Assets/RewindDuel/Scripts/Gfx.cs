using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

// Procedural art for Rewind Duel: every texture, material and synthesized sound is generated here, so the look
// needs no asset files beyond the few template models. The style is a sunlit tactical arena: plaster, stone,
// concrete and wood in warm daylight, with colour used only where it carries information (you, the enemy,
// sites, danger, the AI's mind). Shaders come from materials the scene builder saves as assets
// (DuelClient.shaderKeepers), so a standalone build does not strip them.

namespace RewindDuel
{
    public static class Gfx
    {
        // Colour only where it means something.
        public static readonly Color Ally = new Color(0.25f, 0.82f, 0.74f);   // you
        public static readonly Color Enemy = new Color(0.96f, 0.29f, 0.29f);  // the rival
        public static readonly Color Rec = new Color(0.93f, 0.26f, 0.22f);    // danger: the spike, damage
        public static readonly Color Violet = new Color(0.62f, 0.46f, 0.98f); // the AI's mind
        public static readonly Color Gold = new Color(1f, 0.8f, 0.32f);       // credits, headshots
        public static readonly Color Label = new Color(0.96f, 0.95f, 0.92f);  // text
        public static readonly Color Ink = new Color(0.07f, 0.075f, 0.09f);   // text on light chips

        public static Shader Lit, Unlit, Particles, Skybox, Colored;

        public static void Init(Material[] keepers)
        {
            Shader Pick(string name)
            {
                if (keepers != null) foreach (var m in keepers) if (m && m.shader && m.shader.name == name) return m.shader;
                return Shader.Find(name);
            }
            Lit = Pick("Universal Render Pipeline/Lit");
            Unlit = Pick("Universal Render Pipeline/Unlit");
            Particles = Pick("Universal Render Pipeline/Particles/Unlit");
            Skybox = Pick("Skybox/Procedural");
            Colored = Pick("Hidden/Internal-Colored");
        }

        // ---------------------------------------------------------------- materials

        public static Material LitMat(Color c, float smooth = 0.3f, float metal = 0f, Texture tex = null)
        {
            var m = new Material(Lit);
            m.SetColor("_BaseColor", c);
            m.SetFloat("_Smoothness", smooth);
            m.SetFloat("_Metallic", metal);
            if (tex) m.SetTexture("_BaseMap", tex);
            return m;
        }

        /// A self-lit surface (signs, small indicator lights). `intensity` above 1 reaches the bloom threshold.
        public static Material Glow(Color c, float intensity)
        {
            var m = new Material(Unlit);
            m.SetColor("_BaseColor", c * intensity);
            return m;
        }

        /// Additive, unlit, for light-like things (tracers, muzzle flashes, sparks). HDR colour allowed.
        public static Material Additive(Color c, Texture tex = null)
        {
            var m = new Material(Particles);
            m.SetFloat("_Surface", 1f);
            m.SetFloat("_Blend", 2f);
            m.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
            m.SetInt("_DstBlend", (int)BlendMode.One);
            m.SetInt("_ZWrite", 0);
            m.SetFloat("_Cull", 0f);
            m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            m.renderQueue = (int)RenderQueue.Transparent;
            m.SetColor("_BaseColor", c);
            if (tex) m.SetTexture("_BaseMap", tex);
            return m;
        }

        /// Alpha-blended, unlit (smoke, decals).
        public static Material Fade(Color c, Texture tex = null)
        {
            var m = Additive(c, tex);
            m.SetFloat("_Blend", 0f);
            m.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
            return m;
        }

        /// The daytime sky: a procedural atmosphere with a visible sun.
        public static Material SkyMaterial()
        {
            var m = new Material(Skybox);
            m.SetFloat("_SunSize", 0.035f);
            m.SetFloat("_SunSizeConvergence", 6f);
            m.SetFloat("_AtmosphereThickness", 0.85f);
            m.SetColor("_SkyTint", new Color(0.52f, 0.6f, 0.72f));
            m.SetColor("_GroundColor", new Color(0.42f, 0.39f, 0.35f));
            m.SetFloat("_Exposure", 1.15f);
            return m;
        }

        static Material colored;
        /// For GL drawing in screen space (minimap cones, damage arcs, hit markers).
        public static Material GLMat()
        {
            if (colored) return colored;
            colored = new Material(Colored) { hideFlags = HideFlags.HideAndDontSave };
            colored.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
            colored.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
            colored.SetInt("_Cull", (int)CullMode.Off);
            colored.SetInt("_ZWrite", 0);
            colored.SetInt("_ZTest", (int)CompareFunction.Always);
            return colored;
        }

        // ---------------------------------------------------------------- textures

        static readonly Dictionary<string, Texture2D> cache = new Dictionary<string, Texture2D>();

        static Texture2D Make(string key, int w, int h, Func<float, float, Color> f, TextureWrapMode wrap = TextureWrapMode.Clamp, bool mips = true)
        {
            if (cache.TryGetValue(key, out var t) && t) return t;
            t = new Texture2D(w, h, TextureFormat.RGBA32, mips) { wrapMode = wrap, filterMode = FilterMode.Trilinear, name = key, anisoLevel = 8 };
            var px = new Color[w * h];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    px[y * w + x] = f((x + 0.5f) / w, (y + 0.5f) / h);
            t.SetPixels(px);
            t.Apply(mips, false);
            cache[key] = t;
            return t;
        }

        static float Fbm(float u, float v, float scale, int octaves = 4)
        {
            float a = 0, amp = 0.5f, f = scale;
            for (int i = 0; i < octaves; i++) { a += amp * Mathf.PerlinNoise(u * f + i * 17.3f, v * f + i * 31.7f); f *= 2.03f; amp *= 0.5f; }
            return a;
        }

        /// A soft round dot: white, alpha falls off to the edge.
        public static Texture2D Dot => Make("dot", 64, 64, (u, v) =>
        {
            float d = Mathf.Clamp01(Vector2.Distance(new Vector2(u, v), new Vector2(0.5f, 0.5f)) * 2f);
            return new Color(1, 1, 1, Mathf.Pow(1f - d, 2.2f));
        });

        /// A thin ring (sound pings, teleporter pads).
        public static Texture2D Ring => Make("ring", 128, 128, (u, v) =>
        {
            float d = Vector2.Distance(new Vector2(u, v), new Vector2(0.5f, 0.5f)) * 2f;
            float a = Mathf.Exp(-Mathf.Pow((d - 0.86f) / 0.05f, 2f)) + 0.2f * Mathf.Exp(-Mathf.Pow((d - 0.86f) / 0.16f, 2f));
            return new Color(1, 1, 1, Mathf.Clamp01(a));
        });

        /// A puffy smoke blob.
        public static Texture2D Puff => Make("puff", 128, 128, (u, v) =>
        {
            float d = Mathf.Clamp01(Vector2.Distance(new Vector2(u, v), new Vector2(0.5f, 0.5f)) * 2f);
            float n = Fbm(u, v, 4f, 3);
            return new Color(1, 1, 1, Mathf.Clamp01((1f - d * d) * (0.5f + 0.75f * n)));
        });

        /// Stone floor tiles, one texture tile = 2x2 map units, with grout and per-tile tone variation.
        public static Texture2D Stone => Make("stone", 512, 512, (u, v) =>
        {
            float tu = u * 2f, tv = v * 2f;
            float fx = tu - Mathf.Floor(tu), fy = tv - Mathf.Floor(tv);
            float id = Mathf.PerlinNoise(Mathf.Floor(tu) * 3.7f + 0.3f, Mathf.Floor(tv) * 5.1f + 0.7f);
            float grout = Mathf.Min(Mathf.Min(fx, 1 - fx), Mathf.Min(fy, 1 - fy)) < 0.012f ? 0.62f : 1f;
            float n = 0.86f + 0.14f * Fbm(u, v, 18f, 4);
            float tone = 0.9f + 0.18f * id;
            var c = new Color(0.66f, 0.6f, 0.52f) * tone * n * grout;
            c.a = 1;
            return c;
        }, TextureWrapMode.Repeat);

        /// Warm plaster: soft mottling and faint vertical streaks.
        public static Texture2D Plaster => Make("plaster", 512, 512, (u, v) =>
        {
            float mott = Fbm(u, v, 6f, 5);
            float streak = Mathf.PerlinNoise(u * 40f, v * 2f) * 0.06f;
            float c = 0.9f + 0.14f * mott - streak;
            return new Color(c, c * 0.97f, c * 0.92f, 1);
        }, TextureWrapMode.Repeat);

        /// Concrete for skirting, coping and building bases.
        public static Texture2D Concrete => Make("concrete", 256, 256, (u, v) =>
        {
            float n = 0.78f + 0.22f * Fbm(u, v, 14f, 5);
            float pit = Mathf.PerlinNoise(u * 70f, v * 70f) > 0.82f ? 0.85f : 1f;
            float c = 0.55f * n * pit;
            return new Color(c, c, c * 1.02f, 1);
        }, TextureWrapMode.Repeat);

        /// Wooden crate planks with a darker frame.
        public static Texture2D Wood => Make("wood", 256, 256, (u, v) =>
        {
            float frame = (u < 0.07f || u > 0.93f || v < 0.07f || v > 0.93f || Mathf.Abs(u - v) < 0.035f) ? 0.62f : 1f;
            float plank = Mathf.Repeat(v * 5f, 1f) < 0.04f ? 0.7f : 1f;
            float grain = 0.85f + 0.15f * Mathf.PerlinNoise(u * 3f, v * 60f);
            float c = grain * frame * plank;
            return new Color(0.62f * c, 0.45f * c, 0.29f * c, 1);
        }, TextureWrapMode.Repeat);

        /// A building facade beyond the arena: plaster with rows of dark windows.
        public static Texture2D Facade => Make("facade", 256, 256, (u, v) =>
        {
            float wu = Mathf.Repeat(u * 4f, 1f), wv = Mathf.Repeat(v * 3f, 1f);
            bool window = wu > 0.28f && wu < 0.72f && wv > 0.3f && wv < 0.78f;
            float n = 0.88f + 0.12f * Fbm(u, v, 5f, 3);
            if (window) return new Color(0.16f, 0.19f, 0.23f, 1) * (0.9f + 0.2f * Mathf.PerlinNoise(u * 4, v * 3));
            return new Color(0.82f * n, 0.74f * n, 0.64f * n, 1);
        }, TextureWrapMode.Repeat);

        // A 5x7 pixel font for site letters, drawn into textures so walls hide them (3D text ignores depth).
        static readonly Dictionary<char, string[]> Glyphs = new Dictionary<char, string[]>
        {
            ['A'] = new[] { ".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#" },
            ['B'] = new[] { "####.", "#...#", "#...#", "####.", "#...#", "#...#", "####." },
            ['C'] = new[] { ".####", "#....", "#....", "#....", "#....", "#....", ".####" },
            ['D'] = new[] { "####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####." },
            // The replay's death marker on the floor.
            ['X'] = new[] { "#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#" },
        };

        /// White letter on transparent, for an alpha-clipped material. Unknown letters render as a filled block.
        public static Texture2D LetterTex(string label)
        {
            char ch = string.IsNullOrEmpty(label) ? '?' : char.ToUpperInvariant(label[0]);
            return Make("letter" + ch, 64, 64, (u, v) =>
            {
                // 7 rows tall in the middle 70% of the texture, 5 columns wide.
                float gy = (1f - v - 0.15f) / 0.7f * 7f, gx = (u - 0.25f) / 0.5f * 5f;
                if (gx < 0 || gx >= 5 || gy < 0 || gy >= 7) return new Color(1, 1, 1, 0);
                bool on = Glyphs.TryGetValue(ch, out var g) ? g[(int)gy][(int)gx] == '#' : true;
                return new Color(1, 1, 1, on ? 1 : 0);
            }, TextureWrapMode.Clamp, false);
        }

        /// A lit, alpha-clipped material for painted letters and signs.
        public static Material Cutout(Color c, Texture tex)
        {
            var m = LitMat(c, 0.3f, 0f, tex);
            m.SetFloat("_AlphaClip", 1f);
            m.SetFloat("_Cutoff", 0.5f);
            m.EnableKeyword("_ALPHATEST_ON");
            m.renderQueue = (int)RenderQueue.AlphaTest;
            return m;
        }

        /// 9-slice friendly rounded rectangle for UI panels (small radius: crisp, not bubbly).
        public static Texture2D Rounded => Make("rounded", 32, 32, (u, v) =>
        {
            float r = 0.18f;
            float dx = Mathf.Max(0, Mathf.Abs(u - 0.5f) - (0.5f - r)), dy = Mathf.Max(0, Mathf.Abs(v - 0.5f) - (0.5f - r));
            float d = Mathf.Sqrt(dx * dx + dy * dy) / r;
            return new Color(1, 1, 1, Mathf.Clamp01((1f - d) * 16f));
        }, TextureWrapMode.Clamp, false);

        // ---------------------------------------------------------------- sound

        static readonly Dictionary<string, AudioClip> clips = new Dictionary<string, AudioClip>();

        static AudioClip Synth(string key, float seconds, Func<float, float> f)
        {
            if (clips.TryGetValue(key, out var c) && c) return c;
            const int rate = 44100;
            int n = (int)(seconds * rate);
            var data = new float[n];
            for (int i = 0; i < n; i++) data[i] = Mathf.Clamp(f(i / (float)rate), -1f, 1f);
            c = AudioClip.Create(key, n, 1, rate, false);
            c.SetData(data, 0);
            clips[key] = c;
            return c;
        }

        /// The high ring after a flash.
        public static AudioClip Tinnitus => Synth("tinnitus", 2.4f, t => Mathf.Sin(2 * Mathf.PI * 6200 * t) * 0.16f * Mathf.Exp(-t * 1.1f));
        /// A short ping for gunfire heard through a wall.
        public static AudioClip Ping => Synth("ping", 0.4f, t => Mathf.Sin(2 * Mathf.PI * (900 + 300 * Mathf.Exp(-t * 20)) * t) * 0.2f * Mathf.Exp(-t * 10));
        /// A footstep heard through a wall.
        public static AudioClip Thud => Synth("thud", 0.18f, t => (Mathf.Sin(2 * Mathf.PI * 70 * t) + 0.4f * (Mathf.PerlinNoise(t * 900, 1) - 0.5f)) * 0.5f * Mathf.Exp(-t * 28));
        /// A rising whoosh for teleports.
        public static AudioClip Warp => Synth("warp", 0.6f, t => Mathf.Sin(2 * Mathf.PI * (200 + 1400 * t * t) * t) * 0.25f * Mathf.Sin(Mathf.PI * t / 0.6f));
        /// The planted spike's beep.
        public static AudioClip Siren => Synth("beep", 0.12f, t => Mathf.Sin(2 * Mathf.PI * 1850 * t) * 0.2f * Mathf.Sin(Mathf.PI * t / 0.12f));
        /// A headshot tick.
        public static AudioClip Ding => Synth("ding", 0.3f, t => (Mathf.Sin(2 * Mathf.PI * 2100 * t) + 0.4f * Mathf.Sin(2 * Mathf.PI * 3150 * t)) * 0.18f * Mathf.Exp(-t * 12));
        /// A purchase confirmation.
        public static AudioClip Coin => Synth("coin", 0.25f, t => Mathf.Sin(2 * Mathf.PI * (t < 0.07f ? 1320 : 1760) * t) * 0.16f * Mathf.Exp(-t * 10));
        /// The flash pop.
        public static AudioClip Pop => Synth("pop", 0.5f, t => (Mathf.Sin(2 * Mathf.PI * 120 * t * (1 - t)) + (Mathf.PerlinNoise(t * 3000, 2) - 0.5f) * 1.6f) * 0.42f * Mathf.Exp(-t * 10));
    }
}
