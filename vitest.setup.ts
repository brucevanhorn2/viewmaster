import { vi } from 'vitest'

// Stub monaco-editor for testing. The real monaco-editor has heavy browser
// dependencies and can't be loaded in a test environment. We only need a
// minimal stub for the type and the getModel API used by touchModel.
vi.mock('monaco-editor', () => ({
  Uri: {
    parse: (str: string) => str,
  },
  editor: {
    getModel: () => null,
  },
}))
