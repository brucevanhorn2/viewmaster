import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeRepo, type TestRepo } from '../git/testRepo'
import { createRecorder } from './recorder'
import { appendVersion, getObject, putObject, readVersions } from './store'
import { historyPaths } from './paths'

let repo: TestRepo
let base: string
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(): Promise<void> {
  repo = await makeRepo()
  base = await mkdtemp(join(tmpdir(), 'vm-hist-'))
  cleanups.push(repo.cleanup, () => rm(base, { recursive: true, force: true }))
}

describe('recorder capture', () => {
  it('captures a settled text file once, then again on change, deduping identical', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    const log = historyPaths(base, repo.root).logFile('doc.md')

    await repo.write('doc.md', 'v1')
    rec.handleEvent('doc.md')
    await rec.flush()
    expect((await readVersions(log)).length).toBe(1)

    await repo.write('doc.md', 'v2')
    rec.handleEvent('doc.md')
    await rec.flush()
    let versions = await readVersions(log)
    expect(versions.length).toBe(2)

    rec.handleEvent('doc.md') // no content change
    await rec.flush()
    versions = await readVersions(log)
    expect(versions.length).toBe(2) // deduped

    const objects = historyPaths(base, repo.root).objectsDir
    expect(await getObject(objects, versions[1].sha)).toBe('v2')
    await rec.close()
  })

  it('fires onCapture with the relPath only when a new version is recorded', async () => {
    await setup()
    const captured: string[] = []
    const rec = createRecorder(repo.root, {
      historyBaseDir: base,
      settleMs: 5,
      onCapture: (relPath) => captured.push(relPath)
    })

    await repo.write('doc.md', 'v1')
    rec.handleEvent('doc.md')
    await rec.flush()
    expect(captured).toEqual(['doc.md'])

    rec.handleEvent('doc.md') // identical content — deduped, no capture
    await rec.flush()
    expect(captured).toEqual(['doc.md']) // unchanged

    await repo.write('doc.md', 'v2')
    rec.handleEvent('doc.md')
    await rec.flush()
    expect(captured).toEqual(['doc.md', 'doc.md'])
    await rec.close()
  })

  it('skips binary files', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    await repo.write('bin.dat', Buffer.from([1, 2, 0, 3]))
    rec.handleEvent('bin.dat')
    await rec.flush()
    expect(await readVersions(historyPaths(base, repo.root).logFile('bin.dat'))).toEqual([])
    await rec.close()
  })

  it('prunes versions at/older than the last commit on a .git/HEAD event', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    const log = historyPaths(base, repo.root).logFile('doc.md')

    // Seed an old version (pre-commit) and a future one (post-commit).
    await appendVersion(log, { ts: 1000, sha: 'old', size: 2 })
    await appendVersion(log, { ts: Date.now() + 100_000, sha: 'new', size: 2 })

    await repo.write('doc.md', 'committed')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'c')

    rec.handleEvent('.git/HEAD')
    await rec.flush()

    expect((await readVersions(log)).map((v) => v.sha)).toEqual(['new'])
    await rec.close()
  })

  it('trims stale backstop entries on capture and gcs their objects', async () => {
    await setup()
    const paths = historyPaths(base, repo.root)
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    const log = paths.logFile('doc.md')

    // Seed a stale entry (older than MAX_AGE_DAYS=30) whose object exists in the store.
    const staleSha = await putObject(paths.objectsDir, 'stale content')
    const staleTs = Date.now() - 40 * 86400_000
    await appendVersion(log, { ts: staleTs, sha: staleSha, size: 13 })

    await repo.write('doc.md', 'fresh content')
    rec.handleEvent('doc.md')
    await rec.flush()

    const versions = await readVersions(log)
    expect(versions.map((v) => v.sha)).not.toContain(staleSha)
    expect(versions.length).toBe(1)

    const objects = await readdir(paths.objectsDir)
    expect(objects).not.toContain(staleSha)

    await rec.close()
  })
})
