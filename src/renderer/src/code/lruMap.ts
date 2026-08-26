/**
 * Moves `key` to the most-recently-used end of `map` (a `Map`'s iteration
 * order is insertion order, so delete-then-reinsert moves it to the end),
 * then evicts from the least-recently-used end (the front) via `dispose`
 * until `map.size` is back at or under `cap`.
 *
 * Pure and dependency-free -- this is the actual LRU algorithm,
 * fully unit-testable without importing monaco-editor at all. See modelLru.ts
 * for the thin production wrapper that calls this with real monaco model disposal.
 */
export function touchKey(
  map: Map<string, true>,
  key: string,
  cap: number,
  dispose: (key: string) => void
): void {
  map.delete(key)
  map.set(key, true)
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
    dispose(oldest)
  }
}
