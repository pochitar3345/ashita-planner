/*
 * 質問の分岐エンジン：data/questions.json の showIf / disableIf を評価する
 * ブラウザでは window.Flow、Node では module.exports
 */
(function (root) {
  'use strict';

  function evalCond(c, a) {
    if (!c) return true;
    if (c.any) return c.any.some((x) => evalCond(x, a));
    if (c.all) return c.all.every((x) => evalCond(x, a));
    if (c.not) return !evalCond(c.not, a);
    const v = a[c.q];
    if (v === undefined || v === null) return false;
    if ('eq' in c) return v === c.eq;
    if ('in' in c) return c.in.includes(v);
    if ('includes' in c) return Array.isArray(v) && v.includes(c.includes);
    if ('gt' in c) return typeof v === 'number' && v > c.gt;
    if ('lt' in c) return typeof v === 'number' && v < c.lt;
    return false;
  }

  const visible = (qs, a) => qs.filter((q) => evalCond(q.showIf, a));
  const optionDisabled = (o, a) => !!o.disableIf && evalCond(o.disableIf, a);

  function isAnswered(q, a) {
    const v = a[q.id];
    if (q.type === 'multi' || q.type === 'custom') return Array.isArray(v) && v.length > 0;
    if (q.type === 'text') return typeof v === 'string' && v.trim().length > 0;
    return v !== undefined && v !== null;
  }

  // 選び直したあと、出なくなった質問の回答や、選べなくなった回答を消す（何度か繰り返して安定させる）
  function prune(qs, a) {
    for (let round = 0; round < qs.length + 1; round++) {
      let changed = false;
      for (const q of qs) {
        if (!(q.id in a)) continue;
        if (!evalCond(q.showIf, a)) { delete a[q.id]; changed = true; continue; }
        if (q.type === 'single') {
          const o = q.options.find((x) => x.v === a[q.id]);
          if (!o || optionDisabled(o, a)) { delete a[q.id]; changed = true; }
        }
        if (q.type === 'multi' && Array.isArray(a[q.id])) {
          const ok = a[q.id].filter((v) => q.options.some((o) => o.v === v) || (q.presets && String(v).indexOf('preset:') === 0));
          if (ok.length !== a[q.id].length) { a[q.id] = ok; changed = true; }
        }
      }
      // 「その他」のよく使う項目：選択を外したら中身も消す
      if (Array.isArray(a.presets)) {
        const keep = a.presets.filter((p) => (a.wants || []).includes('preset:' + p.name));
        if (keep.length !== a.presets.length) { a.presets = keep; changed = true; }
      }
      if (!changed) break;
    }
    return a;
  }

  // 次に出す質問の位置（答えていない最初の質問）。全部答えていれば -1
  function firstUnanswered(qs, a) {
    const f = visible(qs, a);
    return f.findIndex((q) => !isAnswered(q, a));
  }

  // ---------- 矛盾チェック（Node のテストとアプリ起動時に使う） ----------
  function refs(c, out = []) {
    if (!c) return out;
    if (c.any) c.any.forEach((x) => refs(x, out));
    else if (c.all) c.all.forEach((x) => refs(x, out));
    else if (c.not) refs(c.not, out);
    else out.push(c);
    return out;
  }

  function validateStatic(qs) {
    const errors = [];
    const seen = new Map();
    qs.forEach((q, i) => {
      if (seen.has(q.id)) errors.push(`質問id「${q.id}」が2回あります`);
      seen.set(q.id, i);
      if ((q.type === 'single' || q.type === 'multi')) {
        if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`「${q.id}」の選択肢が2つ未満です`);
        else {
          const vals = q.options.map((o) => o.v);
          if (new Set(vals).size !== vals.length) errors.push(`「${q.id}」に同じ値の選択肢があります`);
          if (q.type === 'single' && q.options.every((o) => o.disableIf)) errors.push(`「${q.id}」はすべての選択肢が選べなくなる可能性があります（disableIf のない選択肢を1つ残してください）`);
        }
      }
      if (q.base && q.showIf) errors.push(`基本の質問「${q.id}」に showIf があります`);
      const conds = refs(q.showIf).concat(...(q.options || []).map((o) => refs(o.disableIf)));
      for (const c of conds) {
        if (!seen.has(c.q) || seen.get(c.q) >= i) { errors.push(`「${q.id}」の条件が、自分より前にない質問「${c.q}」を参照しています`); continue; }
        const target = qs[seen.get(c.q)];
        const vals = (target.options || []).map((o) => o.v);
        const want = 'eq' in c ? [c.eq] : 'in' in c ? c.in : 'includes' in c ? [c.includes] : [];
        for (const w of want) if (vals.length && !vals.includes(w)) errors.push(`「${q.id}」の条件の値「${w}」は「${c.q}」の選択肢にありません`);
      }
    });
    return errors;
  }

  // ランダムに答えていって、行き止まり・重複・終わらない を探す
  function simulate(qs, runs, seed) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const errors = [];
    const shown = new Set();
    for (let r = 0; r < runs; r++) {
      const a = {};
      const order = [];
      for (let guard = 0; guard <= qs.length + 1; guard++) {
        const idx = firstUnanswered(qs, a);
        if (idx === -1) break;
        const q = visible(qs, a)[idx];
        if (order.includes(q.id)) { errors.push(`同じ質問「${q.id}」が2回出ました`); break; }
        order.push(q.id); shown.add(q.id);
        if (q.type === 'single') {
          const ok = q.options.filter((o) => !optionDisabled(o, a));
          if (!ok.length) { errors.push(`「${q.id}」で選べる選択肢がありません（行き止まり）: ${JSON.stringify(a)}`); break; }
          a[q.id] = ok[Math.floor(rnd() * ok.length)].v;
        } else if (q.type === 'multi') {
          const n = 1 + Math.floor(rnd() * (q.max || q.options.length));
          const pool = q.options.map((o) => o.v).sort(() => rnd() - 0.5);
          a[q.id] = pool.slice(0, n);
        } else if (q.type === 'custom') {
          a[q.id] = [{ name: 'テスト', dur: 30, when: 'any', fixed: false, place: 'indoor' }];
        } else if (q.type === 'text') {
          a[q.id] = 'テスト';
        }
        // ときどき前の質問に戻って選び直す
        if (rnd() < 0.15 && order.length > 1) {
          const back = qs.find((x) => x.id === order[Math.floor(rnd() * order.length)]);
          if (back && back.type === 'single') {
            const ok = back.options.filter((o) => !optionDisabled(o, a));
            if (ok.length) a[back.id] = ok[Math.floor(rnd() * ok.length)].v;
          }
          prune(qs, a);
          order.length = 0;
          visible(qs, a).forEach((x) => { if (isAnswered(x, a)) order.push(x.id); });
        }
      }
      if (firstUnanswered(qs, a) !== -1) errors.push('最後まで進めませんでした: ' + JSON.stringify(a));
      const vis = new Set(visible(qs, a).map((q) => q.id));
      for (const k of Object.keys(a)) if (k !== 'presets' && !vis.has(k)) errors.push(`出ていない質問「${k}」の回答が残っています`);
      if (errors.length > 20) break;
    }
    for (const q of qs) if (!shown.has(q.id)) errors.push(`質問「${q.id}」はどの回答でも出てきません`);
    return { errors: Array.from(new Set(errors)), shown: shown.size };
  }

  const api = { evalCond, visible, optionDisabled, isAnswered, prune, firstUnanswered, validateStatic, simulate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Flow = api;
})(typeof window !== 'undefined' ? window : globalThis);
