import { test, expect } from './fixtures'

test('opening a folder shows the file tree', async ({ window }) => {
  await expect(window.getByText('committed.txt')).toBeVisible()
})
