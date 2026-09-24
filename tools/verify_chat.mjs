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

async function ask(text) {
  await page.getByPlaceholder('バリスタにメッセージ…').fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.getByRole('button', { name: '送信', exact: true }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(1200);
}

// Q1: recommendations in list form -> markdown list + search_menu tool cards
await ask('甘くて冷たいドリンクある?おすすめを箇条書きで教えて');

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
// Q2: structured nutrition filter — cards must all be <= 300kcal
await ask('300kcal以内でタンパク質多めのものを教えて');
const nutritionCards = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-chat-product-card]')];
  const kcals = cards
    .map((c) => Number((c.innerText.match(/(\d+)kcal/) ?? [0, '0'])[1]))
    .filter((n) => n > 0);
  return { cards: cards.length, kcals, over300: kcals.filter((k) => k > 300).length };
});
console.log('Q2 nutrition cards:', JSON.stringify(nutritionCards));

// Q3: recommend_set -> set card with totals -> add all to cart
await ask('朝ごはんにおすすめのセットを組んで');
const setCard = await page.locator('[data-chat-set-card]').count();
const setText = setCard > 0 ? await page.locator('[data-chat-set-card]').first().innerText() : '';
if (setCard > 0) {
  await page.locator('[data-chat-set-card] button:has-text("まとめて追加")').first().click();
  await page.waitForTimeout(1000);
}
const cartCount = await page.evaluate(() => {
  const cart = [...document.querySelectorAll('div')].find((e) => e.textContent.trim().startsWith('カート'));
  if (!cart) return 0;
  return cart.parentElement.querySelectorAll('img + div, .flex.items-center.gap-2').length;
});
console.log('Q3 set:', JSON.stringify({ setCard, hasTotal: setText.includes('合計'), hasKcal: /kcal/.test(setText), cartCount }));

// Q4: milk allergy — answer must mention alternative milk options
await ask('牛乳アレルギーなんだけど、飲めるラテある?');
const allergyText = await page.evaluate(() => {
  const bubbles = [...document.querySelectorAll('.bg-muted.mr-12')];
  return bubbles.map((b) => b.innerText).join('\n');
});
const allergyOk = /代替乳|オーツミルク|豆乳|アーモンドミルク/.test(allergyText);
console.log('Q4 allergy mention:', allergyOk);
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
if (nutritionCards.over300 > 0) failures.push(`structured filter inaccurate: ${nutritionCards.over300} cards over 300kcal`);
if (setCard === 0) failures.push('no recommend_set card rendered');
if (setCard > 0 && (!setText.includes('合計') || !/kcal/.test(setText))) failures.push('set card missing total price or kcal');
if (cartCount < 2) failures.push(`set add-all did not add items to cart (cartCount=${cartCount})`);
if (!allergyOk) failures.push('milk allergy answer did not mention alternative milk');
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
