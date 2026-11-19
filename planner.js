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
  function fmt(m) { return (Math.floor(m / 60) % 24) + ':' + String(m % 60).padStart(2, '0'); }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

  // 時間帯：morning 〜11時 / noon 11〜14時 / afternoon 14〜17時 / evening 17〜19時半 / night 19時半〜
  function slotOf(m) {
    if (m < 660) return 'morning';
    if (m < 840) return 'noon';
    if (m < 1020) return 'afternoon';
    if (m < 1170) return 'evening';
    return 'night';
  }
  const ALL_SLOTS = ['morning', 'noon', 'afternoon', 'evening', 'night'];
  const SLOT_STARTS = [360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1170, 1200, 1260, 1320];
  const CUSTOM_WHEN = { morning: ['morning'], day: ['noon', 'afternoon'], evening: ['evening'], night: ['night'], any: ALL_SLOTS };
  const MEAL_LABEL = { breakfast: '朝ごはん', lunch: '昼ごはん', dinner: '夕ごはん', snack: 'おやつ' };

  // ---------- 回答 → 決まっている時刻 ----------
  function timesFromAnswers(A) {
    const W = A.wake * 60;   // 「7時台」→ 7:00 に起きる
    const B = A.bed * 60;    // 「23時台」→ 23:00 に寝る（0時台=24、1時以降=25）
    const t = { W, B };
    if (A.day === 'work' || A.day === 'school') {
      t.D = Math.max(A.depart * 60 + 30, W + 45);  // 「8時台」→ 8:30 に出発（起きてから最低45分）
      t.R = A.ret === 20 ? 1230 : A.ret * 60;      // 「19時台」→ 19:00 に帰宅（20時以降は 20:30）
    }
    return t;
  }
  function sleepMinutes(A) { return A.wake * 60 + 24 * 60 - A.bed * 60; }

  // ---------- 気分・体力 ----------
  const ENERGY_WEIGHT = {
    tired: { low: 1.2, mid: 0.25, high: 0 },
    normal: { low: 1, mid: 1, high: 0.6 },
    genki: { low: 0.6, mid: 1, high: 1.3 }
  };
  function mood(A, T) {
    const tired = A.energy === 'tired';
    const relaxedDay = A.day === 'off' && A.offstyle === 'relaxed';
    const m = {
      restAfter: tired || relaxedDay ? 20 : 0,
      eveningFrom: T.R != null ? T.R : null,
      evening: T.R != null ? (A.afterwork || 'plenty') : 'plenty',
      calm: tired || relaxedDay || A.afterwork === 'none'
    };
    // extras：追加で入れる予定の数（-1 = 空き時間が3時間以上あれば1つ）
    if (A.day === 'off') m.extras = A.offstyle === 'packed' ? 3 : A.offstyle === 'relaxed' ? 0 : (A.energy === 'genki' ? 2 : -1);
    else m.extras = A.energy === 'genki' ? 2 : -1;
    if (tired) m.extras = m.extras > 0 ? Math.max(0, m.extras - 2) : 0;
    return m;
  }
  function weightFor(A, M, p, start) {
    let w = ENERGY_WEIGHT[A.energy || 'normal'][p.energy];
    if (w == null) w = 1;
    if (M.eveningFrom != null && start >= M.eveningFrom) {
      if (M.evening === 'none' && p.energy !== 'low') return 0;
      if (M.evening === 'little' && p.energy === 'high') return 0;
    }
    return w;
  }
  const budgetOk = (A, p) => A.budget == null || p.cost <= A.budget;

  // ---------- 「やりたいこと」→ 置く候補（タスク） ----------
  function interestById(data, id) { return data.interests.find((i) => i.id === id); }
  function patternsOf(it, A) {
    if (!it.variants) return it.patterns.slice();
    const v = A[it.sub];
    if (v && v !== 'any' && it.variants[v]) return it.variants[v].slice();
    return [].concat(...Object.values(it.variants));
  }

  function buildTasks(A, data) {
    const tasks = [];
    for (const id of A.wants || []) {
      if (id === 'sleep' || id === 'custom' || String(id).indexOf('preset:') === 0) continue;
      const it = interestById(data, id);
      if (!it) continue;
      const t = { id, label: it.label, emoji: it.emoji, patterns: patternsOf(it, A) };
      if (it.lenFrom && A[it.lenFrom.q] != null && (!it.lenFrom.variant || A[it.sub] === it.lenFrom.variant)) t.dur = A[it.lenFrom.q];
      if (id === 'exercise' && A.ex_type === 'gym') t.label = '運動（ジム）';
      if (id === 'outing' && A.out_with && A.out_with !== 'solo') t.prefix = A.out_with === 'friends' ? '友達・恋人と' : '家族と';
      if (id === 'social' && A.social_what === 'meal') t.mealPrefer = A.day === 'off' || A.day === 'half' ? ['lunch', 'dinner'] : ['dinner'];
      if (id === 'gourmet') {
        t.when = A.food_when || 'lunch';
        if (t.when === 'snack') t.times = ['afternoon', 'evening', 'night'];
        else t.mealPrefer = [t.when];
      }
      if (id === 'hobby' && A.hobby_kind === 'other' && A.hobby_text) {
        t.userText = true;
        t.patterns = [{ id: 'hobby-custom', title: A.hobby_text + 'を楽しむ', min: 60, times: ALL_SLOTS, energy: 'low', cost: 0, place: 'indoor' }];
      }
      if (id === 'shopping' && A.shop_what === 'online') t.label = '買い物（ネット）';
      tasks.push(t);
    }
    return tasks;
  }
  function customList(A) { return [].concat(A.custom || [], A.presets || []).slice(0, 3); }

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
  const overlaps = (items, s, e, except) => items.some((i) => i !== except && i.end > i.start && i.start < e && s < i.end);

  // 動かせる予定（食事・お風呂）を、希望時刻のなるべく近くの空きに入れる
  function placeFlexible(items, item, W, B) {
    let best = null;
    for (const iv of freeIntervals(items, W, B)) {
      const len = iv.end - iv.start;
      if (len < item.minDur) continue;
      const dur = Math.min(item.dur, len);
      const s = Math.min(Math.max(item.want, iv.start), iv.end - dur);
      const dist = Math.abs(s - item.want);
      if (dist > 150) continue;
      if (!best || dist < best.dist || (dist === best.dist && dur > best.dur)) best = { s, dur, dist };
    }
    if (!best) return null;
    const placed = Object.assign({}, item, { start: best.s, end: best.s + best.dur });
    delete placed.want; delete placed.dur; delete placed.minDur;
    items.push(placed);
    return placed;
  }

  // ---------- メイン：プランをつくる ----------
  function buildPlan(A, data, seed) {
    const rng = mulberry32(seed);
    const T = timesFromAnswers(A);
    const M = mood(A, T);
    const { W, B } = T;
    const items = [];
    const notes = [];
    const unplaced = [];
    const R = data.routines;
    const routine = (pool) => ({ pool, idx: Math.floor(rng() * R[pool].length) });
    const used = new Set();
    const wants = A.wants || [];

    // 1) 決まっている時刻（起床・出発・帰宅・半日の予定・寝る準備・就寝）
    items.push(Object.assign({ kind: 'wake', title: '起床・身じたく', emoji: '⏰', start: W, end: W + 15, anchor: true }, routine('wakeup')));
    if (T.D != null) {
      const school = A.day === 'school';
      items.push(Object.assign({ kind: 'getready', title: '出かける準備', emoji: '🎒', start: T.D - 15, end: T.D, anchor: true }, routine('getready')));
      items.push(Object.assign({ kind: 'work', title: (school ? '学校' : '仕事') + '（' + (school ? '通学' : '通勤') + '・お昼を含む）', emoji: school ? '🏫' : '💼', start: T.D, end: T.R, anchor: true, mark: '出発' }, routine(school ? 'school' : 'work')));
      items.push(Object.assign({ kind: 'home', title: '帰宅・ひと息', emoji: '🏠', start: T.R, end: T.R + 10, anchor: true }, routine('homecoming')));
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

    let prep;
    if (wants.includes('sleep')) {
      const p = pick(rng, interestById(data, 'sleep').patterns);
      used.add(p.id);
      prep = { kind: 'activity', task: 'sleep', p, start: B - p.min, end: B, anchor: true };
    } else {
      prep = Object.assign({ kind: 'bedprep', title: '寝る準備', emoji: '🪥', start: B - 30, end: B, anchor: true }, routine('bedprep'));
    }
    items.push(prep);
    items.push({ kind: 'bed', title: '就寝', emoji: '🌙', start: B, end: B, anchor: true, mark: '就寝' });

    // 2) 時間が決まっている「その他」
    const customs = customList(A);
    customs.forEach((c, ci) => {
      if (!c.fixed) return;
      const s = c.start, e = c.start + c.dur;
      const reason = s < W + 15 ? '起きる前の時間です' : e > prep.start ? '寝る準備の時間と重なります' : overlaps(items, s, e) ? 'ほかの決まった予定と重なります' : null;
      if (reason) { unplaced.push({ label: c.name, reason, custom: true }); return; }
      items.push({ kind: 'custom', c, ci, start: s, end: e, anchor: true });
    });

    // 3) 食事とお風呂
    const hasLunch = A.day === 'off' || A.day === 'half';
    if (brunch) placeFlexible(items, Object.assign({ kind: 'meal', meal: 'breakfast', brunch: true, title: 'ブランチ（朝昼兼用）', emoji: '🥞', want: W + 15, dur: 45, minDur: 20 }, routine('brunch')), W, B);
    else placeFlexible(items, Object.assign({ kind: 'meal', meal: 'breakfast', title: '朝ごはん', emoji: '🍞', want: W + 15, dur: 25, minDur: 10 }, routine('breakfast')), W, B);
    let dinnerWant = 1110;
    if (T.R != null) dinnerWant = T.R <= 1050 ? 1140 : T.R + 10;
    if (A.day === 'half' && A.half === 'eve') dinnerWant = 1050;
    placeFlexible(items, Object.assign({ kind: 'meal', meal: 'dinner', title: '夕ごはん', emoji: '🍚', want: dinnerWant, dur: 45, minDur: 25 }, routine('dinner')), W, B);
    if (hasLunch && !brunch) {
      const planItem = items.find((i) => i.kind === 'plan');
      const lw = A.day === 'half' && A.half === 'am' ? Math.max(720, planItem.end) : 720;
      placeFlexible(items, Object.assign({ kind: 'meal', meal: 'lunch', title: '昼ごはん', emoji: '🍜', want: lw, dur: 50, minDur: 25 }, routine('lunch')), W, B);
    }
    const bath = placeFlexible(items, Object.assign({ kind: 'bath', title: 'お風呂', emoji: '🛁', want: prep.start - 30, dur: 30, minDur: 15 }, routine('bath')), W, B);
    if (!bath && prep.kind === 'bedprep') prep.title = 'シャワー・寝る準備';

    // 4) やりたいこと
    const tasks = buildTasks(A, data);
    const taskMap = {};
    tasks.forEach((t) => { taskMap[t.id] = t; });
    taskMap.sleep = { id: 'sleep', label: '早く寝る', emoji: '🌙', patterns: interestById(data, 'sleep').patterns, sleepPrep: true };
    const ctx = { A, M, W, B, rng, used, items };

    // 4-1) 食事の代わりになるもの（美味しいもの・友達とごはん）
    for (const t of tasks.filter((x) => x.mealPrefer)) if (placeAsMeal(ctx, t)) t.placed = true;
    // 4-2) 時間が決まっていない「その他」（本人が入れたものを優先）
    customs.forEach((c, ci) => {
      if (c.fixed) return;
      const p = { id: 'custom-' + ci, title: c.name, min: c.dur, times: CUSTOM_WHEN[c.when] || ALL_SLOTS, energy: 'low', cost: 0, place: c.place };
      if (!placeActivity(ctx, { id: 'custom-' + ci, custom: c, ci, patterns: [p], fixedPattern: true })) {
        unplaced.push({ label: c.name, reason: c.dur >= 240 ? '半日分のまとまった空き時間がありません' : '向いている時間帯に空きがありません', custom: true });
      }
    });
    // 4-3) 残りのやりたいこと（外の予定から先に置いて、続けて並びやすくする）
    const outdoorShare = (t) => t.patterns.filter((p) => p.place === 'outdoor').length / Math.max(1, t.patterns.length);
    const rest = tasks.filter((t) => !t.placed);
    rest.sort((a, b) => (outdoorShare(b) - outdoorShare(a)) * 2 + (avgMin(b) - avgMin(a)) / 60 + (rng() - 0.5));
    for (const t of rest) {
      if (placeActivity(ctx, t)) t.placed = true;
      else unplaced.push({ label: t.label, reason: '空き時間が足りません' });
    }
    // 4-4) 予定を多めにしたいとき
    let extra = M.extras;
    if (extra === -1) {
      const freeTotal = freeIntervals(items, W, B).reduce((s, iv) => s + iv.end - iv.start, 0);
      extra = freeTotal >= 180 ? 1 : 0;
    }
    const pool = tasks.filter((t) => !t.userText && !t.mealPrefer && t.placed);
    let k = Math.floor(rng() * Math.max(1, pool.length)), tries = 0;
    while (extra > 0 && pool.length && tries < pool.length * 2 + extra * 3) {
      const t = pool[k % pool.length]; k++; tries++;
      if (placeActivity(ctx, t, true)) extra--;
    }
    // 選んだものだけで埋まらないときは「おすすめ」として、趣味・のんびり・家事から足す
    if (extra > 0) {
      for (const id of ['hobby', 'relax', 'chores']) {
        if (extra <= 0) break;
        if (wants.includes(id)) continue;
        const it = interestById(data, id);
        const t = { id: 'suggest-' + id, label: 'おすすめ：' + it.label, emoji: it.emoji, patterns: patternsOf(it, {}), suggested: true };
        taskMap[t.id] = t;
        if (placeActivity(ctx, t, true)) extra--;
      }
    }

    if (unplaced.length) notes.push('入りきらなかった予定は、いちばん下に出しています。「別の案にする」やほかの予定の「削除」で入ることがあります。');
    items.sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    return { seed, answers: A, items, tasks: taskMap, notes, unplaced, sleepMin: sleepMinutes(A), fillerPick: {}, swapCount: 0, W, B, M };
  }

  function avgMin(t) { return t.dur || t.patterns.reduce((s, p) => s + p.min, 0) / Math.max(1, t.patterns.length); }
  function nextCoreStart(items, item) {
    let n = Infinity;
    for (const i of items) if (i !== item && i.start > item.start && i.start < n) n = i.start;
    return n;
  }

  function candidates(ctx, t) {
    const { A, used } = ctx;
    const list = t.patterns.filter((p) => !used.has(p.id));
    if (t.fixedPattern) return list;
    const ok = list.filter((p) => budgetOk(A, p) && (A.energy !== 'tired' || (p.energy !== 'high' && p.min <= 120)));
    if (ok.length) return ok;
    // 予算や体力で全部はじかれたら、いちばん安くて楽なものを候補に戻す
    return list.slice().sort((a, b) => a.cost - b.cost || (a.energy === 'low' ? -1 : 1)).slice(0, 2);
  }

  // 食事の時間に「美味しいもの」「友達とごはん」を入れる
  function placeAsMeal(ctx, t) {
    const { items, rng, used } = ctx;
    for (const when of t.mealPrefer) {
      let meal = items.find((i) => i.kind === 'meal' && i.meal === when && !i.brunch);
      if (!meal && (when === 'lunch' || when === 'breakfast')) meal = items.find((i) => i.kind === 'meal' && i.brunch);
      const cands = candidates(ctx, t).filter((p) => t.id === 'gourmet' || (p.meal || []).includes(when));
      if (!cands.length) continue;
      if (!meal) {
        // 仕事・学校の日の昼ごはん → 「お昼休みに」として仕事のブロックに添える
        const work = items.find((i) => i.kind === 'work');
        if (when === 'lunch' && work && !work.lunch) {
          const p = pick(rng, cands);
          work.lunch = { task: t.id, p };
          used.add(p.id);
          return true;
        }
        continue;
      }
      const nextStart = nextCoreStart(items, meal);
      const fit = cands.filter((p) => meal.start + p.min <= nextStart);
      if (!fit.length) continue;
      const p = pick(rng, fit);
      items[items.indexOf(meal)] = { kind: 'activity', task: t.id, p, start: meal.start, end: meal.start + p.min, replacesMeal: meal.brunch ? 'brunch' : when, prefix: t.prefix };
      used.add(p.id);
      return true;
    }
    return false;
  }

  function placeOf(i) {
    if (i.kind === 'custom') return i.c.place;
    if (i.kind === 'activity') return i.p.place;
    return null;
  }

  function placeActivity(ctx, t, isExtra) {
    const { A, M, W, B, rng, used, items } = ctx;
    const cands = candidates(ctx, t).filter((p) => !p.meal);
    const ivs = freeIntervals(items, W, B);
    const outdoorItems = items.filter((i) => placeOf(i) === 'outdoor');
    let best = null;
    const restWanted = t.custom ? 0 : (M.restAfter || (M.evening === 'none' && M.eveningFrom != null ? 20 : 0));
    for (const needRest of restWanted ? [true, false] : [false]) {
    for (const p of cands) {
      const dur = t.dur || p.min;
      const times = t.times || p.times || ALL_SLOTS;
      for (const iv of ivs) {
        if (iv.end - iv.start < dur) continue;
        const starts = new Set([ceil10(iv.start), floor10(iv.end - dur - restWanted), floor10(iv.end - dur)]);
        for (const s0 of SLOT_STARTS) if (s0 > iv.start && s0 < iv.end) starts.add(s0);
        if (p.place === 'outdoor') for (const o of outdoorItems) { starts.add(o.end); starts.add(o.start - dur); }
        for (const s of starts) {
          const e = s + dur;
          if (s < iv.start || e > iv.end) continue;
          if (needRest && e + restWanted > iv.end && (M.restAfter || s >= M.eveningFrom)) continue;
          if (!times.includes(slotOf(s))) continue;
          if (dur >= 90 && !times.includes(slotOf(s + Math.floor(dur / 2)))) continue;
          if (p.place === 'outdoor' && e > 1170 && !times.includes('night')) continue;
          const w = t.fixedPattern ? 1 : weightFor(A, M, p, s);
          if (w <= 0) continue;
          let score = w * (0.6 + rng());
          const before = s - iv.start, after = iv.end - e;
          score += before === 0 || before >= 30 ? 0.25 : -0.3;
          score += after === 0 || after >= 30 ? 0.25 : -0.3;
          // 外の予定は続けて並べる（移動を減らす）
          if (p.place === 'outdoor' && outdoorItems.some((o) => Math.abs(o.end - s) <= 10 || Math.abs(e - o.start) <= 10)) score += 2;
          if (M.eveningFrom != null && s >= M.eveningFrom && M.evening === 'none' && t.id === 'relax') score += 0.8;
          if (isExtra) score -= dur / 400;
          if (!best || score > best.score) best = { p, s, e, iv, score };
        }
      }
    }
    if (best) break;
    }
    if (!best) return false;
    const { p, s, e, iv } = best;
    const item = t.custom
      ? { kind: 'custom', c: t.custom, ci: t.ci, start: s, end: e }
      : { kind: 'activity', task: t.id, p, start: s, end: e, prefix: t.prefix };
    items.push(item);
    used.add(p.id);
    const restLen = M.restAfter || (M.eveningFrom != null && s >= M.eveningFrom && M.evening === 'none' ? 20 : 0);
    if (restLen && iv.end - e >= restLen + 5 && !t.custom) {
      items.push({ kind: 'rest', title: 'ひと休み', emoji: '🍵', start: e, end: e + restLen, pool: 'rest', idx: Math.floor(rng() * 4) });
    }
    return true;
  }

  // ---------- 表示用 ----------
  function displayItems(plan, data) {
    const core = plan.items.slice().sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    const fillers = [];
    const calm = plan.M && plan.M.calm;
    for (const iv of freeIntervals(core, plan.W, plan.B)) {
      if (iv.end - iv.start < 20) continue;
      const pool = calm ? 'rest' : 'free';
      const key = String(iv.start);
      const n = data.routines[pool].length;
      const idx = plan.fillerPick[key] != null ? plan.fillerPick[key] : (iv.start / 10) % n;
      fillers.push({ kind: 'free', title: calm ? 'のんびりタイム' : '自由時間', emoji: calm ? '🛋️' : '✨', start: iv.start, end: iv.end, pool, idx: Math.floor(idx), fillerKey: key });
    }
    return core.concat(fillers).sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1)).map((it) => describe(plan, it, data));
  }

  function describe(plan, it, data) {
    const d = { ref: it, start: it.start, end: it.end, kind: it.kind, mark: it.mark || null };
    const sleepPrep = it.kind === 'activity' && it.task === 'sleep';
    d.canShift = ['activity', 'custom', 'meal', 'bath', 'rest'].includes(it.kind) && !sleepPrep;
    d.canDelete = d.canShift || it.kind === 'bedprep' || sleepPrep;
    if (it.kind === 'activity') {
      const t = plan.tasks[it.task] || {};
      d.title = sleepPrep ? '早く寝る：リラックス時間' : t.label;
      if (it.replacesMeal) d.title = t.label + '（' + (it.replacesMeal === 'brunch' ? 'ブランチ' : MEAL_LABEL[it.replacesMeal]) + '）';
      else if (it.task === 'gourmet' && t.when === 'snack') d.title = t.label + '（おやつ）';
      d.emoji = t.emoji;
      d.desc = (it.prefix ? it.prefix + '：' : '') + it.p.title;
      d.cost = it.p.cost; d.place = it.p.place; d.energy = it.p.energy;
      d.swappable = !t.userText;
    } else if (it.kind === 'custom') {
      d.title = it.c.name;
      d.emoji = it.c.fixed ? '📍' : '✏️';
      d.desc = (it.c.place === 'outdoor' ? '外で' : '家で') + (it.c.fixed ? '・時間指定あり' : '') + '（' + durText(it.c.dur) + '）';
      d.place = it.c.place;
      d.custom = true;
      d.swappable = false;
    } else {
      d.title = it.title;
      d.emoji = it.emoji;
      d.desc = it.pool ? data.routines[it.pool][it.idx % data.routines[it.pool].length] : '';
      d.swappable = !!it.pool && it.kind !== 'work';
      if (it.kind === 'work' && it.lunch) {
        const t = plan.tasks[it.lunch.task] || {};
        d.desc = 'お昼休みに：' + it.lunch.p.title + '（' + (t.label || '') + '）';
        d.cost = it.lunch.p.cost;
      }
    }
    return d;
  }
  function durText(m) { const h = Math.floor(m / 60), r = m % 60; return (h ? h + '時間' : '') + (r ? r + '分' : ''); }

  // ---------- 調整：入れ替える／削除／時間をずらす ----------
  function swapItem(plan, data, item, fillerKey) {
    plan.swapCount = (plan.swapCount || 0) + 1;
    const rng = mulberry32((plan.seed ^ Math.imul(plan.swapCount, 2654435761)) >>> 0);
    if (fillerKey != null) {
      const pool = plan.M && plan.M.calm ? 'rest' : 'free';
      const n = data.routines[pool].length;
      const cur = plan.fillerPick[fillerKey] != null ? plan.fillerPick[fillerKey] : (Number(fillerKey) / 10) % n;
      plan.fillerPick[fillerKey] = (Math.floor(cur) + 1) % n;
      return { ok: true };
    }
    if (item.kind !== 'activity') {
      if (!item.pool) return { ok: false };
      item.idx = (item.idx + 1) % data.routines[item.pool].length;
      return { ok: true };
    }
    const t = plan.tasks[item.task];
    const used = new Set(plan.items.filter((i) => i.p).map((i) => i.p.id));
    if (t.sleepPrep) {
      const prevEnd = Math.max(plan.W, ...plan.items.filter((i) => i !== item && i.end <= item.start + 1 && i.kind !== 'bed').map((i) => i.end));
      const c = t.patterns.filter((p) => !used.has(p.id) && plan.B - p.min >= prevEnd);
      if (!c.length) return { ok: false };
      const p = pick(rng, c);
      Object.assign(item, { p, start: plan.B - p.min, end: plan.B });
      return { ok: true };
    }
    const A = plan.answers;
    const maxEnd = Math.min(nextCoreStart(plan.items, item), plan.B);
    const c = t.patterns.filter((p) => {
      if (used.has(p.id)) return false;
      const dur = item.replacesMeal ? p.min : (t.dur || p.min);
      if (item.start + dur > maxEnd) return false;
      if (item.replacesMeal) return t.id === 'gourmet' || (p.meal || []).includes(item.replacesMeal === 'brunch' ? 'lunch' : item.replacesMeal);
      if (p.meal) return false;
      const times = t.times || p.times || ALL_SLOTS;
      return times.includes(slotOf(item.start)) && budgetOk(A, p) && weightFor(A, plan.M, p, item.start) > 0;
    });
    if (!c.length) return { ok: false };
    const p = pick(rng, c);
    item.p = p;
    item.end = item.start + (item.replacesMeal ? p.min : (t.dur || p.min));
    return { ok: true };
  }

  function deleteItem(plan, item) {
    const i = plan.items.indexOf(item);
    if (i < 0) return { ok: false };
    plan.items.splice(i, 1);
    return { ok: true };
  }

  function shiftItem(plan, item, delta) {
    const s = item.start + delta, e = item.end + delta;
    if (s < plan.W + 15) return { ok: false, reason: '起きる時間より前には動かせません' };
    if (e > plan.B) return { ok: false, reason: '寝る時間を過ぎてしまいます' };
    if (overlaps(plan.items, s, e, item)) return { ok: false, reason: 'ほかの予定と重なるため動かせません' };
    item.start = s; item.end = e;
    plan.items.sort((a, b) => a.start - b.start || (a.kind === 'bed' ? 1 : -1));
    return { ok: true };
  }

  function signature(plan) {
    return plan.items.map((i) => i.kind + ':' + (i.p ? i.p.id : i.idx) + '@' + i.start).join('|');
  }
  // 同じ回答から「前と違う」案をつくる
  function buildDifferentPlan(A, data, prevPlan, baseSeed) {
    const prevSig = prevPlan ? signature(prevPlan) : '';
    const prevActs = prevPlan ? new Set(prevPlan.items.filter((i) => i.p).map((i) => i.p.id)) : new Set();
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const plan = buildPlan(A, data, (baseSeed + i * 7919) >>> 0);
      if (signature(plan) === prevSig) continue;
      const acts = plan.items.filter((x) => x.p && x.task !== 'sleep');
      const diff = acts.filter((x) => !prevActs.has(x.p.id)).length / Math.max(1, acts.length);
      const score = diff - plan.unplaced.length * 0.3;
      if (score > bestScore) { best = plan; bestScore = score; }
      if (diff === 1 && !plan.unplaced.length) break;
    }
    return best || buildPlan(A, data, baseSeed);
  }

  const api = { buildPlan, buildDifferentPlan, displayItems, swapItem, deleteItem, shiftItem, sleepMinutes, timesFromAnswers, fmt, slotOf, signature };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
