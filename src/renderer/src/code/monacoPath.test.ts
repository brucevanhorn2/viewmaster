import { describe, it, expect } from 'vitest'
// The real URI class monaco.Uri re-exports, loaded from its standalone module
// because the full monaco entry needs a DOM. That path ships no .d.ts, so it
// is typed as monaco.Uri.
// @ts-expect-error -- no declaration file for this internal ESM path
import { URI as RawURI } from 'monaco-editor/esm/vs/base/common/uri.js'
import type { Uri } from 'monaco-editor'
const URI = RawURI as typeof Uri
type URI = Uri
import { absPathOfModelUri, encodeForMonacoPath } from './monacoPath'

describe('encodeForMonacoPath', () => {
  it('percent-encodes a literal # so it is not read as a URI fragment delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a#b.ts')).toBe('/tmp/a%23b.ts')
  })

  it('percent-encodes a literal ? so it is not read as a URI query delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a?b.ts')).toBe('/tmp/a%3Fb.ts')
  })

  it('encodes both # and ? in the same path', () => {
    expect(encodeForMonacoPath('/tmp/a#b?c.ts')).toBe('/tmp/a%23b%3Fc.ts')
  })

  it('leaves an ordinary path with no special characters unchanged', () => {
    expect(encodeForMonacoPath('/tmp/plain/file.ts')).toBe('/tmp/plain/file.ts')
  })

  it('leaves a literal space unchanged (Uri.parse handles bare spaces correctly)', () => {
    expect(encodeForMonacoPath('/tmp/a b.ts')).toBe('/tmp/a b.ts')
  })
})

// Checked against the real monaco URI: the main editor's model is created by
// @monaco-editor/react with Uri.parse(encodeForMonacoPath(absPath)), which
// turns a Windows drive into a one-letter scheme and drops it from fsPath.
describe('absPathOfModelUri', () => {
  const parsed = (absPath: string): URI => URI.parse(encodeForMonacoPath(absPath))

  it('restores the drive of a Windows path parsed by @monaco-editor/react', () => {
    expect(parsed('C:\\Users\\x\\main.go').fsPath).not.toMatch(/^[A-Za-z]:/) // the bug
    expect(absPathOfModelUri(parsed('C:\\Users\\x\\main.go'))).toBe('C:\\Users\\x\\main.go')
    expect(absPathOfModelUri(parsed('D:\\repo\\pkg\\a.go'))).toBe('D:\\repo\\pkg\\a.go')
    expect(absPathOfModelUri(parsed('d:/repo/a.py'))).toBe('d:/repo/a.py')
  })

  it('decodes # and ? in a parsed Windows path', () => {
    expect(absPathOfModelUri(parsed('C:\\a#b\\c?d.go'))).toBe('C:\\a#b\\c?d.go')
  })

  it('keeps a POSIX path parsed by @monaco-editor/react', () => {
    const p = absPathOfModelUri(parsed('/home/u/a#b.go'))
    expect(p.replace(/\\/g, '/')).toBe('/home/u/a#b.go')
  })

  it('uses fsPath for models built with Uri.file', () => {
    const u = URI.file('C:\\Users\\x\\util.go')
    expect(absPathOfModelUri(u)).toBe(u.fsPath)
    expect(absPathOfModelUri(u).toLowerCase().replace(/\\/g, '/')).toBe('c:/users/x/util.go')
  })
})
