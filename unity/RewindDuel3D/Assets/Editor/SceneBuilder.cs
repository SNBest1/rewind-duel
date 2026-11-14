using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

// Builds the replay scene without the GUI, so the whole project can be created and wired from the CLI.
// Run headless:  unity run --no-graphics -executeMethod RewindDuel.Editor.SceneBuilder.Build
// It creates a scene whose only object carries MatchReplay (which builds the map and players at play time),
// saves it to Assets/Scenes/Replay.unity, and makes it the single enabled scene in Build Settings.

namespace RewindDuel.Editor
{
    public static class SceneBuilder
    {
        const string ScenePath = "Assets/Scenes/Replay.unity";

        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var controller = new GameObject("RewindReplay");
            controller.AddComponent<MatchReplay>();

            System.IO.Directory.CreateDirectory("Assets/Scenes");
            bool saved = EditorSceneManager.SaveScene(scene, ScenePath);
            if (!saved)
            {
                Debug.LogError("SceneBuilder: failed to save scene.");
                EditorApplication.Exit(1);
                return;
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("SceneBuilder: wrote " + ScenePath + " and set it as the build scene.");

            // When invoked in batch mode, exit cleanly so the CLI returns.
            if (Application.isBatchMode) EditorApplication.Exit(0);
        }
    }
}
