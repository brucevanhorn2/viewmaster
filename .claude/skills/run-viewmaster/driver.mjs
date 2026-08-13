// REPL driver for View Master (Electron). Run under xvfb on headless Linux.
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
//
// Paths are relative to the repo root (viewmaster/), same as everywhere
// else in this skill. Run from the repo root:
//   xvfb-run -a node .claude/skills/run-viewmaster/driver.mjs
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = process.env.APP_DIR || process.cwd()
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron')

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    app = await electron.launch({
      executablePath: electronBin,
      args: ['--no-sandbox', APP_DIR],
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      timeout: 30_000
    })
    // Electron has no clean "loaded" signal for this app; a short sleep
    // covers the welcome screen's initial render.
    await new Promise((r) => setTimeout(r, 3_000))
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? (await app.firstWindow())
    console.log('launched.', app.windows().length, 'windows:')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // Click via evaluate() + DOM .click(), not locator.click() / coordinates —
  // more reliable across Electron/Chromium versions and window resizes.
  async click(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, sel)
    console.log('click', sel, '→', r)
  },

  // Text search over interactive elements only (button, a, [role=button]).
  // View Master's sidebar file/dir rows are plain divs — use `click-row`
  // for those instead (see Gotchas in SKILL.md).
  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK: ' + el.tagName
    }, text)
    console.log('click-text', JSON.stringify(text), '→', r)
  },

  // Click a sidebar file/dir row by its exact visible name (the .file-name
  // or .dir-name span text) — these rows are divs with onClick, not
  // buttons/links, so click-text can't find them.
  async 'click-row'(name) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.file-name, .dir-name')].find((e) => e.textContent === n)
      if (!el) return 'NOT_FOUND'
      el.closest('.tree-row')?.click()
      return 'OK'
    }, name)
    console.log('click-row', JSON.stringify(name), '→', r)
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 30 })
  },
  async press(key) {
    if (page) await page.keyboard.press(key)
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first')
    try {
      await page.waitForSelector(sel, { timeout: 10_000 })
      console.log('found:', sel)
    } catch {
      console.log('TIMEOUT:', sel)
    }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(
      await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null)
    )
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  // View Master has no native-dialog automation under xvfb (there's no
  // reliable way to drive the OS file picker headlessly), so this reaches
  // into the app's own exposed preload API to open a folder directly — the
  // exact same repo:open IPC call a real "Open Folder…" pick or Recent-item
  // click triggers. Returns the raw RepoState the main process computed.
  async 'open-path'(dir) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate(async (d) => window.viewmaster.openRepo(d), dir)
    console.log('open-path', dir, '→', JSON.stringify(r).slice(0, 500))
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  }
}

// Electron/Playwright can interfere with inherited stdin — use the raw fd
// for the REPL's own input instead.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  if (!cmd) return rl.prompt()
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log('unknown:', cmd, '— try: help')
    return rl.prompt()
  }
  try {
    await fn(rest.join(' '))
  } catch (e) {
    console.log('ERROR:', e.message)
  }
  if (cmd === 'quit') {
    rl.close()
    process.exit(0)
  }
  rl.prompt()
})
rl.on('close', async () => {
  await COMMANDS.quit()
  process.exit(0)
})

console.log('viewmaster driver — "help" for commands, "launch" to start')
rl.prompt()
