import * as monaco from 'monaco-editor'
import { touchKey } from './lruMap'

const tracked = new Map<string, true>()

/**
 * Marks `uri`'s model as most-recently-used, evicting (disposing) the
 * least-recently-used tracked models once more than `cap` are tracked at
 * once. Safe to call whether or not `uri`'s model has been created yet --
 * eviction looks the model up via `monaco.editor.getModel` at eviction
 * time, so a key evicted after its model was already disposed some other
 * way (e.g. a folder-switch clear elsewhere) is just a harmless no-op.
 *
 * A model that is currently attached to an editor is never disposed: it is
 * kept (and kept tracked) and eviction moves on to the next-oldest entry.
 * This matters because `CodeView`'s import-preload effect touches a file's
 * imports *asynchronously*, i.e. strictly after the synchronous touch of
 * the displayed file's own model -- which makes the displayed file the
 * least-recently-used entry relative to its own imports, so without this
 * guard a file with enough imports evicts the very model the editor is
 * showing and the pane goes blank.
 */
export function touchModel(uri: monaco.Uri, cap: number): void {
  touchKey(tracked, uri.toString(), cap, (key) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(key))
    if (!model) return true
    if (model.isAttachedToEditor()) return false
    model.dispose()
    return true
  })
}
