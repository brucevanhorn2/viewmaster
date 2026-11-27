import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export type MigrationResult = 'migrated' | 'skipped' | 'failed'

const MARKER = 'migrated-from-view-master'

// One-time carry-over of the old "View Master" userData (recent folders, window
// bounds, per-folder modes, local history) into the Second Look folder. Copies,
// never moves. Only runs for the default userData folder, so an explicit
// --user-data-dir (e2e, dev) never picks up real data. Never throws.
export function migrateLegacyUserData(opts: {
  appDataDir: string
  userDataDir: string
  currentName: string
  legacyName: string
}): MigrationResult {
  const { appDataDir, userDataDir, currentName, legacyName } = opts
  try {
    if (userDataDir !== join(appDataDir, currentName)) return 'skipped'
    if (
      existsSync(join(userDataDir, MARKER)) ||
      existsSync(join(userDataDir, 'config.json')) ||
      existsSync(join(userDataDir, 'history'))
    ) {
      return 'skipped'
    }
    const legacyDir = join(appDataDir, legacyName)
    if (!existsSync(legacyDir)) return 'skipped'

    let result: MigrationResult = 'migrated'
    try {
      mkdirSync(userDataDir, { recursive: true })
    } catch (err) {
      console.error('[secondlook:migrate] could not create userData folder:', err)
      result = 'failed'
    }
    // Each copy is independent: a history failure must not skip config.json.
    try {
      if (existsSync(join(legacyDir, 'history'))) {
        cpSync(join(legacyDir, 'history'), join(userDataDir, 'history'), { recursive: true })
      }
    } catch (err) {
      console.error('[secondlook:migrate] history copy failed:', err)
      result = 'failed'
    }
    try {
      if (existsSync(join(legacyDir, 'config.json'))) {
        copyFileSync(join(legacyDir, 'config.json'), join(userDataDir, 'config.json'))
      }
    } catch (err) {
      console.error('[secondlook:migrate] config copy failed:', err)
      result = 'failed'
    }
    try {
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(join(userDataDir, MARKER), new Date().toISOString())
    } catch (err) {
      console.error('[secondlook:migrate] could not write marker:', err)
    }
    return result
  } catch (err) {
    console.error('[secondlook:migrate] unexpected error:', err)
    return 'failed'
  }
}
