import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { readCurrentFile, readBaseFile, isRasterImagePath, isPdfPath } from './content'
import { makeRepo, type TestRepo } from './testRepo'

let repo: TestRepo

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  await repo.cleanup()
})

describe('readCurrentFile', () => {
  it('reads a text file', async () => {
    await repo.write('a.txt', 'hello world\n')
    expect(await readCurrentFile(join(repo.root, 'a.txt'))).toEqual({
      kind: 'text',
      content: 'hello world\n'
    })
  })

  it('detects binary content (NUL bytes)', async () => {
    await repo.write('blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]))
    expect(await readCurrentFile(join(repo.root, 'blob.bin'))).toEqual({ kind: 'binary' })
  })

  it('classifies a raster image by extension, base64-encoded', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    await repo.write('photo.png', bytes)
    expect(await readCurrentFile(join(repo.root, 'photo.png'))).toEqual({
      kind: 'image',
      mime: 'image/png',
      base64: bytes.toString('base64')
    })
  })

  it('classifies a PDF by extension, base64-encoded', async () => {
    const bytes = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')
    await repo.write('doc.pdf', bytes)
    expect(await readCurrentFile(join(repo.root, 'doc.pdf'))).toEqual({
      kind: 'pdf',
      base64: bytes.toString('base64')
    })
  })

  it('infers the correct MIME type per raster extension', async () => {
    await repo.write('a.jpg', Buffer.from([1, 2, 3]))
    await repo.write('b.jpeg', Buffer.from([1, 2, 3]))
    await repo.write('c.gif', Buffer.from([1, 2, 3]))
    await repo.write('d.webp', Buffer.from([1, 2, 3]))

    expect(await readCurrentFile(join(repo.root, 'a.jpg'))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg'
    })
    expect(await readCurrentFile(join(repo.root, 'b.jpeg'))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg'
    })
    expect(await readCurrentFile(join(repo.root, 'c.gif'))).toMatchObject({
      kind: 'image',
      mime: 'image/gif'
    })
    expect(await readCurrentFile(join(repo.root, 'd.webp'))).toMatchObject({
      kind: 'image',
      mime: 'image/webp'
    })
  })

  it('applies the larger 10MB image cap instead of the 2MB text/binary cap', async () => {
    // Over the 2MB text cap, under the 10MB image cap.
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.png', big)
    expect(await readCurrentFile(join(repo.root, 'big.png'))).toEqual({
      kind: 'image',
      mime: 'image/png',
      base64: big.toString('base64')
    })
  })

  it('applies the larger 25MB PDF cap instead of the 2MB text/binary cap', async () => {
    // Over the 2MB text cap, under the 25MB PDF cap.
    const big = Buffer.alloc(3 * 1024 * 1024, 0x25)
    await repo.write('big.pdf', big)
    expect(await readCurrentFile(join(repo.root, 'big.pdf'))).toEqual({
      kind: 'pdf',
      base64: big.toString('base64')
    })
  })

  it('rejects a raster image over the 10MB image size cap', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61)
    await repo.write('huge.png', big)
    expect(await readCurrentFile(join(repo.root, 'huge.png'))).toEqual({
      kind: 'too-large',
      size: big.length
    })
  })

  it('rejects a PDF over the 25MB size cap', async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 0x25)
    await repo.write('huge.pdf', big)
    expect(await readCurrentFile(join(repo.root, 'huge.pdf'))).toEqual({
      kind: 'too-large',
      size: big.length
    })
  })

  it('still classifies SVG as text, not image', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'
    await repo.write('icon.svg', svg)
    expect(await readCurrentFile(join(repo.root, 'icon.svg'))).toEqual({
      kind: 'text',
      content: svg
    })
  })

  it('rejects files over the size cap', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.txt', big)
    expect(await readCurrentFile(join(repo.root, 'big.txt'))).toEqual({
      kind: 'too-large',
      size: big.length
    })
  })

  it('reports missing files', async () => {
    expect(await readCurrentFile(join(repo.root, 'nope.txt'))).toEqual({ kind: 'missing' })
  })
})

describe('isRasterImagePath', () => {
  it('is true for raster extensions, case-insensitively', () => {
    expect(isRasterImagePath('photo.png')).toBe(true)
    expect(isRasterImagePath('photo.PNG')).toBe(true)
    expect(isRasterImagePath('a.jpg')).toBe(true)
    expect(isRasterImagePath('a.JPG')).toBe(true)
    expect(isRasterImagePath('a.jpeg')).toBe(true)
    expect(isRasterImagePath('a.gif')).toBe(true)
    expect(isRasterImagePath('a.webp')).toBe(true)
  })

  it('is false for non-raster extensions and no extension', () => {
    expect(isRasterImagePath('icon.svg')).toBe(false)
    expect(isRasterImagePath('notes.txt')).toBe(false)
    expect(isRasterImagePath('Makefile')).toBe(false)
  })
})

describe('isPdfPath', () => {
  it('is true for .pdf, case-insensitively', () => {
    expect(isPdfPath('doc.pdf')).toBe(true)
    expect(isPdfPath('doc.PDF')).toBe(true)
    expect(isPdfPath('doc.Pdf')).toBe(true)
  })

  it('is false for non-pdf extensions and no extension', () => {
    expect(isPdfPath('notes.txt')).toBe(false)
    expect(isPdfPath('photo.png')).toBe(false)
    expect(isPdfPath('Makefile')).toBe(false)
  })
})

describe('readBaseFile', () => {
  it('returns the baseline content of a committed-then-modified file', async () => {
    await repo.write('doc.md', 'old content\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    const base = (await repo.git('rev-parse', 'HEAD')).stdout.trim()
    await repo.write('doc.md', 'new content\n')

    expect(await readBaseFile(repo.root, base, 'doc.md')).toBe('old content\n')
  })

  it('returns empty string for a path absent at the baseline (untracked/added)', async () => {
    await repo.write('a.txt', 'x\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    const base = (await repo.git('rev-parse', 'HEAD')).stdout.trim()

    expect(await readBaseFile(repo.root, base, 'never-existed.txt')).toBe('')
  })

  it('returns empty string when there is no baseline', async () => {
    expect(await readBaseFile(repo.root, null, 'a.txt')).toBe('')
  })
})
