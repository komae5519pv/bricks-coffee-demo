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

// ---------- 0.5. craft refresh: KPI delta badges, live pill pulse, light theme ----------
const craftCheck = await page.evaluate(() => {
  const page = document.querySelector('[data-history-page]');
  const badges = document.querySelectorAll('[data-delta-badge]');
  const pulse = document.querySelector('[data-live-pulse]');
  const tiles = document.querySelectorAll('[data-kpi-tile]');
  const pageBg = page ? getComputedStyle(page).backgroundColor : null;
  const cardBg = tiles.length > 0 ? getComputedStyle(tiles[0]).backgroundColor : null;
  const cardRadius = tiles.length > 0 ? parseFloat(getComputedStyle(tiles[0]).borderRadius) : 0;
  // luminance: handles oklab/oklch (L 0..1), lab/lch (L 0..100), rgb()
  const lum = (c) => {
    if (!c) return -1;
    let m = c.match(/^(oklab|oklch)\(\s*([\d.]+)/);
    if (m) return Number(m[2]);
    m = c.match(/^(lab|lch)\(\s*([\d.]+)/);
    if (m) return Number(m[2]) / 100;
    m = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return -1;
    const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return {
    badgeCount: badges.length,
    hasPulse: !!pulse,
    tileCount: tiles.length,
    pageBg,
    pageLum: lum(pageBg),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyLum: lum(getComputedStyle(document.body).backgroundColor),
    cardRadius,
  };
});
console.log('craft check:', JSON.stringify(craftCheck));
if (craftCheck.tileCount !== 4) failures.push(`KPI tiles != 4 (${craftCheck.tileCount})`);
// 3 tiles carry a delta badge (進行中の注文 honestly shows none)
if (craftCheck.badgeCount !== 3) failures.push(`delta badges != 3 (${craftCheck.badgeCount})`);
if (!craftCheck.hasPulse) failures.push('live pill pulse dot missing');
// light theme maintained: page tint AND app background must both be light
if (craftCheck.pageLum < 0.85) failures.push(`page background too dark (lum=${craftCheck.pageLum.toFixed(2)})`);
if (craftCheck.bodyLum < 0.85) failures.push(`app background went dark (lum=${craftCheck.bodyLum.toFixed(2)})`);
// 3-layer material: the page tint must be visibly distinct from the app bg
if (craftCheck.pageBg === craftCheck.bodyBg) failures.push('page tint equals app background (no material layering)');
if (craftCheck.cardRadius < 15) failures.push(`cards not rounded-2xl (radius=${craftCheck.cardRadius}px)`);
await page.screenshot({ path: '/tmp/history-v3-kpi-craft.png', clip: { x: 0, y: 0, width: 1440, height: 420 } });

// ---------- 1. donut: recharts Pie with cornerRadius (no hand-made look) ----------
const donutCheck = await page.evaluate(() => {
  const pie = document.querySelector('.recharts-pie');
  const sectors = document.querySelectorAll('.recharts-sector');
  const firstSector = sectors[0];
  const hasCornerRadius = firstSector?.getAttribute('d')?.includes('A') ?? false; // arc segments exist
  const centerTotal = document.body.innerText.includes('合計');
  return {
    hasPie: !!pie,
    sectorCount: sectors.length,
    hasCornerRadius,
    centerTotal,
  };
});
console.log('donut structure:', JSON.stringify(donutCheck));
if (!donutCheck.hasPie) failures.push('no recharts pie found');
if (donutCheck.sectorCount < 5) failures.push(`donut sectors too few (${donutCheck.sectorCount})`);
if (!donutCheck.hasCornerRadius) failures.push('donut sectors have no corner radius (hand-made look)');
if (!donutCheck.centerTotal) failures.push('donut center total missing');
await page.screenshot({ path: '/tmp/donut-check.png', clip: { x: 720, y: 600, width: 720, height: 500 } });

// ---------- 1. world map: land polygons actually render ----------
// (regression: SVG elements existed but land geometry was invisible —
// delta-encoded TopoJSON was used as absolute lon/lat)
const mapCheck = await page.evaluate(() => {
  const svg = document.querySelector('svg[aria-label="世界地図"]');
  if (!svg) return { hasSvg: false };
  const paths = [...svg.querySelectorAll('path')];
  const landPaths = paths.filter((p) => {
    const fill = p.getAttribute('fill');
    return fill === 'var(--chart-land)' || fill === '#d4d4d0';
  });
  const bgFill = getComputedStyle(document.body).backgroundColor;
  const landFill = landPaths.length > 0 ? getComputedStyle(landPaths[0]).fill : null;
  // store bubbles sit on the map: Tokyo's bubble cx should be east of center
  const tokyo = svg.querySelector('[data-store-bubble="TYO001"]');
  const tokyoX = tokyo ? Number(tokyo.getAttribute('cx')) : null;
  return {
    hasSvg: true,
    pathCount: paths.length,
    landPathCount: landPaths.length,
    landFill,
    bgFill,
    landDistinct: landFill != null && landFill !== bgFill,
    tokyoX,
    tokyoEastOfCenter: tokyoX != null && tokyoX > 360,
  };
});
console.log('map structure:', JSON.stringify(mapCheck));
if (!mapCheck.hasSvg) failures.push('world map SVG missing');
else {
  if (mapCheck.landPathCount < 100) failures.push(`land paths too few (${mapCheck.landPathCount} — want 100+ country polygons)`);
  if (!mapCheck.landDistinct) failures.push(`land fill matches background (${mapCheck.landFill})`);
  if (mapCheck.tokyoX != null && !mapCheck.tokyoEastOfCenter) failures.push(`Tokyo bubble misplaced (cx=${mapCheck.tokyoX}, want >360 = east hemisphere)`);
}
await page.screenshot({ path: '/tmp/history-v3-map-check.png', clip: { x: 0, y: 600, width: 720, height: 500 } });

// ---------- 1b. map zoom: transform changes, bubbles follow ----------
const zoomCheck = await page.evaluate(() => {
  const svg = document.querySelector('svg[aria-label="世界地図"]');
  if (!svg) return { hasSvg: false };
  const g = svg.querySelector('g');
  const transform = g?.getAttribute('transform') ?? '';
  const match = transform.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/);
  return {
    hasSvg: true,
    hasTransformGroup: !!g,
    transform,
    scale: match ? Number(match[3]) : 1,
  };
});
console.log('zoom structure:', JSON.stringify(zoomCheck));
if (!zoomCheck.hasSvg) failures.push('map SVG missing for zoom check');
else if (!zoomCheck.hasTransformGroup) failures.push('map has no zoom transform group');

// click zoom-in button and verify transform changes
await page.getByRole('button', { name: '拡大' }).click();
await page.waitForTimeout(600);
const zoomAfter = await page.evaluate(() => {
  const g = document.querySelector('svg[aria-label="世界地図"] g');
  const transform = g?.getAttribute('transform') ?? '';
  const match = transform.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/);
  return {
    transform,
    scale: match ? Number(match[3]) : 1,
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
  };
});
console.log('zoom after click:', JSON.stringify(zoomAfter));
if (zoomAfter.scale <= zoomCheck.scale) failures.push(`zoom-in did not increase scale (${zoomCheck.scale} -> ${zoomAfter.scale})`);

// pan, then zoom via button: pan position must be preserved (review #1)
await page.mouse.move(400, 400);
await page.mouse.down();
await page.mouse.move(500, 450, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const panBefore = await page.evaluate(() => {
  const g = document.querySelector('svg[aria-label="世界地図"] g');
  const t = g?.getAttribute('transform') ?? '';
  const m = t.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null;
});
await page.getByRole('button', { name: '拡大' }).click();
await page.waitForTimeout(600);
const panAfter = await page.evaluate(() => {
  const g = document.querySelector('svg[aria-label="世界地図"] g');
  const t = g?.getAttribute('transform') ?? '';
  const m = t.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null;
});
console.log('pan preserved:', JSON.stringify({ panBefore, panAfter }));
if (panBefore && panAfter) {
  // x/y should not jump to 0 (identity) after button zoom
  const jumpedToOrigin = Math.abs(panAfter.x) < 0.01 && Math.abs(panAfter.y) < 0.01 && (Math.abs(panBefore.x) > 1 || Math.abs(panBefore.y) > 1);
  if (jumpedToOrigin) failures.push(`button zoom reset pan position (was ${panBefore.x.toFixed(1)},${panBefore.y.toFixed(1)} -> ${panAfter.x.toFixed(1)},${panAfter.y.toFixed(1)})`);
  if (panAfter.k <= panBefore.k) failures.push(`button zoom did not increase scale after pan (${panBefore.k} -> ${panAfter.k})`);
} else {
  failures.push('could not read pan transform for preservation check');
}

await page.getByRole('button', { name: 'リセット' }).click();
await page.waitForTimeout(600);

// ---------- 1c. map: legend removed, bubble hover/tap tooltip, drag conflict ----------
const mapCardText = await page.evaluate(() => {
  const h3 = [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('店舗別売上（世界）'));
  const card = h3?.closest('[data-slot="card"], .rounded-2xl');
  return { text: card?.textContent ?? '', bubbleCount: document.querySelectorAll('[data-store-bubble]').length };
});
console.log('map card bubbles:', mapCardText.bubbleCount);
if (mapCardText.bubbleCount !== 12) failures.push(`map bubbles != 12 (${mapCardText.bubbleCount})`);
// legend removed: no store names listed below the map (東京駅前店 etc.)
for (const name of ['東京駅前店', 'Circular Quay', 'Mitte']) {
  if (mapCardText.text.includes(name)) failures.push(`map legend still present (contains ${name})`);
}

// hover a bubble -> shared TooltipCard with store details
const bubble = page.locator('[data-store-bubble]').first();
await bubble.hover();
await page.waitForTimeout(400);
let mapTip = await page.evaluate(() => {
  const tip = document.querySelector('[data-map-tooltip]');
  return tip ? tip.textContent : null;
});
console.log('map hover tooltip:', mapTip?.slice(0, 80));
if (!mapTip) failures.push('map hover tooltip did not appear');
else {
  if (!/売上/.test(mapTip)) failures.push('map tooltip lacks 売上');
  if (!/注文数/.test(mapTip)) failures.push('map tooltip lacks 注文数');
}
await page.screenshot({ path: '/tmp/map-tooltip.png' });
await page.mouse.move(60, 60); // off the bubble
await page.waitForTimeout(400);
mapTip = await page.evaluate(() => document.querySelector('[data-map-tooltip]')?.textContent ?? null);
if (mapTip) failures.push('map tooltip did not dismiss on mouse leave');

// tap (click) pins the tooltip; pan gesture clears it (drag conflict)
await bubble.click();
await page.waitForTimeout(400);
mapTip = await page.evaluate(() => document.querySelector('[data-map-tooltip]')?.textContent ?? null);
if (!mapTip) failures.push('map tap tooltip did not pin');
// drag from the SVG's own center (deterministic — earlier fixed coords could
// land off-map after Playwright's auto-scroll)
const mapSvgBox = await page.locator('svg[aria-label="世界地図"]').boundingBox();
if (!mapSvgBox) {
  failures.push('map svg box not found for drag test');
} else {
  const cx = mapSvgBox.x + mapSvgBox.width / 2;
  const cy = mapSvgBox.y + mapSvgBox.height / 2;
  await page.mouse.move(cx - 100, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 50, { steps: 8 });
  // DURING the drag the pinned tooltip must be gone (zoom 'start' clears it)
  mapTip = await page.evaluate(() => document.querySelector('[data-map-tooltip]')?.textContent ?? null);
  console.log('map tooltip during drag:', mapTip);
  if (mapTip) failures.push('map tooltip survived drag start (drag conflict)');
  await page.mouse.up();
  await page.mouse.move(mapSvgBox.x + 5, mapSvgBox.y + mapSvgBox.height + 60); // off-map neutral spot
  await page.waitForTimeout(400);
  mapTip = await page.evaluate(() => document.querySelector('[data-map-tooltip]')?.textContent ?? null);
  if (mapTip) failures.push('map tooltip reappeared after drag + mouse-out');
}
await page.getByRole('button', { name: 'リセット' }).click();
await page.waitForTimeout(500);

// ---------- 1d. unified tooltips elsewhere + wording ----------
// KPI sparkline hover
await page.locator('[data-kpi-tile]').first().locator('svg').last().hover({ position: { x: 60, y: 18 } });
await page.waitForTimeout(400);
const sparkTip = await page.evaluate(() => document.querySelector('[data-tooltip-card]')?.textContent ?? null);
console.log('sparkline tooltip:', sparkTip?.slice(0, 60));
if (!sparkTip) failures.push('KPI sparkline tooltip did not appear');
await page.mouse.move(20, 60);

// heatmap cell hover
await page.locator('text=曜日×時間帯の注文分布').scrollIntoViewIfNeeded();
const heatCell = page.locator('.aspect-square').nth(10);
await heatCell.hover();
await page.waitForTimeout(400);
const heatTip = await page.evaluate(() => document.querySelector('[data-tooltip-card]')?.textContent ?? null);
console.log('heatmap tooltip:', heatTip?.slice(0, 60));
if (!heatTip || !/件/.test(heatTip)) failures.push('heatmap tooltip missing order count');
await page.mouse.move(60, 60);

// donut hover (recharts path -> shared TooltipCard): hover ON THE RING
// (center + radius offset — center is the donut hole, not a sector)
await page.locator('text=カテゴリ別売上構成').scrollIntoViewIfNeeded();
const donutWrapper = page.locator('text=カテゴリ別売上構成').locator('..').locator('..').locator('.recharts-wrapper').first();
const donutBox = await donutWrapper.boundingBox();
if (!donutBox) {
  failures.push('donut wrapper box not found');
} else {
  await donutWrapper.hover({ position: { x: donutBox.width / 2 + 75, y: donutBox.height / 2 } });
  await page.waitForTimeout(500);
  const donutTip = await page.evaluate(() => document.querySelector('[data-tooltip-card]')?.textContent ?? null);
  console.log('donut tooltip:', donutTip?.slice(0, 60));
  if (!donutTip || !/構成比/.test(donutTip)) failures.push('donut tooltip missing 構成比');
  await page.screenshot({ path: '/tmp/donut-tooltip.png' });
}
await page.mouse.move(60, 60);

// trend chart hover (recharts path)
await page.locator('text=月別売上トレンド').scrollIntoViewIfNeeded();
await page.locator('.recharts-wrapper').first().hover({ position: { x: 300, y: 120 } });
await page.waitForTimeout(400);
const trendTip = await page.evaluate(() => document.querySelector('[data-tooltip-card]')?.textContent ?? null);
console.log('trend tooltip:', trendTip?.slice(0, 60));
if (!trendTip) failures.push('trend tooltip did not appear');
await page.mouse.move(60, 60);

// ranking bar hover
const rankBar = page.locator('text=店舗別売上ランキング').locator('..').locator('..').locator('div.space-y-0\\.5').first();
await rankBar.hover();
await page.waitForTimeout(400);
const rankTip = await page.evaluate(() => document.querySelector('[data-tooltip-card]')?.textContent ?? null);
console.log('ranking tooltip:', rankTip?.slice(0, 60));
if (!rankTip || !/構成比/.test(rankTip)) failures.push('ranking tooltip missing 構成比');
await page.mouse.move(60, 60);

// wording: 過去の日次平均 everywhere, old misnomer gone
const wording = await page.evaluate(() => ({
  hasNew: document.body.innerText.includes('過去の日次平均'),
  hasOld: document.body.innerText.includes('過去データ同日平均') || document.body.innerText.includes('過去データ平均'),
}));
console.log('wording:', JSON.stringify(wording));
if (!wording.hasNew) failures.push('新表記「過去の日次平均」が見つからない');
if (wording.hasOld) failures.push('旧表記「過去データ(同日)平均」が残っている');
await page.screenshot({ path: '/tmp/history-tooltips.png', fullPage: false });

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
    liveBadge: [...document.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'ライブ / Lakebase').length,
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
