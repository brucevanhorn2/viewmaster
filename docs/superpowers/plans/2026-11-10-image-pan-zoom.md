# Image & Diagram Pan/Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map-style pan & zoom (Ctrl+wheel zoom at cursor, drag to pan, −/%/+/Fit controls) for standalone images/SVGs and for mermaid diagrams and images inside rendered markdown, without scaling the rest of the UI.

**Architecture:** One framework-free controller (`attachPanZoom`) owns events, controls and state for a single viewport/content pair, built on pure geometry functions. `ImageView` uses it from a React effect; markdown views use a document-level helper (`attachDocumentPanZoom`) that runs after mermaid finishes, wraps each zoomable element in a fixed-size box, and restores per-diagram state by index across reloads.

**Tech Stack:** React 19 + TypeScript renderer (`src/renderer/src`), vitest (`npm test`; DOM tests opt in with `// @vitest-environment jsdom`), `npm run typecheck`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-image-pan-zoom-design.md`

## Global Constraints

- Zoom range: Fit (`zoom = 1`) to **800%** (`zoom = 8`); never below Fit.
- **Ctrl+wheel** zooms anchored at the pointer; **drag** pans; **Fit** returns to fit and recenters.
- Standalone images: plain wheel pans vertically, Shift+wheel horizontally; controls always visible.
- In markdown: **plain wheel is never intercepted** (page scrolls); controls appear on hover; boxes keep the element's natural rendered size (no layout jump).
- SVGs must stay crisp: apply zoom by setting the element's **width/height in px** (forces re-raster), and pan via `transform: translate(...)` only. Never `scale()` an SVG.
- Standalone SVGs stay inside `<img src={svgDataUrl(...)}>` — do not inline untrusted SVG markup.
- No new npm dependencies. App-wide Zoom In/Out, SVG Source view, PDF/HTML/code views unchanged.
- Zoom/pan not persisted across file switches; not mirrored between side-by-side panes.

## Review Focus

1. Plain wheel over a markdown diagram must reach the page (no `preventDefault`) — a reader scrolling a doc must not get stuck. → Task 2 test `plain wheel is not prevented when wheelPans is false`.
2. Ctrl+wheel over any zoomable must `preventDefault`, or Chromium zooms the whole window (the original bug). → Task 2 test `ctrl+wheel prevents default and zooms`.
3. A drag that starts on an image inside a markdown link must not navigate when released. → Task 2 test `click after a drag is suppressed`.
4. Elements with no usable size (SVG `<img>` with `naturalWidth === 0`, a mermaid node that failed and has no `<svg>`, an `<img>` that hasn't loaded) must be skipped or handled without throwing or producing a 0×0 box. → Task 1 `fitSize` zero-size test; Task 4 tests for `.mermaid-error` and unloaded images.
5. Reload of the same doc where the number of diagrams changed must reset to Fit rather than apply one diagram's zoom to another. → Task 4 test `resets all when count changes`.

---

### Task 1: Pure pan/zoom geometry

**Files:**
- Create: `src/renderer/src/image/panZoomMath.ts`
- Test: `src/renderer/src/image/panZoomMath.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Size { width: number; height: number }
  export interface PanZoomState { zoom: number; x: number; y: number } // zoom 1 = fit; x/y = content top-left offset in viewport px
  export const MIN_ZOOM = 1
  export const MAX_ZOOM = 8
  export const ZOOM_STEP = 1.25 // per +/− click and per wheel notch
  export function fitSize(natural: Size, viewport: Size): Size | null
  export function clampState(s: PanZoomState, fit: Size, viewport: Size): PanZoomState
  export function zoomAt(s: PanZoomState, factor: number, point: { x: number; y: number }, fit: Size, viewport: Size): PanZoomState
  export function panBy(s: PanZoomState, dx: number, dy: number, fit: Size, viewport: Size): PanZoomState
  export function fitState(fit: Size, viewport: Size): PanZoomState
  ```

- [ ] **Step 1: Write failing tests** in `panZoomMath.test.ts` (node env):
  - `fitSize` — `({2000,1000},{1000,800})` → `{1000,500}`; small image `({200,100},{1000,800})` → `{200,100}` (never upscaled); `({0,0},…)` → `null`; `({100,0},…)` → `null`.
  - `fitState` — `fit {1000,500}`, `viewport {1000,800}` → `{zoom:1, x:0, y:150}` (centered).
  - `zoomAt` — from `fitState` above, factor 2 at point `{x:500,y:400}` → `zoom 2`, and the content point under the cursor is unchanged: `(500 - x)/zoom` and `(400 - y)/zoom` equal their before values (assert with `toBeCloseTo`).
  - `zoomAt` clamps: factor 100 → `zoom === MAX_ZOOM`; factor 0.01 from zoom 1 → `zoom === 1` and equals `fitState(...)`.
  - `clampState` — when scaled content is larger than the viewport, `x` is clamped to `[viewport.width - fit.width*zoom, 0]` (same for y); when smaller on an axis, that axis is centered.
  - `panBy` — at zoom 2, `panBy(s, -50, 0, …)` moves `x` by −50 within bounds; a huge pan stops at the clamp bound.

- [ ] **Step 2: Run** `npx vitest run src/renderer/src/image/panZoomMath.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the signatures above. `zoomAt`: `newZoom = clamp(zoom*factor)`, `ratio = newZoom/zoom`, `x' = px - (px - x)*ratio` (same for y), then `clampState`. `clampState` always recenters an axis whose scaled size ≤ viewport.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/renderer/src/image/panZoomMath.* && git commit -m "feat(image): pan/zoom geometry helpers (#49)"`

---

### Task 2: DOM controller with controls

**Files:**
- Create: `src/renderer/src/image/panZoom.ts`
- Test: `src/renderer/src/image/panZoom.test.ts` (`// @vitest-environment jsdom`)
- Modify: `src/renderer/src/styles.css` (append a `/* ---- pan/zoom ---- */` section)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  ```ts
  export interface PanZoomOptions {
    natural: Size              // intrinsic size of the content
    wheelPans: boolean         // true: plain/shift wheel pans (standalone); false: plain wheel untouched (markdown)
    controlsOnHover: boolean   // true: controls hidden until viewport :hover (markdown)
    initial?: PanZoomState     // restore instead of fitting
  }
  export interface PanZoomController {
    getState(): PanZoomState
    zoomBy(factor: number): void      // anchored at viewport center
    fit(): void
    relayout(natural?: Size): void    // recompute fit after a viewport resize or content swap; keeps zoom/x/y (clamped)
    destroy(): void                   // removes listeners, controls, and inline styles it added
  }
  export function attachPanZoom(viewport: HTMLElement, content: HTMLElement, opts: PanZoomOptions): PanZoomController
  ```
  CSS classes: `.pz-viewport` (added to viewport: `position: relative; overflow: hidden; cursor: grab`), `.pz-viewport.pz-dragging` (`cursor: grabbing`), `.pz-content` (added to content: `position: absolute; top: 0; left: 0; transform-origin: 0 0; max-width: none; max-height: none`), `.pz-controls` (top-right cluster), `.pz-hover .pz-controls` hidden unless `.pz-viewport:hover`. Controls DOM: `<div class="pz-controls"><button data-pz="out">−</button><span data-pz="pct">100%</span><button data-pz="in">+</button><button data-pz="fit">Fit</button></div>`. `%` shows `Math.round(zoom*100)` relative to Fit.

