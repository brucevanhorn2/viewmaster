/**
 * Capture-group siblings of `definitionHeuristics.ts`'s `looksLikeDefinition`
 * patterns — same declaration shapes, but extracting the declared name
 * instead of testing a known one. Used to find candidate symbols to look
 * up external references for (issue #15), not to build an accurate
 * symbol table.
 */
const DECLARATION_PATTERNS = [
  /\b(?:function|class|interface|type|enum|namespace|module|struct)\s+(\w+)/,
  /\b(?:const|let|var)\s+(\w+)\b\s*=/,
  /\bdef\s+(\w+)\s*\(/,
  /\bfunc\s+(\w+)\s*\(/,
  /\bfn\s+(\w+)\s*\(/
]

/** Extracts declared symbol names from source text, one line at a time, deduplicated, in first-seen order. */
export function extractDeclaredNames(content: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line)
      if (match && !seen.has(match[1])) {
        seen.add(match[1])
        names.push(match[1])
      }
    }
  }
  return names
}
