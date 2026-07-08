import { DiffEditor } from '@monaco-editor/react'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'

export default function DiffView({
  fileName,
  original,
  modified,
  sideBySide
}: {
  fileName: string
  original: string
  modified: string
  sideBySide: boolean
}): React.JSX.Element {
  return (
    <DiffEditor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      original={original}
      modified={modified}
      options={{
        readOnly: true,
        renderSideBySide: sideBySide,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        domReadOnly: true
      }}
    />
  )
}
