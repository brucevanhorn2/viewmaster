import * as monaco from 'monaco-editor'
import { touchKey } from './lruMap'

export { touchKey }

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
