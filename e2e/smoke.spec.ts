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
