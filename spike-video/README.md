# Video Byte Probe — CLOSED

> **Answered 2026-08-26: no. Kept for the record; do not re-run.**
>
> Ran against the real video in the Kotak deck (`Money Transfer 1`, slide 3,
> `videoHash 20efb2f9…`). Every retrieval path is absent or returns null, and the
> `VideoPaint` prototype chain carries **ten data properties and zero methods** — so this is
> absence, not an undocumented API. Figma's video API is **write-only**.
>
> Incidental: **`figma.createVideo` exists and is undocumented** (docs list only
> `createVideoAsync`). `figma.createGif` is `undefined` in the Figma editor, matching its
> FigJam-only docs.
>
> One sub-question was dropped by the lead's call rather than answered: `exportAsync` video formats
> were only ever aimed at a `RECTANGLE` and a `SECTION`, neither a legal target. Even a working MP4
> render would be a re-encode of Figma's playback rather than the source file, so the picker would
> survive either way — not worth further probing.
>
> **Outcome: the drag-and-drop picker in the main plugin is the design, and it rests on evidence.**

---

Can a Figma plugin retrieve the **original bytes** of a video fill?

The project currently answers "no" and falls back to a manual drag-and-drop picker. That answer
came from **reading developers.figma.com**, not from running anything. Docs lag runtimes, and there
is now a real video in the deck (`Money Transfer 1`, slide 3) to test against. This probe asks the
runtime.

## What it does that the doc read could not

1. **Enumerates the real `figma` global** — own properties *and* the whole prototype chain, which is
   where undocumented methods hide — filtered to anything matching `video|media|image|gif|asset|byte`.
2. **Enumerates the real `VideoPaint` object** the same way, rather than trusting the documented
   field list.
3. **Attempts every plausible retrieval path** against the actual video node:
   - `figma.getVideoByIdAsync(videoHash)` → and if it returns something, looks for `getBytesAsync`
   - `figma.getVideoByHash(videoHash)`
   - `figma.getImageByHash(videoHash).getBytesAsync()` — a long shot, but cheap: does the image
     path accept a video hash?
4. **Tests `exportAsync({format:'MP4'|'WEBM'|'GIF'})` from the PLUGIN.** This matters because the
   earlier "video freezes at its poster" finding came from the **MCP's** `export_video` — a
   different surface. The plugin's own video export was never tested.

## The decisive test

A poster frozen for N seconds and a real clip have identical duration and dimensions. Only the
pixels differ. So each exported clip is loaded into a `<video>`, sampled at two timestamps, and the
frames compared:

```
node-WEBM   5 KB  160×120  1.50s  MOVES (10.83% of pixels changed)
frame-WEBM  3 KB  160×120  1.50s  STATIC (0% changed — a frozen frame)
```

Validated against clips built with `MediaRecorder` — one deliberately moving, one deliberately
frozen — and it separates them correctly.

Two bugs were fixed in the probe itself before it was trusted:

- **`duration` came back `Infinity`.** Chrome reports no duration for streamed WebM until a seek
  past the end forces it to resolve. Without the workaround the motion test silently gave up on
  every clip.
- **The verdict fired on inconclusive evidence** — it announced success from a GIF frame count while
  both video tests were unjudged. Evidence is now tracked by kind, and an inconclusive test reports
  as inconclusive rather than as either answer.

## Running it

Figma desktop, on the page holding the video:

1. **Plugins → Development → Import plugin from manifest…** → this folder's `manifest.json`
2. **Plugins → Development → Video Byte Probe → Run probe**
3. Paste the whole report back.

## How to read the verdict

| Verdict | Means |
|---|---|
| **Original bytes retrievable** | An API returns the source file. Replace the picker with it. |
| **Exported clip MOVES** | No API gives the source, but Figma will render the video out. A re-encode with some quality loss — usable, picker becomes the fallback. |
| **Only a GIF animates** | Check it shows the *video* and not some other moving element before trusting it. |
| **INCONCLUSIVE** | A test could not be judged. Not an answer either way — re-run or inspect by hand. |
| **No path** | Every method absent or null, every export frozen. The picker stays, and now on evidence rather than on documentation. |
