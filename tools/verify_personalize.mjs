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

// clear the cart for a clean reorder assertion
const clearBtn = page.locator('[data-cart]').getByText('クリア');
if (await clearBtn.count()) await clearBtn.click();
await page.waitForTimeout(500);

// 前回と同じ: latest order (抹茶ラテ×1 + アイスコーヒー×2) lands in the cart
await page.getByRole('button', { name: '前回と同じ' }).click();
await page.waitForTimeout(1000);
const cartAfterReorder = await page.locator('[data-cart]').innerText();
console.log('cart after 前回と同じ:', cartAfterReorder.replace(/\n/g, ' | ').slice(0, 300));
if (!cartAfterReorder.includes('アイスコーヒー') && !cartAfterReorder.includes('抹茶ラテ')) {
  failures.push('reorder did not add last-order items to cart');
}
const hasQty2 = /アイスコーヒー[^]*?2/.test(cartAfterReorder) || / 2 \+/.test(cartAfterReorder);
if (!hasQty2) failures.push('reorder quantity (アイスコーヒー×2) not preserved');
await page.screenshot({ path: OUT.replace('.png', '-ui.png') });

// ---------- agent: frequent ranking + reorder set ----------
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
