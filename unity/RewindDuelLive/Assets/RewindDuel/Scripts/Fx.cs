using System;
using System.Collections.Generic;
using UnityEngine;

// Short-lived visual effects. Purely cosmetic: everything here is spawned from server events or the latest
// observation and never feeds back into the game.

namespace RewindDuel
{
    public class Fx
    {
        class Anim { public GameObject go; public float t0, dur; public Action<float> step; public UnityEngine.Object owned; }
        readonly List<Anim> anims = new List<Anim>();
        readonly Transform root;
        readonly Dictionary<Color, Material> additive = new Dictionary<Color, Material>();
        Material sparkMat, puffMat, ringMat, dotMat;

        public Fx(Transform root)
        {
            this.root = root;
            sparkMat = Gfx.Additive(Color.white, Gfx.Dot);
            puffMat = Gfx.Fade(new Color(0.86f, 0.87f, 0.88f, 0.92f), Gfx.Puff);
            ringMat = Gfx.Additive(Color.white, Gfx.Ring);
            dotMat = Gfx.Additive(Color.white, Gfx.Dot);
        }

        Material Add(Color c)
        {
            if (!additive.TryGetValue(c, out var m)) additive[c] = m = Gfx.Additive(c, Gfx.Dot);
            return m;
        }

        public void Update()
        {
            float now = Time.time;
            for (int i = anims.Count - 1; i >= 0; i--)
            {
                var a = anims[i];
                float k = a.dur <= 0 ? 1 : (now - a.t0) / a.dur;
                if (!a.go) { anims.RemoveAt(i); continue; }
                if (k >= 1) { UnityEngine.Object.Destroy(a.go); if (a.owned) UnityEngine.Object.Destroy(a.owned); anims.RemoveAt(i); continue; }
                a.step?.Invoke(k);
            }
        }

        /// `owned` is a per-effect material, destroyed with the effect so long matches do not leak them.
        void Track(GameObject go, float dur, Action<float> step, UnityEngine.Object owned = null) => anims.Add(new Anim { go = go, t0 = Time.time, dur = dur, step = step, owned = owned });

        public static Light PointLight(Transform parent, Vector3 pos, Color c, float intensity, float range)
        {
            var l = new GameObject("Light").AddComponent<Light>();
            l.transform.SetParent(parent, false);
            l.transform.position = pos;
            l.type = LightType.Point;
            l.color = c;
            l.intensity = intensity;
            l.range = range;
            l.shadows = LightShadows.None;
            return l;
        }

        /// A camera-facing quad.
        GameObject Billboard(Vector3 pos, float size, Material m)
        {
            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            UnityEngine.Object.Destroy(q.GetComponent<Collider>());
            q.transform.SetParent(root, false);
            q.transform.position = pos;
            q.transform.localScale = Vector3.one * size;
            var r = q.GetComponent<Renderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var cam = Camera.main;
            if (cam) q.transform.rotation = Quaternion.LookRotation(q.transform.position - cam.transform.position);
            return q;
        }

        public void Muzzle(Vector3 pos, Color c)
        {
            var go = new GameObject("Muzzle");
            go.transform.SetParent(root, false);
            go.transform.position = pos;
            var l = PointLight(go.transform, pos, c, 3f, 4f);
            var flare = Billboard(pos, 0.28f, Add(c * 2f));
            flare.transform.SetParent(go.transform, true);
            flare.transform.Rotate(0, 0, UnityEngine.Random.Range(0, 360f), Space.Self);
            Track(go, 0.06f, k => { l.intensity = 3f * (1 - k); flare.transform.localScale = Vector3.one * 0.28f * (1 - k * 0.6f); });
        }

        public void Tracer(Vector3 a, Vector3 b, Color c, float width)
        {
            var lr = new GameObject("Tracer").AddComponent<LineRenderer>();
            lr.transform.SetParent(root, false);
            lr.sharedMaterial = Gfx.Additive(c * 1.6f);
            lr.positionCount = 2;
            lr.SetPosition(0, a);
            lr.SetPosition(1, b);
            lr.widthCurve = new AnimationCurve(new Keyframe(0, width * 0.4f), new Keyframe(1, width));
            lr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            lr.numCapVertices = 2;
            var mat = lr.sharedMaterial;
            Track(lr.gameObject, 0.08f, k => mat.SetColor("_BaseColor", c * 1.6f * (1 - k) * (1 - k)), mat);
        }

        ParticleSystem Particles(string name, Vector3 pos, Material m)
        {
            var go = new GameObject(name);
            go.transform.SetParent(root, false);
            go.transform.position = pos;
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var r = go.GetComponent<ParticleSystemRenderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return ps;
        }

