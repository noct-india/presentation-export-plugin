# Presentation Export — Figma plugin

Turns a deck of Figma slide frames into a staggered, animated web presentation and publishes it
to a Surge URL. Replaces the hand/MCP pipeline that built
[`Pitch/Kotak 811`](../../../Pitch/Kotak%20811/pitch-deck/html-deck/) — live at
`kotak-811-pitch.surge.sh`.

Build plan: [`../../plans/2026-08-26-figma-presentation-export-plugin.md`](../../plans/2026-08-26-figma-presentation-export-plugin.md)

**Status: Phase 1 (extractor) COMPLETE — 65 tests, validated on the real 41-slide deck.**
Phase 2 (publish UI) and Phase 3 (bridge + Surge) are built and unit-tested, but the full round
trip has not yet been exercised end-to-end from Figma — the bridge has been driven by Node and
real assets, not by the plugin.

Last full run: 41 slides, 128 layers + 100 parts, 51 empty dropped, **anchor 228/228 within 1px**,
coarse grain 128 / fine 193, 1 link (internal, flagged), 1 video slot, 88 image fills all JPEG with
none animated. Payload 81.4 KB of geometry.

---

## What it does today

Extracts, per slide: layer geometry, a proposed reveal order, text hyperlinks, prototype URL
actions, video slots, animated-image detection, a census of every node and fill type, and one
transparent 2× PNG per layer plus a flat slide render. Reports what it found and hands back a
payload JSON.

Claude authors the web page from that payload — the plugin decides nothing about how the deck
should look, and owns no template.

**Reveal grain ships both ways.** A layer grouping more than one child is exported *with* its
children as `parts`, one level deep, so Claude can stagger a copy block line by line on one slide
and keep an artwork group whole on the next without re-extracting. Parts are **alternates, not
extras** — use a layer or its parts, never both, or the group paints twice.

## Running it

Needs the **Figma desktop app**. Zero-build — no `npm install`, no compile.

1. **Plugins → Development → Import plugin from manifest…** → this folder's `manifest.json`
2. Select a section, some slide frames, or just open the deck page
3. **Plugins → Development → Presentation Export** → **Extract deck**

**Republishing to the same address:** selecting a single SECTION (not loose frames, not the whole
page) that was published before pre-fills the project name with that slug, locks the field, and
shows a small **Linked** tag inside it, so Extract → Publish updates the same address instead of
asking for a name again. The link is written onto the section itself with `setPluginData` — it is
a fact about the section, not this machine, so it travels with the file to every collaborator who
opens it. Clicking the **Linked** tag unlocks the field if this publish should move elsewhere.

**To publish** (the extract in step 3 is local and needs none of this): the deck is built and
deployed by a small local bridge, because a Figma plugin is sandboxed and cannot write files or
run `surge` itself. Start the bridge by **double-clicking `Start Bridge.cmd`** (Windows) or
**`Start Bridge.command`** (macOS) in this folder, and leave that window open — no Terminal
needed. Both launchers find `node` even when Finder/Explorer's PATH is thin, and warn (with an
offer to stop it) if something is already holding the port instead of silently failing to bind.
*(macOS, first time only: `chmod +x "Start Bridge.command"`, or right-click → Open once to clear
Gatekeeper.)*

The plugin pings the bridge on open and shows a banner if it is not running. Once the bridge has
answered at least once, the banner also remembers the launcher's exact path on this machine (via
`figma.clientStorage` — the sandboxed iframe has no filesystem access of its own) and offers
**Copy path** and **Copy terminal command** buttons, so a designer never has to go hunting for the
file or retype the manual `node bridge/server.mjs` equivalent.

```bash
node test/extract.test.js
```

36 tests over the pure logic. Fixtures are real Phase 0 measurements from the Kotak deck, so they
pin observed behaviour rather than assumed behaviour.

---

## How it is put together

| File | Does |
|---|---|
| `code.js` | Plugin main thread. Traversal, geometry, reveal order, links, video slots, export loop. No pixel work. |
| `ui.html` | Iframe. Decodes each PNG on a canvas, drops empty layers, resolves the anchor, assembles the payload. |
| `test/extract.test.js` | Node tests over `code.js`'s pure half. |
| `spike/` | Phase 0 throwaway. Kept for the record — its README carries the API findings. |

**The pixel work is in the UI because it has to be.** The plugin sandbox has no canvas, so alpha
inspection and the anchor assertion can only happen iframe-side. `code.js` streams bytes out and
lets the UI decide.

`code.js` ends with a `module.exports` guard that Figma's sandbox skips (`module` is undefined
there) and Node picks up — which is how the pure logic stays testable without a bundler.

---

## What Phase 0 settled, and what it cost

Four spike runs against the real deck. Findings that shaped this code:

