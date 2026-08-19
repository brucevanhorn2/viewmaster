import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'

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
