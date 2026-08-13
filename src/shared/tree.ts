import type { ChangedFile } from './types'

export interface TreeNode {
  name: string
  /** Repo-relative dir path ('' for root). */
  path: string
  dirs: TreeNode[]
  files: ChangedFile[]
}

/**
 * Build a directory tree from a flat file list. Used both for the
 * changed-files sidebar view (only directories with changes appear) and the
 * full browse-mode tree (every non-ignored file and its ancestor dirs).
 */
export function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: [], files: [] }

  for (const file of files) {
    const segments = file.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]
      let dir = node.dirs.find((d) => d.name === name)
      if (!dir) {
        dir = { name, path: segments.slice(0, i + 1).join('/'), dirs: [], files: [] }
        node.dirs.push(dir)
      }
      node = dir
    }
    node.files.push(file)
  }

  const sortNode = (node: TreeNode): void => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.path.localeCompare(b.path))
    node.dirs.forEach(sortNode)
  }
  sortNode(root)

  return root
}
