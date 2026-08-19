const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\bfrom\s+)??['"]([^'"]+)['"]/g,
  /\bexport\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
]

/**
 * Extracts import-like specifier strings from TS/JS source text via
 * regex, not real parsing — deliberately approximate (see the design
 * spec's decision on incremental, one-level import preloading). Used only
 * to find candidate local files to preload as Monaco models, not to
 * build an accurate module graph.
 */
export function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1])
    }
  }
  return [...specifiers]
}

/**
 * Candidate extensions/index files to try, in order, loosely mirroring
 * Node/TypeScript module resolution.
 */
const CANDIDATE_SUFFIXES = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx'
]

/**
 * Joins `dir` and a relative `specifier` (which may contain `.`/`..`
 * segments) into an absolute, forward-slash path. Assumes forward-slash
 * paths throughout, matching this codebase's existing convention — like
 * `markdown/paths.ts` from issue #5, this does not handle Windows path
 * separators (an accepted, pre-existing limitation, not new here).
 */
function posixJoin(dir: string, specifier: string): string {
  const segments = `${dir}/${specifier}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return (dir.startsWith('/') ? '/' : '') + resolved.join('/')
}

/**
 * Builds the ordered list of candidate absolute paths for a relative
 * import specifier — the caller tries each in turn (e.g. via `readFile`)
 * until one exists. Bare specifiers (not starting with `.` or `/`) are
 * node_modules-style and return an empty list — there is no
 * node_modules type-awareness here.
 */
export function candidateImportPaths(fromDir: string, specifier: string): string[] {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return []
  const base = posixJoin(fromDir, specifier)
  return [base, ...CANDIDATE_SUFFIXES.map((suffix) => base + suffix)]
}
