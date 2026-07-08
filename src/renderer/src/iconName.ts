import manifest from 'material-icon-theme/dist/material-icons.json'

interface IconManifest {
  fileNames?: Record<string, string>
  fileExtensions?: Record<string, string>
  folderNames?: Record<string, string>
  file?: string
  folder?: string
  folderExpanded?: string
}

const icons = manifest as IconManifest
const fileNames = icons.fileNames ?? {}
const fileExtensions = icons.fileExtensions ?? {}
const folderNames = icons.folderNames ?? {}

/**
 * material-icon-theme lookup: exact file name, then longest matching
 * compound extension (`d.ts` beats `ts`), then the generic file icon.
 */
export function iconNameForFile(fileName: string): string {
  const lower = fileName.toLowerCase()
  const byName = fileNames[lower]
  if (byName) return byName

  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const byExt = fileExtensions[ext]
    if (byExt) return byExt
  }

  return icons.file ?? 'file'
}

export function iconNameForFolder(folderName: string, expanded: boolean): string {
  const byName = folderNames[folderName.toLowerCase()]
  if (byName) return expanded ? `${byName}-open` : byName
  return expanded ? (icons.folderExpanded ?? 'folder-open') : (icons.folder ?? 'folder')
}
