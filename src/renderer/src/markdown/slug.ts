/**
 * GitHub-style heading slug: lowercase, strip everything but letters/
 * digits/spaces/hyphens, collapse whitespace to single hyphens, trim
 * leading/trailing hyphens. Falls back to "section" for text that slugs
 * to nothing (e.g. a heading made entirely of punctuation/emoji).
 */
function baseSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/**
 * Slugifies `text`, disambiguating repeats within one render pass via
 * `seen` (a Map the caller creates once per document and passes to every
 * heading) — a second "Overview" heading becomes "overview-1", matching
 * GitHub's convention.
 */
export function slugify(text: string, seen: Map<string, number>): string {
  const slug = baseSlug(text)
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count === 0 ? slug : `${slug}-${count}`
}
