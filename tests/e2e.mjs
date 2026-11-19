// Playwright で実際に操作して確認する（スマホサイズ 390×844）
// 使い方: npm install && npm test   （BASE_URL=https://... で公開URLに対しても実行できます）
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
mkdirSync(shots, { recursive: true });
for (const f of readdirSync(shots)) rmSync(path.join(shots, f));
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
  try { return await chromium.launch(); } catch (e) { console.log('(Edge で実行します)'); return chromium.launch({ channel: 'msedge' }); }
}
const browser = await launch();
const errors = [];
async function newContext(opts = {}) {
  return browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: opts.dark ? 'dark' : 'light', acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write']
  });
}
async function open(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(BASE);
  await page.waitForSelector('[data-act="begin"]');
  return page;
}
const wait = (page, ms = 230) => page.waitForTimeout(ms);
async function tap(page, sel) { await page.locator(sel).first().click(); await wait(page); }
const state = (page) => page.evaluate(() => { const s = window.__ashita.state; return { screen: s.screen, cur: s.cur, cw: s.cw && s.cw.step, wants: s.answers.wants || [] }; });
async function shot(page, name, full) {
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.waitForTimeout(250);
  if (full) await page.evaluate(() => document.body.classList.add('shot-mode'));
  await page.screenshot({ path: path.join(shots, name), fullPage: !!full });
  if (full) await page.evaluate(() => document.body.classList.remove('shot-mode'));
}

// 画面に出ている質問を読み取って、answers のとおりに答える（分岐の順番に依存しない）
async function answerAll(page, A, { customs = [], shotsAt = {} } = {}) {
  const visited = [];
  await tap(page, '[data-act="begin"]');
  for (let guard = 0; guard < 40; guard++) {
    const st = await state(page);
    if (st.screen === 'result') break;
    const q = st.cur;
    if (!visited.includes(q)) visited.push(q);
    if (shotsAt[q]) await shot(page, shotsAt[q]);
    if (q === 'wants') {
      for (const w of A.wants) await tap(page, `[data-multi="wants"][data-v="${w}"]`);
      if (shotsAt.wantsSelected) await shot(page, shotsAt.wantsSelected);
      await tap(page, '[data-act="next"]');
    } else if (q === 'custom') {
      for (const c of customs) {
        await tap(page, '[data-act="cadd"]');
        await page.fill('#cw-name', c.name); await wait(page, 80);
        if (shotsAt.customName && c === customs[0]) await shot(page, shotsAt.customName);
        await tap(page, '[data-act="cw-name-next"]');
        await tap(page, `[data-cw="dur"][data-v="${c.dur}"]`);
        await tap(page, `[data-cw="when"][data-v="${c.when}"]`);
        await tap(page, `[data-cw="fixed"][data-v="${c.start != null ? 'yes' : 'no'}"]`);
        if (c.start != null) {
          if (shotsAt.customTime) await shot(page, shotsAt.customTime);
          await tap(page, `[data-cwstart="${c.start}"]`);
        }
        await tap(page, `[data-cw="place"][data-v="${c.place}"]`);
      }
      if (shotsAt.customList) await shot(page, shotsAt.customList);
      await tap(page, '[data-act="cnext"]');
    } else if (q === 'hobby_text') {
      await page.fill('#text-hobby_text', A.hobby_text); await tap(page, '[data-act="text-next"]');
    } else {
      if (A[q] == null) throw new Error('答えが用意されていない質問: ' + q);
      await tap(page, `[data-key="${q}"][data-v="${A[q]}"]`);
    }
  }
  await page.waitForSelector('#timeline');
  return visited;
}
const timeline = (page) => page.$$eval('#timeline > li', (lis) => lis.map((li) => ({
  time: li.querySelector('.tl-time') ? li.querySelector('.tl-time').firstChild.textContent.trim() : '',
  end: li.querySelector('.tl-time small') ? li.querySelector('.tl-time small').textContent.replace('〜', '').trim() : '',
  title: (li.querySelector('.tl-title > span') || {}).textContent || '',
  desc: (li.querySelector('.tl-desc') || {}).textContent || '',
  meta: (li.querySelector('.tl-meta') || {}).textContent || '',
  cls: li.className
})));
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return (h < 5 ? h + 24 : h) * 60 + m; };

