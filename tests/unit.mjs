// ブラウザなしで確認するテスト：質問の分岐に矛盾がないか／予定の組み立てルール
// 使い方: node tests/unit.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Flow = require('../flow.js');
const P = require('../planner.js');
const Q = require('../data/questions.json').questions;
const data = require('../data/activities.json');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

// ---------- 分岐の矛盾チェック ----------
const staticErr = Flow.validateStatic(Q);
check('questions.json：id重複・前方参照・存在しない値なし', staticErr.length === 0, staticErr.join(' / '));
const sim = Flow.simulate(Q, 20000, 12345);
check(`分岐を2万通りランダムに回答（途中で戻って選び直すのも含む）：行き止まり・重複・回答の残りなし、全${Q.length}問が出る`, sim.errors.length === 0, sim.errors.slice(0, 3).join(' / ') || `${sim.shown}問が出現`);
const maxLen = (() => {
  // いちばん長くなる組み合わせ（仕事の日＋追加の質問が多い4つ）
  const a = { day: 'work', wake: 7, depart: 8, ret: 19, afterwork: 'little', wants: ['exercise', 'study', 'outing', 'gourmet'] };
  a.ex_type = 'gym';
  return Flow.visible(Q, a).length;
})();
check('いちばん長い組み合わせでも20問以内（2分以内の目安）', maxLen <= 20, `${maxLen}問`);

// 戻って選び直したときの分岐
{
  const a = { day: 'work', wake: 7, depart: 8, ret: 19, afterwork: 'little' };
  a.day = 'off'; Flow.prune(Q, a);
  check('「仕事の日」→「休みの日」に選び直すと、出発・帰宅・帰宅後の元気の回答が消える', !('depart' in a) && !('ret' in a) && !('afterwork' in a));
  check('「休みの日」にすると「過ごし方のイメージ」が出る', Flow.visible(Q, a).some((q) => q.id === 'offstyle'));
  const b = { day: 'work', wake: 6, depart: 6 };
  b.wake = 8; Flow.prune(Q, b);
  check('起床を6時台→8時台に選び直すと、6時台の出発は消える', !('depart' in b));
  const c = { day: 'off', wake: 9, offstyle: 'packed', wants: ['exercise'], ex_type: 'gym', ex_len: 60 };
  c.ex_type = 'run'; Flow.prune(Q, c);
  check('「ジム」→「ランニング」にすると「ジムはどれくらい？」の回答が消える', !('ex_len' in c));
  const d = { day: 'off', wake: 9, offstyle: 'packed', wants: ['outing'], out_where: 'indoor', out_with: 'friends', budget: 3000 };
  d.wants = ['relax']; Flow.prune(Q, d);
  check('「おでかけ」を外すと、行き先・だれと・予算の回答が消える', !('out_where' in d) && !('out_with' in d) && !('budget' in d));
  const e = { day: 'off', wake: 9, offstyle: 'packed', wants: ['social'], social_what: 'home' };
  check('「家で過ごす」だけなら予算の質問は出ない', !Flow.visible(Q, e).some((q) => q.id === 'budget'));
  e.social_what = 'meal';
  check('「友達とごはん」なら予算の質問が出る', Flow.visible(Q, e).some((q) => q.id === 'budget'));
}

// ---------- 予定の組み立て ----------
const view = (plan) => P.displayItems(plan, data);
function noOverlap(plan) {
  const it = plan.items.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  for (let i = 1; i < it.length; i++) if (it[i].start < it[i - 1].end) return false;
  return true;
}
const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 37);

