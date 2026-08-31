# Publish bridge

A Figma plugin is sandboxed — no filesystem, no shell. It cannot write a `dist/` and it cannot
run `surge`. This sits beside it and does both.

```
Figma plugin  ──fetch POST /publish──▶  bridge  ──▶  dist/  ──▶  surge
```

Zero dependencies: Node built-ins only. Nothing to install.

## Running it

Double-click **`Start Bridge.cmd`** (Windows) or **`Start Bridge.command`** (macOS) in the plugin
folder (one level up from here) and leave the window open — no Terminal needed. The manual
equivalent is:

```bash
node bridge/server.mjs
```

Either way, `http://localhost:3001/health` should then answer, and the plugin's manifest already
points there. The plugin also pings `/health` when it opens and warns if the bridge is down.

| Route | Does |
|---|---|
| `GET /health` | build stamp + port |
| `POST /publish` | render a payload to `dist/`, and deploy **only** with `deploy: true` |
| `GET /preview/<project>/` | serve a built deck locally, before it goes anywhere public |

## ⚠️ It fails closed

`POST /publish` **builds and stops** unless the body carries exactly `deploy: true`. Anything
else — missing, `false`, the string `"true"` — renders and returns a `preview` URL instead.

This was originally a `dryRun` **opt-out**, and during development a stale bridge process that
predated the flag ignored it and published a test deck to a real public URL. A deploy puts content
on the open internet, so the safe state has to be the default, not the opt-in. There is a test
pinning every falsy shape.

## What varies per deck, and what does not

The viewer **shell** (`viewer/shell.html`) is constant. It is ported from the proven Kotak 811
deck and is not re-authored per publish, because it carries behaviour whose reasons are not
inferable from a payload:

- *"muted MUST be set before a source is attached"* — the autoplay decision is made when resource
  selection starts, and a still-unmuted video is refused.
- *"`paused === false` is not proof"* — a refused clip can report playing and never advance, which
  is exactly how a still frame looks. Hence the `currentTime` watchdog and the image fallback.
- *"Never remove the cap"* — gating hard on `decode()` left slides permanently blank in a throttled
  tab. `DECODE_GATE_MS = 400` with a `FAILSAFE_MS = 2500` backstop.

What varies is **data** — which grain each layer reveals at, the reveal order, the link and video
overlays. That is the split the live deck already uses (`index.html` + `window.DECK_LAYERS`), and
it is preserved rather than invented.

Verified after porting, against real Kotak assets: delays `0 / 0.07 / 0.14 / 0.21 / 0.28s`,
duration `0.48s`, easing `cubic-bezier(0.22, 1, 0.36, 1)`, `translateY(14px)`, first arrow press
completes a running build and the second advances, and a slide with no layers keeps its flat render.

## ⚠️ The toolbar is permanently visible — do not re-gate it

The first published deck's toolbar hid itself on `mouseleave` from `#stage`. The bar overlays the
stage, so **reaching for a button *is* a mouseleave**: it faded out, went `pointer-events:none`,
and the click fell **through** to the click-to-advance handler on `#stage`.

That handler advances on the outer 11% of the window — and the old left-aligned bar put every
button inside the left zone. Measured on a 1280px window: the **Next** button centred at `x=100`,
where the prev zone ends at `x=141`. So a click on **Next** ran `prev()`. That is the whole of
"the toolbar is glitchy, the controls don't work, and it jumps backwards".

A control that disappears when you reach for it cannot be fixed by tuning the fade. So:

- `#chrome` is a **centred pill** at `bottom:16px`, always `opacity:1`, always `pointer-events:auto`.
  There is no `show-chrome` class and no idle fade.
- It sits at `z-index:40`, **above** `#grid` (30), so it stays usable in the overview instead of
  being traded away for it. `#grid` carries 96px of bottom padding so the last row clears it.
The reference deck fades its own chrome on idle and hides it in the grid. **That part is
deliberately not ported**: this viewer keeps the toolbar up in every view.

**There is no progress bar.** The counter already says where you are, and a 2px strip pinned across
the top of the slide is one more fixed element overlaying the stage — the same fall-through hazard
in miniature. Removed at the designer's call after reviewing the first published preview.

## ⚠️ ONE INPUT = ONE SLIDE. Do not put a branch back in `next()` / `prev()`

They are bare `go(current ± 1)` calls, and they must stay that way.

The reference deck's presenter contract is *"the first press completes a running build, the second
advances"*. **Ported here, it was simply broken.** Every navigation starts a build lasting the decode
gate plus `REVEAL_MS` plus the stagger — about **1.2s on a three-layer slide**. At any normal
clicking pace every first click therefore landed inside a build and was swallowed, so the deck only
moved on the *second* click, in both directions. Reported from the live preview as "I have to
double-click to move".

