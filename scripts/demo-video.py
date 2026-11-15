"""Cuts the demo video from footage recorded by the Unity client's demo director (DuelDemo.cs).

Usage: uv run --with pillow python scripts/demo-video.py <frames dir> <out.mp4>

The frames dir holds f000000.jpg... and frames.txt: one "index time" line per frame (real seconds) and
"# marker time" lines for scene boundaries. Each scene is cut between two markers, re-timed to a constant
30 fps from the real frame times (so replays play at true speed), given a title and a voiceover line
(macOS `say`, Ava Premium), and held on its last frame if the line runs longer than the footage.
Title cards are drawn here with Pillow in the game's own fonts and colours. Needs ffmpeg and macOS.
"""
import bisect
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
TEAL, RED, LABEL, INK = (64, 209, 189), (245, 74, 74), (245, 242, 235), (18, 19, 23)
COND = "/System/Library/Fonts/Avenir Next Condensed.ttc"
BODY = "/System/Library/Fonts/Avenir Next.ttc"
VOICE = "Ava (Premium)"


def font(path: str, size: int, face: str) -> ImageFont.FreeTypeFont:
    for i in range(16):
        f = ImageFont.truetype(path, size, index=i)
        if f.getname()[1] == face:
            return f
    raise SystemExit(f"no {face} face in {path}")


# (scene, cuts, title, subtitle, voiceover). A cut is (from marker, seconds after it, to marker, seconds after it, speed).
SCENES = [
    ("replay", [("replay", 0, "cameras", 0, 1.0)], "THE REPLAY", "every round, every kill, every shot",
     "This is the replay. Every round and every kill down the side, with each player's shots, hits and damage. "
     "The whole match on the timeline, and a live tactical map on the left."),
    ("cameras", [("cameras", 0, "fog", 0, 1.0)], "FOUR CAMERAS", "their eyes, free flight, overhead",
     "Watch from behind the player, through their eyes, from a free camera, or from straight above."),
    ("fog", [("fog", 0, "loss", 0, 1.0)], "WHAT THEY SAW", "the game's own line-of-sight rule",
     "Turn on What They Saw, and the rival only exists while this player could actually see him. "
     "It runs the game's own sight rule, so you see exactly what they saw."),
    ("loss", [("loss", 0, "coach", 0, 1.0)], "ROUND 3", "nipun loses the duel",
     "Round three. Nipun walks into Pratul, and loses the duel."),
    ("coach", [("coach", 0, "control-1", 0, 1.0)], "THE COACH", "a hundred futures from one tick",
     "So ask the coach what he could have done. The server forks the match at that exact tick and plays a hundred futures, "
     "every plan five times, against Pratul's recreation. Pick one, and the replay plays that future instead, "
     "with what really happened left behind as ghosts."),
    ("control", [("control-1", 0, "control-1", 1.15, 1.0), ("live-1", 0.2, "won-1", 0, 0.5, 1.7), ("won-1", 0, "attempts", 0, 1.0)], "TAKE CONTROL", "play it again from the same tick",
     "Or take control and play it again. Pratul repeats exactly what he did until you change the fight. "
     "Then he is recreated: his own habits from his recordings, with the AI fighting at his rank. "
     "This time, the duel goes the other way."),
    ("attempts", [("attempts", 0, "end", 0, 1.0)], "EVERY ATTEMPT, SAVED", "rebuilt exactly from its inputs",
     "Every attempt is saved to the timeline, and can be watched like the real match, rebuilt exactly from its inputs."),
]

# How long a scene's title stays up; the take-control title must be gone before the fight.
TITLE_SECONDS = {"control": 1.15}

INTRO = ("Rewind Duel. A one-on-one tactical shooter where every round is recorded, tick by tick, on a deterministic server. "
         "So any moment can be replayed, questioned, and played again.")
STATS = ("The recreation keeps the person's movement, ninety-one percent agreement on a match it never saw, "
         "and wins thirty-eight percent of rounds against an AI at their rank, where a plain clone won twenty-three.")
OUTRO = "Rewind Duel. Don't just watch the round you lost. Replay it."


def run(*args: str) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def voice(text: str, out: Path) -> float:
    run("say", "-v", VOICE, "-r", "182", "-o", str(out.with_suffix(".aiff")), text)
    run("ffmpeg", "-y", "-i", str(out.with_suffix(".aiff")), "-ar", "48000", "-ac", "2", str(out))
    return duration(out)


