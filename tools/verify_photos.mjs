#!/usr/bin/env node
/**
 * Visual verification: screenshot the order tab with menu photos.
 * Uses a Playwright context with the OAuth bearer token injected, so the
 * Databricks Apps front-door lets the SPA through without interactive SSO.
 *
 *   APP_TOKEN=<token> node tools/verify_photos.mjs [outfile]
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN ?? readFileSync('/tmp/app_token.txt', 'utf8').trim();
const OUT = process.argv[2] ?? '/tmp/daiwt-coffee-photos.png';

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
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
// let lazy images settle
await page.waitForTimeout(4000);

const stats = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img[loading="lazy"]'));
  const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
  const distinctSrc = new Set(imgs.map((i) => i.src));
  const credits = document.body.innerText.match(/Photo by .+ on Unsplash/g) ?? [];
  return { imgs: imgs.length, loaded: loaded.length, distinctSrc: distinctSrc.size, credits: credits.length };
});
console.log('image stats:', JSON.stringify(stats));

await page.screenshot({ path: OUT, fullPage: false });
console.log('screenshot:', OUT);
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();

if (stats.imgs === 0 || stats.loaded === 0 || stats.credits === 0) {
  console.error('VERIFICATION FAILED: images or credits missing');
  process.exit(1);
}
console.log('VERIFICATION PASSED');
