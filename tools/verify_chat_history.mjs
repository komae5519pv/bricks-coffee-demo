#!/usr/bin/env node
/**
 * Chat history verification: persistence, browse, resume, new conversation,
 * delete, leak-freedom, and mobile layout.
 *
 *   APP_TOKEN=$(databricks auth token --profile fevm-konomi-demo -o json | jq -r .access_token) \
 *     node tools/verify_chat_history.mjs
 *
 * Optional: FOREIGN_THREAD_ID=<uuid of another user's thread> adds a check
 * that GET /api/agents/threads/<id> returns 404 for us.
 *
 * Reply-content assertions go through /api/agents/threads/:id (the DB-backed
 * read path), not the DOM, so they are independent of rendering. This is the
 * regression check for the "new thread -> LLM gets only the system message"
 * bug: if the user message never reaches the model, the reply cannot mention
 * the drinks/calories we asked about.
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

async function ask(text) {
  await page.getByPlaceholder('バリスタにメッセージ…').fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.getByRole('button', { name: '送信', exact: true }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(800);
}

const getThreads = () => page.evaluate(async () => fetch('/api/agents/threads').then((r) => r.json()));
const getThread = (id) => page.evaluate(async (tid) => fetch(`/api/agents/threads/${tid}`).then((r) => r.json()), id);
const lastAssistant = (thread) => [...(thread.messages ?? [])].reverse().find((m) => m.role === 'assistant');

// Node-side fetch for the intentional 404 probes — doing them inside the page
// would log "Failed to load resource: 404" console errors and trip the
// console-error gate on our own negative tests.
const apiStatus = (path) =>
  fetch(`${APP}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.status);

// ---------- 1. new conversation -> barista answers the FIRST message ----------
// (regression: empty thread.messages meant the LLM never saw the question)
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
await ask(FIRST_Q);
await page.screenshot({ path: '/tmp/chat-history-first-reply.png' });

const list1 = await getThreads();
console.log('threads after Q1:', list1.threads.length, '| titles:', list1.threads.map((t) => t.title));
const t1 = list1.threads[0];
if (!t1) failures.push('no thread persisted after first message');
if (t1 && !t1.title.includes('アイスコーヒー')) failures.push(`title not from first message: ${t1.title}`);
if (t1) {
  const full = await getThread(t1.id);
  const reply = lastAssistant(full)?.content ?? '';
  console.log('Q1 reply length:', reply.length, '| mentions drinks:', /抹茶|アイスコーヒー/.test(reply));
  if (reply.length < 30) failures.push(`first reply too short (${reply.length} chars) — LLM may not have seen the question`);
  if (!/抹茶|アイスコーヒー/.test(reply)) failures.push('first reply does not mention the asked drinks — question did not reach the LLM');
}

// ---------- 2. reload -> history survives (persistence) ----------
await page.reload({ waitUntil: 'networkidle' });
await page.getByPlaceholder('バリスタにメッセージ…').waitFor({ timeout: 30000 });
await page.getByRole('button', { name: '履歴' }).click();
await page.waitForTimeout(1500);
const sheetHasT1 = t1 ? await page.getByText(t1.title, { exact: false }).count() : 0;
console.log('history sheet shows thread:', sheetHasT1);
if (t1 && sheetHasT1 === 0) failures.push('thread not visible in history sheet after reload');
await page.screenshot({ path: '/tmp/chat-history-sheet.png' });

// ---------- 3. load thread -> messages render + resume WITH context ----------
if (t1) {
  await page.getByText(t1.title, { exact: false }).first().click();
  await page.waitForTimeout(1500);
  const rendered = await page.evaluate(() => document.body.innerText.includes('アイスコーヒー') && document.body.innerText.includes('抹茶ラテ'));
  console.log('loaded messages render:', rendered);
  if (!rendered) failures.push('loaded thread messages did not render');
  await page.screenshot({ path: '/tmp/chat-history-loaded.png' });

  // resume: follow-up continues the SAME thread and the model sees the history
  await ask(RESUME_Q);
  const list2 = await getThreads();
  const sameThread = list2.threads.some((t) => t.id === t1.id);
  const t1full = await getThread(t1.id);
  const resumeReply = lastAssistant(t1full)?.content ?? '';
  console.log('resume: same thread kept:', sameThread, '| messages in t1:', t1full.messages?.length);
  console.log('resume reply references a drink:', /アイスコーヒー|抹茶ラテ/.test(resumeReply));
  if (!sameThread) failures.push('resume lost the thread');
  if ((t1full.messages?.length ?? 0) < 4) failures.push(`resume did not append to thread (messages=${t1full.messages?.length})`);
  if (!/アイスコーヒー|抹茶ラテ/.test(resumeReply)) failures.push('resume reply lacks context (no drink reference) — history did not reach the LLM');
  await page.screenshot({ path: '/tmp/chat-history-resumed.png' });
}

// ---------- 4. new conversation -> separate thread, barista answers there too ----------
await page.getByRole('button', { name: '新しい会話' }).click();
await page.waitForTimeout(500);
const cleared = await page.evaluate(() => document.body.innerText.includes('バリスタに話しかけてみましょう'));
console.log('new conversation resets view:', cleared);
if (!cleared) failures.push('new conversation did not reset the view');
// read-only question: an order here would park the stream on the approval gate
await ask(NEW_Q);
const list3 = await getThreads();
console.log('threads after new conversation:', list3.threads.length);
if (list3.threads.length < 2) failures.push(`new conversation did not create a separate thread (${list3.threads.length})`);
const other = list3.threads.find((t) => t1 && t.id !== t1.id);
if (other) {
  const full = await getThread(other.id);
  const reply = lastAssistant(full)?.content ?? '';
  const hasCalorie = /kcal|カロリー/.test(reply) && /抹茶/.test(reply);
  console.log('new thread reply mentions 抹茶+calorie:', hasCalorie, '| length:', reply.length);
  if (!hasCalorie) failures.push('new-thread reply does not answer the calorie question — question did not reach the LLM');
}

// ---------- 5. delete with confirm ----------
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
await page.screenshot({ path: '/tmp/chat-history-after-delete.png' });
await page.keyboard.press('Escape');

// ---------- 6. leak check: single-owner list + optional foreign-thread 404 ----------
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

// ---------- 7. mobile 375 ----------
const m = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  viewport: { width: 375, height: 812 },
});
const mp = await m.newPage();
track(mp);
await mp.goto(APP, { waitUntil: 'networkidle', timeout: 60000 });
await mp.waitForTimeout(2000);
const mobileOverflow = await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
await mp.getByRole('button', { name: '履歴' }).click();
await mp.waitForTimeout(1000);
const sheetVisible = await mp.getByText('会話の履歴').count();
const mobileOverflowAfter = await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
console.log('mobile: overflow', mobileOverflow, '| sheet opens', sheetVisible, '| overflow after sheet', mobileOverflowAfter);
if (mobileOverflow || mobileOverflowAfter) failures.push('mobile horizontal overflow with history UI');
if (sheetVisible === 0) failures.push('mobile: history sheet did not open');
await mp.screenshot({ path: '/tmp/chat-history-mobile.png' });
await m.close();

await browser.close();
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures.push(`${consoleErrors.length} console errors`);
if (failures.length) {
  console.error('VERIFICATION FAILED:', failures.join(' / '));
  process.exit(1);
}
console.log('VERIFICATION PASSED');
console.log('screenshots: /tmp/chat-history-{first-reply,sheet,loaded,resumed,after-delete,mobile}.png');