// ---------- 1. 仕事の日 ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  const A1 = { day: 'work', wake: 7, depart: 8, ret: 19, afterwork: 'little', wants: ['exercise', 'study'], ex_type: 'gym', ex_len: 60, st_what: 'cert', st_len: 60, energy: 'normal', bed: 23 };
  const visited = await answerAll(page, A1, { shotsAt: { afterwork: 'q_branch_afterwork.png', ex_len: 'q_branch_gym_len.png' } });
  check('1 仕事の日：追加の質問（出発・帰宅・帰宅後の元気・運動の種類・ジムの時間・勉強の内容・勉強の時間）が出る',
    ['depart', 'ret', 'afterwork', 'ex_type', 'ex_len', 'st_what', 'st_len'].every((q) => visited.includes(q)), visited.join('→'));
  check('1 仕事の日：関係ない質問（休日の過ごし方・半日・予算）は出ない', !['offstyle', 'half', 'budget'].some((q) => visited.includes(q)));
  await shot(page, 'result_1_work.png', true);
  const t = await timeline(page);
  const gym = t.find((x) => x.title.includes('運動（ジム）'));
  const st = t.find((x) => x.title.includes('勉強'));
  check('1 仕事の日：ジムが1時間で入る', gym && toMin(gym.end) - toMin(gym.time) === 60, gym ? `${gym.time}〜${gym.end} ${gym.desc}` : 'なし');
  check('1 仕事の日：資格の勉強が1時間で入る', st && toMin(st.end) - toMin(st.time) === 60, st ? `${st.time}〜${st.end} ${st.desc}` : 'なし');
  check('1 仕事の日：起床7:00・出発8:30・帰宅19:00・就寝23:00', t[0].time === '7:00' && t.some((x) => x.title.includes('出発') && x.time === '8:30') && t.some((x) => x.title.includes('帰宅') && x.time === '19:00') && t.at(-1).time === '23:00');
  check('1 仕事の日：朝・夕ごはん、お風呂、寝る準備がある', ['朝ごはん', '夕ごはん', 'お風呂', '寝る準備'].every((k) => t.some((x) => x.title.includes(k))));
  check('7 睡眠：8時間0分で注意なし', (await page.locator('#sleep-card strong').innerText()).includes('8時間0分') && await page.locator('.sleep.short').count() === 0);

  // 6. 別の案にする／入れ替える
  const before = (await timeline(page)).map((x) => x.desc).join('|');
  await tap(page, '[data-act="again"]');
  const after = (await timeline(page)).map((x) => x.desc).join('|');
  check('6 「別の案にする」で内容が変わる', before !== after);
  await shot(page, 'result_1_work_again.png', true);
  const idx = await page.$$eval('#timeline > li', (lis) => lis.findIndex((li) => li.className.includes('kind-activity') && !li.textContent.includes('早く寝る')));
  const li = page.locator('#timeline > li').nth(idx);
  const d0 = await li.locator('.tl-desc').innerText();
  await li.locator('.tl-hit').click(); await wait(page);
  await shot(page, 'result_tools_open.png');
  await page.locator('#timeline > li').nth(idx).locator('[data-tool="swap"]').click(); await wait(page);
  const d1 = await page.locator('#timeline > li').nth(idx).locator('.tl-desc').innerText();
  check('6 「入れ替える」で1つだけ内容が変わる', d0 !== d1, `${d0} → ${d1}`);
  // 時間をずらす（＋30分か－30分のどちらかで動く予定を探す）／削除
  let moved = '';
  const count = await page.locator('#timeline > li.kind-activity, #timeline > li.kind-meal').count();
  for (let k = 0; k < count && !moved; k++) {
    const item = page.locator('#timeline > li.kind-activity, #timeline > li.kind-meal').nth(k);
    if ((await item.locator('.tl-hit').getAttribute('aria-expanded')) !== 'true') { await item.locator('.tl-hit').click(); await wait(page); }
    for (const dir of ['plus', 'minus']) {
      const open = page.locator('#timeline li.open');
      if (!(await open.count())) break;
      const firstLine = (s) => s.trim().split(/\s+/)[0];
      const before = firstLine(await open.locator('.tl-time').innerText());
      await open.locator(`[data-tool="${dir}"]`).click(); await wait(page);
      const after = firstLine(await page.locator('#timeline li.open .tl-time').innerText().catch(() => ''));
      if (after && after !== before) { moved = `${before} → ${after}（${dir === 'plus' ? '＋' : '－'}30分）`; break; }
    }
  }
  check('調整：「±30分」で時間がずれる', !!moved, moved);
  const n0 = await page.locator('#timeline > li.kind-activity').count();
  const firstAct = page.locator('#timeline > li.kind-activity').first();
  if ((await firstAct.locator('.tl-hit').getAttribute('aria-expanded')) !== 'true') { await firstAct.locator('.tl-hit').click(); await wait(page); }
  await page.locator('#timeline li.open [data-tool="del"]').click(); await wait(page);
  const n1 = await page.locator('#timeline > li.kind-activity').count();
  check('調整：「削除」で予定が消える', n1 === n0 - 1, `${n0}→${n1}`);
  await page.locator('#toast .toast-act').click(); await wait(page);
  check('調整：「元に戻す」で戻る', await page.locator('#timeline > li.kind-activity').count() === n0);

  // 持ち出し
  await tap(page, '[data-act="copy"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('持ち出し：テキストでコピー', clip.startsWith('【明日の予定】') && clip.includes('就寝'));
  writeFileSync(path.join(shots, 'sample_copy.txt'), clip);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="image"]')]);
  await dl.saveAs(path.join(shots, 'sample_export.png'));
  check('持ち出し：画像（PNG）', readFileSync(path.join(shots, 'sample_export.png')).subarray(0, 4).toString('hex') === '89504e47');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="ics"]')]);
  await dl2.saveAs(path.join(shots, 'sample_export.ics'));
  const ics = readFileSync(path.join(shots, 'sample_export.ics'), 'utf8');
  check('持ち出し：.ics（形式・75バイト折り返し）', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('BEGIN:VEVENT') && ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  await page.reload(); await page.waitForSelector('[data-act="reuse"]');
  await tap(page, '[data-act="reuse"]');
  check('前回と同じ条件で始める', (await timeline(page)).some((x) => x.title.includes('ジム')));
  await ctx.close();
}

