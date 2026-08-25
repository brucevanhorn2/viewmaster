function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A single, language-agnostic set of "this line declares something named
 * `word`" patterns, checked regardless of the file's actual language (see
 * the design spec's decision on a shared pattern list instead of
 * per-language parsers). Not exhaustive, not per-language-correct —
 * intentionally cheap heuristics covering common declaration shapes
 * across TypeScript/JavaScript, Python, Go, and a couple of cheap extras.
 */
export function looksLikeDefinition(line: string, word: string): boolean {
  const w = escapeRegExp(word)
  const patterns = [
    new RegExp(`\\b(function|class|interface|type|enum|namespace|module|struct)\\s+${w}\\b`),
    new RegExp(`\\b(const|let|var)\\s+${w}\\b\\s*=`),
    new RegExp(`\\bdef\\s+${w}\\s*\\(`),
    new RegExp(`\\bfunc\\s+${w}\\s*\\(`),
    new RegExp(`\\bfn\\s+${w}\\s*\\(`)
  ]
  return patterns.some((p) => p.test(line))
}
