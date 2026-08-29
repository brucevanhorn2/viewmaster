/**
 * Moves `key` to the most-recently-used end of `map` (a `Map`'s iteration
 * order is insertion order, so delete-then-reinsert moves it to the end),
 * then evicts from the least-recently-used end (the front) via `dispose`
 * until `map.size` is back at or under `cap`.
 *
 * `dispose` returns whether the entry was actually released. Returning
 * `false` means "this one is still in use, don't drop it" -- the key is put
 * back at the most-recently-used end (it *is* in use, so that's also its
 * honest LRU position) and eviction moves on to the next-oldest entry
 * instead. Each entry present when the call started is examined at most
 * once, so a map where nothing may be evicted simply stops rather than
 * looping forever; `map.size` can then legitimately sit above `cap` by the
 * number of in-use entries, which makes `cap` a bound on *evictable*
 * entries rather than a hard ceiling.
 *
 * Pure and dependency-free -- this is the actual LRU algorithm,
 * fully unit-testable without importing monaco-editor at all. See modelLru.ts
 * for the thin production wrapper that calls this with real monaco model disposal.
 */
export function touchKey(
  map: Map<string, true>,
  key: string,
  cap: number,
  dispose: (key: string) => boolean
): void {
  map.delete(key)
  map.set(key, true)
  let examinable = map.size
  while (map.size > cap && examinable > 0) {
    examinable--
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
    if (!dispose(oldest)) map.set(oldest, true)
  }
}
