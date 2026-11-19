// Playwright で実際に操作して確認する（スマホサイズ 390×844）
// 使い方: npm install && npx playwright install chromium && npm test
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
mkdirSync(shots, { recursive: true });
const PORT = 8766;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}/`;

let server = null;
if (!process.env.BASE_URL) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function launch() {
  try { return await chromium.launch(); } catch (e) {
    console.log('(bundled Chromium が無いので Edge で実行します)');
    return chromium.launch({ channel: 'msedge' });
  }
}
const browser = await launch();
const errors = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: opts.dark ? 'dark' : 'light', acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('[data-act="begin"]');
  return page;
}

async function fullShot(page, name) {
  await page.evaluate(() => document.body.classList.add('shot-mode'));
  await page.screenshot({ path: path.join(shots, name), fullPage: true });
  await page.evaluate(() => document.body.classList.remove('shot-mode'));
}
async function tap(page, sel) { await page.locator(sel).first().click(); await page.waitForTimeout(260); }
async function answer(page, a, { shotAt } = {}) {
  await tap(page, '[data-act="begin"]');
  const steps = [['day', a.day], ['wake', a.wake]];
  if (a.depart != null) steps.push(['depart', a.depart], ['ret', a.ret]);
  if (a.half) steps.push(['half', a.half]);
  for (const [k, v] of steps) await tap(page, `[data-key="${k}"][data-v="${v}"]`);
  for (const w of a.wants) await tap(page, `[data-want="${w}"]`);
  if (shotAt === 'wants') await page.screenshot({ path: path.join(shots, 'q_wants.png') });
  await tap(page, '[data-act="next"]');
  await tap(page, `[data-key="energy"][data-v="${a.energy}"]`);
  if (a.budget != null) await tap(page, `[data-key="budget"][data-v="${a.budget}"]`);
  await tap(page, `[data-key="bed"][data-v="${a.bed}"]`);
  await page.waitForSelector('#timeline');
}
const timelineText = (page) => page.$$eval('#timeline > li', (lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ').replace('↻ 入れ替える', '').trim()));
const activityTitles = (page) => page.$$eval('#timeline > li.kind-activity .tl-title > span:first-child', (els) => els.map((e) => e.textContent.trim()));

// ---------- 1. 仕事の日 ----------
{
  const page = await newPage();
  // 質問画面のスクショ（1問目）と進み具合
  await tap(page, '[data-act="begin"]');
  await page.screenshot({ path: path.join(shots, 'q1_day.png') });
  check('Q1の進み具合が「1 / 7」', (await page.locator('.progress-text').innerText()).replace(/\s/g, '') === '1/7');
  await tap(page, '[data-key="day"][data-v="work"]');
  await tap(page, '[data-key="wake"][data-v="7"]');
  const disabled = await page.locator('[data-key="depart"][data-v="6"]').isDisabled();
  check('起床7時台のとき、出発6時台は選べない', disabled);
  check('3問目で「3 / 7」と表示', (await page.locator('.progress-text').innerText()).replace(/\s/g, '') === '3/7');
  await tap(page, '[data-act="back"]');
  check('「戻る」で前の質問（起床）に戻る', (await page.locator('#qtitle').innerText()) === '何時に起きる？');
  check('戻ったとき前の選択が残っている', await page.locator('[data-key="wake"][data-v="7"].selected').count() === 1);
  await tap(page, '[data-act="back"]'); await tap(page, '[data-act="back"]');

  const A1 = { day: 'work', wake: 7, depart: 8, ret: 19, wants: ['exercise', 'study'], energy: 'normal', bed: 23 };
  await answer(page, A1, { shotAt: 'wants' });
  await fullShot(page, 'result_1_work.png');
  const t = await timelineText(page);
  const acts = await activityTitles(page);
  check('仕事の日：起床7:00・出発8:30・帰宅19:30・就寝23:00', t[0].startsWith('7:00') && t.some((x) => x.includes('出発') && x.startsWith('8:30')) && t.some((x) => x.startsWith('19:30') && x.includes('帰宅')) && t.at(-1).startsWith('23:00'), t.join(' | ').slice(0, 300));
  check('仕事の日：運動と勉強が入っている', acts.some((x) => x.includes('運動')) && acts.some((x) => x.includes('勉強')), acts.join(', '));
  check('仕事の日：朝・夕ごはん、お風呂、寝る準備がある', ['朝ごはん', '夕ごはん', 'お風呂', '寝る準備'].every((k) => t.some((x) => x.includes(k))));
  const sleep1 = await page.locator('#sleep-card strong').innerText();
  check('仕事の日：睡眠「8時間0分」で注意なし', sleep1.includes('8時間0分') && await page.locator('.sleep.short').count() === 0, sleep1);

  // 4. 別の案にする
  const before = await timelineText(page);
  await tap(page, '[data-act="again"]');
  const after = await timelineText(page);
  const changed = before.join('|') !== after.join('|');
  check('「別の案にする」で内容が変わる', changed, `変わった行: ${after.filter((x) => !before.includes(x)).length}行`);
  await fullShot(page, 'result_1_work_again.png');

  // 個別の入れ替え
  const li = page.locator('#timeline > li.kind-activity').first();
  const beforeOne = await li.innerText();
  await li.locator('.swap').click(); await page.waitForTimeout(200);
  const afterOne = await page.locator('#timeline > li.kind-activity').first().innerText();
  check('「入れ替える」で1つだけ変わる', beforeOne !== afterOne, `${beforeOne.split('\n')[3] || ''} → ${afterOne.split('\n')[3] || ''}`);

  // 持ち出し：テキスト
  await tap(page, '[data-act="copy"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('テキストでコピーできる', clip.startsWith('【明日の予定】') && clip.includes('就寝') && clip.includes('睡眠'), clip.split('\n').slice(0, 3).join(' / '));
  writeFileSync(path.join(shots, 'sample_copy.txt'), clip);
  // 画像
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="image"]')]);
  const imgPath = path.join(shots, 'sample_export.png');
  await dl.saveAs(imgPath);
  const sig = readFileSync(imgPath).subarray(0, 8).toString('hex');
  check('画像（PNG）で保存できる', sig === '89504e470d0a1a0a', dl.suggestedFilename());
  // ics
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="ics"]')]);
  const icsPath = path.join(shots, 'sample_export.ics');
  await dl2.saveAs(icsPath);
  const ics = readFileSync(icsPath, 'utf8');
  const lines = ics.split('\r\n');
  const tooLong = lines.filter((l) => Buffer.byteLength(l, 'utf8') > 75).length;
  check('.ics で書き出せる（形式チェック）', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('BEGIN:VEVENT') && ics.trim().endsWith('END:VCALENDAR') && tooLong === 0, `${(ics.match(/BEGIN:VEVENT/g) || []).length}件の予定 / 75バイト超の行 ${tooLong}`);

  // 前回と同じ条件で始める
  await page.reload();
  await page.waitForSelector('[data-act="reuse"]');
  check('次回は「前回と同じ条件で始める」が出る', true, await page.locator('.last-summary').innerText());
  await tap(page, '[data-act="reuse"]');
  check('前回と同じ条件で結果が出る', (await activityTitles(page)).some((x) => x.includes('運動')));
  await page.context().close();
}

// ---------- 2. 休みの日 ----------
{
  const page = await newPage();
  const A2 = { day: 'off', wake: 9, wants: ['outing', 'gourmet'], energy: 'genki', budget: 3000, bed: 24 };
  await answer(page, A2);
  await fullShot(page, 'result_2_holiday.png');
  const acts = await activityTitles(page);
  const costs = await page.$$eval('#timeline > li.kind-activity .tl-meta', (els) => els.map((e) => e.textContent));
  const maxCost = Math.max(0, ...costs.map((c) => { const m = c.match(/約([\d,]+)円/); return m ? Number(m[1].replace(/,/g, '')) : 0; }));
  check('休みの日：おでかけと美味しいものが入っている', acts.some((x) => x.includes('おでかけ')) && acts.some((x) => x.includes('美味しいもの')), acts.join(', '));
  check('休みの日：元気いっぱいなので予定が3つ以上', acts.length >= 3, `${acts.length}件`);
  check('休みの日：費用はすべて3,000円以内', maxCost <= 3000, `最大 ${maxCost}円`);
  check('休みの日：睡眠9時間0分', (await page.locator('#sleep-card strong').innerText()).includes('9時間0分'));
  await page.context().close();
}

// ---------- 3. 疲れ気味の休日 ----------
{
  const page = await newPage();
  const A3 = { day: 'off', wake: 10, wants: ['relax', 'chores'], energy: 'tired', bed: 22 };
  await answer(page, A3);
  await fullShot(page, 'result_3_tired.png');
  const t = await timelineText(page);
  const acts = await activityTitles(page);
  const energies = await page.$$eval('#timeline > li.kind-activity .tl-meta', (els) => els.map((e) => e.textContent));
  check('疲れ気味：のんびりと家事が入っている', acts.some((x) => x.includes('のんびり')) && acts.some((x) => x.includes('家事')), acts.join(', '));
  check('疲れ気味：体力「低」の予定だけ', energies.every((e) => e.includes('体力：低')), energies.join(' / '));
  check('疲れ気味：休憩（ひと休み／のんびりタイム）が入っている', t.filter((x) => x.includes('ひと休み') || x.includes('のんびりタイム')).length >= 2);
  check('疲れ気味：10時起床なのでブランチ', t.some((x) => x.includes('ブランチ')));
  await page.context().close();
}

// ---------- 5. 睡眠が7時間未満 ----------
{
  const page = await newPage();
  const A5 = { day: 'school', wake: 6, depart: 7, ret: 17, wants: ['study', 'hobby'], energy: 'normal', bed: 24 };
  await answer(page, A5);
  const warn = await page.locator('.sleep.short').count();
  const txt = await page.locator('#sleep-card').innerText();
  check('睡眠6時間（0時就寝・6時起床）で注意が出る', warn === 1 && txt.includes('少し睡眠が短めです'), txt.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(shots, 'result_5_short_sleep.png') });
  await page.context().close();
}

// ---------- ダークモード ----------
{
  const page = await newPage({ dark: true });
  await answer(page, { day: 'half', wake: 8, half: 'pm', wants: ['shopping', 'social', 'sleep'], energy: 'normal', bed: 23 });
  await fullShot(page, 'result_dark_half.png');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('ダークモードで背景が暗くなる', bg === 'rgb(23, 22, 28)', bg);
  await page.context().close();
}

// ---------- 文字入力欄が無いこと / 横スクロールなし ----------
{
  const page = await newPage();
  await answer(page, { day: 'work', wake: 8, depart: 9, ret: 20, wants: ['exercise', 'study', 'hobby', 'sleep'], energy: 'genki', bed: 22 });
  const inputs = await page.locator('input, textarea, select, [contenteditable="true"]').count();
  check('文字の入力欄がない', inputs === 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('スマホ幅で横スクロールが出ない', !overflow);
  await page.context().close();
}

check('JavaScriptエラーなし', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
if (server) server.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件OK`);
writeFileSync(path.join(shots, 'test-results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
