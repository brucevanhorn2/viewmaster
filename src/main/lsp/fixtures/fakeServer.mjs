// Test-only LSP server. Behaviour of textDocument/definition is set by FAKE_MODE:
// ok | empty | hang | crash | init-hang (never answers initialize) | nodie (never
// answers shutdown and ignores exit, stdin end and SIGTERM). FAKE_DEF_DELAY_MS
// delays definition answers. Not collected by vitest (only *.test.ts) nor typechecked.
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-languageserver-protocol/node'

const mode = process.env.FAKE_MODE || 'ok'
const defDelay = Number(process.env.FAKE_DEF_DELAY_MS || 0)
const events = []
let initParams = null
const conn = createProtocolConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
)

if (mode === 'nodie') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1 << 30) // stay alive after stdin closes
}

conn.onRequest('initialize', (p) => {
  initParams = p
  return mode === 'init-hang'
    ? new Promise(() => {})
    : { capabilities: { definitionProvider: true, referencesProvider: true } }
})
conn.onNotification('initialized', () => {})
conn.onRequest('shutdown', () => (mode === 'nodie' ? new Promise(() => {}) : null))
conn.onNotification('exit', () => {
  if (mode !== 'nodie') process.exit(0)
})
conn.onNotification('textDocument/didOpen', (p) => {
  events.push({ kind: 'didOpen', uri: p.textDocument.uri, version: p.textDocument.version, languageId: p.textDocument.languageId, text: p.textDocument.text })
})
conn.onNotification('textDocument/didClose', (p) => {
  events.push({ kind: 'didClose', uri: p.textDocument.uri })
})
conn.onNotification('workspace/didChangeWatchedFiles', (p) => {
  events.push({ kind: 'didChangeWatchedFiles', changes: p.changes })
})
conn.onRequest('fake/opened', () => events)
conn.onRequest('fake/initParams', () => initParams)
conn.onRequest('textDocument/definition', async (p) => {
  if (defDelay) await new Promise((r) => setTimeout(r, defDelay))
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
process.stdin.on('end', () => {
  if (mode !== 'nodie') process.exit(0)
})
