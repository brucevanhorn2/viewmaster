import {
  extractImportSpecifiers as extractTsSpecifiers,
  candidateImportPaths as candidateTsPaths,
  posixJoin
} from './resolveImports'

const PYTHON_RELATIVE_FROM_PATTERN = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm

/**
 * Extracts Python *relative* import specifiers only (`from .foo import
 * bar`, `from ..pkg.sub import baz`, `from . import qux`) — absolute
 * dotted imports (`from myapp.utils import x`) are deliberately not
 * extracted, since resolving them needs the project's actual source
 * root, which light parsing has no honest way to determine (see the
 * design spec's decision 4).
 */
function extractPythonRelativeImports(content: string): string[] {
  const specifiers = new Set<string>()
  for (const match of content.matchAll(PYTHON_RELATIVE_FROM_PATTERN)) {
    specifiers.add(match[1] + match[2])
  }
  return [...specifiers]
}

/**
 * Resolves a Python relative import specifier (leading dots + optional
 * dotted module path) against `fromDir`. One leading dot means "this
 * package" (0 levels up); each additional dot means one more level up.
 * Remaining dots in the module path become path separators. Tries both
 * a `.py` file and a `/__init__.py` package directory, mirroring
 * `candidateImportPaths`' TS/JS suffix-list approach.
 */
function candidatePythonImportPaths(fromDir: string, specifier: string): string[] {
  const dotMatch = /^(\.+)(.*)$/.exec(specifier)
  if (!dotMatch) return []
  const [, dots, rest] = dotMatch
  const modulePath = rest.replace(/\./g, '/')
  let base = fromDir
  for (let i = 0; i < dots.length - 1; i++) {
    const lastSlash = base.lastIndexOf('/')
    base = lastSlash === -1 ? base : base.slice(0, lastSlash)
  }
  const joined = modulePath ? posixJoin(base, modulePath) : base
  return [`${joined}.py`, `${joined}/__init__.py`]
}

/**
 * Dispatches import-specifier extraction by Monaco language id. Go
 * returns an empty list unconditionally — see the design spec's Go
 * carve-out (module-qualified package paths have no light-parsing
 * resolution to a local file, so extraction alone isn't useful).
 */
export function extractImportSpecifiersForLanguage(language: string, content: string): string[] {
  if (language === 'typescript' || language === 'javascript') return extractTsSpecifiers(content)
  if (language === 'python') return extractPythonRelativeImports(content)
  return []
}

/** Dispatches candidate-path resolution by Monaco language id, mirroring extractImportSpecifiersForLanguage's dispatch. */
export function candidateImportPathsForLanguage(
  language: string,
  fromDir: string,
  specifier: string
): string[] {
  if (language === 'typescript' || language === 'javascript') return candidateTsPaths(fromDir, specifier)
  if (language === 'python') return candidatePythonImportPaths(fromDir, specifier)
  return []
}
