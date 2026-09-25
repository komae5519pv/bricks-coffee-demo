#!/usr/bin/env node
/**
 * Chat overlay + history verification: floating panel sizing, non-modal
 * cart operations, navigation persistence, Lakebase persistence, browse,
 * resume, new conversation, delete, leak-freedom, and responsive layout
 * (desktop 1440 / iPad 768 / iPhone 375).
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_chat_history.mjs
 *
 * Optional: FOREIGN_THREAD_ID=<uuid of another user's thread> adds a check
 * that GET /api/agents/threads/<id> returns 404 for us.
 *
 * Reply-content assertions go through /api/agents/threads/:id (the DB-backed
 * read path), not the DOM, so they are independent of rendering.
 */
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com';
const TOKEN = process.env.APP_TOKEN;
if (!TOKEN) {
  console.error('APP_TOKEN env var is required');
  process.exit(1);
}
const FIRST_Q = 'アイスコーヒーと抹茶ラテの違いを教えて';
const RESUME_Q = 'その2つのうち、カロリーが低いのはどっち?';
const NEW_Q = '抹茶ラテのカロリーは?';

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

const panel = page.locator('[data-chat-panel]');
const fab = page.getByRole('button', { name: 'AI バリスタに相談' });

async function ask(text) {
  await page.getByPlaceholder('バリスタにメッセージ…').fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.getByRole('button', { name: '送信', exact: true }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(800);
}

const getThreads = () => page.evaluate(async () => fetch('/api/agents/threads').then((r) => r.json()));
const getThread = (id) => page.evaluate(async (tid) => fetch(`/api/agents/threads/${tid}`).then((r) => r.json()), id);
const lastAssistant = (thread) => [...(thread.messages ?? [])].reverse().find((m) => m.role === 'assistant');
const cartCount = async () =>
  (await page.locator('[data-cart-qty]').allTextContents()).reduce((s, t) => s + Number(t), 0);

// Node-side fetch for the intentional 404 probes — doing them inside the page
// would log "Failed to load resource: 404" console errors and trip the
// console-error gate on our own negative tests.
const apiStatus = (path) =>
  fetch(`${APP}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.status);

// ---------- 1. 6+ items in the cart, then open the overlay panel ----------
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: '追加' }).first().waitFor({ timeout: 30000 });
const firstAdd = page.getByRole('button', { name: '追加' }).first();
for (let i = 0; i < 6; i++) await firstAdd.click();
await page.waitForTimeout(500);
const count6 = await cartCount();
console.log('cart count after 6 adds:', count6);
if (count6 !== 6) failures.push(`cart count after 6 adds = ${count6}`);

await fab.click();
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
const panelBox = await panel.boundingBox();
const cartBox = await page.locator('[data-cart]').boundingBox();
console.log(
  'panel:',
  panelBox && `${Math.round(panelBox.width)}x${Math.round(panelBox.height)} @ (${Math.round(panelBox.x)},${Math.round(panelBox.y)})`,
  '| cart x:',
  cartBox && Math.round(cartBox.x),
);
if (!panelBox || panelBox.width < 380) failures.push(`panel too narrow (${panelBox?.width})`);
if (!panelBox || panelBox.height < 500) failures.push(`panel too short (${panelBox?.height})`);
if (panelBox && (panelBox.x < 0 || panelBox.x + panelBox.width > 1441)) failures.push('panel overflows the viewport');
if (panelBox && cartBox && panelBox.x + panelBox.width > cartBox.x + 1) failures.push('panel overlaps the cart column');
await page.screenshot({ path: '/tmp/chat-overlay-cart6-panel.png' });

// ---------- 2. first question -> barista answers (LLM-payload regression) ----------
await ask(FIRST_Q);
const list1 = await getThreads();
console.log('threads after Q1:', list1.threads.length, '| newest title:', list1.threads[0]?.title);
const t1 = list1.threads[0];
if (!t1) failures.push('no thread persisted after first message');
if (t1 && !t1.title.includes('アイスコーヒー')) failures.push(`title not from first message: ${t1.title}`);
if (t1) {
  const full = await getThread(t1.id);
  const reply = lastAssistant(full)?.content ?? '';
  console.log('Q1 reply length:', reply.length, '| mentions drinks:', /抹茶|アイスコーヒー/.test(reply));
  if (reply.length < 30) failures.push(`first reply too short (${reply.length} chars)`);
  if (!/抹茶|アイスコーヒー/.test(reply)) failures.push('first reply does not mention the asked drinks');
}
await page.screenshot({ path: '/tmp/chat-overlay-first-reply.png' });

// ---------- 3. NON-MODAL: add to cart + edit quantities with the panel open ----------
await page.getByRole('button', { name: '追加' }).nth(1).click();
await page.waitForTimeout(500);
const count7 = await cartCount();
await page.locator('[data-cart-line]').first().getByRole('button', { name: '数量を増やす' }).click();
await page.waitForTimeout(500);
const count8 = await cartCount();
console.log('cart ops with panel open: after add', count7, '| after bump', count8);
if (count7 !== 7) failures.push(`add-to-cart with panel open failed (count=${count7})`);
if (count8 !== 8) failures.push(`cart quantity edit with panel open failed (count=${count8})`);
const inputStillThere = await page.getByPlaceholder('バリスタにメッセージ…').count();
if (inputStillThere === 0) failures.push('panel vanished during background cart ops');
await page.screenshot({ path: '/tmp/chat-overlay-nonmodal-cart.png' });

// ---------- 4. reload -> history survives (persistence) ----------
await page.reload({ waitUntil: 'networkidle' });
await fab.click();
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
await page.getByRole('button', { name: '履歴' }).click();
await page.waitForTimeout(1500);
const sheetHasT1 = t1 ? await page.getByText(t1.title, { exact: false }).count() : 0;
console.log('history sheet shows thread:', sheetHasT1);
if (t1 && sheetHasT1 === 0) failures.push('thread not visible in history sheet after reload');
await page.screenshot({ path: '/tmp/chat-overlay-sheet.png' });

// ---------- 5. load thread -> messages render + resume WITH context ----------
if (t1) {
  await page.getByText(t1.title, { exact: false }).first().click();
  await page.waitForTimeout(1500);
  const rendered = await page.evaluate(
    () => document.body.innerText.includes('アイスコーヒー') && document.body.innerText.includes('抹茶ラテ'),
  );
  console.log('loaded messages render:', rendered);
  if (!rendered) failures.push('loaded thread messages did not render');
  await page.screenshot({ path: '/tmp/chat-overlay-loaded.png' });

  await ask(RESUME_Q);
  const list2 = await getThreads();
  const sameThread = list2.threads.some((t) => t.id === t1.id);
  const t1full = await getThread(t1.id);
  const resumeReply = lastAssistant(t1full)?.content ?? '';
  console.log('resume: same thread kept:', sameThread, '| messages in t1:', t1full.messages?.length);
  console.log('resume reply references a drink:', /アイスコーヒー|抹茶ラテ/.test(resumeReply));
  if (!sameThread) failures.push('resume lost the thread');
  if ((t1full.messages?.length ?? 0) < 4) failures.push(`resume did not append (messages=${t1full.messages?.length})`);
  if (!/アイスコーヒー|抹茶ラテ/.test(resumeReply)) failures.push('resume reply lacks context (no drink reference)');
}

// ---------- 6. NAVIGATION: conversation survives page transitions ----------
await page.getByRole('link', { name: 'マイ注文' }).click();
await page.waitForTimeout(1500);
const onOrders = await page.evaluate(() => ({
  inputVisible: !!document.querySelector('[placeholder="バリスタにメッセージ…"]'),
  messagesKept: document.body.innerText.includes('アイスコーヒー'),
}));
console.log('after nav to マイ注文:', JSON.stringify(onOrders));
if (!onOrders.inputVisible) failures.push('panel did not survive navigation to マイ注文');
if (!onOrders.messagesKept) failures.push('conversation lost on navigation');
await page.screenshot({ path: '/tmp/chat-overlay-myorders.png' });
await page.getByRole('link', { name: '注文する' }).click();
await page.waitForTimeout(1500);

// ---------- 7. new conversation -> separate thread, barista answers ----------
await page.getByRole('button', { name: '新しい会話' }).click();
await page.waitForTimeout(500);
const cleared = await page.evaluate(() => document.body.innerText.includes('バリスタに話しかけてみましょう'));
console.log('new conversation resets view:', cleared);
if (!cleared) failures.push('new conversation did not reset the view');
await ask(NEW_Q);
const list3 = await getThreads();
console.log('threads after new conversation:', list3.threads.length);
const other = list3.threads.find((t) => t1 && t.id !== t1.id);
if (!other) failures.push('new conversation did not create a separate thread');
if (other) {
  const full = await getThread(other.id);
  const reply = lastAssistant(full)?.content ?? '';
  const hasCalorie = /kcal|カロリー/.test(reply) && /抹茶/.test(reply);
  console.log('new thread reply mentions 抹茶+calorie:', hasCalorie, '| length:', reply.length);
  if (!hasCalorie) failures.push('new-thread reply does not answer the calorie question');
}

// ---------- 8. delete with confirm ----------
await page.getByRole('button', { name: '履歴' }).click();
await page.waitForTimeout(1000);
page.once('dialog', (d) => void d.accept());
if (t1) {
  const rowDiv = page.locator('div.group', { hasText: t1.title.slice(0, 10) }).first();
  await rowDiv.hover();
  await rowDiv.getByRole('button', { name: '削除' }).click();
  await page.waitForTimeout(1500);
}
const list4 = await getThreads();
const t1Gone = t1 ? !list4.threads.some((t) => t.id === t1.id) : true;
console.log('deleted thread gone:', t1Gone, '| remaining:', list4.threads.length);
if (!t1Gone) failures.push('deleted thread still listed');
if (t1) {
  const gone = await apiStatus(`/api/agents/threads/${t1.id}`);
  console.log('deleted thread GET status:', gone);
  if (gone !== 404) failures.push(`deleted thread still fetchable (status ${gone})`);
}
await page.screenshot({ path: '/tmp/chat-overlay-after-delete.png' });
await page.keyboard.press('Escape');

// ---------- 9. leak check: single-owner list + optional foreign-thread 404 ----------
{
  const list = await getThreads();
  const foreignLeak = list.threads.filter((t) => t.userId !== list.threads[0]?.userId).length;
  console.log('foreign threads leaked:', foreignLeak);
  if (foreignLeak > 0) failures.push(`${foreignLeak} foreign threads leaked into list`);
}
if (process.env.FOREIGN_THREAD_ID) {
  const status = await apiStatus(`/api/agents/threads/${process.env.FOREIGN_THREAD_ID}`);
  console.log('foreign thread GET status:', status);
  if (status !== 404) failures.push(`foreign thread readable (status ${status})`);
}

await page.close();

// ---------- 10. iPad 768: overlay opens and stays within the viewport ----------
{
  const c = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
    viewport: { width: 768, height: 1024 },
  });
  const p = await c.newPage();
  track(p);
  await p.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
  await p.getByRole('button', { name: 'AI バリスタに相談' }).click();
  await p.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
  const box = await p.locator('[data-chat-panel]').boundingBox();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  console.log('ipad: panel', box && `${Math.round(box.width)}x${Math.round(box.height)}`, '| page overflow:', overflow);
  if (!box || box.x < 0 || box.x + box.width > 769) failures.push('ipad: panel overflows the viewport');
  if (overflow) failures.push('ipad: horizontal page overflow with panel open');
  await p.screenshot({ path: '/tmp/chat-overlay-ipad.png' });
  await c.close();
}

// ---------- 11. iPhone 375: near-fullscreen sheet + history works ----------
{
  const c = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
    viewport: { width: 375, height: 812 },
  });
  const p = await c.newPage();
  track(p);
  await p.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(1500);
  const overflowBefore = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  await p.getByRole('button', { name: 'AI バリスタに相談' }).click();
  await p.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
  const box = await p.locator('[data-chat-panel]').boundingBox();
  console.log('mobile: sheet', box && `${Math.round(box.width)}x${Math.round(box.height)}`);
  if (!box || box.width < 340 || box.height < 700) failures.push(`mobile: sheet not near-fullscreen (${box?.width}x${box?.height})`);
  await p.getByRole('button', { name: '履歴' }).click();
  await p.waitForTimeout(1000);
  const sheetVisible = await p.getByText('会話の履歴').count();
  const overflowAfter = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  console.log('mobile: overflow', overflowBefore, '| history sheet opens', sheetVisible, '| overflow after', overflowAfter);
  if (overflowBefore || overflowAfter) failures.push('mobile: horizontal overflow with overlay UI');
  if (sheetVisible === 0) failures.push('mobile: history sheet did not open');
  await p.screenshot({ path: '/tmp/chat-overlay-mobile.png' });
  await c.close();
}

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/chat-overlay-*.png');