// ---------- 2. 休みの日 ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  const A2 = { day: 'off', wake: 9, offstyle: 'packed', wants: ['outing', 'gourmet'], out_where: 'indoor', out_with: 'friends', food_kind: 'ramen', food_when: 'lunch', budget: 3000, energy: 'genki', bed: 24 };
  const visited = await answerAll(page, A2, { shotsAt: { offstyle: 'q_branch_offstyle.png', budget: 'q_branch_budget.png' } });
  check('2 休みの日：過ごし方・行き先・だれと・食べ物・いつ・予算の質問が出る', ['offstyle', 'out_where', 'out_with', 'food_kind', 'food_when', 'budget'].every((q) => visited.includes(q)), visited.join('→'));
  await shot(page, 'result_2_holiday.png', true);
  const t = await timeline(page);
  const ramen = t.find((x) => x.title.includes('美味しいもの（昼ごはん）'));
  check('2 休みの日：ラーメンが昼ごはんに入る', !!ramen && toMin(ramen.time) >= 660 && toMin(ramen.time) <= 780, ramen ? `${ramen.time} ${ramen.desc}` : 'なし');
  const outs = t.filter((x) => x.title.startsWith('おでかけ'));
  check('2 休みの日：おでかけは屋内・友達と', outs.length > 0 && outs.every((o) => o.desc.startsWith('友達・恋人と') && o.meta.includes('室内')), outs.map((o) => o.desc).join(' / '));
  const costs = t.map((x) => { const m = x.meta.match(/約([\d,]+)円/); return m ? Number(m[1].replace(/,/g, '')) : 0; });
  check('2 休みの日：費用はすべて3,000円以内', Math.max(...costs) <= 3000, `最大${Math.max(...costs)}円`);
  check('2 休みの日：しっかり詰めたい→予定4つ以上', t.filter((x) => x.cls.includes('kind-activity')).length >= 4, `${t.filter((x) => x.cls.includes('kind-activity')).length}件`);
  await ctx.close();
}