// 1. 仕事の日
{
  const A = { day: 'work', wake: 7, depart: 8, ret: 19, afterwork: 'little', wants: ['exercise', 'study'], ex_type: 'gym', ex_len: 60, st_what: 'cert', st_len: 60, energy: 'normal', bed: 23 };
  let ok = 0, gym = 0, study = 0, overlap = 0;
  for (const s of SEEDS) {
    const plan = P.buildPlan(A, data, s);
    const acts = plan.items.filter((i) => i.kind === 'activity' && i.task !== 'sleep');
    const g = acts.find((i) => i.task === 'exercise'); const st = acts.find((i) => i.task === 'study');
    if (g && g.end - g.start === 60 && data.interests[0].variants.gym.some((p) => p.id === g.p.id)) gym++;
    if (st && st.end - st.start === 60 && st.p.id.startsWith('stc')) study++;
    if (!noOverlap(plan)) overlap++;
    if (g && st) ok++;
  }
  check('仕事の日：「ジム・1時間」が60分のジムとして入る', gym === SEEDS.length, `${gym}/${SEEDS.length}`);
  check('仕事の日：「資格・1時間」が60分の資格の勉強として入る', study === SEEDS.length, `${study}/${SEEDS.length}`);
  check('仕事の日：予定が重ならない', overlap === 0);
  const plan = P.buildPlan(A, data, 7);
  const highEvening = plan.items.filter((i) => i.kind === 'activity' && i.start >= 19.5 * 60 && i.p.energy === 'high');
  check('仕事の日：帰宅後の元気「少しなら」→ 夜に体力「高」の予定は入らない', highEvening.length === 0);
}
// 2. 休みの日
{
  const A = { day: 'off', wake: 9, offstyle: 'packed', wants: ['outing', 'gourmet'], out_where: 'indoor', out_with: 'friends', food_kind: 'ramen', food_when: 'lunch', budget: 3000, energy: 'genki', bed: 24 };
  let ramenLunch = 0, indoor = 0, budget = 0, many = 0;
  for (const s of SEEDS) {
    const plan = P.buildPlan(A, data, s);
    const g = plan.items.find((i) => i.task === 'gourmet');
    if (g && g.replacesMeal === 'lunch' && g.p.id.startsWith('gmr') && g.start >= 660 && g.start <= 780) ramenLunch++;
    const outs = plan.items.filter((i) => i.task === 'outing');
    if (outs.length && outs.every((o) => o.p.place === 'indoor' && o.prefix === '友達・恋人と')) indoor++;
    if (plan.items.filter((i) => i.p).every((i) => i.p.cost <= 3000)) budget++;
    if (plan.items.filter((i) => i.kind === 'activity').length >= 4) many++;
  }
  check('休みの日：ラーメンが昼ごはんの時間に入る', ramenLunch === SEEDS.length, `${ramenLunch}/${SEEDS.length}`);
  check('休みの日：おでかけは屋内・「友達・恋人と」', indoor === SEEDS.length, `${indoor}/${SEEDS.length}`);
  check('休みの日：費用はすべて3,000円以内', budget === SEEDS.length, `${budget}/${SEEDS.length}`);
  check('休みの日：「しっかり詰めたい」で予定が4つ以上', many === SEEDS.length, `${many}/${SEEDS.length}`);
}
// 3. その他あり
{
  const A = { day: 'off', wake: 9, offstyle: 'moderate', wants: ['custom', 'relax'], energy: 'normal', bed: 23,
    custom: [{ name: '美容院', dur: 60, when: 'any', fixed: true, start: 840, place: 'outdoor' }, { name: '洗車', dur: 30, when: 'any', fixed: false, place: 'outdoor' }] };
  let at14 = 0, adjacent = 0;
  for (const s of SEEDS) {
    const plan = P.buildPlan(A, data, s);
    const b = plan.items.find((i) => i.kind === 'custom' && i.c.name === '美容院');
    const w = plan.items.find((i) => i.kind === 'custom' && i.c.name === '洗車');
    if (b && b.start === 840 && b.end === 900) at14++;
    if (b && w && (w.start === b.end || w.end === b.start)) adjacent++;
  }
  check('その他：美容院が14:00〜15:00に入る', at14 === SEEDS.length, `${at14}/${SEEDS.length}`);
  check('その他：洗車（外）が美容院（外）と続けて入る', adjacent === SEEDS.length, `${adjacent}/${SEEDS.length}`);
  const B = Object.assign({}, A, { custom: [{ name: '会議', dur: 60, when: 'any', fixed: true, start: 360, place: 'outdoor' }] });
  const plan = P.buildPlan(B, data, 1);
  check('その他：起きる前の時間指定は「入りきらなかった予定」になる', plan.unplaced.some((u) => u.label === '会議'));
}
// 4. 疲れている日
{
  const A = { day: 'work', wake: 7, depart: 8, ret: 18, afterwork: 'none', wants: ['exercise', 'hobby', 'relax'], ex_type: 'any', hobby_kind: 'game', energy: 'tired', bed: 23 };
  let light = 0, rest = 0;
  for (const s of SEEDS) {
    const plan = P.buildPlan(A, data, s);
    const night = plan.items.filter((i) => i.kind === 'activity' && i.task !== 'sleep' && i.start >= 18.5 * 60);
    if (night.every((i) => i.p.energy === 'low')) light++;
    if (plan.items.some((i) => i.kind === 'rest') || night.length === 0) rest++;
  }
  check('疲れている日：帰宅後の予定は体力「低」だけ', light === SEEDS.length, `${light}/${SEEDS.length}`);
  check('疲れている日：ひと休みが入る', rest === SEEDS.length, `${rest}/${SEEDS.length}`);
}
// ネットで買い物
{
  const A = { day: 'off', wake: 8, offstyle: 'moderate', wants: ['shopping'], shop_what: 'online', energy: 'normal', bed: 23 };
  const plan = P.buildPlan(A, data, 3);
  const s = plan.items.find((i) => i.task === 'shopping');
  check('買い物「ネットで済ませたい」→ 家の中で15分', s && s.end - s.start === 15 && s.p.place === 'indoor');
}
// 調整
{
  const A = { day: 'off', wake: 8, offstyle: 'moderate', wants: ['chores', 'hobby'], hobby_kind: 'music', energy: 'normal', bed: 23 };
  const plan = P.buildPlan(A, data, 5);
  const act = plan.items.find((i) => i.task === 'chores');
  const before = act.p.id;
  const sw = P.swapItem(plan, data, act);
  check('入れ替え：別のパターンになる', sw.ok && act.p.id !== before);
  const s0 = act.start;
  const r1 = P.shiftItem(plan, act, 30);
  check('時間をずらす：+30分（空いていれば動く／重なれば理由つきで止まる）', r1.ok ? act.start === s0 + 30 : !!r1.reason, r1.ok ? '動いた' : r1.reason);
  const n = plan.items.length;
  P.deleteItem(plan, act);
  check('削除：予定が1つ減る', plan.items.length === n - 1);
  check('調整後も予定が重ならない', noOverlap(plan));
}
// 睡眠
check('睡眠：0時台に寝て6時台に起きる → 6時間（7時間未満）', P.sleepMinutes({ wake: 6, bed: 24 }) === 360);

