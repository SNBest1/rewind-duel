using System.Collections.Generic;
using System.IO;
using UnityEngine;

// Drives the 3D replay: loads map.json + match.json from StreamingAssets, builds the world, and animates
// both players and a first-person camera through the recorded frames. Logic stays 2D in Node; this script
// only interpolates and draws the snapshots it is given (DECISIONS D31 / the Unity equivalent).
//
// Controls:
//   Space        play / pause
//   Left/Right   step one frame (when paused)
//   , / .        scrub back / forward fast
//   V            toggle first-person (eye) vs top-down overview camera
//   Tab          switch which slot the eye follows

namespace RewindDuel
{
    public class MatchReplay : MonoBehaviour
    {
        public float eyeHeight = 1.6f;
        public int playbackTickRate = 32;

        MapData map;
        MatchData match;
        Transform world;
        Transform p0, p1;
        Transform smokesRoot;
        Transform spike;
        Camera cam;

        int eyeSlot = 0;
        bool firstPerson = true;
        bool playing = true;
        float frameAccum;
        int frame;

        readonly Color VU = new Color(1f, 0.71f, 0.28f);  // you
        readonly Color Ice = new Color(0.50f, 0.84f, 0.91f); // rival
        readonly Color Dead = new Color(0.35f, 0.29f, 0.24f);

        void Start()
        {
            map = LoadJson<MapData>("map.json");
            match = LoadJson<MatchData>("match.json");
            if (map == null || match == null)
            {
                Debug.LogError("RewindDuel: could not load map.json / match.json from StreamingAssets.");
                enabled = false;
                return;
            }
            if (match.tickRate > 0) playbackTickRate = match.tickRate;

            world = new GameObject("World").transform;
            MapBuilder.Build(world, map);

            p0 = MakePlayer("Player0_You", VU);
            p1 = MakePlayer("Player1_Rival", Ice);
            smokesRoot = new GameObject("Smokes").transform;
            spike = MakeSpike();

            SetupCameraAndLights();
            Apply(0);
        }

        T LoadJson<T>(string file) where T : class
        {
            var path = Path.Combine(Application.streamingAssetsPath, file);
            if (!File.Exists(path)) return null;
            return JsonUtility.FromJson<T>(File.ReadAllText(path));
        }

        Transform MakePlayer(string name, Color c)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            go.name = name;
            go.transform.localScale = new Vector3(0.8f, 0.9f, 0.8f); // radius 0.4, ~1.8 tall
            go.GetComponent<Renderer>().sharedMaterial = SolidMat(c);
            // A short barrel marker showing aim direction.
            var barrel = GameObject.CreatePrimitive(PrimitiveType.Cube);
            barrel.name = "Aim";
            barrel.transform.SetParent(go.transform, false);
            barrel.transform.localScale = new Vector3(0.12f, 0.12f, 1.3f);
            barrel.transform.localPosition = new Vector3(0f, 0.2f, 0.7f);
            Object.Destroy(barrel.GetComponent<Collider>());
            barrel.GetComponent<Renderer>().sharedMaterial = SolidMat(Color.white);
            return go.transform;
        }

