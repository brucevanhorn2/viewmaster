import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_VERSIONS_PER_FILE,
  applyBackstops,
  appendVersion,
  getObject,
  gcObjects,
  pruneLog,
  putObject,
  readState,
  readVersions,
  referencedShas,
  writeState,
  writeVersions
} from './store'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vm-store-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('pruneLog', () => {
  it('drops entries at or older than the commit time', () => {
    const e = [
      { ts: 100, sha: 'a', size: 1 },
      { ts: 200, sha: 'b', size: 1 },
      { ts: 300, sha: 'c', size: 1 }
    ]
    expect(pruneLog(e, 200).map((x) => x.sha)).toEqual(['c'])
  })
})

describe('applyBackstops', () => {
  it('drops entries older than MAX_AGE_DAYS', () => {
    const now = 1_000_000_000_000
    const old = now - 40 * 86400_000
    const e = [
      { ts: old, sha: 'a', size: 1 },
      { ts: now, sha: 'b', size: 1 }
    ]
    expect(applyBackstops(e, now).map((x) => x.sha)).toEqual(['b'])
  })

  it('keeps only the newest MAX_VERSIONS_PER_FILE', () => {
    const now = 1_000_000_000_000
    const e = Array.from({ length: MAX_VERSIONS_PER_FILE + 5 }, (_, i) => ({
      ts: now - (MAX_VERSIONS_PER_FILE + 5 - i) * 1000,
      sha: `s${i}`,
      size: 1
    }))
    const kept = applyBackstops(e, now)
    expect(kept.length).toBe(MAX_VERSIONS_PER_FILE)
    expect(kept[kept.length - 1].sha).toBe(`s${MAX_VERSIONS_PER_FILE + 4}`)
  })
})

describe('referencedShas', () => {
  it('collects shas across logs', () => {
    const set = referencedShas([
      [{ ts: 1, sha: 'a', size: 1 }],
      [{ ts: 2, sha: 'b', size: 1 }, { ts: 3, sha: 'a', size: 1 }]
    ])
    expect([...set].sort()).toEqual(['a', 'b'])
  })
})

describe('object store + logs (fs)', () => {
  it('round-trips gzipped content and dedups by sha', async () => {
    const objects = tmp()
    const sha1 = await putObject(objects, 'hello world')
    const sha2 = await putObject(objects, 'hello world')
    expect(sha1).toBe(sha2)
    expect(await getObject(objects, sha1)).toBe('hello world')
    expect((await readdir(objects)).length).toBe(1)
  })

  it('appends and reads versions, tolerating a partial trailing line', async () => {
    const dir = tmp()
    const log = join(dir, 'f.jsonl')
    await appendVersion(log, { ts: 1, sha: 'a', size: 1 })
    await appendVersion(log, { ts: 2, sha: 'b', size: 1 })
    const { appendFileSync } = await import('fs')
    appendFileSync(log, '{"ts":3,"sha":"c"') // truncated line
    const v = await readVersions(log)
    expect(v.map((x) => x.sha)).toEqual(['a', 'b'])
  })

  it('missing log reads as empty', async () => {
    expect(await readVersions(join(tmp(), 'nope.jsonl'))).toEqual([])
  })

  it('gcObjects removes unreferenced objects only', async () => {
    const objects = tmp()
    const keep = await putObject(objects, 'keep')
    const drop = await putObject(objects, 'drop')
    await gcObjects(objects, new Set([keep]))
    const left = await readdir(objects)
    expect(left).toEqual([keep])
    expect(left).not.toContain(drop)
  })

  it('state round-trips, missing reads as null', async () => {
    const dir = tmp()
    const state = join(dir, 'state.json')
    expect(await readState(state)).toEqual({ lastPrunedCommit: null })
    await writeState(state, { lastPrunedCommit: 'abc' })
    expect(await readState(state)).toEqual({ lastPrunedCommit: 'abc' })
  })

  it('writeVersions overwrites the log', async () => {
    const dir = tmp()
    const log = join(dir, 'f.jsonl')
    await appendVersion(log, { ts: 1, sha: 'a', size: 1 })
    await writeVersions(log, [{ ts: 9, sha: 'z', size: 1 }])
    expect((await readVersions(log)).map((x) => x.sha)).toEqual(['z'])
  })
})