// ランダムな回答でも壊れない（重なり・例外なし）
{
  let bad = 0;
  for (let r = 0; r < 300; r++) {
    const a = {};
    let s = r * 99991 + 7;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let g = 0; g < 40; g++) {
      const idx = Flow.firstUnanswered(Q, a);
      if (idx === -1) break;
      const q = Flow.visible(Q, a)[idx];
      if (q.type === 'single') { const ok = q.options.filter((o) => !Flow.optionDisabled(o, a)); a[q.id] = ok[Math.floor(rnd() * ok.length)].v; }
      else if (q.type === 'multi') a[q.id] = q.options.map((o) => o.v).sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 4));
      else if (q.type === 'custom') a[q.id] = [{ name: 'テスト<b>', dur: [15, 30, 60, 120, 240][Math.floor(rnd() * 5)], when: 'any', fixed: rnd() < 0.5, start: 600 + 30 * Math.floor(rnd() * 20), place: rnd() < 0.5 ? 'outdoor' : 'indoor' }];
      else a[q.id] = 'テスト';
    }
    try {
      const plan = P.buildPlan(a, data, r);
      view(plan);
      if (!noOverlap(plan)) bad++;
    } catch (e) { bad++; console.log(e, JSON.stringify(a)); }
  }
  check('ランダムな回答300通りで、例外・予定の重なりなし', bad === 0, `${bad}件NG`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件OK`);
process.exit(failed.length ? 1 : 0);
