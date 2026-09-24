#!/usr/bin/env node
/**
 * Visual verification: screenshot the order tab + admin menu with photos.
 * Uses a Playwright context with the OAuth bearer token injected, so the
 * Databricks Apps front-door lets the SPA through without interactive SSO.
 *
 * The token is accepted ONLY via the APP_TOKEN env var (never read from
 * files, never hardcoded):
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_photos.mjs [orderOutfile] [adminOutfile]
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required (OAuth access token). Example:');
  console.error('  APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) node tools/verify_photos.mjs');
  process.exit(1);
}
const ORDER_OUT = process.argv[2] ?? '/tmp/daiwt-coffee-photos.png';
const ADMIN_OUT = process.argv[3] ?? '/tmp/daiwt-coffee-admin.png';

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

async function imageStats() {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[loading="lazy"]'));
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
    const distinctSrc = new Set(imgs.map((i) => i.src));
    const credits = document.body.innerText.match(/Photo by .+ on Unsplash/g) ?? [];
    const text = document.body.innerText;
    return {
      imgs: imgs.length,
      loaded: loaded.length,
      distinctSrc: distinctSrc.size,
      credits: credits.length,
      hasYen: text.includes('¥'),
      // legacy local-currency symbols must be gone from every surface
      hasForeignCurrency: /A\$|US\$|£|€\d/.test(text),
      hasJaCategory: ['ドリップコーヒー', 'エスプレッソ', 'ティー&抹茶'].some((c) => text.includes(c)),
    };
  });
}

// --- order tab ---
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(4000); // let lazy images settle
const order = await imageStats();
console.log('order tab:', JSON.stringify(order));

// --- size consolidation: every product appears on exactly ONE card, and
// size chips change the displayed price ---
const cardNames = await page
  .locator('.grid.gap-3 div.font-medium.text-sm')
  .allTextContents();
const dupNames = cardNames.filter((n, i) => cardNames.indexOf(n) !== i);
const firstCard = page.locator('.grid.gap-3 > div').first();
const priceM = await firstCard.locator('div.font-semibold', { hasText: '¥' }).first().textContent();
const lChip = firstCard.getByRole('button', { name: 'L', exact: true });
let priceL = priceM;
if (await lChip.count()) {
  await lChip.click();
  await page.waitForTimeout(300);
  priceL = await firstCard.locator('div.font-semibold', { hasText: '¥' }).first().textContent();
}
console.log(JSON.stringify({ cards: cardNames.length, dupNames, priceM, priceL }));

// --- brand + role-based navigation ---
const brand = await page.getByRole('heading', { name: 'BRICKS COFFEE' }).count();
const navCount = async () => page.locator('header nav a').count();
const staffNav = await navCount();
await page.screenshot({ path: ORDER_OUT });
console.log('screenshot:', ORDER_OUT);

// switch to customer preview: nav must collapse to 注文する/マイ注文 only
await page.getByRole('button', { name: 'お客さん表示' }).click();
await page.waitForTimeout(500);
const customerNav = await navCount();
const CUSTOMER_OUT = ORDER_OUT.replace('.png', '-customer.png');
await page.screenshot({ path: CUSTOMER_OUT });
console.log('screenshot:', CUSTOMER_OUT);
// back to staff view
await page.getByRole('button', { name: 'スタッフ表示' }).click();
await page.waitForTimeout(500);
const staffNavAfter = await navCount();
console.log(JSON.stringify({ brand, staffNav, customerNav, staffNavAfter }));

// --- admin menu (staff) ---
await page.goto(`${APP}/admin/menu`, { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('table').waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
const admin = await imageStats();
console.log('admin menu:', JSON.stringify(admin));
await page.screenshot({ path: ADMIN_OUT });
console.log('screenshot:', ADMIN_OUT);

console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();

const failures = [];
if (order.imgs === 0 || order.loaded === 0 || order.credits === 0) failures.push('order tab: images or credits missing');
if (admin.imgs === 0 || admin.loaded === 0 || admin.credits === 0) failures.push('admin menu: images or credits missing');
if (!order.hasYen) failures.push('order tab: no ¥ price visible');
if (order.hasForeignCurrency) failures.push('order tab: legacy currency symbol (A$/US$/£/€) still visible');
if (!order.hasJaCategory) failures.push('order tab: Japanese category chip missing');
if (brand !== 1) failures.push('brand heading BRICKS COFFEE not found');
if (staffNav !== 6) failures.push(`staff nav should be 6 items, got ${staffNav}`);
if (customerNav !== 2) failures.push(`customer preview nav should be 2 items, got ${customerNav}`);
if (staffNavAfter !== 6) failures.push(`nav after switching back should be 6 items, got ${staffNavAfter}`);
if (dupNames.length > 0) failures.push(`duplicate product cards: ${dupNames.join(', ')}`);
if (priceM === priceL) failures.push(`size chip should change the displayed price (M: ${priceM}, L: ${priceL})`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
