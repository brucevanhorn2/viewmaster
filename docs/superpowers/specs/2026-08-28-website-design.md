# View Master Website — Design

**Issue:** [#43](https://github.com/brucevanhorn2/viewmaster/issues/43) "Website"

## Problem

View Master has no public-facing presence beyond its GitHub repo's README.
There's nothing to link people to that quickly explains what the tool is and
shows it in action.

## Goal

A single, beautiful, dark-themed static web page that:
- Explains what View Master is and who it's for
- Showcases its major features, including real screenshots of the app
- Sends visitors to the GitHub repo (no download links yet — no releases
  exist)

Not a goal: a multi-page site, a blog, analytics, or any backend. This is a
one-page marketing/landing page.

## Approach

Plain static HTML + CSS, no framework, no build step, no JavaScript beyond
what's needed for trivial interactivity (if any — e.g. no interactivity is
actually required for a single-page marketing site, so none is planned).
This matches the "single page, doesn't need to be a full app" scope in the
issue, and it means GitHub Pages can serve the files directly with no build
pipeline.

### Why not reuse the app's React/TS stack

The app's stack (Electron + React + Monaco) exists to build an interactive
desktop app; none of that machinery buys anything for a static marketing
page. A plain HTML file is simpler to write, simpler to review, has zero
build step, and is trivially hostable. YAGNI.

## File structure

- `website/index.html` — all page content (hero, description, features,
  screenshots, footer)
- `website/styles.css` — dark theme styling
- `website/screenshots/*.png` — captured app screenshots (see below)
- `website/favicon.png` — derived from `img/viewmaster.png`
- `.github/workflows/deploy-website.yml` — GitHub Actions workflow that
  publishes `website/` to GitHub Pages on every push to `master` that
  touches that folder

`website/` lives at the repo root, sibling to `src/`, `docs/`, etc. — kept
fully separate from the Electron app's source and from `docs/superpowers/`
(which holds unrelated planning documents, not site content).

## Content plan

Content is original marketing copy informed by `README.md`, not a literal
copy of it — the README is developer-facing reference documentation; the
site's job is a quick pitch plus a visual tour.

1. **Hero** — logo (`img/viewmaster.png`), product name, one-line tagline
   ("A read-only desktop viewer for markdown, images, PDFs, and branch
   diffs"), a "View on GitHub" button linking to the repo.
2. **What it's for** — a short paragraph: built to replace reaching for a
   full IDE just to read a rendered markdown file, preview an image/PDF, or
   eyeball what changed on a branch; View Master only ever *views*, never
   edits.
3. **Features grid** — one card per major feature area, each with a
   one-line description (drawn from README's feature list, condensed):
   - Markdown viewing (rendering, mermaid diagrams, in-app link navigation)
   - Image & PDF viewing
   - HTML viewing (sandboxed preview)
   - Branch diff viewing (changed-files sidebar, side-by-side diffs,
     editor's-marks diff mode)
   - Code navigation (Find in Files, Go to Definition/Find Usages, Related
     Files)
4. **Screenshots** — 2–3 real screenshots interleaved with or below the
   features grid, captured live from the running app (see Screenshot
   capture below):
   - Markdown rendered view
   - Branch diff view (side-by-side)
   - Code navigation in action (e.g. Find Usages results, or Related Files)
5. **Footer** — MIT license mention, link back to the repo.

## Screenshot capture

Captured via the `run-viewmaster` skill during implementation: launch the
app against this repo itself (a real git repo with real markdown, code, and
history), drive it into each target state, and screenshot. No placeholder
or mocked-up images — real captures of the real app.

## Deployment

GitHub Actions workflow (`actions/upload-pages-artifact` +
`actions/deploy-pages`, the standard modern GitHub Pages deploy path) rather
than a manually-maintained `gh-pages` branch — zero ongoing maintenance
once set up, and it deploys automatically on every relevant push to
`master`.

This requires a one-time manual step outside this PR: in the repo's
Settings → Pages, set Source to "GitHub Actions". This can't be done via
the `gh` CLI reliably and isn't part of this implementation; it's a
post-merge step for Bruce.

## Testing

No automated tests — this is static markup with no logic to unit test,
consistent with how this codebase already treats non-logic surfaces (e.g.
Electron menu wiring, React component rendering are verified manually, not
unit tested). Verification is: open `website/index.html` directly in a
browser and visually confirm layout, and (post-merge, after Pages is
enabled) confirm the deployed page loads correctly.