// ---------- 3. その他あり ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  const A3 = { day: 'off', wake: 9, offstyle: 'moderate', wants: ['custom', 'relax'], energy: 'normal', bed: 23 };
  const customs = [
    { name: '美容院', dur: 60, when: 'any', start: 840, place: 'outdoor' },
    { name: '洗車', dur: 30, when: 'any', place: 'outdoor' }
  ];
  const visited = await answerAll(page, A3, { customs, shotsAt: { wantsSelected: 'q_wants_custom.png', customName: 'q_custom_input.png', customTime: 'q_custom_time.png', customList: 'q_custom_list.png' } });
  check('3 その他：「その他」の入力画面が出る', visited.includes('custom'), visited.join('→'));
  await shot(page, 'result_3_custom.png', true);
  const t = await timeline(page);
  const biyo = t.find((x) => x.title.includes('美容院'));
  const wash = t.find((x) => x.title.includes('洗車'));
  check('3 その他：14:00に美容院（その他マーク付き）', biyo && biyo.time === '14:00' && biyo.end === '15:00' && biyo.cls.includes('is-custom'), biyo ? `${biyo.time}〜${biyo.end}` : 'なし');
  check('3 その他：洗車（外）が美容院（外）と続けて入る', wash && (wash.time === '15:00' || wash.end === '14:00'), wash ? `${wash.time}〜${wash.end}` : 'なし');
  // 20文字の上限
  await page.goto(BASE); await page.waitForSelector('[data-act="begin"]');
  await tap(page, '[data-act="begin"]');
  for (const [k, v] of [['day', 'off'], ['wake', 9], ['offstyle', 'moderate']]) await tap(page, `[data-key="${k}"][data-v="${v}"]`);
  const presetCount = await page.locator('.chip-preset').count();
  check('3 その他：よく使う「その他」が次から選択肢に出る', presetCount >= 1, `${presetCount}件（${(await page.locator('.chip-preset').allInnerTexts()).join('、')}）`);
  await tap(page, '[data-multi="wants"][data-v="custom"]'); await tap(page, '[data-act="next"]'); await tap(page, '[data-act="cadd"]');
  await page.locator('#cw-name').pressSequentially('あいうえおかきくけこさしすせそたちつてとなにぬねの');
  const len = await page.$eval('#cw-name', (el) => Array.from(el.value).length);
  check('3 その他：入力は20文字まで', len === 20, `${len}文字`);
  await ctx.close();
}

// ---------- 4. 疲れている日 ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  const A4 = { day: 'work', wake: 7, depart: 8, ret: 18, afterwork: 'none', wants: ['exercise', 'hobby', 'relax'], ex_type: 'any', hobby_kind: 'game', energy: 'tired', bed: 23 };
  await answerAll(page, A4);
  await shot(page, 'result_4_tired.png', true);
  const t = await timeline(page);
  const evening = t.filter((x) => x.cls.includes('kind-activity') && toMin(x.time) >= 18 * 60 && x.meta);
  check('4 疲れている日：帰宅後の予定は体力「低」だけ', evening.every((x) => x.meta.includes('体力：低')), evening.map((x) => `${x.time} ${x.desc}`).join(' / ') || '夜の予定なし');
  check('4 疲れている日：休憩（ひと休み・のんびりタイム）が入る', t.some((x) => x.title.includes('ひと休み') || x.title.includes('のんびりタイム')));
  await ctx.close();
}

