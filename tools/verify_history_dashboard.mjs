#!/usr/bin/env node
/**
 * History dashboard v3 verification: 7 chart forms, live KPI tween, true
 * live-month accent, responsive 375/768, no console errors.
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

// ---------- 0. true live-month accent (B1) ----------
const orderMonth = new Date().toISOString().slice(0, 7);
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });
await page.getByRole('button', { name: '追加' }).first().click();
await page.getByPlaceholder('お名前(呼び出し用)').fill('v3検証');
await page.getByRole('button', { name: 'この内容で注文する' }).click();
await page.locator('[data-order-toast]').waitFor({ timeout: 30000 });

await page.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByText('月別売上トレンド').waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);

const liveCheck = await page.evaluate((month) => {
  const rects = [...document.querySelectorAll('.recharts-area-dot, circle[r="5"]')];
  const accentDot = rects.find((r) => r.getAttribute('fill') === 'var(--chart-accent)' || r.getAttribute('fill') === '#eb6834');
  return fetch('/api/history/summary')
    .then((r) => r.json())
    .then((d) => ({
      month,
      liveMonthRow: d.monthly.find((m) => m.month === month),
      hasAccentDot: !!accentDot,
      accentFill: accentDot?.getAttribute('fill'),
      dailyLen: d.daily?.length ?? 0,
      bubbleLen: d.bubble?.length ?? 0,
      heatmapLen: d.heatmap?.length ?? 0,
      geoLen: d.store_geo?.length ?? 0,
    }));
}, orderMonth);
console.log('live month check:', JSON.stringify(liveCheck));
if (!liveCheck.liveMonthRow) failures.push(`no ${orderMonth} in monthly`);
else if (!liveCheck.liveMonthRow.is_live) failures.push('live month is_live=false');
if (!liveCheck.hasAccentDot) failures.push('no accent dot on live month');
if (liveCheck.dailyLen < 1) failures.push('no daily sparkline data');
if (liveCheck.bubbleLen < 1) failures.push('no bubble data');
if (liveCheck.heatmapLen < 1) failures.push('no heatmap data');
if (liveCheck.geoLen < 12) failures.push(`store_geo has ${liveCheck.geoLen} stores (want 12)`);

// ---------- 1. v3 structure ----------
const structure = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    kpiSales: text.includes('今日の売上'),
    kpiOrders: text.includes('今日の注文数'),
    kpiAvg: text.includes('平均客単価'),
    kpiInProgress: text.includes('進行中の注文'),
    trend: text.includes('月別売上トレンド'),
    map: text.includes('店舗別売上（世界）'),
    donut: text.includes('カテゴリ別売上構成'),
    bubble: text.includes('メニューエンジニアリング'),
    heatmap: text.includes('曜日×時間帯の注文分布'),
    ranking: text.includes('店舗別売上ランキング'),
    popular: text.includes('人気商品 Top 10'),
    sparklines: document.querySelectorAll('svg path[stroke="var(--chart-primary)"]').length,
    liveBadge: document.querySelectorAll('[class*="bg-blue-100"]').length,
  };
});
console.log('structure:', JSON.stringify(structure));
for (const [k, v] of Object.entries(structure)) {
  if (!v) failures.push(`missing section: ${k}`);
}
await page.screenshot({ path: '/tmp/history-v3-desktop.png' });

// ---------- 2. KPI tween on new order ----------
const kpiBefore = await page.evaluate(() => {
  const el = document.querySelector('.text-4xl.tabular-nums');
  return el?.textContent;
});
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().click();
await page.getByPlaceholder('お名前(呼び出し用)').fill('トゥイーン検証');
await page.getByRole('button', { name: 'この内容で注文する' }).click();
await page.locator('[data-order-toast]').waitFor({ timeout: 30000 });
await page.goto(`${APP}/history`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
const kpiAfter = await page.evaluate(() => {
  const el = document.querySelector('.text-4xl.tabular-nums');
  return el?.textContent;
});
console.log('KPI tween:', kpiBefore, '->', kpiAfter);
if (kpiBefore === kpiAfter) failures.push('KPI did not tween after new order');

// ---------- 3. responsive ----------
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
await p768.screenshot({ path: '/tmp/history-v3-768.png' });
await ctx768.close();

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
await p375.screenshot({ path: '/tmp/history-v3-375.png' });
await ctx375.close();

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/history-v3-{desktop,768,375}.png');
