/**
 * `@monaco-editor/react`'s `path` prop builds a model's URI via
 * `monaco.Uri.parse(path)`, which treats `#` and `?` as URI fragment/query
 * delimiters and strips everything after them from `.fsPath` — permanently
 * losing that suffix from the model's own URI object. Every other URI in
 * this app is built via `monaco.Uri.file(...)`, which treats the whole
 * string as a literal filesystem path with no such splitting. Percent-
 * encoding `#`/`?` before handing a path to `Uri.parse` (via this function)
 * makes it decode back to the correct literal path, matching what
 * `Uri.file` would have produced — verified empirically against this
 * repo's bundled monaco-editor package.
 */
export function encodeForMonacoPath(path: string): string {
  return path.replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/**
 * The filesystem path a Monaco model stands for. The main editor's model URI
 * comes from `Uri.parse(encodeForMonacoPath(absPath))`, and on a Windows path
 * that parse reads the drive letter as a one-letter scheme (`C:\a\b.go` ->
 * scheme `C`, path `\a\b.go`), so `.fsPath` loses the drive. Rebuild it from
 * scheme + path in that case; models built with `Uri.file` (scheme `file`)
 * already have a correct `.fsPath`.
 */
export function absPathOfModelUri(uri: { scheme: string; path: string; fsPath: string }): string {
  if (/^[A-Za-z]$/.test(uri.scheme)) return `${uri.scheme}:${uri.path}`
  return uri.fsPath
}
