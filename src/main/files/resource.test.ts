import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { readResource } from './resource'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'viewmaster-resource-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content: Buffer | string): Promise<string> {
  const abs = join(dir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return abs
}

describe('readResource', () => {
  it('reads a file inside the workspace root as base64 with the right MIME', async () => {
    const abs = await write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await readResource(abs, dir)).toEqual({
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mime: 'image/png'
    })
  })

  it('infers MIME from extension for common web asset types', async () => {
    const css = await write('style.css', 'body{}')
    const woff = await write('font.woff2', Buffer.from([1, 2, 3]))
    const svg = await write('icon.svg', '<svg/>')
    expect((await readResource(css, dir))?.mime).toBe('text/css')
    expect((await readResource(woff, dir))?.mime).toBe('font/woff2')
    expect((await readResource(svg, dir))?.mime).toBe('image/svg+xml')
  })

  it('falls back to application/octet-stream for an unknown extension', async () => {
    const abs = await write('data.xyz', 'blob')
    expect((await readResource(abs, dir))?.mime).toBe('application/octet-stream')
  })

  it('rejects a path outside the workspace root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'viewmaster-outside-'))
    const outsideFile = join(outsideDir, 'secret.png')
    await writeFile(outsideFile, 'x')
    expect(await readResource(outsideFile, dir)).toBeNull()
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('rejects a "../" traversal that resolves outside the workspace root', async () => {
    await write('sub/x.png', 'x')
    const escaped = join(dir, 'sub', '..', '..', 'escape.png')
    expect(await readResource(escaped, dir)).toBeNull()
  })

  it('rejects a sibling directory with a name-prefix collision', async () => {
    const evilRoot = dir + '-evil'
    await mkdir(evilRoot, { recursive: true })
    const evilFile = join(evilRoot, 'x.png')
    await writeFile(evilFile, 'x')
    expect(await readResource(evilFile, dir)).toBeNull()
    await rm(evilRoot, { recursive: true, force: true })
  })

  it('returns null for a missing file', async () => {
    expect(await readResource(join(dir, 'nope.png'), dir)).toBeNull()
  })

  it('returns null for a file over the size cap', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61)
    const abs = await write('big.png', big)
    expect(await readResource(abs, dir)).toBeNull()
  })
})
