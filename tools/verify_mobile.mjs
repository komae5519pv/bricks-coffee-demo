#!/usr/bin/env node
/**
 * Mobile verification: 375px (iPhone) and 768px (iPad) across all 6 pages,
 * floating cart bar, and cart calorie totals.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_mobile.mjs
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}

const PAGES = ['/', '/orders', '/board', '/admin/menu', '/history', '/status'];
const VIEWPORTS = [
  { name: 'iphone', width: 375, height: 812 },
  { name: 'ipad', width: 768, height: 1024 },
];

const browser = await chromium.launch();
const consoleErrors = [];
const failures = [];

async function newPage(vp) {
  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
    viewport: vp,
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${vp.name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${vp.name}] ${String(e)}`));
  return page;
}

for (const vp of VIEWPORTS) {
  for (const path of PAGES) {
    const page = await newPage(vp);
    await page.goto(APP + path, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      fullNavVisible: (() => {
        const nav = document.querySelector('header nav');
        return nav ? getComputedStyle(nav).display !== 'none' : false;
      })(),
      hamburgerVisible: (() => {
        const btn = document.querySelector('header button[aria-label="Open navigation"], header .lg\\:hidden button');
        return btn ? getComputedStyle(btn).display !== 'none' : false;
      })(),
    }));
    const tag = `${vp.name} ${path}`;
    console.log(tag, JSON.stringify(r));
    if (r.scrollW > r.innerW + 1) failures.push(`${tag}: horizontal overflow (scrollWidth ${r.scrollW} > ${r.innerW})`);
    if (vp.width <= 768 && r.fullNavVisible) failures.push(`${tag}: full nav visible at ${vp.width}px (should be hamburger)`);
    if (vp.width >= 1024 && !r.fullNavVisible) failures.push(`${tag}: full nav missing at ${vp.width}px`);
    const name = path === '/' ? 'order' : path.slice(1).replace('/', '-');
    await page.screenshot({ path: `/tmp/mobile-${vp.name}-${name}.png` });
    await page.close();
  }
}

// ---------- order page mobile flow: add item -> floating bar -> cart ----------
const page = await newPage(VIEWPORTS[0]);
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /追加/ }).first().click();
await page.waitForTimeout(800);
const bar = await page.locator('[data-floating-cart]');
const barCount = await bar.count();
console.log('floating bar:', barCount, barCount ? await bar.innerText() : '(missing)');
if (barCount === 0) failures.push('floating cart bar did not appear after adding an item');
if (barCount > 0) {
  await bar.click();
  await page.waitForTimeout(1200);
  const cartTop = await page.evaluate(() => document.querySelector('[data-cart]')?.getBoundingClientRect().top ?? null);
  console.log('cart top after bar tap:', cartTop);
  if (cartTop === null || cartTop > 200) failures.push(`tap did not scroll cart into view (top=${cartTop})`);
}
await page.screenshot({ path: '/tmp/mobile-iphone-floating-bar.png' });

// place the order (name + submit)
await page.getByPlaceholder('お名前(呼び出し用)').fill('Mobile Test');
await page.getByRole('button', { name: 'この内容で注文する' }).click();
await page.waitForTimeout(2500);
const notice = await page.evaluate(() => document.body.innerText.includes('受け付けました'));
console.log('order placed notice:', notice);
if (!notice) failures.push('mobile order flow did not complete');

// ---------- cart kcal totals match line sums (desktop) ----------
const d = await newPage({ width: 1440, height: 900 });
await d.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await d.getByRole('button', { name: /追加/ }).first().waitFor({ timeout: 30000 });
await d.waitForTimeout(2500);
// add two different items
const addButtons = d.getByRole('button', { name: /追加/ });
await addButtons.nth(0).click();
await d.waitForTimeout(300);
await addButtons.nth(1).click();
await d.waitForTimeout(800);
const kcalCheck = await d.evaluate(() => {
  const cart = document.querySelector('[data-cart]');
  if (!cart) return { ok: false, reason: 'no cart' };
  const text = cart.textContent ?? '';
  const lineKcals = [...text.matchAll(/\/ (\d+)kcal/g)].map((m) => Number(m[1]));
  const total = lineKcals.pop() ?? null;
  const sum = lineKcals.reduce((s, k) => s + k, 0);
  return { lineKcals, total, sum };
});
console.log('kcal check:', JSON.stringify(kcalCheck));
if (kcalCheck.total === null) failures.push('no total kcal in cart');
else if (kcalCheck.total !== kcalCheck.sum) failures.push(`total kcal mismatch: ${kcalCheck.total} != sum ${kcalCheck.sum}`);
await d.screenshot({ path: '/tmp/mobile-desktop-cart-kcal.png' });
await d.close();

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/mobile-{iphone,ipad}-*.png, /tmp/mobile-iphone-floating-bar.png, /tmp/mobile-desktop-cart-kcal.png');
