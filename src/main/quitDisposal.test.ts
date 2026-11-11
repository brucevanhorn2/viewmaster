import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { installQuitDisposal, type QuittableApp } from './quitDisposal'

// Models what the e2e run showed of Electron on Windows: quit() emits
// will-quit and exits unless a listener prevents it, and a quit() issued
// before the event loop turns after a prevented quit is silently ignored.
class FakeApp extends EventEmitter implements QuittableApp {
  quitCalls = 0
  ignoredQuits = 0
  exited = false
  private inQuitCycle = false
  quit = vi.fn(() => {
    this.quitCalls++
    if (this.inQuitCycle) {
      this.ignoredQuits++
      return
    }
    this.inQuitCycle = true
    setImmediate(() => (this.inQuitCycle = false))
    let prevented = false
    this.emit('will-quit', { preventDefault: () => (prevented = true) })
    if (!prevented) this.exited = true
  })
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('installQuitDisposal', () => {
  it('holds the first quit, disposes, then re-quits asynchronously exactly once', async () => {
    const app = new FakeApp()
    const dispose = vi.fn(async () => {})
    installQuitDisposal(app, dispose)

    app.quit()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(app.exited).toBe(false)
    expect(app.quitCalls).toBe(1) // not re-issued synchronously inside the handler

    await tick()
    await tick()
    expect(app.quitCalls).toBe(2)
    expect(app.ignoredQuits).toBe(0)
    expect(app.exited).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1) // the re-quit is not re-entered

    await tick()
    expect(app.quitCalls).toBe(2)
  })

  it('re-quits even when dispose resolves immediately (the common no-server case)', async () => {
    const app = new FakeApp()
    installQuitDisposal(app, () => Promise.resolve())
    app.quit()
    await tick()
    await tick()
    expect(app.exited).toBe(true)
  })

  it('still quits when dispose never settles, after the bound', async () => {
    const app = new FakeApp()
    installQuitDisposal(app, () => new Promise<void>(() => {}), 100)
    app.quit()
    await new Promise((r) => setTimeout(r, 50))
    expect(app.exited).toBe(false)
    await new Promise((r) => setTimeout(r, 150))
    expect(app.exited).toBe(true)
  })

  it('still quits when dispose rejects', async () => {
    const app = new FakeApp()
    installQuitDisposal(app, () => Promise.reject(new Error('boom')))
    app.quit()
    await tick()
    await tick()
    expect(app.exited).toBe(true)
  })
})
