import { test, expect } from './fixtures'

test('opening a folder shows the file tree', async ({ window }) => {
  await expect(window.getByText('committed.txt')).toBeVisible()
})

test('selecting a changed file shows a diff', async ({ window }) => {
  await window.getByText('committed.txt').click()
  await window.getByRole('button', { name: 'Diff' }).click()
  await expect(window.locator('.monaco-diff-editor')).toBeVisible()
})

test('browse mode lists all files, not just changed ones', async ({ window }) => {
  await window.getByRole('button', { name: 'Browse' }).click()
  await expect(window.getByText('other.txt')).toBeVisible()
})

test('find in files finds a match and navigates to it', async ({ window, electronApp }) => {
  await expect(window.getByText('committed.txt')).toBeVisible()
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-find-in-files')?.click()
  })
  await window.getByPlaceholder('Find in files…').fill('searchable-marker-xyz')
  await window.locator('.search-result-row').first().click()
  await expect(window.locator('.toolbar-path')).toHaveText('other.txt')
})

test('related files opens its pane', async ({ window, electronApp }) => {
  await window.getByText('committed.txt').click()
  // Related Files acts on the selected file; wait until the selection has rendered.
  await expect(window.locator('.toolbar-path')).toHaveText('committed.txt')
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-related-files')?.click()
  })
  await expect(window.locator('.related-files-title')).toBeVisible()
  // The title renders in every state; the References section only once a file's results load.
  await expect(window.locator('.related-files-section-title', { hasText: 'References' })).toBeVisible()
})