        Transform MakeSpike()
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "Spike";
            go.transform.localScale = new Vector3(0.6f, 0.6f, 0.6f);
            go.GetComponent<Renderer>().sharedMaterial = SolidMat(new Color(0.9f, 0.28f, 0.23f));
            go.SetActive(false);
            return go.transform;
        }

        Material SolidMat(Color c)
        {
            var sh = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            return new Material(sh) { color = c };
        }

        void SetupCameraAndLights()
        {
            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.0f;
            sun.transform.rotation = Quaternion.Euler(55f, 40f, 0f);
            RenderSettings.ambientLight = new Color(0.4f, 0.37f, 0.33f);

            var camGo = new GameObject("ReplayCamera");
            cam = camGo.AddComponent<Camera>();
            cam.fieldOfView = 80f;
            cam.backgroundColor = new Color(0.086f, 0.059f, 0.047f);
            cam.farClipPlane = 200f;
        }

        void Update()
        {
            if (match == null) return;
            HandleInput();

            if (playing)
            {
                frameAccum += Time.deltaTime * playbackTickRate;
                while (frameAccum >= 1f)
                {
                    frameAccum -= 1f;
                    frame++;
                    if (frame >= match.frames.Length) { frame = match.frames.Length - 1; playing = false; }
                }
                Apply(frame);
            }
            UpdateCamera();
        }

        void HandleInput()
        {
            if (Input.GetKeyDown(KeyCode.Space)) playing = !playing;
            if (Input.GetKeyDown(KeyCode.V)) firstPerson = !firstPerson;
            if (Input.GetKeyDown(KeyCode.Tab)) { eyeSlot = 1 - eyeSlot; }
            if (!playing && Input.GetKeyDown(KeyCode.RightArrow)) { frame = Mathf.Min(match.frames.Length - 1, frame + 1); Apply(frame); }
            if (!playing && Input.GetKeyDown(KeyCode.LeftArrow)) { frame = Mathf.Max(0, frame - 1); Apply(frame); }
            if (Input.GetKey(KeyCode.Period)) { frame = Mathf.Min(match.frames.Length - 1, frame + 4); Apply(frame); }
            if (Input.GetKey(KeyCode.Comma)) { frame = Mathf.Max(0, frame - 4); Apply(frame); }
        }

        // Places both players, smokes and the spike for frame i. Map (x,y) -> world (x, _, y).
        void Apply(int i)
        {
            var f = match.frames[i];
            PlacePlayer(p0, f.p0x, f.p0y, f.p0aim, f.p0hp, VU);
            PlacePlayer(p1, f.p1x, f.p1y, f.p1aim, f.p1hp, Ice);

            // Spike.
            if (f.spikeState == "planted")
            {
                spike.gameObject.SetActive(true);
                spike.localPosition = new Vector3(f.spikeX, 0.3f, f.spikeY);
            }
            else spike.gameObject.SetActive(false);

            // Smokes: rebuild each frame (counts vary). Cheap at this scale.
            for (int c = smokesRoot.childCount - 1; c >= 0; c--) Object.Destroy(smokesRoot.GetChild(c).gameObject);
            if (f.smokes != null)
            {
                foreach (var k in f.smokes)
                {
                    var s = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    s.transform.SetParent(smokesRoot, false);
                    s.transform.localScale = Vector3.one * (k.r * 2f);
                    s.transform.localPosition = new Vector3(k.x, k.r * 0.7f, k.y);
                    Object.Destroy(s.GetComponent<Collider>());
                    s.GetComponent<Renderer>().sharedMaterial = SolidMat(new Color(0.84f, 0.78f, 0.71f));
                }
            }
        }

        void PlacePlayer(Transform t, float x, float y, float aim, float hp, Color live)
        {
            t.localPosition = new Vector3(x, 0.9f, y);
            // Aim is a 2D angle in the X,Y plane -> rotate around world Y so +Z faces the aim direction.
            t.localRotation = Quaternion.Euler(0f, 90f - aim * Mathf.Rad2Deg, 0f);
            var rend = t.GetComponent<Renderer>();
            rend.sharedMaterial.color = hp > 0 ? live : Dead;
            t.gameObject.SetActive(true);
        }

        void UpdateCamera()
        {
            if (cam == null) return;
            var eye = eyeSlot == 0 ? p0 : p1;
            if (firstPerson)
            {
                // First person: at the followed player's eye, looking along their aim.
                cam.transform.position = eye.localPosition + Vector3.up * (eyeHeight - 0.9f);
                cam.transform.rotation = eye.localRotation;
            }
            else
            {
                // Overview: high angled shot of the whole map.
                cam.transform.position = new Vector3(map.width / 2f, 34f, map.height / 2f - 10f);
                cam.transform.rotation = Quaternion.Euler(70f, 0f, 0f);
            }
        }

        // A minimal on-screen HUD so the viewer is usable without extra UI assets.
        void OnGUI()
        {
            if (match == null) return;
            var f = match.frames[Mathf.Clamp(frame, 0, match.frames.Length - 1)];
            var you = match.players.Length > eyeSlot ? match.players[eyeSlot].name : ("slot " + eyeSlot);
            GUI.Label(new Rect(12, 10, 900, 22),
                $"{match.players[0].name} vs {match.players[1].name}   round {f.round}   t={f.tick / (float)playbackTickRate:0.0}s   " +
                $"frame {frame}/{match.frames.Length - 1}   eye: {you}   [{(firstPerson ? "FPV" : "overview")}]");
            GUI.Label(new Rect(12, 30, 900, 22), "Space play/pause   ←/→ step   ,/. scrub   V view   Tab switch eye");
        }
    }
}
