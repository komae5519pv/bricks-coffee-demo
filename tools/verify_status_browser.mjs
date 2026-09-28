#!/usr/bin/env node
/**
 * Status page improvements verification: data browser (Lakebase + Delta,
 * scoped to own rows, on-demand only) + SVG architecture diagram.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_status_browser.mjs
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

// ---------- 0. order first -> orders row must appear in the browser ----------
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });
await page.getByRole('button', { name: '追加' }).first().click();
await page.getByPlaceholder('お名前(呼び出し用)').fill('ブラウザ検証');
await page.getByRole('button', { name: 'この内容で注文する' }).click();
await page.locator('[data-order-toast]').waitFor({ timeout: 30000 });
const toastText = await page.locator('[data-order-toast]').innerText();
console.log('order placed:', toastText.slice(0, 60));

// ---------- 1. architecture diagram: SVG with zones, nodes, arrows ----------
await page.goto(`${APP}/status`, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByText('データブラウザ').waitFor({ timeout: 30000 });
const archCheck = await page.evaluate(() => {
  const svg = document.querySelector('svg[aria-label="アーキテクチャ構成図"]');
  if (!svg) return { hasSvg: false };
  const rects = svg.querySelectorAll('rect').length;
  const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent);
  const hasZones = texts.filter((t) => ['CLIENT', 'APP', 'DATA'].includes(t ?? '')).length;
  const hasNodes = texts.filter((t) => ['ブラウザ', 'Databricks App', 'Lakebase', 'UC Delta', 'Genie'].includes(t ?? '')).length;
  return { hasSvg: true, rects, hasZones, hasNodes };
});
console.log('arch diagram:', JSON.stringify(archCheck));
if (!archCheck.hasSvg) failures.push('no SVG architecture diagram');
else {
  if (archCheck.hasZones < 3) failures.push(`arch zones < 3 (${archCheck.hasZones})`);
  if (archCheck.hasNodes < 5) failures.push(`arch nodes < 5 (${archCheck.hasNodes})`);
}
await page.screenshot({ path: '/tmp/status-arch-desktop.png', clip: { x: 0, y: 0, width: 1100, height: 500 } });

// ---------- 2. data browser: orders (own rows only) ----------
await page.getByRole('button', { name: '読み込む' }).click();
await page.waitForTimeout(3000);
const ordersCheck = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-browse-row]')];
  const badge = document.querySelector('[data-browse-source-badge]')?.textContent ?? '';
  const firstRow = rows[0]?.textContent ?? '';
  return { rowCount: rows.length, badge, firstRow, hasBrowserValidation: document.body.innerText.includes('ブラウザ検証') };
});
console.log('orders browse:', JSON.stringify({ rowCount: ordersCheck.rowCount, badge: ordersCheck.badge, hasOrder: ordersCheck.hasBrowserValidation }));
if (ordersCheck.rowCount === 0) failures.push('orders browse returned 0 rows');
if (!ordersCheck.badge.includes('Lakebase の生テーブル')) failures.push(`wrong source badge: ${ordersCheck.badge}`);
if (!ordersCheck.hasBrowserValidation) failures.push('new order not visible in data browser (注文→即見える)');
await page.screenshot({ path: '/tmp/status-browser-orders.png' });

// row click -> raw JSON (scoped to the data browser card, not other <pre> on the page)
await page.locator('[data-browse-row]').first().click();
await page.waitForTimeout(400);
const jsonVisible = await page.evaluate(() => {
  const browser = document.querySelector('[data-browse-table]');
  const card = browser?.closest('[data-slot="card"], .rounded-2xl');
  const pre = card?.querySelector('pre');
  return pre?.textContent?.includes('customer_name') ?? false;
});
console.log('raw JSON visible:', jsonVisible);
if (!jsonVisible) failures.push('row click did not show raw JSON');
await page.screenshot({ path: '/tmp/status-browser-json.png' });

// ---------- 3. PII scoping: own rows only (no other users' PII) ----------
const piiCheck = await page.evaluate(() => {
  const text = document.querySelector('[data-browse-table]')?.textContent ?? '';
  return { hasOtherUser: text.includes('other.user@example.com'), text: text.slice(0, 200) };
});
console.log('PII check: other.user visible =', piiCheck.hasOtherUser);
if (piiCheck.hasOtherUser) failures.push('other user PII (other.user@example.com) leaked in orders browse');

// chat_threads: owner-scoped too (foreign thread from earlier rounds must not appear)
await page.selectOption('[data-browse-table-select]', 'lakebase:chat_threads');
await page.getByRole('button', { name: '読み込む' }).click();
await page.waitForTimeout(3000);
const threadsCheck = await page.evaluate(() => {
  const text = document.querySelector('[data-browse-table]')?.textContent ?? '';
  return { hasForeign: text.includes('他者の会話'), rows: document.querySelectorAll('[data-browse-row]').length };
});
console.log('chat_threads scope:', JSON.stringify(threadsCheck));
if (threadsCheck.hasForeign) failures.push('foreign chat thread (他者の会話) leaked');

// ---------- 4. filter + Lakebase shared table (menu_items) ----------
await page.selectOption('[data-browse-table-select]', 'lakebase:menu_items');
await page.getByPlaceholder('テキストフィルタ（部分一致）').fill('抹茶ラテ');
await page.getByRole('button', { name: '読み込む' }).click();
await page.waitForTimeout(3000);
const menuCheck = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-browse-row]')];
  return { rowCount: rows.length, allMatcha: rows.every((r) => r.textContent.includes('抹茶ラテ') || r.textContent.includes('LATTE')) };
});
console.log('menu filter:', JSON.stringify(menuCheck));
if (menuCheck.rowCount === 0) failures.push('menu_items filter returned 0 rows');

// ---------- 5. Delta on-demand: only on click, not on page load ----------
// (The /api/browse network call already happened above — assert a Delta
//  browse works when clicked, and that NO delta request fired before.)
let deltaRequests = 0;
page.on('request', (req) => {
  if (req.url().includes('/api/browse/delta')) deltaRequests++;
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByText('データブラウザ').waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
const deltaBeforeClick = deltaRequests;
await page.selectOption('[data-browse-table-select]', 'delta:lb_orders_history');
await page.getByRole('button', { name: '読み込む' }).click();
await page.waitForTimeout(6000);
const deltaCheck = await page.evaluate(() => {
  const rows = document.querySelectorAll('[data-browse-row]').length;
  const badge = document.querySelector('[data-browse-source-badge]')?.textContent ?? '';
  const err = document.querySelector('.text-destructive')?.textContent ?? '';
  return { rows, badge, err };
});
console.log('delta browse:', JSON.stringify({ ...deltaCheck, deltaBeforeClick, deltaAfterClick: deltaRequests }));
if (deltaBeforeClick > 0) failures.push(`Delta request fired before user click (${deltaBeforeClick})`);
if (deltaRequests === 0) failures.push('Delta browse click did not fire any request');
if (deltaCheck.err) failures.push(`Delta browse error: ${deltaCheck.err}`);
if (!deltaCheck.badge.includes('Delta の同期テーブル')) failures.push(`wrong delta badge: ${deltaCheck.badge}`);
await page.screenshot({ path: '/tmp/status-browser-delta.png' });

// ---------- 6. responsive ----------
for (const [w, h, name] of [[768, 1024, '768'], [375, 812, '375']]) {
  const c = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` }, viewport: { width: w, height: h } });
  const p = await c.newPage();
  await p.goto(`${APP}/status`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(2500);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  console.log(`${name} overflow:`, overflow);
  if (overflow) failures.push(`${name}px horizontal overflow`);
  await p.screenshot({ path: `/tmp/status-arch-${name}.png` });
  await c.close();
}

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/status-{arch-desktop,arch-768,arch-375,browser-orders,browser-json,browser-delta}.png');
