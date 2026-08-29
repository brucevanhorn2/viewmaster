import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'
import { extractImportSpecifiers, candidateImportPaths, isTsJsExtension } from '../code/resolveImports'
import { encodeForMonacoPath } from '../code/monacoPath'
import { touchModel } from '../code/modelLru'

// Bounds how many distinct files' Monaco models can accumulate at once
// within one open folder (see docs/superpowers/specs/2026-08-26-monaco-
// model-disposal-design.md) -- generous enough that ordinary browsing
// never triggers eviction, while bounding the real worst case of a long
// session touching hundreds of files in one large repo.
const MODEL_CAP = 60

export default function CodeView({
  fileName,
  absPath,
  content,
  revealLine
}: {
  fileName: string
  absPath: string
  content: string
  revealLine?: number
}): React.JSX.Element {
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    if (!editorInstance) return
    if (!decorationsRef.current) {
      decorationsRef.current = editorInstance.createDecorationsCollection()
    }
    if (revealLine) {
      editorInstance.revealLineInCenter(revealLine)
      decorationsRef.current.set([
        {
          range: {
            startLineNumber: revealLine,
            startColumn: 1,
            endLineNumber: revealLine,
            endColumn: 1
          },
          options: { isWholeLine: true, className: 'code-view-highlight-line' }
        }
      ])
    } else {
      decorationsRef.current.clear()
    }
  }, [editorInstance, revealLine, content])

  // Incrementally makes Monaco's TypeScript language service aware of
  // this file's direct local imports (one level, not recursive — see the
  // design spec), so cross-file "go to definition"/"find usages" can
  // follow an import you haven't opened yet. Bare (node_modules-style)
  // specifiers are skipped entirely — there is no node_modules
  // type-awareness here. Candidates are also filtered to TS/JS
  // extensions only -- a resolved import like './styles.css' must not
  // be registered as a 'typescript' model (Monaco/monaco-editor-react
  // reuse an existing model by URI and ignore value/language on later
  // mounts, so a wrongly-typed model corrupts that file's own display
  // the next time it's actually opened).
  useEffect(() => {
    const language = languageForFile(fileName)
    if (language !== 'typescript' && language !== 'javascript') return
    let cancelled = false
    const lastSlash = absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? absPath : absPath.slice(0, lastSlash)
    const specifiers = extractImportSpecifiers(content)
    void Promise.all(
      specifiers.map(async (specifier) => {
        for (const candidate of candidateImportPaths(fromDir, specifier)) {
          if (cancelled) return
          if (!isTsJsExtension(candidate)) continue
          const uri = monaco.Uri.file(candidate)
          if (monaco.editor.getModel(uri)) {
            touchModel(uri, MODEL_CAP)
            return
          }
          const result = await window.viewmaster.readFile(candidate)
          if (cancelled || result.kind !== 'text') continue
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(result.content, languageForFile(candidate), uri)
          }
          touchModel(uri, MODEL_CAP)
          return
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [fileName, absPath, content])

  // Tracks the main displayed file's own model for LRU eviction, keyed the
  // same deterministic way its `path` prop below is computed -- reading
  // editorInstance.getModel() instead would risk a one-render-behind race
  // against @monaco-editor/react's own internal model-switch effect.
  useEffect(() => {
    touchModel(monaco.Uri.parse(encodeForMonacoPath(absPath)), MODEL_CAP)
  }, [absPath])

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      path={encodeForMonacoPath(absPath)}
      keepCurrentModel={true}
      value={content}
      onMount={setEditorInstance}
      options={{
        readOnly: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        automaticLayout: true,
        domReadOnly: true
      }}
    />
  )
}
