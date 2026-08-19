import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import type { SymbolLocation } from '@shared/types'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// Use the bundled monaco, never a CDN — the app must work offline.
loader.config({ monaco })

// Shift+F12 is Monaco's default binding for `editor.action.goToReferences`
// ("Go to References"), a *different* action from `referenceSearch.trigger`
// ("Peek References") — confirmed via task 8's manual verification that
// `goToReferences` itself is broken in this bundled monaco-editor version
// (silently no-ops: no peek, no cursor move, no error, even with
// console/window-error capture installed), while `referenceSearch.trigger`
// works correctly and is reachable via the editor's own right-click menu.
// Rebinding the chord to the working action directly, rather than waiting
// on an upstream fix, restores the feature's own promised keyboard path
// ("Shift+F12 find usages"). The `when` clause reproduces exactly what
// `goToReferences`' own native keybinding rule evaluates to — Monaco's
// `registerAction2` ANDs a command's `precondition` with its
// `keybinding.when` (see `vs/platform/actions/common/actions.js`), and for
// `GoToReferencesAction` that's `editorHasReferenceProvider &&
// !inReferenceSearchEditor && !isInEmbeddedEditor` (the precondition) AND
// `editorTextFocus` (the keybinding's own when) — so this only fires where
// the native chord would have, not more broadly.
monaco.editor.addKeybindingRule({
  keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F12,
  command: 'editor.action.referenceSearch.trigger',
  when: 'editorTextFocus && editorHasReferenceProvider && !inReferenceSearchEditor && !isInEmbeddedEditor'
})

/** Map a file name to a Monaco language id via the registered languages. */
export function languageForFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
  const base = fileName.toLowerCase()
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === base)) return lang.id
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id
  }
  return 'plaintext'
}

const HEURISTIC_EXCLUDED_LANGUAGE_IDS = new Set(['typescript', 'javascript'])

function toMonacoLocations(locations: SymbolLocation[]): monaco.languages.Location[] {
  return locations.map((loc) => ({
    uri: monaco.Uri.file(loc.absPath),
    range: {
      startLineNumber: loc.line,
      startColumn: loc.column + 1,
      endLineNumber: loc.line,
      endColumn: loc.column + 1
    }
  }))
}

function wordUnderCursor(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): string | null {
  return model.getWordAtPosition(position)?.word ?? null
}

// TypeScript/JavaScript already get real, type-aware definition/reference
// providers from Monaco's bundled TS language service the moment a
// .ts/.tsx file is opened — registering a second, heuristic provider for
// those language ids would have both queried and merged, polluting real
// results with heuristic noise. Every other language id gets the
// heuristic path (see the design spec's decision 8).
const heuristicLanguageIds = monaco.languages
  .getLanguages()
  .map((lang) => lang.id)
  .filter((id) => !HEURISTIC_EXCLUDED_LANGUAGE_IDS.has(id))

monaco.languages.registerDefinitionProvider(heuristicLanguageIds, {
  async provideDefinition(model, position) {
    const word = wordUnderCursor(model, position)
    if (!word) return []
    const { locations } = await window.viewmaster.findDefinitions(word)
    return toMonacoLocations(locations)
  }
})

monaco.languages.registerReferenceProvider(heuristicLanguageIds, {
  async provideReferences(model, position) {
    const word = wordUnderCursor(model, position)
    if (!word) return []
    const { locations } = await window.viewmaster.findReferences(word)
    return toMonacoLocations(locations)
  }
})
