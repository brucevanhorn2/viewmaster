// Test-only LSP server. Behaviour of textDocument/definition is set by FAKE_MODE:
// ok | empty | hang | crash | init-hang (never answers initialize). Not collected by vitest (only *.test.ts) nor typechecked.
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-languageserver-protocol/node'

const mode = process.env.FAKE_MODE || 'ok'
const events = []
const conn = createProtocolConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
)

conn.onRequest('initialize', () =>
  mode === 'init-hang'
    ? new Promise(() => {})
    : { capabilities: { definitionProvider: true, referencesProvider: true } }
)
conn.onNotification('initialized', () => {})
conn.onRequest('shutdown', () => null)
conn.onNotification('exit', () => process.exit(0))
conn.onNotification('textDocument/didOpen', (p) => {
  events.push({ kind: 'didOpen', uri: p.textDocument.uri, version: p.textDocument.version, languageId: p.textDocument.languageId, text: p.textDocument.text })
})
conn.onNotification('textDocument/didClose', (p) => {
  events.push({ kind: 'didClose', uri: p.textDocument.uri })
})
conn.onRequest('fake/opened', () => events)
conn.onRequest('textDocument/definition', (p) => {
  if (mode === 'hang') return new Promise(() => {})
  if (mode === 'crash') process.exit(1)
  if (mode === 'empty') return []
  return [{ uri: p.textDocument.uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } }]
})
conn.onRequest('textDocument/references', (p) => {
  if (mode === 'empty') return []
  return [{ uri: p.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }]
})
conn.listen()
process.stdin.on('end', () => process.exit(0))