The first attempt at fixing this made it worse: a `pending` flag extended the swallow window to cover
the decode gate as well, on the theory that the bug was a *skipped* slide. It was the opposite — the
click was being eaten, not doubled. Both `isRevealing()` and `pending` are gone.

Nothing is lost. The branch existed so a presenter never waits on an animation; moving on the first
click serves that better than eating the click did, `go()` resets the outgoing slide's build on its
way out, and `R` still replays the current slide's build on demand.

Verified in-browser on a 10-slide fixture, clicking *during* builds rather than after them: six
clicks 350ms apart move six slides, forward and back; three clicks 80ms apart (inside the decode
gate) move three; arrow keys behave identically; the ends stay clamped with no wrap-around. The
animation contract is untouched — delays `0 / 0.07 / 0.14s`, duration `0.48s`,
`cubic-bezier(0.22, 1, 0.36, 1)`, `translateY(14px)`.

## Overview captions sit ABOVE their thumbnails

A title under one thumbnail reads as the caption of the thumbnail *below* it as the eye scans a
grid. The caption is also **first in the DOM**, so the reading order matches what is on screen.

## Video fidelity — two rects, not one

Every video used to render with a hardcoded `object-fit: cover` inside a centring grid, so Figma's
`scaleMode`, crop transform and clipping were all discarded. A clipped video came out cropped from
the **centre** when Figma crops from wherever the node sits.

The fix needs no knowledge of the video's pixel size — Figma will not give it, and CSS computes
`cover`/`contain` from the media's own aspect ratio at runtime. What it needs is the media's box and
the window that clips it, and **Figma returns both rects on every node**:

```
rect (absoluteRenderBounds) → the clipping WINDOW — what survives ancestor clipping
box  (absoluteBoundingBox)  → the MEDIA's own box — where the video actually lives
```

`videoGeometry()` turns that pair into the media's position, size and `object-fit` relative to the
window. It is derived per node, so it holds for any position, size, aspect ratio or nesting depth
rather than being hand-authored per deck the way the reference's `clip:{w,h}` was.

| Figma `scaleMode` | Result |
|---|---|
| `FILL` | `object-fit: cover` |
| `FIT` | `object-fit: contain` |
| `CROP` | reconstructed from `videoTransform`, then `object-fit: fill` |
| `TILE` | ⚠️ no `<video>` equivalent — falls back to cover **and warns** |

`CROP`'s matrix maps node space into normalised media space, so inverting it gives the media's full
size and offset. A **rotated or skewed** crop is not reproducible without the media's intrinsic
size — that case warns and degrades to cover rather than rendering something subtly wrong.

## Video layering follows FIGMA's order, not the DOM's

Layers are appended in **reveal** order (`revealOrder` reorders for the animation), so DOM order was
never Figma order — and overlays, appended last, always painted on top. Anything drawn over a video
in Figma ended up buried underneath it.

`zIndexFor()` assigns explicit z-indices from Figma's child index: a layer takes `order × 100`, a
split part sits inside its parent's band, and a video takes `order × 100 + 50` — above its own layer
(whose PNG *is* the poster frame) and below the next sibling. Verified in a browser: a scrim at
Figma order 9 lands at `z-index: 900`, above every video.

The node's own exported bitmap is also emitted as the video's `poster`, which finally gives
`useFallback()` something to show when autoplay is refused — it used to bail on `if (!fb) return`.

## Video shape — ⚠️ a video's shape is rarely its OWN

Reading `cornerRadius` off the node that carries the video fill misses the usual Figma
construction entirely: a **FRAME with rounded corners and `clipsContent`**, holding a
square-cornered rectangle that carries the fill. The rounding lives on the frame. Same for a mask —
the shape doing the cutting is a **sibling**, not the video node. A first fix that read only the
video node's own radius therefore changed nothing on real decks, which is exactly what was reported.

`clipChain()` walks from the video up to the slide frame and collects **every ancestor that visually
clips** — anything with `clipsContent`, and any container holding a mask — each with its rect,
corner radii and, for a mask, its shape. `clipBoxes()` turns that into a list of shapes outermost
first, with the video's own rounding appended last and tightest, and the viewer renders **one nested
wrapper per shape**. Nesting reproduces the intersection exactly at any depth, so CSS never has to
intersect anything itself.

Verified in a browser across four constructions: rounding on the video node, rounding on a parent
frame, a custom vector mask, and a rounded video inside a rounded frame (which keeps **both** — 40px
outside, 8px inside).

⚠️ **The radius is expressed as PERCENTAGES, in the `H / V` form** — `border-radius: 3.75% … / 6.67% …`.
A px radius would stay fixed while the deck resized around it. And one percentage per corner is not
enough: a percentage resolves against the width on the horizontal axis and the height on the
vertical, so a single value turns a circular corner into an ellipse on any video that is not square.