def title_png(title: str, sub: str, out: Path) -> None:
    """A title block for the middle of the frame, clear of the game's own panels."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    big, small = font(COND, 92, "Heavy"), font(BODY, 30, "Demi Bold")
    tw = d.textlength(title, font=big)
    sw = d.textlength(sub.upper(), font=small)
    bw = max(tw, sw) + 120
    x0, y0 = (W - bw) / 2, 470
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + 190], 10, fill=(10, 11, 15, 205))
    d.rectangle([x0, y0 + 186, x0 + bw, y0 + 190], fill=TEAL)
    d.text(((W - tw) / 2, y0 + 12), title, font=big, fill=LABEL)
    d.text(((W - sw) / 2, y0 + 128), sub.upper(), font=small, fill=TEAL)
    img.save(out)


def card(bg: Image.Image | None, lines: list[tuple[str, ImageFont.FreeTypeFont, tuple]], out: Path, accent=TEAL) -> None:
    """A full-frame card: a blurred, darkened frame of the game behind left-aligned type."""
    img = (bg.copy().filter(ImageFilter.GaussianBlur(18)) if bg else Image.new("RGB", (W, H), INK)).convert("RGBA")
    img = Image.alpha_composite(img, Image.new("RGBA", (W, H), (10, 11, 15, 190)))
    d = ImageDraw.Draw(img)
    y = 300
    for text, f, colour in lines:
        if text == "--":
            d.rectangle([160, y + 10, 560, y + 18], fill=accent)
            y += 60
            continue
        d.text((160, y), text, font=f, fill=colour)
        y += int(f.size * 1.15)
    img.convert("RGB").save(out)


def main() -> None:
    frames_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
    times: list[float] = []
    index: list[int] = []
    marks: dict[str, float] = {}
    for line in (frames_dir / "frames.txt").read_text().splitlines():
        a = line.split()
        if a[0] == "#":
            marks[a[1]] = float(a[2])
        else:
            index.append(int(a[0]))
            times.append(float(a[1]))
    tmp = Path(tempfile.mkdtemp(prefix="rewind-demo-"))
    parts: list[Path] = []

    def frame_at(t: float) -> Path:
        i = min(bisect.bisect_left(times, t), len(times) - 1)
        return frames_dir / f"f{index[i]:06d}.jpg"

    def still(png: Path, text: str, name: str, min_len: float, zoom: bool = True) -> None:
        wav = tmp / f"{name}.wav"
        vo = voice(text, wav)
        length = max(min_len, vo + 1.2)
        zp = (f"zoompan=z='min(1+0.0006*on,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(length * FPS)}:s={W}x{H}:fps={FPS},"
              if zoom else f"fps={FPS},")
        part = tmp / f"{name}.mp4"
        run("ffmpeg", "-y", "-loop", "1", "-i", str(png), "-i", str(wav),
            "-filter_complex", f"[0]{zp}format=yuv420p,fade=in:d=0.4,fade=out:st={length - 0.4}:d=0.4[v];[1]adelay=500|500,apad[a]",
            "-map", "[v]", "-map", "[a]", "-t", f"{length:.3f}", "-r", str(FPS), "-c:v", "libx264", "-crf", "18",
            "-preset", "medium", "-c:a", "aac", "-b:a", "192k", str(part))
        parts.append(part)

    cond_heavy, cond_med, body = font(COND, 150, "Heavy"), font(COND, 54, "Medium"), font(BODY, 34, "Regular")
    intro_bg = Image.open(frame_at(marks["replay"] + 3)).convert("RGB")
    card(intro_bg, [("REWIND", cond_heavy, LABEL), ("DUEL", cond_heavy, RED), ("--", body, TEAL),
                    ("Every round recorded. Any moment replayed, questioned and played again.", body, LABEL)], tmp / "intro.png")
    still(tmp / "intro.png", INTRO, "00-intro", 9)

    for k, (name, cuts, title, sub, text) in enumerate(SCENES, start=1):
        wav = tmp / f"{name}.wav"
        vo = voice(text, wav)
        # Each cut becomes its own clip: every frame lasts until the next one (the real capture times, slowed by the
        # cut's speed), re-timed to a constant 30 fps; a cut with zoom > 1 punches in on the crosshair.
        clips: list[Path] = []
        footage = 0.0
        for c, cut in enumerate(cuts):
            a, da, b, db, speed = cut[:5]
            zoom = cut[5] if len(cut) > 5 else 1.0
            t0, t1 = marks[a] + da, marks[b] + db
            i0, i1 = bisect.bisect_left(times, t0), bisect.bisect_left(times, t1)
            lst = tmp / f"{name}-{c}.txt"
            clip_len = 0.0
            with lst.open("w") as f:
                for i in range(i0, i1):
                    nxt = times[i + 1] if i + 1 < len(times) else times[i] + 1 / FPS
                    dur = (nxt - times[i]) / speed
                    clip_len += dur
                    f.write(f"file '{frames_dir / f'f{index[i]:06d}.jpg'}'\nduration {dur:.4f}\n")
                f.write(f"file '{frames_dir / f'f{index[i1 - 1]:06d}.jpg'}'\n")
            footage += clip_len
            cw, ch = int(W / zoom) // 2 * 2, int(H / zoom) // 2 * 2
            crop = f"crop={cw}:{ch}:{(W - cw) // 2}:{(H - ch) // 2},scale={W}:{H}:flags=lanczos," if zoom > 1 else ""
            clip = tmp / f"{name}-{c}.mp4"
            run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", f"fps={FPS},scale={W}:{H},{crop}format=yuv420p",
                "-t", f"{clip_len:.3f}", "-r", str(FPS), "-c:v", "libx264", "-crf", "14", "-preset", "fast", str(clip))
            clips.append(clip)
        joined = tmp / f"{name}-joined.txt"
        joined.write_text("".join(f"file '{p}'\n" for p in clips))
        length = max(footage, vo + 1.0)
        png = tmp / f"{name}-title.png"
        title_png(title, sub, png)
        hold = max(0.0, length - footage)
        show = TITLE_SECONDS.get(name, 3.1)
        part = tmp / f"{k:02d}-{name}.mp4"
        run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(joined), "-loop", "1", "-i", str(png), "-i", str(wav),
            "-filter_complex",
            f"[0]tpad=stop_mode=clone:stop_duration={hold + 0.1:.3f},format=yuv420p[base];"
            f"[1]format=rgba,fade=in:st=0.15:d=0.3:alpha=1,fade=out:st={show - 0.5:.2f}:d=0.4:alpha=1[t];"
            f"[base][t]overlay=0:0:shortest=0:enable='lt(t,{show})',fade=in:d=0.25,fade=out:st={length - 0.25:.3f}:d=0.25[v];"
            f"[2]adelay=400|400,apad[a]",
            "-map", "[v]", "-map", "[a]", "-t", f"{length:.3f}", "-r", str(FPS), "-c:v", "libx264", "-crf", "18",
            "-preset", "medium", "-c:a", "aac", "-b:a", "192k", str(part))
        parts.append(part)

    stat_bg = Image.open(frame_at(marks["control-1"] + 2)).convert("RGB")
    big = font(COND, 120, "Heavy")
    card(stat_bg, [("THE OPPONENT IS", cond_med, TEAL), ("THEM + THE AI", big, LABEL), ("--", body, TEAL),
                   ("Their habits from their own recordings: where they go, how they move, where they look.", body, LABEL),
                   ("The AI's fighting, at their rank. Off known ground, the AI plays it their way.", body, LABEL),
                   ("", body, LABEL),
                   ("91% move agreement on an unseen match  ·  38% rounds won vs 23% for a plain clone", font(BODY, 34, "Demi Bold"), TEAL)],
         tmp / "stats.png")
    still(tmp / "stats.png", STATS, "90-stats", 9, zoom=False)

    card(intro_bg, [("REWIND", cond_heavy, LABEL), ("DUEL", cond_heavy, RED), ("--", body, TEAL),
                    ("Don't just watch the round you lost. Replay it.", font(COND, 64, "Demi Bold"), LABEL),
                    ("", body, LABEL), ("DevHacks 2026  ·  Riot Track", body, (180, 180, 180))], tmp / "outro.png")
    still(tmp / "outro.png", OUTRO, "99-outro", 6)

    lst = tmp / "all.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(out))
    print(f"wrote {out} ({duration(out):.1f} s) from {len(parts)} parts in {tmp}")


if __name__ == "__main__":
    main()