- [ ] **Step 1: Write failing tests.** Stub layout: `viewport.getBoundingClientRect = () => ({left:0, top:0, width:1000, height:800, …})`. Content is a `<div>`; `natural = {2000,1000}`.
  - `applies fit on attach` — `content.style.width === '1000px'`, `height === '500px'`, `transform` contains `translate(0px, 150px)`; pct reads `100%`.
  - `ctrl+wheel prevents default and zooms` — dispatch `new WheelEvent('wheel', {deltaY:-100, ctrlKey:true, clientX:500, clientY:400, cancelable:true})` on the viewport → `defaultPrevented === true`, `getState().zoom` ≈ `1.25`, `content.style.width === '1250px'` (zoom via width, not `scale`), `transform` does not contain `scale`.
  - `plain wheel is not prevented when wheelPans is false` — `deltaY:100`, no modifiers → `defaultPrevented === false`, state unchanged.
  - `plain wheel pans when wheelPans is true` — after `zoomBy(2)`, `deltaY:100` → `defaultPrevented === true`, `y` decreased by 100 (or hit its clamp); with `shiftKey:true` → `x` changes instead.
  - `drag pans` — `pointerdown` (button 0) at (500,400), `pointermove` to (450,380), `pointerup` → x/y moved by (−50,−20) after `zoomBy(2)`; viewport has `pz-dragging` only during the drag. Guard `setPointerCapture` (absent in jsdom).
  - `click after a drag is suppressed` — wrap viewport in an `<a>` with a click spy; drag > 4px then dispatch `click` on content → spy not called, event `defaultPrevented`. A click without a drag (move < 4px) → spy called.
  - `buttons` — click `[data-pz=in]` → zoom 1.25; `[data-pz=fit]` → `getState()` equals `fitState`; zoom never exceeds 8 after 20 `in` clicks.
  - `initial state is restored` — `attachPanZoom(..., {initial:{zoom:2,x:-100,y:-50}})` → `getState()` equals it (clamped).
  - `destroy` removes `.pz-controls`, the `pz-*` classes, and inline width/height/transform; further wheel events do nothing.

