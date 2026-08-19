import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'
import { extractImportSpecifiers, candidateImportPaths } from '../code/resolveImports'

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
  // type-awareness here.
  useEffect(() => {
    if (languageForFile(fileName) !== 'typescript') return
    let cancelled = false
    const lastSlash = absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? absPath : absPath.slice(0, lastSlash)
    const specifiers = extractImportSpecifiers(content)
    void Promise.all(
      specifiers.map(async (specifier) => {
        for (const candidate of candidateImportPaths(fromDir, specifier)) {
          if (cancelled) return
          const uri = monaco.Uri.file(candidate)
          if (monaco.editor.getModel(uri)) return
          const result = await window.viewmaster.readFile(candidate)
          if (cancelled || result.kind !== 'text') continue
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(result.content, 'typescript', uri)
          }
          return
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [fileName, absPath, content])

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      path={absPath}
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