### Custom vector masks

`border-radius` only describes rounded rectangles, so a video inside a vector mask published as a
plain box. Figma exposes the mask's shape as an SVG path (`fillGeometry`), and the viewer applies it
as a **`mask-image` holding an inline SVG with a viewBox**.

That choice is deliberate: an SVG with a viewBox **scales to whatever size the element is**, which
`clip-path: path()` does not — its coordinates are fixed user units and would not survive the deck
resizing. `-webkit-mask-image` is set alongside for older Safari.

⚠️ **The radius is expressed as PERCENTAGES, in the `H / V` form** — `border-radius: 3.75% … / 6.67% …`.
A px radius would stay fixed while the deck resized around it. And one percentage per corner is not
enough: a percentage resolves against the width on the horizontal axis and the height on the
vertical, so a single value turns a circular corner into an ellipse on any video that is not square.
Verified in a browser: 24px stays 24×24 slide-px on a 640×360 video, and 40px stays 40×40 on a
300×533 one.

## Video containers — one file per slot, labelled correctly

`videoTypeOf()` replaces `webm ? video/webm : video/mp4`, which handed a `.mov` to the page declared
as `video/mp4`. A `<source>` type is a hint the browser uses to decide whether to attempt a resource
at all, so a wrong one can make it skip a file it could have played.

```
.mp4 .m4v → video/mp4        .mov .qt → video/quicktime
.webm     → video/webm       .ogv .ogg → video/ogg
```

Anything else is **refused with a named error** rather than silently renamed `.mp4` — a `.mkv`
relabelled as mp4 produces a deck that loads and plays nothing.

**Containers are identified from the BYTES, not the filename.** `sniffVideo()` reads the ISO-BMFF
`ftyp` brand (or the EBML / Ogg magic), because an extension is a claim and plenty of files named
`.mov` carry an MP4 brand and are ordinary MP4s. Those are published as `.mp4` — correct
identification, not a shim, and it makes many "mov" files simply work.

⚠️ **A genuine QuickTime file is listed as `video/mp4` FIRST, deliberately.** A browser checks a
`<source>`'s `type` with `canPlayType` **before fetching it**, and Chrome answers `""` for
`video/quicktime` — so a source typed that way is skipped without ever being tried, even though
Chrome's demuxer handles H.264 in a `.mov` perfectly well. Labelling `.mov` "correctly" as
`video/quicktime` is exactly what stopped it playing, reported from a real publish: the video
positioned correctly and showed its poster but never played. `video/quicktime` stays as a second
hint. Both point at **the same file** — no second encode is ever requested. Firefox does not support
the container at all, which no hint can fix; the review UI says so.

**No alternate encodes are ever required.** The designer supplies the one file they have, each slot
is judged on its own file, and one slide can mix `.mov`, `.webm` and `.mp4` freely. Where a
container has known gaps the review table says so — WebM fails in older Safari (VP9 needs 14.1+ /
iOS 14.5+, VP8 never), QuickTime fails in Firefox — as advice, not a block.

Autoplay, loop, muted-before-source, `playsInline` and the `currentTime` watchdog are untouched.

### An undecodable container collapses without a fallback

Confirmed live: **only `.mov` failed**, and it failed *both* ways — no autoplay **and** a collapsed
bounding box. One cause: a container the browser cannot decode gives the element **no intrinsic
size**, so `object-fit` has nothing to fit and the video reads as an empty box.

A `poster` only shows until playback starts, so the fallback has to be a real `<img>` — no codec to
refuse, no autoplay policy. The video node's **own exported bitmap is the Figma frame**, so it serves
as both `poster` and `fallback` at no extra cost. The viewer swaps on the `error` event as well as
via the watchdog, because an unsupported container fails fast and definitively.

Verified in a browser: a video with undecodable bytes swaps to its still at **exactly the same box**,
inside the same rounded wrapper. The slide shows what Figma drew instead of a hole.

**This does not make `.mov` play.** Chrome cannot decode QuickTime reliably and Firefox not at all;
re-exporting as `.mp4` is the only real fix. It makes the failure look like the design.

## Reveal grain — how `auto` resolves

Explicit `coarse` / `fine` from the designer always wins. `auto` splits a group **only when every
part is text**: a copy block staggering line by line reads as deliberate, while artwork split into
pieces reads as a loading bug.

Parts are **alternates, not extras** — the renderer emits a layer *or* its parts, never both, or
the group paints twice. Stagger indices are renumbered after the swap, because a gap in `--i` shows
as a visible hitch mid-reveal.

## ⚠️ The project name is a global, first-come domain