// ---------- 5. 分岐の確認（戻って選び直す） ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  await tap(page, '[data-act="begin"]');
  await tap(page, '[data-key="day"][data-v="work"]');
  await tap(page, '[data-key="wake"][data-v="7"]');
  check('5 分岐：仕事の日 → 「何時に家を出る？」が出る', (await state(page)).cur === 'depart');
  await tap(page, '[data-act="back"]'); await tap(page, '[data-act="back"]');
  check('5 分岐：「戻る」で1問目に戻る', (await state(page)).cur === 'day');
  await tap(page, '[data-key="day"][data-v="off"]');
  check('5 分岐：選んでいた起床時間が残っている', await page.locator('[data-key="wake"][data-v="7"].selected').count() === 1);
  await tap(page, '[data-key="wake"][data-v="7"]');
  check('5 分岐：休みの日に変えると「出発」は消え、「過ごし方のイメージ」が出る', (await state(page)).cur === 'offstyle');
  const prog = await page.locator('.progress-text').innerText();
  check('5 分岐：進み具合は「〇問目・残り約〇問」で表示', /\d+問目・残り約\d+問/.test(prog.replace(/\s/g, '')), prog.replace(/\s+/g, ''));
  await tap(page, '[data-key="offstyle"][data-v="moderate"]');
  await tap(page, '[data-multi="wants"][data-v="exercise"]'); await tap(page, '[data-act="next"]');
  await tap(page, '[data-key="ex_type"][data-v="gym"]');
  check('5 分岐：ジム → 「ジムはどれくらい？」が出る', (await state(page)).cur === 'ex_len');
  await shot(page, 'q_branch_gym_len_2.png');
  await tap(page, '[data-act="back"]');
  await tap(page, '[data-key="ex_type"][data-v="run"]');
  check('5 分岐：ランニングに選び直すと「ジムはどれくらい？」は出ない', (await state(page)).cur === 'energy', (await state(page)).cur);
  await tap(page, '[data-act="back"]'); await tap(page, '[data-act="back"]');
  await tap(page, '[data-multi="wants"][data-v="gourmet"]'); await tap(page, '[data-act="next"]');
  const seq = [];
  for (let i = 0; i < 6; i++) {
    const st = await state(page);
    if (st.cur === 'energy') break;
    seq.push(st.cur);
    const first = page.locator(`[data-key="${st.cur}"]:not([disabled])`).first();
    await first.click(); await wait(page);
  }
  check('5 分岐：あとから「美味しいもの」を足すと、食べ物・いつ・予算の質問が追加される', ['food_kind', 'food_when', 'budget'].every((q) => seq.includes(q)), seq.join('→'));
  await ctx.close();
}

// ---------- 7. 睡眠が7時間未満 ----------
{
  const ctx = await newContext();
  const page = await open(ctx);
  await answerAll(page, { day: 'school', wake: 6, depart: 7, ret: 17, afterwork: 'plenty', wants: ['study'], st_what: 'lang', st_len: 30, energy: 'normal', bed: 24 });
  const txt = await page.locator('#sleep-card').innerText();
  check('7 睡眠6時間で注意が出る', await page.locator('.sleep.short').count() === 1 && txt.includes('少し睡眠が短めです'), txt.replace(/\s+/g, ' '));
  await shot(page, 'result_7_short_sleep.png');
  await ctx.close();
}

// ---------- ダークモード／横スクロール ----------
{
  const ctx = await newContext({ dark: true });
  const page = await open(ctx);
  await answerAll(page, { day: 'half', wake: 8, half: 'pm', wants: ['shopping', 'social', 'sleep', 'custom'], shop_what: 'clothes', social_what: 'meal', budget: 5000, energy: 'normal', bed: 23 },
    { customs: [{ name: 'レポートを書く', dur: 120, when: 'night', place: 'indoor' }, { name: '<b>太字</b>テスト', dur: 15, when: 'any', place: 'indoor' }] });
  await shot(page, 'result_dark_half.png', true);
  const html = await page.locator('#timeline').innerHTML();
  check('その他：入力した「<b>」はHTMLとして解釈されず文字のまま表示', (await page.locator('#timeline b').count()) === 0 && html.includes('&lt;b&gt;太字&lt;/b&gt;テスト'));
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('ダークモードで背景が暗くなる', bg === 'rgb(23, 22, 28)', bg);
  check('スマホ幅で横スクロールが出ない', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await ctx.close();
}

check('JavaScriptエラーなし', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
if (server) server.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件OK`);
writeFileSync(path.join(shots, 'test-results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
