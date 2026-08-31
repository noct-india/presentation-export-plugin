# Phase 0 Spike — run this before anything else gets built

Three unknowns decide the architecture of the presentation-export plugin. All three are
questions about what the Figma Plugin API actually does, and none can be answered from the
docs. This plugin answers them in one run. It is **read-only** — it exports nothing to disk
and writes nothing to the document.

Build plan: `../../plans/2026-08-26-figma-presentation-export-plugin.md`

---

## What it answers

**A — Does `exportAsync` return TEXT layers with a real alpha channel?**

This is the one that matters. The MCP/REST route does *not*: it renders a text node with the
slide background composited in behind the glyphs, alpha 255 everywhere. Laid over artwork,
that opaque box masks whatever sits beneath it. `build-layers.py` spends ~50 lines undoing it
— reconstructing the matte from `E = a·C + (1-a)·B`.

- **If clean** → the entire matte-recovery stage never gets written, and slide 35 (white
  labels on `#fcfcfc`, currently the deck's only flat fallback) may become recoverable,
  taking Kotak from 40 of 41 to 41 of 41.
- **If baked** → port `unkey()` and keep the flat-fallback path exactly as it is.

The spike also reports, per sample, which rect matches the exported pixel size — `box`
(`absoluteBoundingBox`) or `render` (`absoluteRenderBounds`). That is trap 2 from the Kotak
build. A `neither` result would mean the existing rule needs a third case.

**B — Do inherited prototype reactions surface on an instance's sublayers?**
Undocumented. Decides whether the link sweep has to recurse into instances.

**C — How much can be exported at 2× before the tab's memory ceiling bites?**
`exportAsync` returns a `Uint8Array` held in plugin memory, inside the browser's ~2 GB
per-tab budget. Off by default — tick the box to run it.

---

## Running it

Needs the **Figma desktop app** — the browser build cannot load an unpublished plugin.

1. Open the Kotak 811 file → page **"Testing ppt"**.
2. **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this folder.
3. Select a handful of slides that include **text sitting over artwork or a photo** — that is
   the case the whole question turns on. Text on a plain background cannot tell the two
   outcomes apart. Slides 2, 8 and 11 are good candidates (8 has the full-bleed art layer).
   With nothing selected it falls back to every top-level frame on the page.
4. **Plugins → Development → Phase 0 Spike** → **Run spike**.
5. Read the three coloured verdicts, hit **Copy report**, and paste it back into the session.

For **C**, tick *include memory test* and run it once on the whole page with nothing selected.
It exports all 41 frames sequentially. Expect it to take a while; it reports total MB, mean
and slowest export, and stops at the first failure.

---

## Reading the result

Each text sample prints its alpha profile:

```
[alpha]  heading            <- real matte
    alpha min=0 max=255  fully-transparent=89.0%  partial=5.2%
    corner px #000000 a=0    slide bg #fcfcfc

[OPAQUE] label             <- background baked in
    alpha min=255 max=255  fully-transparent=0.0%  partial=0.0%
    corner px #fcfcfc a=255  slide bg #fcfcfc
```

The tell is the **corner pixel**: `a=0` means a genuine matte; `a=255` with the corner RGB
equal to the slide background is the defect. `partial%` should be non-zero on any
anti-aliased glyph — if it is 0 and alpha is uniformly 255, the export is flat.

A **MIXED** verdict is not a pass. It means some texts came back clean and some didn't, and
the difference has to be understood before Phase 1 starts — most likely a blend mode, an
effect, or a text node whose own fill is opaque behind the glyphs.

---

## Run 1 result (2026-08-26, slide 8, 6 text nodes)

**A — CLEAN, 6/6.** `exportAsync` returns a real alpha channel. `unkey()` and
`layer-types.json` drop out of scope entirely. Full findings in the build plan.

Two samples showed why corner-alpha alone is not a sufficient test, and the spike now says so
in a comment: `LED BY` reported `corner a=255` because the label is cropped so tightly the
top-left pixel sits *inside the "L"* — but the corner RGB was the text colour, not the slide
background. The defect signature is `a=255` **and** corner RGB == slide bg. The gate is
`zeroPct > 1%`, which called all six correctly.

All six text nodes anchored to `absoluteRenderBounds`, none to `box`, worst error 0.45 CSS px.

**B — unanswered** (no instances or links on slide 8). **C — not run.**

## Run 2 result (slide 35 — 14 text, 15 non-text)

**A — CLEAN, 12/12, white text included.** `Brand & Visual Designers + Strategists` (fill
`#ffffff`) exported `corner a=0`, 79.8% transparent. That was the deck's one unrecoverable
matte, so **Kotak reaches 41 of 41**. Text anchored to render in all 12; with run 1 that is
18 of 18.

**Trap 3 confirmed.** The `spacer` frame exported `alpha min=0 max=0` — the empty
`.pptx`-conversion frame, detected by alpha rather than by name, exactly as before.

**A2 — INCONCLUSIVE, after a spike bug was fixed.** The first A2 verdict claimed all 10
non-text samples matched `box`. That was wrong: every sample had `box == render` exactly, and
the tie-break resolved equal distances to `box`, inventing a conclusion from samples that
could not tell the rects apart. The spike now flags `box == render` as an explicit **tie**,
excludes ties from the tallies, and reports INCONCLUSIVE when nothing decisive remains.

Also fixed: non-text nodes borrowed the TEXT discriminator and were labelled `[OPAQUE]`,
making the slide-root frame and a 1px `#e6e6e6` divider look like defects when both are
correctly solid. Non-text now reads `[alpha]` / `[solid]` / `[empty]` with no defect judgement.

**B — still unanswered** (no instances on slide 35 either). **C — 1 frame only**, not meaningful.

## Runs 3 and 4 result (slides 41 and 4 — the clipped decoration circles)

**A2 — DECISIVE. `exportAsync` CLIPS to the parent.** Both slides, identical:

```
ELLIPSE Decoration · circle
    export 457x288    box 457x457    render 457x288    -> anchor: render
```

The export is the visible sliver, not the whole circle — the **opposite** of the MCP/REST route,
where the export held the whole shape and `box` sometimes won. That is why the original build
needed a two-candidate match; the plugin does not.

**Across all four runs: 27 decisive samples, every one on `absoluteRenderBounds`. Zero on `box`.**
Anchor on render bounds; keep `box` as an assertion fallback only.

**B — half answered on real data.** Slide 41 carries a working text hyperlink, so
`getStyledTextSegments(['hyperlink'])` is confirmed. But it points at an **internal Google Slides
document** — see the warning in the build plan; Phase 2 gains a link review list because of it.

The Kotak deck has **zero instances and zero prototype reactions** across all four runs (it is a
`.pptx` conversion, flat frames throughout), so that path cannot be exercised on this fixture.

## Still open

1. **C on the whole page** — nothing selected, memory box ticked. The only genuinely open item.
   Every run so far had one frame selected (116–163 KB, ~390 ms each).
2. **Prototype reactions + instances** — need a deck that has them.

## Gate

**Phase 0 is complete enough to start Phase 1.** A cleared, slide 35 recovered, the anchor rule
settled by evidence. Neither open item blocks the extractor.

---

## Notes

- Zero-build: plain JS, no `npm install`, no compile step. Edit and re-run.
- Manifest id is `noct-presentation-export-spike` — deliberately separate from the real
  plugin's id, so the throwaway can be deleted without touching anything the plugin stores.
- Sample cap is 12 text nodes (`MAX_TEXT_SAMPLES` in `code.js`); raise it if the sample looks
  unrepresentative.
- `ui.html` was verified against mock data in a browser before handing over: the clean/baked
  discrimination, the box-vs-render anchor rule, and all three verdict paths render correctly.