`<project>.surge.sh` is not reserved for us. A short, plausible name is very likely to belong to a
stranger already — a designer publishing as `orient` hit `orient.surge.sh`, which serves an
unrelated company's site. Surge refuses with *"you do not have permission to publish to …"*, the
bridge returns 500, and **nothing is published**.

Check `npx surge list` for what this account actually owns before assuming a name is free. Prefer a
qualified name (`orient-pitch`, not `orient`).

**Whatever fails, the reason is in the 500's body.** `POST /publish` always answers
`{ error: <message> }`, token already scrubbed. The plugin discarded that for a while and printed
`bridge returned 500` instead, which is how a taken domain name reached a designer as a mystery —
the staging path had always read the body, the publish path had not. Both do now, and the
plugin names the taken-domain case explicitly. Do not "simplify" a failure branch back to a status
code.

## ⚠️ Surge rejects very large deploys — compress video first

Surge is a static-site CDN, not a video host. A deck heavy with raw video fails at deploy with a
generic `Error - Deployment did not succeed` **after** the whole upload — auth and domain are fine
(a taken name errors differently), and the bridge did **not** time out (that path says
`surge timed out after Ns`). Surge documents no exact number, but a single ~50 MB file inside a
~110 MB deploy is past what it reliably accepts; the reference Kotak deck published fine at a
fraction of that. Observed live: 29 files / 110 MB, of which three `.mov` clips were 52.9 / 20 /
11.8 MB.

The fix is upstream, not in the bridge: **supply web-encoded clips.** Figma `.mov` exports are
often 10–50 MB; the same clip as H.264 MP4 is usually a few MB, and MP4 also sidesteps the `.mov`
playback gaps documented above. The bridge deliberately does **not** transcode — that would mean
bundling ffmpeg, which it avoids by design.

The plugin now guards this so a doomed 100 MB upload is caught before it is sent: the Videos table
flags any clip over `BIG_CLIP_MB` (15 MB), the review warns when the deck will exceed `MAX_DECK_MB`
(50 MB), and a failed publish over that size names the cause instead of "the publish step failed."
Both thresholds live in `ui.html`. Advisory, not a hard block — Surge publishes no firm limit.

Compress with HandBrake ("Fast 1080p30" preset, MP4 container, **Web Optimized** checked) or ffmpeg:

```bash
ffmpeg -i clip.mov -c:v libx264 -crf 24 -preset slow -vf "scale='min(1920,iw)':-2" \
  -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k clip.mp4
```

## Credentials

`SURGE_TOKEN` is read from `NOCT/credentials/surge.env` at run time by walking up to `NOCT/`, so it
works wherever the repo sits. It is never hardcoded, never logged, and never returned to the plugin
— `scrub()` strips it from any surge output before it can reach an error message.

`surge login` is never run. An interactive prompt inside a spawned process is a hang with no error,
which is the worst failure shape for something a designer triggers from a plugin.

## Two loopback traps, both already paid for

Both are documented in `NOCT/Figma plugins/Design System Documentation/bridge/README.md`, and one
of them was hit again here for want of reading it first.

1. **Listen on BOTH `127.0.0.1` and `[::1]`.** `localhost` resolves to IPv6 on macOS and IPv4
   elsewhere, and there is no saying which Figma's iframe will pick. Binding one family leaves a
   failure that looks exactly like "the bridge isn't running".
2. **The manifest must name the hostname, not an IP.** Figma's validator rejects
   `http://127.0.0.1:3001` with *"must be a valid URL"* and accepts `http://localhost:3001`.

## Tests

```bash
node bridge/test/render.test.mjs
```

30 tests: grain resolution, the parts-are-alternates rule, contiguous stagger indices, overlay
building, `.env` parsing, domain validation, token scrubbing, a real `dist/` written to a temp dir,
stale-build cleanup, fail-closed publishing, and the viewer invariants above — the toolbar never
opacity-gated and out-stacking the grid, captions built before their thumbnails, no progress bar,
and `next()`/`prev()` as bare `go()` calls with `isRevealing`/`pending` absent.

Importing `server.mjs` does **not** bind a port — only running it directly does. Otherwise the
suite could not run while a bridge was up, and `import` would carry a surprising side effect.

## Not done yet

- **The blurred-diff verifier.** The original pipeline composited each slide's layers and diffed
  against its known-good flat render (`BLUR_RADIUS = 4` at 2×, `MAX_FRACTION_OVER = 0.0008`),
  dropping any failing slide back to its flat image so a visibly wrong slide never shipped. That
  gate does not exist here yet. Its natural home is the **plugin UI**, which already decodes every
  PNG and has a canvas — not this server, which would need a PNG decoder to do the same work slower.
- **The full round trip has never run from Figma.** The bridge has been driven by Node and by real
  Kotak assets, not by the plugin.
