#!/usr/bin/env node
/**
 * Lakebase realtime demo verification (theme A):
 *   1. order toast shows the MEASURED Lakebase commit latency + record link
 *   2. kitchen board: new order card pulses in, relative time ticks live
 *   3. status page: live latency ticker updates + event log records
 *      write -> Lakebase commit -> Delta reflect for the order
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_realtime.mjs
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}

const browser = await chromium.launch();
const failures = [];
const consoleErrors = [];
const ctx = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// ---------- setup: open order page + board page on the SAME store ----------
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });

const board = await ctx.newPage();
board.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`board: ${m.text()}`);
});
board.on('pageerror', (e) => consoleErrors.push(`board: ${String(e)}`));
await board.goto(`${APP}/board`, { waitUntil: 'networkidle', timeout: 60000 });
await board.locator('select').waitFor({ timeout: 30000 });
await board.waitForTimeout(2000);
// the board defaults to the staff's own store — order at THAT store so the
// new card is guaranteed to be visible there (RLS)
const boardStore = await board.locator('select').inputValue();
console.log('board store:', boardStore);

const orderStoreSelect = page.locator('select').first();
await orderStoreSelect.selectOption(boardStore);
await page.waitForTimeout(1500); // menu reloads for the new store

async function placeOrder(name) {
  await page.getByRole('button', { name: '追加' }).first().click();
  await page.waitForTimeout(400);
  await page.getByPlaceholder('お名前(呼び出し用)').fill(name);
  await page.getByRole('button', { name: 'この内容で注文する' }).click();
  const toast = page.locator('[data-order-toast]');
  await toast.waitFor({ timeout: 30000 });
  return toast;
}

// ---------- A-1: toast with measured commit latency + record link ----------
const run1 = `検証A-${Date.now() % 100000}`;
const toast1 = await placeOrder(run1);
const toastText = await toast1.innerText();
console.log('toast:', toastText.replace(/\n/g, ' | ').slice(0, 160));
if (!/Lakebase にコミットしました \(\d+(\.\d+)?秒\)/.test(toastText)) {
  failures.push(`toast lacks measured commit seconds: ${toastText.slice(0, 120)}`);
}
const recordLink = toast1.getByRole('link', { name: 'このレコードを見る' });
const href = await recordLink.getAttribute('href');
console.log('record link:', href);
const orderId1 = href?.match(/order=([0-9a-f-]{36})/)?.[1] ?? null;
if (!orderId1) failures.push(`record link has no order id: ${href}`);
await page.screenshot({ path: '/tmp/realtime-toast.png' });

// follow the link -> status page focuses this order's event row
await recordLink.click();
await page.waitForTimeout(1000);
console.log('after link, url:', page.url());
if (!page.url().includes(`/status?order=${orderId1}`)) failures.push(`link did not navigate: ${page.url()}`);
const row1 = page.locator(`[data-order-event="${orderId1}"]`);
await row1.waitFor({ timeout: 20000 }).catch(() => undefined);
const row1Count = await row1.count();
console.log('event row for order present:', row1Count);
if (row1Count === 0) failures.push('status page has no event row for the new order');
const row1Text = row1Count ? await row1.innerText() : '';
if (row1Count && !/Lakebase コミット/.test(row1Text)) failures.push('event row lacks Lakebase commit time');
if (row1Count && !/アプリ書込 \d+(\.\d+)?秒/.test(row1Text)) failures.push('event row lacks measured write seconds');
if (row1Count && !(await row1.getAttribute('class'))?.includes('ring-2')) failures.push('focused row is not highlighted');

// ---------- A-2: kitchen board pulse + live relative time ----------
const run2 = `検証B-${Date.now() % 100000}`;
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });
await orderStoreSelect.selectOption(boardStore);
await page.waitForTimeout(1500);
const toast2 = await placeOrder(run2);
const href2 = await toast2.getByRole('link', { name: 'このレコードを見る' }).getAttribute('href');
const orderId2 = href2?.match(/order=([0-9a-f-]{36})/)?.[1] ?? null;
console.log('order for board pulse:', orderId2?.slice(0, 8));
if (!orderId2) failures.push('second order has no id');

// the board polls every 5s — the new card should appear WITH the pulse class
const newCard = board.locator(`[data-order-card="${orderId2}"]`);
await newCard.waitFor({ timeout: 20000 }).catch(() => undefined);
const cardCount = await newCard.count();
if (cardCount === 0) {
  failures.push('board never showed the new order card');
} else {
  const cls = (await newCard.getAttribute('class')) ?? '';
  console.log('new card has pulse class:', cls.includes('animate-order-pulse'));
  if (!cls.includes('animate-order-pulse')) failures.push(`new card did not pulse (class="${cls}")`);
  await board.screenshot({ path: '/tmp/realtime-board-pulse.png' });

  const ago = newCard.locator('[data-order-ago]');
  const t0 = await ago.innerText();
  await board.waitForTimeout(11000);
  const t1 = await ago.innerText();
  console.log('relative time ticking:', JSON.stringify(t0), '->', JSON.stringify(t1));
  if (t0 === t1) failures.push(`relative time not updating (${t0})`);
  if (!/たった今|秒前|分前/.test(t0 + t1)) failures.push(`relative time format unexpected (${t0}/${t1})`);
}

// ---------- A-3: ticker + Delta reflect for the second order ----------
const ticker = page.locator('[data-live-ticker]');
await page.goto(`${APP}/status?order=${orderId2}`, { waitUntil: 'networkidle', timeout: 60000 });
await ticker.waitFor({ timeout: 30000 });
const row2 = page.locator(`[data-order-event="${orderId2}"]`);
await row2.waitFor({ timeout: 20000 }).catch(() => undefined);
if ((await row2.count()) === 0) {
  failures.push('event log lacks the second order');
} else {
  console.log('event row (pre-sync):', (await row2.innerText()).replace(/\n/g, ' | ').slice(0, 200));
}
await page.screenshot({ path: '/tmp/realtime-status-presync.png' });

// CDC should materialize within seconds; give the pipeline a generous window
const syncedRow = row2.filter({ hasText: /Delta 反映 \d{1,2}:\d{2}:\d{2}/ });
await syncedRow.waitFor({ timeout: 180000 }).catch(() => undefined);
const syncedCount = await syncedRow.count();
console.log('delta reflect recorded:', syncedCount > 0);
if (syncedCount === 0) {
  failures.push('event row never showed Delta reflect (180s timeout)');
} else {
  const txt = await syncedRow.innerText();
  console.log('event row (synced):', txt.replace(/\n/g, ' | ').slice(0, 220));
  if (!/\(\+\d+(\.\d+)?秒\)/.test(txt)) failures.push('synced row lacks the lag seconds');
}
const tickerText = await ticker.innerText();
console.log('ticker:', tickerText.replace(/\n/g, ' | '));
if (!/最後の注文が Delta に反映: \d+(\.\d+)?秒/.test(tickerText)) {
  failures.push(`ticker did not switch to the reflected value: ${tickerText.slice(0, 120)}`);
}
await page.screenshot({ path: '/tmp/realtime-status-events.png' });

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/realtime-{toast,board-pulse,status-presync,status-events}.png');
