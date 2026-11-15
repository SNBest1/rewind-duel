using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

// Builds Assets/RewindDuel/RewindDuel.unity from code so the scene can be regenerated from the CLI:
//   ~/.unity/bin/unity run "<project>" -- -executeMethod RewindDuel.Editor.DuelSceneBuilder.Build
// or from the editor menu Rewind Duel > Build Scene. It wires the kept template weapon, enemy and sounds into
// DuelClient, saves one material per shader the client creates at runtime (so a standalone build keeps those
// shaders), raises the pipeline's per-object light limit for the neon, and makes this the only build scene.

namespace RewindDuel.Editor
{
    public static class DuelSceneBuilder
    {
        const string ScenePath = "Assets/RewindDuel/RewindDuel.unity";
        // The few FPS-template assets Rewind Duel still draws, kept under their template-relative paths.
        // The two prefabs here are script-free copies; the rest of the template was removed.
        const string Fps = "Assets/RewindDuel/Template/";
        const string Mats = "Assets/RewindDuel/Materials";

        static T Load<T>(string path) where T : Object
        {
            var a = AssetDatabase.LoadAssetAtPath<T>(Fps + path);
            if (!a) Debug.LogWarning("DuelSceneBuilder: missing " + Fps + path + " (the client falls back to plain shapes)");
            return a;
        }

        static Material Keeper(string shader)
        {
            if (!AssetDatabase.IsValidFolder(Mats)) AssetDatabase.CreateFolder("Assets/RewindDuel", "Materials");
            string path = Mats + "/Keep_" + shader.Replace('/', '_').Replace(' ', '_') + ".mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m) return m;
            var s = Shader.Find(shader);
            if (!s) { Debug.LogError("DuelSceneBuilder: shader not found: " + shader); return null; }
            m = new Material(s);
            AssetDatabase.CreateAsset(m, path);
            return m;
        }

        [MenuItem("Rewind Duel/Build Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var camGo = new GameObject("Main Camera");
            camGo.tag = "MainCamera";
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.Skybox;
            camGo.AddComponent<AudioListener>();

            // The sun; the client sets its colour and angle.
            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.shadows = LightShadows.Soft;

            var client = new GameObject("RewindDuel").AddComponent<DuelClient>();
            client.weaponPrefab = Load<GameObject>("Prefabs/Weapons/Weapon_Blaster.prefab");
            client.enemyPrefab = Load<GameObject>("Prefabs/Enemies/Enemy_HoverBot.prefab");
            client.shotClip = Load<AudioClip>("Audio/SFX/Weapons/Blaster_Shot.wav");
            client.hitClip = Load<AudioClip>("Audio/SFX/UI/Notification_Snap.wav");
            client.hurtClip = Load<AudioClip>("Audio/SFX/Player/Damage_Tick.mp3");
            client.killClip = Load<AudioClip>("Audio/SFX/Enemies/Hoverbot_Death.wav");
            client.roundStartClip = Load<AudioClip>("Audio/SFX/UI/Notification_Chime.wav");
            client.roundEndClip = Load<AudioClip>("Audio/SFX/UI/Notification_End.wav");
            client.dashClip = Load<AudioClip>("Audio/SFX/Player/Jump.wav");
            client.smokeClip = Load<AudioClip>("Audio/SFX/Weapons/Launcher_Release.wav");
            client.plantClip = Load<AudioClip>("Audio/SFX/Enemies/Turret_Alert.mp3");
            client.shaderKeepers = new[]
            {
                Keeper("Universal Render Pipeline/Lit"),
                Keeper("Universal Render Pipeline/Unlit"),
                Keeper("Universal Render Pipeline/Particles/Unlit"),
                Keeper("Skybox/Procedural"),
                Keeper("Hidden/Internal-Colored"),
            };

            // The arena is lit by many small neon lights; let each object take up to 8 of them.
            var pipeline = UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline;
            if (pipeline)
            {
                var so = new SerializedObject(pipeline);
                var limit = so.FindProperty("m_AdditionalLightsPerObjectLimit");
                if (limit != null && limit.intValue < 8) { limit.intValue = 8; so.ApplyModifiedPropertiesWithoutUndo(); }
            }

            if (!EditorSceneManager.SaveScene(scene, ScenePath))
            {
                Debug.LogError("DuelSceneBuilder: failed to save " + ScenePath);
                if (Application.isBatchMode) EditorApplication.Exit(1);
                return;
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("DuelSceneBuilder: wrote " + ScenePath + " and made it the only scene in Build Settings.");
            if (Application.isBatchMode) EditorApplication.Exit(0);
        }

        /// Builds the WebGL client into Build/WebGL (what the server serves at /play/), with the scenes and player
        /// settings the project already has. For rebuilding without opening the Editor:
        /// Unity -batchmode -nographics -projectPath unity/RewindDuelLive -executeMethod RewindDuel.Editor.DuelSceneBuilder.BuildWebGL
        [MenuItem("Rewind Duel/Build WebGL")]
        public static void BuildWebGL()
        {
            var scenes = System.Array.ConvertAll(EditorBuildSettings.scenes, s => s.path);
            var report = UnityEditor.BuildPipeline.BuildPlayer(scenes, "Build/WebGL", BuildTarget.WebGL, BuildOptions.None);
            var ok = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded;
            Debug.Log("DuelSceneBuilder: WebGL build " + report.summary.result + ", " + report.summary.totalSize + " bytes");
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
