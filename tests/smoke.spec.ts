/**
 * Smoke test for the DAIWT coffee shop app (Playwright).
 *
 * Covers the golden path: app loads, menu renders from Lakebase, a real
 * order can be placed end-to-end, and the architecture/status page renders.
 *
 * Run with:
 *   npx playwright test tests/smoke.spec.ts
 * against a running app (APP_URL env or http://localhost:8000).
 * Excluded from `npm test` (vitest) — this file needs @playwright/test.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8000';

test.beforeEach(async ({ page }) => {
  await page.goto(BASE_URL);
});

test('home page loads with store selector and menu from Lakebase', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'DAIWT Coffee' })).toBeVisible();
  await expect(page.getByRole('link', { name: '注文する' })).toBeVisible();
  // store selector is populated from /api/stores
  await expect(page.locator('select').first()).toBeVisible({ timeout: 30000 });
  // at least one menu item card with an "追加" button (data comes from Lakebase)
  await expect(page.getByRole('button', { name: /追加/ }).first()).toBeVisible({ timeout: 30000 });
});

test('order flow: add to cart and place an order', async ({ page }) => {
  await expect(page.getByRole('button', { name: /追加/ }).first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: /追加/ }).first().click();
  await page.getByPlaceholder('お名前(呼び出し用)').fill('Smoke Test');
  await page.getByRole('button', { name: 'この内容で注文する' }).click();
  await expect(page.getByText(/注文 #[0-9a-f]{8} を受け付けました/)).toBeVisible({ timeout: 30000 });
});

test('status page shows agent, OBO token, and sync sections', async ({ page }) => {
  await page.goto(`${BASE_URL}/status`);
  await expect(page.getByRole('heading', { name: 'アーキテクチャ & ステータス' })).toBeVisible();
  await expect(page.getByText('エージェント稼働状態')).toBeVisible();
  await expect(page.getByText(/OBO トークン/)).toBeVisible();
  await expect(page.getByText('Delta 同期状態 (読み出し側)')).toBeVisible({ timeout: 60000 });
});
