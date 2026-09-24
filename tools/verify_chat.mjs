#!/usr/bin/env node
/**
 * Chat verification: Markdown rendering + generative product cards.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_chat.mjs [outfile]
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}
const OUT = process.argv[2] ?? '/tmp/daiwt-coffee-chat.png';

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

await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });

// ask for recommendations in list form -> markdown list + search_menu tool cards
await page.getByPlaceholder('バリスタにメッセージ…').fill('甘くて冷たいドリンクある?おすすめを箇条書きで教えて');
await page.getByRole('button', { name: '送信', exact: true }).click();

// wait for the assistant turn to complete (send button re-enables)
await page.getByRole('button', { name: '送信', exact: true }).waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);

const stats = await page.evaluate(() => {
  // markdown rendered? (elements exist inside assistant bubbles, raw tokens absent)
  const bubbles = Array.from(document.querySelectorAll('.bg-muted.mr-12'));
  const bubbleText = bubbles.map((b) => b.innerText).join('\n');
  const rawMd = /(^|\n)\s*#{1,4}\s|\*\*[^*]+\*\*/.test(bubbleText);
  const mdElements = bubbles.reduce(
    (n, b) => n + b.querySelectorAll('strong, h3, h4, ul, ol, table').length,
    0,
  );
  // product cards inside chat: images + 追加 buttons below the tool row
  const cardImgs = Array.from(document.querySelectorAll('img[loading="lazy"]')).length;
  return { rawMd, mdElements, cardImgs };
});
const chatAddButtons = await page.locator('[data-chat-product-card] button:has-text("追加")').count();
console.log(JSON.stringify(stats, null, 1), '| chat card 追加 buttons:', chatAddButtons);

// add the first recommended product to the cart FROM A CHAT CARD (scoped)
let cartLine = '';
if (chatAddButtons > 0) {
  await page.locator('[data-chat-product-card] button:has-text("追加")').first().click();
  await page.waitForTimeout(800);
  cartLine = await page.locator('text=カート').locator('..').innerText().catch(() => '');
}
await page.screenshot({ path: OUT });
console.log('screenshot:', OUT);
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();

const failures = [];
if (stats.rawMd) failures.push('raw markdown tokens visible in assistant bubble');
if (stats.mdElements === 0) failures.push('no rendered markdown elements (strong/headings/lists) found');
if (stats.cardImgs === 0) failures.push('no product card images in chat');
if (chatAddButtons === 0) failures.push('no 追加 buttons on chat product cards');
if (!cartLine.includes('合計')) failures.push('cart did not update after adding from chat card');
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
