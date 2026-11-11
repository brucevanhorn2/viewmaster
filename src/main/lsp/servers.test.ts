import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findGopls,
  goplsCommand,
  findVenvPython,
  pyrightCommand,
  pyrightStubsDir,
  externalRootsFor
} from './servers'
import { LspClient } from './client'

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vm-servers-'))
  dirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const win = process.platform === 'win32'
const goplsName = win ? 'gopls.exe' : 'gopls'
async function fakeExe(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), '#!/bin/sh\n', { mode: 0o755 })
}

describe('findGopls', () => {
  it('finds gopls on PATH', async () => {
    const d = await tmp()
    await fakeExe(d, goplsName)
    expect(await findGopls({ PATH: d })).toBe(join(d, goplsName))
  })
  it('looks the PATH key up case-insensitively (Path on Windows)', async () => {
    const d = await tmp()
    await fakeExe(d, goplsName)
    expect(await findGopls({ Path: d })).toBe(join(d, goplsName))
  })
  it('falls back to GOPATH/bin', async () => {
    const empty = await tmp()
    const gp = await tmp()
    await fakeExe(join(gp, 'bin'), goplsName)
    expect(await findGopls({ PATH: empty, GOPATH: gp })).toBe(join(gp, 'bin', goplsName))
  })
  it('uses the first entry of a GOPATH list', async () => {
    const empty = await tmp()
    const gp = await tmp()
    await fakeExe(join(gp, 'bin'), goplsName)
    const sep = win ? ';' : ':'
    expect(await findGopls({ PATH: empty, GOPATH: gp + sep + empty })).toBe(
      join(gp, 'bin', goplsName)
    )
  })
  it('returns null when absent', async () => {
    const empty = await tmp()
    const gp = await tmp()
    expect(await findGopls({ PATH: empty, GOPATH: gp })).toBeNull()
  })
  it('splits PATH by the given platform delimiter', async () => {
    const d = await tmp()
    await fakeExe(d, 'gopls.exe')
    const r = await findGopls({ PATH: `${join(d, 'nope')};${d}`, GOPATH: d }, 'win32')
    expect(r).toBe(join(d, 'gopls.exe'))
  })
})

describe('goplsCommand', () => {
  it('serves with env unchanged', () => {
    const env = { A: '1' }
    const c = goplsCommand('/x/gopls', env)
    expect(c.command).toBe('/x/gopls')
    expect(c.args).toEqual(['serve'])
    expect(c.env).toBe(env)
  })
})

describe('findVenvPython', () => {
  it('prefers .venv over venv', async () => {
    const root = await tmp()
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, '.venv', 'bin', 'python'), '')
    await mkdir(join(root, 'venv', 'bin'), { recursive: true })
    await writeFile(join(root, 'venv', 'bin', 'python'), '')
    expect(await findVenvPython(root, 'linux')).toBe(join(root, '.venv', 'bin', 'python'))
  })
  it('falls back to venv', async () => {
    const root = await tmp()
    await mkdir(join(root, 'venv', 'bin'), { recursive: true })
    await writeFile(join(root, 'venv', 'bin', 'python'), '')
    expect(await findVenvPython(root, 'linux')).toBe(join(root, 'venv', 'bin', 'python'))
  })
  it('uses Scripts/python.exe on win32', async () => {
    const root = await tmp()
    await mkdir(join(root, '.venv', 'Scripts'), { recursive: true })
    await writeFile(join(root, '.venv', 'Scripts', 'python.exe'), '')
    expect(await findVenvPython(root, 'win32')).toBe(join(root, '.venv', 'Scripts', 'python.exe'))
  })
  it('returns null with no venv', async () => {
    expect(await findVenvPython(await tmp(), 'linux')).toBeNull()
  })
})

describe('pyright', () => {
  it('passes the venv python in settings', () => {
    const c = pyrightCommand('/v/bin/python')
    expect(c.command).toBe(process.execPath)
    expect(c.args[0]).toMatch(/langserver\.index\.js$/)
    expect(c.args[1]).toBe('--stdio')
    expect(existsSync(c.args[0])).toBe(true)
    expect(c.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(c.settings).toEqual({
      python: { pythonPath: '/v/bin/python' },
      'python.analysis': { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' }
    })
  })
  it('leaves pythonPath undefined without a venv', () => {
    const c = pyrightCommand(null)
    expect((c.settings!.python as { pythonPath?: string }).pythonPath).toBeUndefined()
  })
  it('pyrightStubsDir exists', () => {
    expect(existsSync(pyrightStubsDir())).toBe(true)
  })
})

describe('externalRootsFor', () => {
  it('python: venv + stubs', async () => {
    const root = await tmp()
    await mkdir(join(root, '.venv', 'Scripts'), { recursive: true })
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, '.venv', 'Scripts', 'python.exe'), '')
    await writeFile(join(root, '.venv', 'bin', 'python'), '')
    const roots = await externalRootsFor('python', root, {})
    expect(roots.map((r) => r.kind)).toEqual(['python-venv', 'python-stubs'])
  })
  it('python: stubs only without venv', async () => {
    const roots = await externalRootsFor('python', await tmp(), {})
    expect(roots.map((r) => r.kind)).toEqual(['python-stubs'])
  })
})

const goplsPath = await findGopls(process.env)

describe('real servers', () => {
  it.skipIf(!goplsPath)(
    'real gopls answers a definition',
    async () => {
      const root = await tmp()
      await mkdir(join(root, 'pkg'))
      await writeFile(join(root, 'go.mod'), 'module example.com/m\n\ngo 1.20\n')
      await writeFile(
        join(root, 'pkg', 'hello.go'),
        'package pkg\n\nfunc Hello() string { return "hi" }\n'
      )
      const main = 'package main\n\nimport "example.com/m/pkg"\n\nfunc main() { pkg.Hello() }\n'
      await writeFile(join(root, 'main.go'), main)
      const client = new LspClient(goplsCommand(goplsPath!, process.env), root)
      try {
        await client.start()
        const col = main.split('\n')[4].indexOf('Hello')
        const locs = await client.definition(join(root, 'main.go'), 5, col, 60_000)
        expect(locs.some((l) => l.absPath.replace(/\\/g, '/').endsWith('pkg/hello.go'))).toBe(true)
      } finally {
        client.dispose()
      }
    },
    60_000
  )

  it(
    'real pyright answers a definition',
    async () => {
      const root = await tmp()
      await writeFile(join(root, 'b.py'), 'def f():\n    return 1\n')
      await writeFile(join(root, 'a.py'), 'from b import f\n\nf()\n')
      const client = new LspClient(pyrightCommand(null), root)
      try {
        await client.start()
        const locs = await client.definition(join(root, 'a.py'), 3, 0, 60_000)
        expect(locs.some((l) => l.absPath.replace(/\\/g, '/').endsWith('/b.py'))).toBe(true)
      } finally {
        client.dispose()
      }
    },
    60_000
  )
})
