/**
 * Capture-group siblings of `definitionHeuristics.ts`'s `looksLikeDefinition`
 * patterns — same declaration shapes, but extracting the declared name
 * instead of testing a known one. Used to find candidate symbols to look
 * up external references for (issue #15), not to build an accurate
 * symbol table.
 *
 * Anchored to column 0 (optionally after `export `/`export default `/
 * `declare `/`abstract `/`async ` modifiers) as a cheap proxy for
 * "top-level, not nested inside a function" — nested declarations are
 * indented in virtually all conventionally-formatted code, so an
 * unanchored match would otherwise pull in every local const/let inside
 * every function.
 */
const DECLARATION_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|module|struct)\s+(\w+)/,
  /^(?:export\s+)*(?:const|let|var)\s+(\w+)\b\s*=/,
  /^def\s+(\w+)\s*\(/,
  /^func\s+(\w+)\s*\(/,
  /^fn\s+(\w+)\s*\(/
]

/** Names beyond this count are dropped (first-seen order) — a defensive
 * bound on the batched `related:references` search this feeds into. */
const MAX_NAMES = 30

/** Extracts top-level declared symbol names from source text, one line at a time, deduplicated, in first-seen order, capped at MAX_NAMES. */
export function extractDeclaredNames(content: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    if (names.length >= MAX_NAMES) break
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line)
      if (match && !seen.has(match[1])) {
        seen.add(match[1])
        names.push(match[1])
        if (names.length >= MAX_NAMES) break
      }
    }
  }
  return names
}
