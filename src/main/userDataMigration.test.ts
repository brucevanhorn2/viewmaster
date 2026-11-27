import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyUserData } from './userDataMigration'

// cpSync(recursive) on a plain file just copies it on this platform, so there is no
// reliable on-disk way to make only the history copy fail; inject the failure instead.
const cpFail = vi.hoisted(() => ({ on: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (cpFail.on) throw new Error('simulated history copy failure')
      return actual.cpSync(...args)
    }
  }
})

const MARKER = 'migrated-from-view-master'

describe('migrateLegacyUserData', () => {
  let appData: string
  let legacy: string
  let current: string

  const run = (userDataDir = current) =>
    migrateLegacyUserData({
      appDataDir: appData,
      userDataDir,
      currentName: 'Second Look',
      legacyName: 'View Master'
    })

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'secondlook-migrate-'))
    legacy = join(appData, 'View Master')
    current = join(appData, 'Second Look')
  })

  afterEach(() => {
    cpFail.on = false
    rmSync(appData, { recursive: true, force: true })
  })

  function seedLegacy(): void {
    mkdirSync(join(legacy, 'history', 'abc'), { recursive: true })
    writeFileSync(join(legacy, 'history', 'abc', 'state.json'), '{"a":1}')
    writeFileSync(join(legacy, 'config.json'), '{"recentFolders":["/x"]}')
  }

  it('copies config.json and history/ from the legacy folder', () => {
    seedLegacy()
    expect(run()).toBe('migrated')
    expect(readFileSync(join(current, 'config.json'), 'utf8')).toBe('{"recentFolders":["/x"]}')
    expect(existsSync(join(current, 'history', 'abc', 'state.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(join(current, MARKER))).toBe(true)
  })

  it('skips a non-default userData dir', () => {
    seedLegacy()
    const custom = join(appData, 'custom-dir')
    expect(run(custom)).toBe('skipped')
    expect(existsSync(current)).toBe(false)
    expect(existsSync(custom)).toBe(false)
  })

  it('never overwrites existing Second Look data', () => {
    seedLegacy()
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'config.json'), '{"mine":true}')
    expect(run()).toBe('skipped')
    expect(readFileSync(join(current, 'config.json'), 'utf8')).toBe('{"mine":true}')
  })

  it('runs once', () => {
    seedLegacy()
    expect(run()).toBe('migrated')
    rmSync(join(current, 'config.json'))
    rmSync(join(current, 'history'), { recursive: true })
    expect(run()).toBe('skipped')
    expect(existsSync(join(current, 'config.json'))).toBe(false)
  })

  it('skips when there is no legacy folder', () => {
    expect(run()).toBe('skipped')
    expect(existsSync(join(current, MARKER))).toBe(false)
  })

  it('reports failure without throwing', () => {
    mkdirSync(join(legacy, 'config.json'), { recursive: true })
    expect(run()).toBe('failed')
    expect(existsSync(join(current, MARKER))).toBe(true)
  })

  it('skips when the Second Look folder already has history/', () => {
    seedLegacy()
    mkdirSync(join(current, 'history'), { recursive: true })
    expect(run()).toBe('skipped')
    expect(existsSync(join(current, 'config.json'))).toBe(false)
    expect(existsSync(join(current, 'history', 'abc'))).toBe(false)
  })

  it('still copies config.json when the history copy fails', () => {
    seedLegacy()
    cpFail.on = true
    expect(run()).toBe('failed')
    expect(readFileSync(join(current, 'config.json'), 'utf8')).toBe('{"recentFolders":["/x"]}')
    expect(existsSync(join(current, MARKER))).toBe(true)
  })
})
