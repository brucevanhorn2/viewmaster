/** Joins forward-slash path segments, resolving "." and ".." (POSIX-style). */
export function joinPath(...segments: string[]): string {
  const isAbsolute = segments[0]?.startsWith('/') ?? false
  const parts = segments.join('/').split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!isAbsolute) stack.push('..')
      continue
    }
    stack.push(part)
  }
  return (isAbsolute ? '/' : '') + stack.join('/')
}

/** Everything before the last "/" segment. */
export function dirnamePath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return path.slice(0, idx)
}

/** True when `path` is `root` itself or a descendant of it. */
export function isInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  return path === normalizedRoot || path.startsWith(normalizedRoot + '/')
}
