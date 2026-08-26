import * as monaco from 'monaco-editor'

/**
 * Moves `key` to the most-recently-used end of `map` (a `Map`'s iteration
 * order is insertion order, so delete-then-reinsert moves it to the end),
 * then evicts from the least-recently-used end (the front) via `dispose`
 * until `map.size` is back at or under `cap`.
 *
 * Pure and dependency-free on purpose -- this is the actual LRU algorithm,
 * fully unit-testable without importing monaco-editor at all. `touchModel`
 * below is the thin, real-monaco production wrapper around it.
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

const tracked = new Map<string, true>()

/**
 * Marks `uri`'s model as most-recently-used, evicting (disposing) the
 * least-recently-used tracked models once more than `cap` are tracked at
 * once. Safe to call whether or not `uri`'s model has been created yet --
 * eviction looks the model up via `monaco.editor.getModel` at eviction
 * time, so a key evicted after its model was already disposed some other
 * way (e.g. a folder-switch clear elsewhere) is just a harmless no-op via
 * the `?.dispose()` optional chain.
 */
export function touchModel(uri: monaco.Uri, cap: number): void {
  touchKey(tracked, uri.toString(), cap, (key) => {
    monaco.editor.getModel(monaco.Uri.parse(key))?.dispose()
  })
}
