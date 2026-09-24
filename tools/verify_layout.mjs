#!/usr/bin/env node
/**
 * Layout verification: sticky right column + sticky filter bar.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_layout.mjs
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}

const browser = await chromium.launch();
const consoleErrors = [];

async function newPage(viewport) {
  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
    viewport,
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  return page;
}

const failures = [];

// ---------- desktop ----------
const page = await newPage({ width: 1440, height: 900 });
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/daiwt-layout-top.png' });

// scroll to the very bottom
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/daiwt-layout-bottom.png' });

const atBottom = await page.evaluate(() => {
  const visible = (sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.width > 0;
    });
    return Boolean(el);
  };
  const barBg = getComputedStyle(document.querySelector('.sticky.top-0') ?? document.body).backgroundColor;
  const opaque = barBg !== 'rgba(0, 0, 0, 0)' && barBg !== 'transparent';
  return {
    cartVisible: [...document.querySelectorAll('div')].some(
      (e) => e.textContent.trim().startsWith('カート') && e.getBoundingClientRect().top < innerHeight && e.getBoundingClientRect().bottom > 0,
    ),
    chipVisible: visible('button'),
    chipRect: [...document.querySelectorAll('button')].find((b) => b.textContent === 'エスプレッソ')?.getBoundingClientRect().top ?? null,
    barOpaque: opaque,
    barBg,
  };
});
console.log('desktop at bottom:', JSON.stringify(atBottom));
if (!atBottom.cartVisible) failures.push('cart not visible at page bottom');
if (atBottom.chipRect === null || atBottom.chipRect < 0) failures.push('category chip not visible at page bottom');
if (!atBottom.barOpaque) failures.push(`sticky bar background is transparent (${atBottom.barBg})`);

// category chip still operable at the bottom: click エスプレッソ, grid must filter
await page.getByRole('button', { name: 'エスプレッソ', exact: true }).click();
await page.waitForTimeout(1500);
const filtered = await page.evaluate(() => {
  const cats = [...document.querySelectorAll('.grid.gap-3 div.text-xs.text-muted-foreground')].map((e) => e.textContent);
  return { count: cats.length, nonEspresso: cats.filter((c) => c !== 'エスプレッソ').length };
});
console.log('after chip click:', JSON.stringify(filtered));
if (filtered.nonEspresso > 0) failures.push(`chip filter did not work at bottom (${filtered.nonEspresso} non-espresso cards)`);
await page.screenshot({ path: '/tmp/daiwt-layout-bottom-filtered.png' });
await page.close();

// ---------- mobile ----------
const m = await newPage({ width: 390, height: 844 });
await m.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await m.waitForTimeout(2500);
await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await m.waitForTimeout(800);
const mobile = await m.evaluate(() => ({
  noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
  chatVisible: [...document.querySelectorAll('*')].some(
    (e) => e.textContent === 'AI バリスタに相談' && e.getBoundingClientRect().top < innerHeight * 2,
  ),
}));
console.log('mobile:', JSON.stringify(mobile));
if (!mobile.noHorizontalOverflow) failures.push('mobile: horizontal overflow');
if (!mobile.chatVisible) failures.push('mobile: chat not reachable when stacked');
await m.screenshot({ path: '/tmp/daiwt-layout-mobile.png' });
await m.close();

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/daiwt-layout-top.png, -bottom.png, -bottom-filtered.png, -mobile.png');
