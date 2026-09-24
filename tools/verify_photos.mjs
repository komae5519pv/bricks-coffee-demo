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
await page.screenshot({ path: ORDER_OUT });
console.log('screenshot:', ORDER_OUT);

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
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
