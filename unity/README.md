# Rewind Duel — Unity 3D viewer

A 3D viewer for recorded Rewind Duel matches, built with Unity (URP, editor `6000.6.9f1`) and scaffolded entirely from the `unity` CLI. It is the Unity counterpart of the three.js first-person view (`web/fpv.html`).

**It is a renderer, not the game.** Unity reads a recorded match's per-tick snapshots (exported from the Node engine) and draws them in 3D — floor, extruded walls, two capsule players, a first-person camera. No gameplay logic lives in C#, so it can never disagree with the deterministic Node engine or the clones. This keeps the spec's hard rule 3 (one runtime, all simulation in Node); see `DECISIONS.md` D31/D48.

Map `x,y` (2D) become world `x,z`; up is `y`.

## Layout

```
unity/RewindDuel3D/
  Assets/
    Scripts/
      ReplayData.cs    DTOs matching the exported JSON (JsonUtility)
      MapBuilder.cs     builds floor + extruded walls + site markers from map.json
      MatchReplay.cs    loads match.json, animates both players + the FPV camera, HUD + controls
    Editor/
      SceneBuilder.cs   headless scene generator (run with -executeMethod)
    Scenes/Replay.unity the generated scene (its only object carries MatchReplay)
    StreamingAssets/    map.json + match.json  (generated; git-ignored)
```

## Build the data (from the repo root)

```bash
npm run export:unity               # exports the duel-straight preset's match
npm run export:unity -- <matchId>  # or any match id from data/
```

This writes `unity/RewindDuel3D/Assets/StreamingAssets/{map.json,match.json}` from `engine/map.ts` and `data/<matchId>.json`.

## Generate the scene (headless, from the Unity project dir)

```bash
cd unity/RewindDuel3D
~/.unity/bin/unity run . -- -executeMethod RewindDuel.Editor.SceneBuilder.Build
```

The CLI runs the editor in batch mode and builds `Assets/Scenes/Replay.unity`.

## Run it

Open the project in the Unity editor and press Play on `Replay.unity`, or build a standalone:

```bash
cd unity/RewindDuel3D
~/.unity/bin/unity build . --target StandaloneOSX --output /tmp/RewindDuel3D.app
```

### Controls

| Key | Action |
| --- | --- |
| Space | play / pause |
| ← / → | step one frame (paused) |
| , / . | scrub back / forward |
| V | toggle first-person vs overview camera |
| Tab | switch which player the camera follows |

## Why no live WebSocket / no clone in C#

The Node engine is the single deterministic source of truth. Re-implementing movement, vision or the KNN clone in C# would be a second engine that could drift from the recordings and the evals. The viewer therefore consumes exported snapshots only — exactly like the three.js FPV. Driving a live rewind still happens in Node (`server/` + `web/replay.html`).