        /// A one-shot burst of hot sparks.
        public void Sparks(Vector3 pos, Color c, int count, float speed = 4f, float life = 0.35f)
        {
            var ps = Particles("Sparks", pos, Add(c * 2f));
            var main = ps.main;
            main.duration = 0.1f;
            main.loop = false;
            main.startLifetime = new ParticleSystem.MinMaxCurve(life * 0.5f, life);
            main.startSpeed = new ParticleSystem.MinMaxCurve(speed * 0.4f, speed);
            main.startSize = new ParticleSystem.MinMaxCurve(0.03f, 0.09f);
            main.gravityModifier = 0.6f;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            var em = ps.emission;
            em.rateOverTime = 0;
            em.SetBursts(new[] { new ParticleSystem.Burst(0, (short)count) });
            var shape = ps.shape;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.05f;
            var r = ps.GetComponent<ParticleSystemRenderer>();
            r.renderMode = ParticleSystemRenderMode.Stretch;
            r.velocityScale = 0.06f;
            r.lengthScale = 1.5f;
            ps.Play();
            Track(ps.gameObject, life + 0.2f, null);
        }

        /// An expanding glowing ring on the floor (a shockwave or a sonar ping).
        public void Ring(Vector3 pos, Color c, float from, float to, float dur)
        {
            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            UnityEngine.Object.Destroy(q.GetComponent<Collider>());
            q.transform.SetParent(root, false);
            q.transform.position = pos + Vector3.up * 0.04f;
            q.transform.rotation = Quaternion.Euler(90, 0, 0);
            var mat = new Material(ringMat);
            q.GetComponent<Renderer>().sharedMaterial = mat;
            Track(q, dur, k =>
            {
                float s = Mathf.Lerp(from, to, 1 - (1 - k) * (1 - k));
                q.transform.localScale = new Vector3(s, s, 1);
                mat.SetColor("_BaseColor", c * 1.4f * (1 - k));
            }, mat);
        }

        /// A kill: sparks, a shockwave, a light flash and a hot core.
        public void Burst(Vector3 pos, Color c)
        {
            // Restrained on purpose: a short spark burst and a brief light, not a firework.
            Sparks(pos + Vector3.up * 1.2f, c, 24, 5f, 0.5f);
            var go = new GameObject("Burst");
            go.transform.SetParent(root, false);
            var l = PointLight(go.transform, pos + Vector3.up, c, 4f, 5f);
            Track(go, 0.35f, k => l.intensity = 4f * (1 - k));
        }

        /// A flashbang pop: a blinding sphere and a huge, short light.
        public void FlashPop(Vector3 pos)
        {
            var go = new GameObject("FlashPop");
            go.transform.SetParent(root, false);
            var l = PointLight(go.transform, pos, new Color(0.9f, 0.95f, 1f), 40f, 16f);
            var core = Billboard(pos, 1f, Add(new Color(1f, 1f, 1f) * 8f));
            core.transform.SetParent(go.transform, true);
            Sparks(pos, new Color(0.85f, 0.95f, 1f), 40, 7f, 0.5f);
            Track(go, 0.45f, k => { l.intensity = 40f * (1 - k) * (1 - k); core.transform.localScale = Vector3.one * (1f + 5f * k) * (1 - k); });
        }

        public void TeleportBurst(Vector3 pos)
        {
            Sparks(pos + Vector3.up * 0.8f, new Color(0.45f, 0.85f, 1f), 24, 4f, 0.5f);
            Ring(new Vector3(pos.x, 0, pos.z), new Color(0.45f, 0.85f, 1f), 0.3f, 3f, 0.45f);
            var go = new GameObject("Warp");
            go.transform.SetParent(root, false);
            var l = PointLight(go.transform, pos + Vector3.up, new Color(0.45f, 0.85f, 1f), 5f, 6f);
            Track(go, 0.35f, k => l.intensity = 5f * (1 - k));
        }

        // ---------------------------------------------------------------- persistent: smokes and flashes in flight

        readonly List<ParticleSystem> smokes = new List<ParticleSystem>();