- [ ] **Step 2: Run** `npx vitest run src/renderer/src/image/panZoom.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `attachPanZoom`** in `panZoom.ts`. Wheel listener registered with `{ passive: false }`. Click suppression: capture-phase `click` listener on the viewport that calls `preventDefault()` + `stopPropagation()` when the last pointer sequence moved > 4px. Use `ResizeObserver` on the viewport (if defined) to call `relayout()`. Append the CSS section to `styles.css`, using existing tokens (`--bg-sidebar`, `--border`, `--bg-hover`) for the controls.

- [ ] **Step 4: Run** the same command — Expected: PASS. Then `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit** — `git add src/renderer/src/image/panZoom.* src/renderer/src/styles.css && git commit -m "feat(image): pan/zoom DOM controller and controls (#49)"`

---

### Task 3: Standalone image viewer

**Files:**
- Modify: `src/renderer/src/components/ImageView.tsx`
- Modify: `src/renderer/src/components/ContentPane.tsx:258` and `:275` (the two `<ImageView>` call sites)
- Modify: `src/renderer/src/styles.css:703-715` (`.image-view` rules)

**Interfaces:**
- Consumes: `attachPanZoom`, `PanZoomController`, `PanZoomState` (Task 2).
- Produces: `ImageView({ src, resetKey }: { src: string; resetKey: string })`. ContentPane passes `resetKey={file.absPath}` at both sites.

