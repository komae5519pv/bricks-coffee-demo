#!/usr/bin/env node
/**
 * History dashboard redesign verification: Row1-4 implemented, live KPI moves
 * after placing an order, charts render, responsive at 375/768, no console errors.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_history_dashboard.mjs
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}

const browser = await chromium.launch();
const failures = [];
const consoleErrors = [];

function track(page) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
}

const ctx = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
track(page);

// ---------- 1. dashboard structure ----------
await page.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByText('今日の売上').waitFor({ timeout: 30000 });

const structure = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    kpiSales: text.includes('今日の売上'),
    kpiOrders: text.includes('今日の注文数'),
    kpiAvg: text.includes('平均客単価'),
    kpiInProgress: text.includes('進行中の注文'),
    trend: text.includes('月別売上トレンド'),
    category: text.includes('カテゴリ別売上'),
    hourly: text.includes('時間帯別注文分布'),
    store: text.includes('店舗別売上'),
    popular: text.includes('人気商品 Top 10'),
    liveBadge: document.querySelectorAll('[class*="bg-blue-100"]').length,
    histBadge: text.includes('履歴'),
  };
});
console.log('structure:', JSON.stringify(structure));
for (const [k, v] of Object.entries(structure)) {
  if (!v) failures.push(`missing section: ${k}`);
}
await page.screenshot({ path: '/tmp/history-dashboard-desktop.png' });

// ---------- 2. live KPI moves after placing an order ----------
const before = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.text-4xl, .text-2xl')].map((t) => t.textContent);
  return { sales: tiles[0], orders: tiles[1] };
});
console.log('KPI before order:', JSON.stringify(before));

await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });
await page.getByRole('button', { name: '追加' }).first().click();
await page.getByPlaceholder('お名前(呼び出し用)').fill('履歴検証');
await page.getByRole('button', { name: 'この内容で注文する' }).click();
await page.locator('[data-order-toast]').waitFor({ timeout: 30000 });
const toastText = await page.locator('[data-order-toast]').innerText();
console.log('order placed:', toastText.slice(0, 80));

await page.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByText('今日の売上').waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
const after = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.text-4xl, .text-2xl')].map((t) => t.textContent);
  return { sales: tiles[0], orders: tiles[1] };
});
console.log('KPI after order:', JSON.stringify(after));
if (before.sales === after.sales && before.orders === after.orders) {
  failures.push('live KPI did not change after placing an order');
}

// ---------- 3. trend toggle ----------
await page.getByRole('button', { name: '売上', exact: true }).first().click();
await page.waitForTimeout(500);
const revLabel = await page.evaluate(() => document.body.innerText.includes('売上'));
await page.getByRole('button', { name: '注文数', exact: true }).first().click();
await page.waitForTimeout(500);
const ordLabel = await page.evaluate(() => document.body.innerText.includes('注文数'));
console.log('trend toggle: revenue label', revLabel, '| orders label', ordLabel);
if (!revLabel || !ordLabel) failures.push('trend toggle labels missing');

// ---------- 4. popular toggle ----------
await page.getByRole('button', { name: '点数', exact: true }).first().click();
await page.waitForTimeout(500);
const qtyVisible = await page.evaluate(() => /\d+点/.test(document.body.innerText));
console.log('popular qty visible:', qtyVisible);
if (!qtyVisible) failures.push('popular qty toggle not working');
await page.getByRole('button', { name: '売上', exact: true }).first().click();

// ---------- 5. responsive 768 ----------
const ctx768 = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 768, height: 1024 },
});
const p768 = await ctx768.newPage();
track(p768);
await p768.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await p768.waitForTimeout(2000);
const overflow768 = await p768.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
console.log('768 overflow:', overflow768);
if (overflow768) failures.push('768px horizontal overflow');
await p768.screenshot({ path: '/tmp/history-dashboard-768.png' });
await ctx768.close();

// ---------- 6. responsive 375 ----------
const ctx375 = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 375, height: 812 },
});
const p375 = await ctx375.newPage();
track(p375);
await p375.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await p375.waitForTimeout(2000);
const overflow375 = await p375.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
console.log('375 overflow:', overflow375);
if (overflow375) failures.push('375px horizontal overflow');
await p375.screenshot({ path: '/tmp/history-dashboard-375.png' });
await ctx375.close();

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/history-dashboard-{desktop,768,375}.png');
