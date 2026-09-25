#!/usr/bin/env node
/**
 * Layout verification: sticky global header (all pages), sticky filter bar
 * offset, sticky right column, mobile sheet.
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
const HEADER_H = 56; // h-14 — keep in sync with App.tsx header

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

// ---------- all pages: header stays pinned at the bottom ----------
const page = await newPage({ width: 1440, height: 900 });
const headerTopAtBottom = {};
for (const path of ['/', '/orders', '/board', '/admin/menu', '/history', '/status']) {
  await page.goto(APP + path, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  headerTopAtBottom[path] = await page.evaluate(
    () => document.querySelector('header')?.getBoundingClientRect().top ?? null,
  );
  if (headerTopAtBottom[path] !== 0) failures.push(`${path}: header not pinned at bottom (top=${headerTopAtBottom[path]})`);
}
console.log('header top at page bottom per route:', JSON.stringify(headerTopAtBottom));

// ---------- order tab: header -> filter bar -> content stacking ----------
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/daiwt-layout-top.png' });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/daiwt-layout-bottom.png' });

const stack = await page.evaluate((headerH) => {
  const header = document.querySelector('header');
  const bar = document.querySelector('.sticky.top-14');
  const cart = [...document.querySelectorAll('div')].find((e) => e.textContent.trim().startsWith('カート'));
  const headerRect = header?.getBoundingClientRect();
  const barRect = bar?.getBoundingClientRect();
  const barBg = bar ? getComputedStyle(bar).backgroundColor : 'missing';
  return {
    headerTop: headerRect?.top ?? null,
    headerBottom: headerRect?.bottom ?? null,
    barTop: barRect?.top ?? null,
    barOpaque: barBg !== 'rgba(0, 0, 0, 0)' && barBg !== 'transparent',
    cartVisible: Boolean(cart && cart.getBoundingClientRect().top < innerHeight && cart.getBoundingClientRect().bottom > 0),
    cartTop: cart ? Math.round(cart.getBoundingClientRect().top) : null,
  };
}, HEADER_H);
console.log('stacking at bottom:', JSON.stringify(stack));
if (stack.headerTop !== 0) failures.push(`header not at top (top=${stack.headerTop})`);
if (stack.barTop !== HEADER_H) failures.push(`filter bar not directly under header (top=${stack.barTop}, want ${HEADER_H})`);
if (!stack.barOpaque) failures.push('filter bar background is transparent');
if (!stack.cartVisible) failures.push('cart not visible at page bottom');
if (stack.cartTop === null || stack.cartTop < HEADER_H) failures.push(`right column overlaps header (cartTop=${stack.cartTop})`);

// category chip still operable at the bottom
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

// ---------- mobile: stacked layout + Sheet over header ----------
const m = await newPage({ width: 390, height: 844 });
await m.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await m.waitForTimeout(2000);
// hamburger opens the Sheet; it must cover the sticky header
await m.getByRole('button', { name: 'Open navigation' }).click();
await m.waitForTimeout(800);
const sheetInfo = await m.evaluate(() => {
  const sheet = document.querySelector('[role="dialog"]');
  const header = document.querySelector('header');
  if (!sheet || !header) return { sheet: Boolean(sheet) };
  const sz = Number(getComputedStyle(sheet.closest('[class*="z-"]') ?? sheet).zIndex) || 0;
  const hz = Number(getComputedStyle(header).zIndex) || 0;
  return { sheet: true, sheetZ: sz, headerZ: hz, sheetAbove: sz >= hz };
});
console.log('mobile sheet:', JSON.stringify(sheetInfo));
if (!sheetInfo.sheet) failures.push('mobile: sheet did not open');
else if (!sheetInfo.sheetAbove) failures.push(`mobile: sheet under header (sheetZ=${sheetInfo.sheetZ} < headerZ=${sheetInfo.headerZ})`);
await m.screenshot({ path: '/tmp/daiwt-layout-mobile-sheet.png' });
await m.keyboard.press('Escape');
await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await m.waitForTimeout(800);
const mobile = await m.evaluate(() => ({
  noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
  headerPinned: document.querySelector('header')?.getBoundingClientRect().top === 0,
  chatVisible: !!document.querySelector('[data-chat-fab]'), // chat is a floating overlay now (FAB)
}));
console.log('mobile:', JSON.stringify(mobile));
if (!mobile.noHorizontalOverflow) failures.push('mobile: horizontal overflow');
if (!mobile.headerPinned) failures.push('mobile: header not pinned');
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
console.log('screenshots: /tmp/daiwt-layout-top.png, -bottom.png, -bottom-filtered.png, -mobile.png, -mobile-sheet.png');
