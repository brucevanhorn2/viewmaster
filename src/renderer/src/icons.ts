import { iconNameForFile, iconNameForFolder } from './iconName'

// Bundle every theme SVG as an asset URL, keyed by icon name.
const urls = import.meta.glob('../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const byName = new Map<string, string>()
for (const [path, url] of Object.entries(urls)) {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.svg$/, '')
  byName.set(name, url)
}

export function fileIconUrl(fileName: string): string | undefined {
  return byName.get(iconNameForFile(fileName)) ?? byName.get('file')
}

export function folderIconUrl(folderName: string, expanded: boolean): string | undefined {
  return (
    byName.get(iconNameForFolder(folderName, expanded)) ??
    byName.get(expanded ? 'folder-open' : 'folder')
  )
}
