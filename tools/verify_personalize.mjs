#!/usr/bin/env node
/**
 * Personalization verification: frequent items + reorder (UI + agent + RLS).
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_personalize.mjs [outfile]
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}
const OUT = process.argv[2] ?? '/tmp/daiwt-coffee-personalize.png';

const browser = await chromium.launch();
const context = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const failures = [];

// ---------- UI: quick action + frequent row ----------
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);

const reorderBtn = await page.getByRole('button', { name: '前回と同じ' }).count();
const freqRow = await page.locator('[data-frequent-row]').count();
const freqBadges = await page.locator('[data-frequent-row] span', { hasText: '×' }).count();
console.log('ui:', JSON.stringify({ reorderBtn, freqRow, freqBadges }));
if (reorderBtn === 0) failures.push('前回と同じ button missing');
if (freqRow === 0) failures.push('frequent row missing');
if (freqBadges === 0) failures.push('no ×N badges in frequent row');

// --- regression (B1): /api/orders must be owner-scoped; the foreign demo
// order (other.user@example.com, ゆずシトラスティー) must not leak ---
const leakCheck = await page.evaluate(async () => {
  const [me, orders] = await Promise.all([
    fetch('/api/me').then((r) => r.json()),
    fetch('/api/orders').then((r) => r.json()),
  ]);
  const foreign = orders.filter((o) => o.user_email !== me.email);
  return { me: me.email, total: orders.length, foreign: [...new Set(foreign.map((o) => o.user_email))] };
});
console.log('owner scope:', JSON.stringify(leakCheck));
if (leakCheck.foreign.length > 0) failures.push(`foreign orders leaked into /api/orders: ${leakCheck.foreign.join(',')}`);
const uiYuzu = await page.locator('[data-frequent-row]').getByText('ゆずシトラスティー').count();
if (uiYuzu > 0) failures.push('ゆずシトラスティー (他者注文) がよく注文する商品に混入');

// --- non-regression: kitchen board still shows store-scoped orders ---
const boardCheck = await page.evaluate(async () => {
  const rows = await fetch('/api/board?store_id=TYO001').then((r) => r.json());
  return { total: rows.length, hasForeign: rows.some((o) => o.user_email === 'other.user@example.com') };
});
console.log('board scope:', JSON.stringify(boardCheck));
if (!boardCheck.hasForeign) failures.push('kitchen board lost store-scoped visibility (non-regression)');

// clear the cart for a clean reorder assertion
const clearBtn = page.locator('[data-cart]').getByText('クリア');
if (await clearBtn.count()) await clearBtn.click();
await page.waitForTimeout(500);

// 前回と同じ: the LATEST own order lands in the cart (data-driven, owner-scoped)
const lastOrderItems = await page.evaluate(async () => {
  const orders = await fetch('/api/orders').then((r) => r.json());
  return (orders[0]?.items ?? []).map((i) => i.item_name);
});
await page.getByRole('button', { name: '前回と同じ' }).click();
await page.waitForTimeout(3500); // store auto-switch + menu reload + add
const cartAfterReorder = await page.locator('[data-cart]').innerText();
console.log('last order items:', lastOrderItems, '| cart:', cartAfterReorder.replace(/\n/g, ' | ').slice(0, 200));
for (const name of lastOrderItems) {
  if (!cartAfterReorder.includes(name)) failures.push(`reorder missing last-order item: ${name}`);
}
if (!/合計/.test(cartAfterReorder)) failures.push('reorder did not land in the cart with a total');
await page.screenshot({ path: OUT.replace('.png', '-ui.png') });

// ---------- agent: frequent ranking + reorder set ----------
await page.getByRole('button', { name: 'AI バリスタに相談' }).click(); // chat is a floating overlay now
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
async function ask(text) {
  await page.getByPlaceholder('バリスタにメッセージ…').fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.getByRole('button', { name: '送信', exact: true }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(1200);
}

await ask('よく買ってるやつある?');
const chatBadges = await page.locator('[data-chat-product-card] span', { hasText: '×' }).count();
const chatCards = await page.locator('[data-chat-product-card]').count();
console.log('chat frequent:', JSON.stringify({ chatCards, chatBadges }));
if (chatCards === 0) failures.push('no frequent cards in chat');
if (chatBadges === 0) failures.push('no ×N count badges on chat frequent cards');
const chatYuzu = await page.locator('[data-chat-product-card]').getByText('ゆずシトラスティー').count();
if (chatYuzu > 0) failures.push('ゆずシトラスティー (他者注文) がチャットの商品カードに混入');

await ask('前回と同じので');
const setCount = await page.locator('[data-chat-set-card]').count();
const setText = setCount > 0 ? await page.locator('[data-chat-set-card]').first().innerText() : '';
console.log('chat reorder set:', JSON.stringify({ setCount, text: setText.replace(/\n/g, ' | ').slice(0, 200) }));
if (setCount === 0) failures.push('no reorder set card in chat');
if (setCount > 0 && !setText.includes('合計')) failures.push('reorder set missing totals');
if (setCount > 0) {
  await page.locator('[data-chat-set-card] button:has-text("まとめて追加")').first().click();
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: OUT });
console.log('screenshot:', OUT, '| ui:', OUT.replace('.png', '-ui.png'));
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();

if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