**`exportAsync` returns a real alpha channel.** The MCP/REST route bakes the slide background in
behind glyphs; the Plugin API does not. That deleted the ~50-line matte reconstruction
(`unkey()` in `build-layers.py`) and `layer-types.json` with it — and recovered **slide 35**, the
old pipeline's only flat fallback. The deck reaches **41 of 41**.

**`exportAsync` clips to the parent — the opposite of the MCP route.** The decoration circles on
slides 4 and 41 export as the visible `457×288` sliver, not the whole `457×457` shape. 27 decisive
samples across four slides, every one anchoring to `absoluteRenderBounds`, none to
`absoluteBoundingBox`.

So `pickAnchor` tries **render first**, keeping `box` only as an assertion fallback. Do not port
the MCP-era assumption back in; `build-layers.py`'s docstring describes the *other* surface's
behaviour and is wrong for this one.

**Empty `.pptx` spacer frames are detected by alpha, never by name** — `alphaMax === 0`. Confirmed
live on slide 35.

---

## Known gaps

- **Video bytes cannot be extracted — confirmed at runtime, not just from the docs.** A probe
  (`spike-video/`, now closed) enumerated the live `figma` global and the real `VideoPaint` against
  the actual video in the deck: `getVideoByIdAsync` / `getVideoByHash` / `getVideoById` are all
  `undefined`, `getImageByHash(videoHash)` returns null, and the `VideoPaint` prototype chain holds
  **ten data properties and zero methods**. The API is write-only for video. The extractor emits a
  video *slot* per fill and the designer drops the file in at publish time — that is the design,
  not a stopgap.
- **The prototype-reaction path is unexercised.** The Kotak deck is a `.pptx` conversion with zero
  instances and zero reactions across all four spike runs, so `urlActions` and the
  instance-recursion default rest on the API docs alone. Needs a different fixture.
- **A partial text hyperlink gets the whole node as its hotspot.** Figma exposes no per-character
  bounding box. Flagged `partial: true` in the payload rather than quietly approximated.
- **⚠️ A hidden node reports NULL for BOTH `absoluteRenderBounds` and `absoluteBoundingBox`.**
  Both describe what is *rendered*, and a hidden node renders nothing — and a node with
  `visible === true` gets null boxes too if any ancestor is hidden. Sweeping links out of hidden
  layers was therefore necessary but **not sufficient**: the links reached the payload and the
  review table with `rect: null`, and the renderer drops a rect-less link, so no `<a>` was ever
  written. `geometricRect()` derives the position from layout instead — `absoluteTransform` first
  (correct under a rotated or scaled ancestor), then a parent-chain sum. Visible links never reach
  it and still anchor render-first.
- **Links are reported but not yet excludable** — Phase 2's job. See the warning below.

## Masks

**Traversal never stops at a mask, or at anything inside one.** `everyNode()` descends
unconditionally through `children` with no mask logic and no depth limit, so links, videos, images,
text and the census inside a mask are swept exactly as they are anywhere else — at any depth, under
any names. A mask that is a **container** (a GROUP or FRAME carrying `isMask`) is descended into
just the same, so content whose *parent* is a mask is never lost.

That is pinned by tests, including one that fails if a "skip masks" shortcut is ever added. A
leaf-mask fixture cannot catch that regression — stopping at a leaf loses nothing — so the fixture
deliberately uses a mask container with content beneath it.

A mask is **not content**, though, and two things follow:

- **A mask node is never exported as a layer.** Exported it paints the mask *shape* — a solid blob
  appearing nowhere in the design — while the siblings it masks export unmasked.
- **A group holding a mask is never split into parts.** Parts export one node at a time and Figma
  applies a mask at the group level, so splitting one exports the mask as a blob and its content
  unmasked. The group stays whole: one reveal option lost, the picture kept correct. An unmasked
  group splits exactly as before, and a mask nested deeper does not constrain its ancestors —
  `hasMask` looks at a container's own children only.

⚠️ **A mask sitting DIRECTLY on a slide cannot be applied.** Figma applies a mask at the level of the
node containing it, and there that node is the slide frame — whose export is the flat render. Layers
export one at a time, so the masked layers render unmasked. The extractor names the mask and says so:

> `"Ellipse 4" is a mask directly on the slide — layers export one at a time, so it cannot be
> applied and the layers it masks will render UNMASKED. Group the mask together with what it masks
> and it will be exact.`

Grouping the mask with what it masks fixes it, because a group exports as one bitmap with the mask
baked in.

## ⚠️ Hiding a LAYER is not the same as hiding a SLIDE

- **Hidden layer inside a visible slide** → its links are extracted and become invisible hotspots.
  That is the feature below.
- **Hidden top-level frame (a slide)** → the whole slide leaves the deck, and its links go with it.
  There is no slide left for a hotspot to sit on, so this is correct — but it is now **reported by
  name**, with a count of the hyperlinks going down with it.