        /// Keeps one billowing cloud per smoke in the observation. The engine's smoke is a 2.5-unit disc that
        /// blocks sight completely, so the cloud is dense and fills that disc to above head height.
        public void SyncSmokes(List<Vector3> centers, List<float> lifeLeft, float radius)
        {
            while (smokes.Count < centers.Count)
            {
                var ps = Particles("Smoke", Vector3.zero, puffMat);
                var main = ps.main;
                main.loop = true;
                main.duration = 1f;
                main.startLifetime = new ParticleSystem.MinMaxCurve(2.5f, 4f);
                main.startSpeed = new ParticleSystem.MinMaxCurve(0.05f, 0.25f);
                main.startSize = new ParticleSystem.MinMaxCurve(radius * 0.9f, radius * 1.5f);
                main.startRotation = new ParticleSystem.MinMaxCurve(0, Mathf.PI * 2);
                main.startColor = new ParticleSystem.MinMaxGradient(new Color(0.8f, 0.81f, 0.83f, 0.9f), new Color(0.92f, 0.92f, 0.93f, 0.97f));
                main.maxParticles = 90;
                main.simulationSpace = ParticleSystemSimulationSpace.World;
                main.prewarm = false;
                var em = ps.emission;
                em.rateOverTime = 26;
                var shape = ps.shape;
                shape.shapeType = ParticleSystemShapeType.Sphere;
                shape.radius = radius * 0.65f;
                shape.scale = new Vector3(1f, 0.75f, 1f);
                var rot = ps.rotationOverLifetime;
                rot.enabled = true;
                rot.z = new ParticleSystem.MinMaxCurve(-0.4f, 0.4f);
                var col = ps.colorOverLifetime;
                col.enabled = true;
                var g = new Gradient();
                g.SetKeys(new[] { new GradientColorKey(Color.white, 0), new GradientColorKey(Color.white, 1) },
                          new[] { new GradientAlphaKey(0, 0), new GradientAlphaKey(1, 0.18f), new GradientAlphaKey(1, 0.75f), new GradientAlphaKey(0, 1) });
                col.color = g;
                var r = ps.GetComponent<ParticleSystemRenderer>();
                r.sortMode = ParticleSystemSortMode.Distance;
                ps.Play();
                smokes.Add(ps);
            }
            for (int i = 0; i < smokes.Count; i++)
            {
                var ps = smokes[i];
                bool on = i < centers.Count;
                if (!on) { if (ps.isEmitting) ps.Stop(true, ParticleSystemStopBehavior.StopEmitting); continue; }
                if (!ps.isEmitting) { ps.Clear(); ps.Play(); }
                ps.transform.position = centers[i] + Vector3.up * 1.3f;
                var em = ps.emission;
                em.rateOverTime = lifeLeft[i] < 1.2f ? 4f : 26f; // thins out in its last second
            }
        }

        readonly List<(GameObject go, TrailRenderer trail, Light light)> orbs = new List<(GameObject, TrailRenderer, Light)>();

        /// One glowing orb per flashbang in flight.
        public void SyncFlashes(List<Vector3> positions, List<bool> mine)
        {
            while (orbs.Count < positions.Count)
            {
                var s = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                UnityEngine.Object.Destroy(s.GetComponent<Collider>());
                s.name = "FlashOrb";
                s.transform.SetParent(root, false);
                s.transform.localScale = Vector3.one * 0.18f;
                s.GetComponent<Renderer>().sharedMaterial = Gfx.Glow(Color.white, 6f);
                var trail = s.AddComponent<TrailRenderer>();
                trail.time = 0.25f;
                trail.widthMultiplier = 0.12f;
                trail.sharedMaterial = Gfx.Additive(new Color(0.8f, 0.9f, 1f) * 3f);
                trail.widthCurve = new AnimationCurve(new Keyframe(0, 1), new Keyframe(1, 0));
                var l = PointLight(s.transform, s.transform.position, Color.white, 3f, 4f);
                orbs.Add((s, trail, l));
            }
            for (int i = 0; i < orbs.Count; i++)
            {
                bool on = i < positions.Count;
                if (orbs[i].go.activeSelf != on) { orbs[i].go.SetActive(on); orbs[i].trail.Clear(); }
                if (!on) continue;
                // Flashes fly at chest height and arc up a little, purely for the look.
                orbs[i].go.transform.position = Vector3.Lerp(orbs[i].go.transform.position, positions[i] + Vector3.up * 1.3f, orbs[i].trail.positionCount == 0 ? 1f : 0.6f);
                orbs[i].light.color = mine[i] ? new Color(1f, 0.85f, 0.6f) : new Color(0.7f, 0.9f, 1f);
            }
        }

        public void Clear()
        {
            foreach (var a in anims) { if (a.go) UnityEngine.Object.Destroy(a.go); if (a.owned) UnityEngine.Object.Destroy(a.owned); }
            anims.Clear();
            foreach (var s in smokes) if (s) UnityEngine.Object.Destroy(s.gameObject);
            smokes.Clear();
            foreach (var o in orbs) if (o.go) UnityEngine.Object.Destroy(o.go);
            orbs.Clear();
        }
    }
}
