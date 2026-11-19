/*
 * あしたプランナー：回答から明日のタイムラインを作るロジック（AI・外部APIなし）
 * ブラウザでは window.Planner、Node では module.exports で使えます。
 * 時刻はすべて「明日の0:00からの分」で扱います（25:00 = 翌日1:00）。
 */
(function (root) {
  'use strict';

  // ---------- 小さな道具 ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ceil10 = (m) => Math.ceil(m / 10) * 10;
  const floor10 = (m) => Math.floor(m / 10) * 10;
  function fmt(m) {
    const h = Math.floor(m / 60) % 24;
    const mm = String(m % 60).padStart(2, '0');
    return h + ':' + mm;
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // 時間帯：morning 〜11時 / noon 11〜14時 / afternoon 14〜17時 / evening 17〜19時半 / night 19時半〜
  function slotOf(m) {
    if (m < 660) return 'morning';
    if (m < 840) return 'noon';
    if (m < 1020) return 'afternoon';
    if (m < 1170) return 'evening';
    return 'night';
  }
  const SLOT_STARTS = [360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1170, 1200, 1260, 1320];

  // ---------- 回答 → 決まっている時刻 ----------
  function timesFromAnswers(A) {
    const W = A.wake * 60;                 // 「7時台」→ 7:00 に起きる
    const B = A.bed * 60;                  // 「23時台」→ 23:00 に寝る（0時台=24、1時以降=25）
    const t = { W, B };
    if (A.day === 'work' || A.day === 'school') {
      // 「8時台」→ 8:30 に出発。起きてから最低45分はとる
      t.D = Math.max(A.depart * 60 + 30, W + 45);
      t.R = A.ret * 60 + 30;               // 「19時台」→ 19:30 に帰宅（20時以降=20:30）
    }
    return t;
  }

  function sleepMinutes(A) {
    // 今夜もQ7の時間に寝て、Q2の時間に起きる想定
    return A.wake * 60 + 24 * 60 - A.bed * 60;
  }

  // ---------- 素材の絞り込み ----------
  const ENERGY_WEIGHT = {
    tired: { low: 1.2, mid: 0.25, high: 0 },
    normal: { low: 1, mid: 1, high: 0.6 },
    genki: { low: 0.6, mid: 1, high: 1.3 }
  };
  function energyW(A, p) { return ENERGY_WEIGHT[A.energy || 'normal'][p.energy] || 0; }
  function budgetOk(A, p) { return A.budget == null || p.cost <= A.budget; }

  function interestById(data, id) { return data.interests.find((i) => i.id === id); }

  function eligiblePatterns(A, data, interestId, used, only) {
    const it = interestById(data, interestId);
    if (!it) return [];
    const base = it.patterns.filter((p) => !used.has(p.id) && (!only || only(p)));
    let list = base.filter((p) => energyW(A, p) > 0 && budgetOk(A, p));
    if (A.energy === 'tired') list = list.filter((p) => p.min <= 120);
    if (!list.length) {
      // 予算や体力で全部はじかれたら、いちばん安くて楽なものを候補に戻す
      const rest = base.slice();
      rest.sort((a, b) => a.cost - b.cost || (a.energy === 'low' ? -1 : 1));
      list = rest.slice(0, 3);
    }
    return list;
  }

  // ---------- 空き時間 ----------
  function freeIntervals(items, from, to) {
    const sorted = items.filter((i) => i.end > i.start).slice().sort((a, b) => a.start - b.start);
    const out = [];
    let cur = from;
    for (const it of sorted) {
      if (it.start > cur) out.push({ start: cur, end: Math.min(it.start, to) });
      cur = Math.max(cur, it.end);
    }
    if (cur < to) out.push({ start: cur, end: to });
    return out.filter((iv) => iv.end - iv.start > 0);
  }

  // 動かせる予定（食事・お風呂）を、希望時刻のなるべく近くの空きに入れる
  function placeFlexible(items, item, W, B) {
    const ivs = freeIntervals(items, W, B);
    let best = null;
    for (const iv of ivs) {
      const len = iv.end - iv.start;
      if (len < item.minDur) continue;
      const dur = Math.min(item.dur, len);
      const s = Math.min(Math.max(item.want, iv.start), iv.end - dur);
      const dist = Math.abs(s - item.want);
      if (dist > 150) continue;
      if (!best || dist < best.dist || (dist === best.dist && dur > best.dur)) best = { s, dur, dist };
    }
    if (!best) return false;
    const placed = Object.assign({}, item, { start: best.s, end: best.s + best.dur });
    delete placed.want; delete placed.dur; delete placed.minDur;
    items.push(placed);
    return true;
  }

  // ---------- メイン：プランをつくる ----------
  function buildPlan(A, data, seed) {
    const rng = mulberry32(seed);
    const T = timesFromAnswers(A);
    const { W, B } = T;
    const items = [];
    const notes = [];
    const R = data.routines;
    const routine = (pool) => ({ pool, idx: Math.floor(rng() * R[pool].length) });
    const wants = (A.wants || []).slice();
    const used = new Set();

    // 1) 決まっている時刻（起床・出発・帰宅・就寝・半日の予定）
    items.push(Object.assign({ kind: 'wake', title: '起床・身じたく', emoji: '⏰', start: W, end: W + 15, anchor: true }, routine('wakeup')));

    if (T.D != null) {
      const label = A.day === 'school' ? '学校' : '仕事';
      items.push(Object.assign({ kind: 'getready', title: '出かける準備', emoji: '🎒', start: T.D - 15, end: T.D, anchor: true }, routine('getready')));
      items.push(Object.assign({ kind: 'work', title: label + '（' + (A.day === 'school' ? '通学' : '通勤') + '・お昼を含む）', emoji: A.day === 'school' ? '🏫' : '💼', start: T.D, end: T.R, anchor: true, mark: '出発' }, routine(A.day === 'school' ? 'school' : 'work')));
      items.push(Object.assign({ kind: 'home', title: '帰宅・ひと息', emoji: '🏠', start: T.R, end: T.R + 15, anchor: true }, routine('homecoming')));
      if (T.D > A.depart * 60 + 59 && A.depart < 9) notes.push('起きてから出発まで45分はとれるよう、出発を ' + fmt(T.D) + ' にしました。');
    }

    let brunch = false;
    if (A.day === 'half') {
      let ps, pe;
      if (A.half === 'am') { ps = Math.max(540, W + 70); pe = Math.max(720, ps + 120); }
      else if (A.half === 'pm') { ps = 780; pe = 1020; }
      else { ps = 1110; pe = 1260; }
      items.push(Object.assign({ kind: 'getready', title: '出かける準備', emoji: '🎒', start: ps - 15, end: ps, anchor: true }, routine('getready')));
      items.push(Object.assign({ kind: 'plan', title: '予定（' + ({ am: '午前', pm: '午後', eve: '夕方以降' })[A.half] + '）', emoji: '📌', start: ps, end: pe, anchor: true, mark: '出発' }, routine('plan')));
      brunch = W >= 600 && A.half !== 'am';
    }
    if (A.day === 'off') brunch = W >= 600;

    // 寝る前の準備（「早く寝る」を選んだ人はリラックス時間に）
    let prep;
    if (wants.includes('sleep')) {
      const cands = eligiblePatterns(A, data, 'sleep', used);
      const p = pick(rng, cands);
      used.add(p.id);
      prep = { kind: 'activity', interest: 'sleep', pattern: p.id, start: B - p.min, end: B, anchor: true };
    } else {
      prep = Object.assign({ kind: 'bedprep', title: '寝る準備', emoji: '🪥', start: B - 30, end: B, anchor: true }, routine('bedprep'));
    }
    items.push(prep);
    items.push({ kind: 'bed', title: '就寝', emoji: '🌙', start: B, end: B, anchor: true, mark: '就寝' });

    // 2) 食事とお風呂（決まった時刻のすきまに入れる）
    const hasLunch = A.day === 'off' || A.day === 'half';
    if (brunch) {
      placeFlexible(items, Object.assign({ kind: 'meal', meal: 'breakfast', title: 'ブランチ（朝昼兼用）', emoji: '🥞', want: W + 15, dur: 45, minDur: 20 }, routine('brunch')), W, B);
    } else {
      placeFlexible(items, Object.assign({ kind: 'meal', meal: 'breakfast', title: '朝ごはん', emoji: '🍞', want: W + 15, dur: 25, minDur: 10 }, routine('breakfast')), W, B);
    }
    let dinnerWant = 1110; // 18:30
    if (T.R != null) dinnerWant = T.R <= 1050 ? 1140 : T.R + 20;
    if (A.day === 'half' && A.half === 'eve') dinnerWant = 1050;
    placeFlexible(items, Object.assign({ kind: 'meal', meal: 'dinner', title: '夕ごはん', emoji: '🍚', want: dinnerWant, dur: A.day === 'half' && A.half === 'eve' ? 40 : 45, minDur: 25 }, routine('dinner')), W, B);
    if (hasLunch && !brunch) {
      const lw = A.day === 'half' && A.half === 'am' ? Math.max(720, items.find((i) => i.kind === 'plan').end) : 720;
      placeFlexible(items, Object.assign({ kind: 'meal', meal: 'lunch', title: '昼ごはん', emoji: '🍜', want: lw, dur: 50, minDur: 25 }, routine('lunch')), W, B);
    }
    const bathOk = placeFlexible(items, Object.assign({ kind: 'bath', title: 'お風呂', emoji: '🛁', want: prep.start - 40, dur: 40, minDur: 15 }, routine('bath')), W, B);
    if (!bathOk && prep.kind === 'bedprep') prep.title = 'シャワー・寝る準備';

    // 3) やりたいこと：まず「食事の代わり」になるもの（美味しいもの・家族と夕ごはん など）
    const placedInterests = new Set(prep.interest ? ['sleep'] : []);
    const mealChance = { gourmet: 0.75, social: 0.45 };
    for (const id of shuffle(rng, wants.filter((w) => mealChance[w] != null))) {
      if (rng() > mealChance[id]) continue;
      const meals = items.filter((i) => i.kind === 'meal');
      const cands = [];
      for (const p of eligiblePatterns(A, data, id, used)) {
        if (!p.meal) continue;
        for (const m of meals) {
          if (!p.meal.includes(m.meal) || m.title.indexOf('ブランチ') === 0) continue;
          if (!p.times.includes(slotOf(m.start))) continue;
          const nextStart = nextCoreStart(items, m);
          if (m.start + p.min > nextStart) continue;
          cands.push({ p, m, w: energyW(A, p) * (0.5 + rng()) });
        }
      }
      if (!cands.length) continue;
      cands.sort((a, b) => b.w - a.w);
      const { p, m } = cands[0];
      const idx = items.indexOf(m);
      items[idx] = { kind: 'activity', interest: id, pattern: p.id, start: m.start, end: m.start + p.min, replacesMeal: m.meal };
      used.add(p.id);
      placedInterests.add(id);
    }

    // 4) 残りのやりたいことを、向いている時間帯の空きに入れる
    const restAfter = A.energy === 'tired' ? 20 : 0;
    const order = wants.filter((w) => w !== 'sleep' && !placedInterests.has(w));
    order.sort((a, b) => avgMin(data, b) - avgMin(data, a) + (rng() - 0.5) * 40);
    const unplaced = [];
    for (const id of order) {
      if (placeActivity(items, A, data, id, used, rng, W, B, restAfter)) placedInterests.add(id);
      else unplaced.push(id);
    }

    // 5) 元気なら予定を多めに（ふつうは時間がかなり余ったときだけ1つ追加）
    const pool = wants.filter((w) => w !== 'sleep');
    let extra = A.energy === 'genki' ? 2 : 0;
    if (A.energy === 'normal') {
      const freeTotal = freeIntervals(items, W, B).reduce((s, iv) => s + iv.end - iv.start, 0);
      if (freeTotal >= 180) extra = 1;
    }
    let tries = 0, k = Math.floor(rng() * Math.max(1, pool.length));
    while (extra > 0 && pool.length && tries < pool.length * 2) {
      const id = pool[k % pool.length];
      k++; tries++;
      if (placeActivity(items, A, data, id, used, rng, W, B, restAfter, true)) extra--;
    }

    if (unplaced.length) {
      notes.push('時間が足りず入らなかったこと：' + unplaced.map((id) => interestById(data, id).label).join('、') + '（「別の案にする」で入ることがあります）');
    }

    items.sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    return { seed, answers: A, items, notes, sleepMin: sleepMinutes(A), fillerPick: {}, swapCount: 0, W, B };
  }

  function shuffle(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function avgMin(data, id) {
    const it = interestById(data, id);
    return it ? it.patterns.reduce((s, p) => s + p.min, 0) / it.patterns.length : 0;
  }
  function nextCoreStart(items, item) {
    let n = Infinity;
    for (const i of items) if (i !== item && i.start > item.start && i.start < n) n = i.start;
    return n;
  }

  function placeActivity(items, A, data, id, used, rng, W, B, restAfter, isExtra) {
    const cands = eligiblePatterns(A, data, id, used, (p) => !p.meal);
    const ivs = freeIntervals(items, W, B);
    let best = null;
    for (const p of cands) {
      for (const iv of ivs) {
        const need = p.min + restAfter;
        if (iv.end - iv.start < p.min) continue;
        const starts = new Set([ceil10(iv.start), floor10(iv.end - need), floor10(iv.end - p.min)]);
        for (const s0 of SLOT_STARTS) if (s0 > iv.start && s0 < iv.end) starts.add(s0);
        for (const s of starts) {
          const e = s + p.min;
          if (s < iv.start || e > iv.end) continue;
          if (!p.times.includes(slotOf(s))) continue;
          if (p.min >= 90 && !p.times.includes(slotOf(s + Math.floor(p.min / 2)))) continue;
          if (p.place === 'outdoor' && e > 1170 && !p.times.includes('night')) continue;
          let score = energyW(A, p) * (0.6 + rng());
          const before = s - iv.start, after = iv.end - e;
          score += before === 0 || before >= 30 ? 0.25 : -0.3;
          score += after === 0 || after >= 30 ? 0.25 : -0.3;
          if (isExtra) score -= p.min / 400; // 追加分は短めのものを優先
          if (!best || score > best.score) best = { p, s, e, iv, score };
        }
      }
    }
    if (!best) return false;
    const { p, s, e, iv } = best;
    items.push({ kind: 'activity', interest: id, pattern: p.id, start: s, end: e });
    used.add(p.id);
    if (restAfter && iv.end - e >= restAfter + 5) {
      items.push({ kind: 'rest', title: 'ひと休み', emoji: '🍵', start: e, end: e + restAfter, pool: 'rest', idx: Math.floor(rng() * data.routines.rest.length) });
    }
    return true;
  }

  // ---------- 表示用：すきま時間を「自由時間」で埋めて、表示データにする ----------
  function displayItems(plan, data) {
    const A = plan.answers;
    const core = plan.items.slice().sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    const ivs = freeIntervals(core, plan.W, plan.B);
    const fillers = [];
    for (const iv of ivs) {
      if (iv.end - iv.start < 20) continue;
      const pool = A.energy === 'tired' ? 'rest' : 'free';
      const list = data.routines[pool];
      const key = String(iv.start);
      const idx = plan.fillerPick[key] != null ? plan.fillerPick[key] : (iv.start / 10) % list.length;
      fillers.push({ kind: 'free', title: A.energy === 'tired' ? 'のんびりタイム' : '自由時間', emoji: A.energy === 'tired' ? '🛋️' : '✨', start: iv.start, end: iv.end, pool, idx: Math.floor(idx), fillerKey: key });
    }
    const all = core.concat(fillers).sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    return all.map((it) => describe(it, data));
  }

  function describe(it, data) {
    const d = { ref: it, start: it.start, end: it.end, kind: it.kind, mark: it.mark || null };
    if (it.kind === 'activity') {
      const interest = interestById(data, it.interest);
      const p = interest.patterns.find((x) => x.id === it.pattern);
      d.title = interest.label;
      d.emoji = interest.emoji;
      d.desc = p.title;
      d.cost = p.cost;
      d.place = p.place;
      d.energy = p.energy;
      d.swappable = true;
      if (it.interest === 'sleep') d.title = '早く寝る：リラックス時間';
      if (it.replacesMeal) d.title = interest.label + '（' + ({ breakfast: '朝ごはん', lunch: '昼ごはん', dinner: '夕ごはん' })[it.replacesMeal] + '）';
    } else {
      d.title = it.title;
      d.emoji = it.emoji;
      d.desc = it.pool ? data.routines[it.pool][it.idx % data.routines[it.pool].length] : '';
      d.swappable = !!it.pool;
    }
    return d;
  }

  // ---------- 個別に入れ替える ----------
  function swapItem(plan, data, item, fillerKey) {
    plan.swapCount = (plan.swapCount || 0) + 1;
    const rng = mulberry32((plan.seed ^ (plan.swapCount * 2654435761)) >>> 0);
    const A = plan.answers;
    if (fillerKey != null) {
      const pool = A.energy === 'tired' ? 'rest' : 'free';
      const cur = plan.fillerPick[fillerKey] != null ? plan.fillerPick[fillerKey] : (Number(fillerKey) / 10) % data.routines[pool].length;
      plan.fillerPick[fillerKey] = (Math.floor(cur) + 1) % data.routines[pool].length;
      return { ok: true };
    }
    if (item.kind !== 'activity') {
      if (!item.pool) return { ok: false };
      item.idx = (item.idx + 1) % data.routines[item.pool].length;
      return { ok: true };
    }
    const used = new Set(plan.items.filter((i) => i.kind === 'activity').map((i) => i.pattern));
    if (item.interest === 'sleep') {
      const prevEnd = Math.max(...plan.items.filter((i) => i !== item && i.end <= item.start + 1).map((i) => i.end), plan.W);
      const cands = eligiblePatterns(A, data, 'sleep', used).filter((p) => plan.B - p.min >= prevEnd);
      if (!cands.length) return { ok: false };
      const p = pick(rng, cands);
      item.pattern = p.id; item.start = plan.B - p.min; item.end = plan.B;
      return { ok: true };
    }
    const nextStart = nextCoreStart(plan.items, item);
    const maxEnd = Math.min(nextStart, plan.B);
    const fits = (p) => item.start + p.min <= maxEnd && p.times.includes(slotOf(item.start));
    let cands = eligiblePatterns(A, data, item.interest, used).filter((p) => fits(p) && (item.replacesMeal ? (p.meal || []).includes(item.replacesMeal) : !p.meal));
    if (!cands.length && !item.replacesMeal) {
      // 同じジャンルで入るものがなければ、ほかの「やりたいこと」から
      for (const other of (A.wants || []).filter((w) => w !== item.interest && w !== 'sleep')) {
        const c = eligiblePatterns(A, data, other, used).filter((p) => fits(p) && !p.meal);
        if (c.length) { cands = c; item.interest = other; break; }
      }
    }
    if (!cands.length) return { ok: false };
    const p = pick(rng, cands);
    item.pattern = p.id;
    item.end = item.start + p.min;
    return { ok: true };
  }

  function signature(plan) {
    return plan.items.map((i) => i.kind + ':' + (i.pattern || i.idx) + '@' + i.start).join('|');
  }

  // 同じ回答から「前と違う」案をつくる
  function buildDifferentPlan(A, data, prevPlan, baseSeed) {
    const prevSig = prevPlan ? signature(prevPlan) : '';
    const prevActs = prevPlan ? new Set(prevPlan.items.filter((i) => i.kind === 'activity').map((i) => i.pattern)) : new Set();
    let best = null, bestDiff = -1;
    for (let i = 0; i < 12; i++) {
      const plan = buildPlan(A, data, (baseSeed + i * 7919) >>> 0);
      if (signature(plan) === prevSig) continue;
      const acts = plan.items.filter((x) => x.kind === 'activity');
      const diff = acts.filter((x) => !prevActs.has(x.pattern)).length / Math.max(1, acts.length);
      if (diff > bestDiff) { best = plan; bestDiff = diff; }
      if (diff === 1) break;
    }
    return best || buildPlan(A, data, baseSeed);
  }

  const api = { buildPlan, buildDifferentPlan, displayItems, swapItem, sleepMinutes, timesFromAnswers, fmt, slotOf, signature };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
