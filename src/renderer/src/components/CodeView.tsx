import Editor from '@monaco-editor/react'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'

export default function CodeView({
  fileName,
  content
}: {
  fileName: string
  content: string
}): React.JSX.Element {
  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      value={content}
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