That distinction cost several debugging rounds. A designer hid the slide rather than a layer inside
it; `findSlides()` discarded the frame inside its type filter, so the sweep never saw it and the link
disappeared with no message. The diagnostics said `0 hidden nodes` — true, and deeply misleading,
because the hidden thing was never in the traversed tree at all. Extraction details now open with:

```
slide pool : 12 extracted · 1 hidden top-level frame(s) NOT extracted
```

## Links on hidden layers

A hyperlink parked on a switched-off layer, or nested inside a switched-off section, **is
extracted**. The sweep used to `continue` past any invisible node, so those links vanished from the
payload — and because they never reached the review table either, their absence was invisible too.

- **Detection has TWO paths, and the second is not optional.** `getStyledTextSegments` throws when
  Figma treats a node as inaccessible — which includes invisible ones in some editor states — and
  `textLinks()` used to swallow that and return `[]`, so the link was lost *without a trace*.
  It now reports the failure and falls back to **`TextNode.hyperlink`**, a separate API carrying a
  whole-node link. The segment path runs first and wins whenever it yields anything, so a visible
  link produces byte-identical output to before; the fallback can never duplicate or override it.
- A link found via the property path is tagged `via: 'hyperlink'` so the diagnostics say which API
  found it.

### URLs written into the LAYER NAME

Some files carry the link as the layer's **name** — the URL is in `node.name` and appears in no text
segment, no `TextNode.hyperlink` and no prototype reaction, so every native path correctly finds
nothing. `urlFromName()` handles that, over any layer name in any file:

- Finds an `http(s)` URL **anywhere** in the name, trims trailing sentence punctuation, and keeps a
  balanced bracket that genuinely belongs to the address (`…/Foo_(bar)`).
- Requires a real host — dotted, or `localhost` with an optional port. `Rectangle 42`,
  `example.com`, `ftp://…` and `mailto:…` are not links.
- **Consulted LAST, and only when the node produced no native link.** A node with a real hyperlink
  or a prototype URL action keeps exactly the link it had and its name is ignored, so nothing is
  duplicated or shadowed.
- **The slide frame's own name is excluded.** A frame named with a URL would become a hotspot
  covering the whole slide, swallowing every click and breaking click-to-advance — and a slide name
  is a title, not a layer annotation.
- Works on hidden layers exactly like visible ones: geometry comes from the node's real position, so
  a hidden named layer becomes an invisible hotspot in the right place and paints nothing.
- Tagged `via: 'name'`, shown as a **`from name`** chip in the review table. Internal/external
  handling is unchanged — an internal host still defaults to excluded.
- **Geometry comes from layout, not render bounds** — see the null-boxes note under Known gaps.
  This is the half that was missing on the first attempt.
- `figma.skipInvisibleInstanceChildren` is set to `false` at startup. It defaults to false in Figma
  but **true in Dev Mode**, where `children` skips invisible instance nodes entirely and touching
  their properties throws. This plugin reads links out of hidden layers, so it cannot inherit that.
- The link is **tagged, never filtered** — `hidden: true` in the payload, a `hidden layer` chip in
  the review table, and the same include/exclude checkbox as any other link.
- The content stays invisible in the published deck. A hidden node is not exported as a layer, and a
  link overlay paints nothing anyway — it is a bare `<a>` hotspot. So the published result is a
  clickable area, correctly positioned, over blank slide, with a pointer cursor.
- **Videos keep the original gate.** They are still skipped on the node's own visibility; widening
  that would change which clips the designer is asked to supply.

Verified in a browser against a rendered deck: a hidden link and a visible one produce identical
overlays — `cursor: pointer`, nothing painted, hit-testable, landing on the exact slide coordinates
they were extracted from.

**The link sweep reports itself.** Extraction details now carry a line like

```
link sweep: 412 nodes visited (37 hidden) · 168 text nodes (12 hidden) · links found: 1 via segments, 0 via the hyperlink property
```

plus a warning per detection error. That distinguishes *never reached the node* from *reached it and
found nothing* — indistinguishable from a missing Links section alone, and the reason this bug took
several passes. The **alpha-max-0 drop and the "no bitmap" drop apply to LAYERS only**; links are
carried straight off the plan slide and no layer filter can take one with it. There is a test
pinning that, because a missing Links section looks exactly like a filtering bug and is not one.

## ⚠️ Internal links

Phase 0 found a live `docs.google.com` presentation link inside slide 41's body text. Nobody put
it there for a client to click, and the current hand-built deck ships it, because nothing has ever
enumerated the links.

The extractor flags internal-looking hosts (`docs.google.com`, `drive.google.com`, `figma.com`,
`notion.so`, `slack.com`, `dropbox.com`, `airtable.com`, `localhost`) and shouts about them.
**Phase 2 makes them individually excludable before publish.** Until then, remove them in Figma.

Extraction without review is worse than no extraction — it ships an internal URL under a client's
eyes.
