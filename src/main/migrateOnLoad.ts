// Side-effect module: must be the first import in index.ts, because store.ts
// constructs electron-store (reading userData) at import time.
import { app } from 'electron'
import { migrateLegacyUserData } from './userDataMigration'

const result = migrateLegacyUserData({
  appDataDir: app.getPath('appData'),
  userDataDir: app.getPath('userData'),
  currentName: app.getName(),
  legacyName: 'View Master'
})
if (result === 'failed') {
  console.error('[secondlook:migrate] migration failed; continuing with fresh data')
}