- [ ] **Step 1: Implement.** `ImageView` keeps its `failed` handling. On `<img>` `load`, read `naturalWidth/naturalHeight`; if either is 0 (SVG without intrinsic size), fall back to the rendered `getBoundingClientRect()` size before attaching, and if that is also 0, render without pan/zoom (today's look). Attach with `{ wheelPans: true, controlsOnHover: false, initial }` where `initial` is the last `getState()` saved in a ref **only if `resetKey` is unchanged** since that state was saved; changing `resetKey` discards it (file switch → Fit). Destroy the controller in the effect cleanup and on `src` change (save state first). Replace `.image-view` CSS: `height: 100%` stays; drop the flex centering and `img` max-size rules (the controller now positions and sizes the image).

- [ ] **Step 2: Verify** `npm run typecheck` and `npm test` — Expected: all pass.

- [ ] **Step 3: Verify in the app** with the `run-viewmaster` skill driver (on Windows run `node .claude/skills/run-viewmaster/driver.mjs` directly, no `xvfb-run`; set `SCREENSHOT_DIR` to a scratch folder). `npm run build`, `launch`, open a folder with a large `.svg` (create one if needed: an SVG with `width="4000" height="3000"` and small text). `send-ipc menu:openFile {"root":"<dir>","absPath":"<dir>/big.svg"}`, then `eval` a `WheelEvent` with `ctrlKey:true` on `.image-view` and `ss zoomed`. Expected: controls visible top-right, pct > 100%, text sharp in the screenshot, toolbar/sidebar unchanged in size.

- [ ] **Step 4: Commit** — `git add src/renderer/src/components/ImageView.tsx src/renderer/src/components/ContentPane.tsx src/renderer/src/styles.css && git commit -m "feat(image): pan/zoom for standalone images and SVGs (#49)"`

---

### Task 4: Document-level attachment for markdown

**Files:**
- Modify: `src/renderer/src/markdown/mermaidRunner.ts` — `runMermaidIn(container): Promise<void>` (return the chained queue promise; behavior otherwise unchanged)
- Create: `src/renderer/src/markdown/documentPanZoom.ts`
- Test: `src/renderer/src/markdown/documentPanZoom.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `attachPanZoom`, `PanZoomState` (Task 2).
- Produces:
  ```ts
  export const MIN_ZOOMABLE_PX = 64 // images smaller than this on both axes are skipped (icons/badges)
  export interface DocumentPanZoom { states(): PanZoomState[]; destroy(): void }
  export function attachDocumentPanZoom(container: HTMLElement, saved: PanZoomState[] | null): DocumentPanZoom
  ```
  Zoomables, in document order: `pre.mermaid[data-processed]:not(.mermaid-error) > svg`, and `img` elements that are `complete` with `naturalWidth > 0` and either natural dimension ≥ `MIN_ZOOMABLE_PX`. Each is wrapped in `<div class="pz-viewport pz-hover pz-doc">` sized to the element's current `getBoundingClientRect()` (px), attached with `{ wheelPans: false, controlsOnHover: true }`. `saved` is applied by index **only when `saved.length` equals the number of zoomables found**; otherwise all start at Fit. `destroy()` unwraps every element back to its original position.

- [ ] **Step 1: Write failing tests** (stub `getBoundingClientRect` on created elements and `naturalWidth`/`complete` via `Object.defineProperty`):
  - `wraps a processed mermaid svg` — container with `<pre class="mermaid" data-processed="true"><svg/></pre>` → one `.pz-viewport.pz-doc` containing the svg, with `.pz-controls`.
  - `skips failed mermaid nodes` — `pre.mermaid.mermaid-error` with text only → no wrapper, no throw.
  - `skips tiny and unloaded images` — a 32×32 img and an img with `complete=false` → not wrapped; a 400×300 img → wrapped.
  - `restores saved states by index` — two zoomables, `saved=[{zoom:2,…},{zoom:3,…}]` → `states()` equals them (after clamping).
  - `resets all when count changes` — three zoomables, `saved` of length 2 → every `states()[i].zoom === 1`.
  - `destroy unwraps` — after `destroy()`, `container.innerHTML` equals the original markup.
  - (`runMermaidIn`'s new `Promise<void>` return is covered by typecheck; don't import mermaid into a jsdom test. Return `Promise.resolve()` on its no-nodes early-return path.)

- [ ] **Step 2: Run** `npx vitest run src/renderer/src/markdown/documentPanZoom.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `documentPanZoom.ts` and the `runMermaidIn` return-type change.

- [ ] **Step 4: Run** the same command, then `npm test` and `npm run typecheck` — Expected: PASS / no errors.

- [ ] **Step 5: Commit** — `git add src/renderer/src/markdown/mermaidRunner.ts src/renderer/src/markdown/documentPanZoom.* && git commit -m "feat(markdown): attach pan/zoom to diagrams and images in rendered docs (#49)"`

---

### Task 5: Wire into markdown views

**Files:**
- Create: `src/renderer/src/markdown/useDocumentPanZoom.ts`
- Modify: `src/renderer/src/components/MarkdownView.tsx:88-92` (mermaid effect)
- Modify: `src/renderer/src/components/MarkdownSideBySideView.tsx:31-35` (mermaid effect in the per-pane hook)

**Interfaces:**
- Consumes: `runMermaidIn(container): Promise<void>`, `attachDocumentPanZoom`, `DocumentPanZoom` (Task 4).
- Produces: `useDocumentPanZoom(ref: React.RefObject<HTMLElement | null>, html: string, pathKey: string): void` — replaces the existing `runMermaidIn` effect in both views. On each `html` change: destroy the previous `DocumentPanZoom` (saving `states()` into a ref tagged with `pathKey`), `await runMermaidIn(container)`, then `attachDocumentPanZoom(container, saved)` where `saved` is the stored states only if their `pathKey` equals the current one (else `null`). Ignore the result if a newer `html` arrived meanwhile (stale flag). Destroy on unmount. `MarkdownView` passes `absPath`; each side-by-side pane passes its own existing `pathKey` and owns its own hook instance (panes independent).

- [ ] **Step 1: Implement** the hook and replace both mermaid effects with it. Marks mode (`MarkdownView` with `baseContent`) gets it automatically.

- [ ] **Step 2: Verify** `npm run typecheck` and `npm test` — Expected: all pass.

- [ ] **Step 3: Verify in the app** (driver as in Task 3). Open a `.md` containing a large ```mermaid``` `erDiagram` followed by enough paragraphs to scroll. Check, with `eval`-dispatched events and `ss` screenshots: (a) plain wheel over the diagram scrolls `.markdown-scroll` (`scrollTop` increases); (b) Ctrl+wheel over it zooms the diagram only (box size unchanged, pct > 100%, page `scrollTop` unchanged); (c) controls appear on hover only; (d) write the same file again on disk with an unchanged diagram count → zoom persists; add a second diagram → resets to Fit; (e) switch files and back → Fit. Repeat (b) in Side by side mode on one pane: the other pane's diagram stays at Fit.

- [ ] **Step 4: Commit** — `git add src/renderer/src/markdown/useDocumentPanZoom.ts src/renderer/src/components/MarkdownView.tsx src/renderer/src/components/MarkdownSideBySideView.tsx && git commit -m "feat(markdown): pan/zoom in rendered and side-by-side markdown (#49)"`
