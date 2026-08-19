function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A language-agnostic set of "this line imports something named
 * `basename`" patterns — the reverse-direction sibling to
 * `definitionHeuristics.ts`'s `looksLikeDefinition`. Not exhaustive, not
 * per-language-correct — covers common import shapes across
 * TypeScript/JavaScript, Python, and Go. (Go's own pattern is kept here
 * for completeness even though the call site never searches a Go file's
 * own basename — see the design spec's Go carve-out — a cross-language
 * false match is not a realistic concern.)
 */
export function looksLikeImportOf(line: string, basename: string): boolean {
  const b = escapeRegExp(basename)
  const patterns = [
    new RegExp(`\\bimport\\b[^'"]*['"][^'"]*${b}[^'"]*['"]`),
    new RegExp(`\\brequire\\(\\s*['"][^'"]*${b}[^'"]*['"]`),
    new RegExp(`\\bfrom\\s+[.\\w]*${b}[.\\w]*\\s+import\\b`),
    new RegExp(`\\bimport\\s+[.\\w]*${b}[.\\w]*\\s*$`)
  ]
  return patterns.some((p) => p.test(line))
}
