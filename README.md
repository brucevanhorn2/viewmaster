<p align="center">
  <img src="img/second-look.png" alt="Second Look" width="320">
</p>

A read-only desktop viewer for **markdown documents**, **images and PDFs**, and
**branch diffs**.

Built to replace reaching for a full IDE just to read a rendered markdown file,
preview an image or PDF, or eyeball what changed on a branch. Second Look only
ever *views* — it never edits your files.

## Features

### Markdown viewing
- Renders markdown beautifully — no raw source.
- Renders embedded **mermaid** diagrams.
- Syntax-highlighted code fences.
- **Links between markdown documents navigate in-app** — a relative link
  jumps to the linked file, and a `#heading` link scrolls to that heading
  (in the current document, or after navigating to another one). External
  `http(s)` links still open in your default browser.

### Image & PDF viewing
- Click an **image** file (PNG, JPEG, GIF, WEBP, SVG) → rendered preview.
  SVG gets a **Rendered | Code** toggle to see the raw markup.
- Click a **PDF** → rendered pages via a canvas-based viewer, with
  Prev/Next navigation for multi-page documents.

### HTML viewing
- Click an **HTML** file (`.html`/`.htm`) → sandboxed rendered preview (no
  network access, no external requests), with a **Rendered | Code | Diff**
  toggle and an **Open in Default Browser** action.

### Branch diff viewing
- Left sidebar shows **only the files changed within the current branch** —
  committed, staged, or modified/untracked — collapsed to just the directories
  that contain changes.
- **Changed / Browse toggle** — flip to Browse to see the full folder tree
  (filtered by `.gitignore`), not just what changed. Files that are still
  git-changed keep their status coloring. Opening a folder that isn't a git
  repository always browses — there's nothing "changed" to show without git.
- File-type icons and status coloring (untracked / modified / staged / committed).
- Click a **markdown** file → rendered view, with a four-way toggle:
  **Rendered | Marks | Side-by-Side | Source**.
- **Editor's-marks diff (Marks)** — the branch's changes shown as proofreader's
  marks inline in the *rendered* output: insertions highlighted, deletions
  struck through. Changed code fences and mermaid diagrams appear as the old
  block (struck) followed by the new block.
- **Side-by-Side diff** — the old and new revisions rendered as two
  independently-rendered, scroll-synced markdown panes. The old (left) pane's
  links are inert (a link's target may not exist, or may mean something
  different, at that revision); the new (right) pane behaves exactly like
  Rendered mode, with full link interactivity.
- Click **any other file** → read-only, syntax-highlighted code with line numbers
  (VS Code's Monaco editor), with a **Diff toggle**.
- Diffs are **side-by-side** by default, with an inline toggle.
- **Right-click a file → Copy absolute path** (handy for pasting into AI chats).
- **Right-click a file, folder, or the root → Open location** — reveals it
  in your OS's file browser (Finder, Explorer, etc.).
- The change list and open file **auto-refresh** as files change on disk.

The "changed in this branch" baseline is the branch's fork point
(`git merge-base HEAD <default-branch>`), so you see everything the branch
introduced — not just what happens to differ from the tip of `main`.

### Code navigation
- **Find in Files** (`Cmd/Ctrl+Shift+F`) — full-text search across the open
  folder's documents, live against current on-disk content (no index to
  go stale).
- **Go to Definition / Find Usages** (`F12` / `Shift+F12`) — real semantic
  accuracy for TypeScript via Monaco's bundled language service, with a
  language-agnostic heuristic fallback for other languages.
- **Related Files** (`Cmd/Ctrl+Alt+R`) — see what the selected file
  imports, what imports it, and what references its declared symbols —
  even files untouched by the current branch.

### Upgrading from View Master
On first launch, Second Look copies your recent folders and local history from
View Master, its previous name. The old folder is left in place.

## Tech stack

Electron + TypeScript + React, with Monaco (code + diffs), markdown-it + mermaid +
shiki (rendered markdown), pdf.js (PDF rendering), and Allotment (resizable panes).
Dark mode only.

## Development

> Prerequisites: Node.js and the `git` CLI on your `PATH`.

```bash
npm install
npm run dev      # launch the app with hot reload
npm test         # run the test suite (vitest)
```

## Building

```bash
npm run build          # compile
npm run dist:mac       # build a macOS .dmg
npm run dist:linux     # build a Linux AppImage
npm run dist:win       # build a Windows .exe
```

### Releasing (macOS)

Release DMGs are universal (Intel + Apple Silicon), signed with a Developer ID
Application certificate, and notarized by Apple so Gatekeeper opens them without
any right-click workaround.

One-time setup:

1. Install a **Developer ID Application** certificate in your login keychain.
   electron-builder discovers the signing identity automatically.
2. Create an app-specific password at [appleid.apple.com](https://appleid.apple.com).
3. Export the notarization credentials in your shell:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="ABCDE12345"
   ```

Then build with `npm run dist:mac`. The signed, notarized DMG lands in `release/`.

In CI, supply the certificate with `CSC_LINK` (base64-encoded `.p12`) and
`CSC_KEY_PASSWORD` instead of a keychain, along with the three `APPLE_*`
variables above.

For a local build without signing or notarization (electron-builder packages
`out/` and does not compile, so build first):

```bash
npm run build
npx electron-builder --mac -c.mac.identity=null -c.mac.notarize=false
```

An unsigned build is blocked by Gatekeeper on first launch; right-click the app
and choose **Open** to run it.

Second Look shells out to the system `git`, so Git or the Xcode Command Line
Tools must be installed.

## Roadmap

- Configurable baseline (compare against an arbitrary branch or ref)
  ([#13](https://github.com/brucevanhorn2/viewmaster/issues/13)).

## Status

MVP in development. See
[`docs/superpowers/specs/2026-07-08-viewmaster-design.md`](docs/superpowers/specs/2026-07-08-viewmaster-design.md)
for the full design.
