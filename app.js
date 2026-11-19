/* あしたプランナー：画面の動き（質問は data/questions.json、素材は data/activities.json） */
(function () {
  'use strict';
  const P = window.Planner;
  const F = window.Flow;
  const app = document.getElementById('app');
  const KEY_LAST = 'ashita-planner:v2:last';
  const KEY_PRESETS = 'ashita-planner:v2:presets';

  // ---------- 状態 ----------
  const S = {
    data: null, qs: null, screen: 'start',
    answers: {}, cur: null,      // cur = いま表示している質問id
    cw: null,                    // 「その他」入力の途中 { step, draft }
    plan: null, view: [], openKey: null
  };

  // ---------- 保存（ブラウザ内だけ） ----------
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 保存できなくても動く */ } }
  function load(key) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function loadPresets() { const p = load(KEY_PRESETS); return Array.isArray(p) ? p.filter((x) => x && typeof x.name === 'string') : []; }
  function savePreset(item) {
    const list = loadPresets();
    const hit = list.find((x) => x.name === item.name);
    if (hit) Object.assign(hit, item, { count: (hit.count || 0) + 1, last: Date.now() });
    else list.push(Object.assign({}, item, { count: 1, last: Date.now() }));
    list.sort((a, b) => b.count - a.count || b.last - a.last);
    store(KEY_PRESETS, list.slice(0, 10));
  }

  // ---------- 小道具 ----------
  // 画面に出す文字は必ずここを通す（「その他」の入力をHTMLとして解釈させない）
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function cleanText(s, max) {
    return Array.from(String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
  }
  const fmt = P.fmt;
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function tomorrow() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return d; }
  const dateLabel = (d) => (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）';
  function durLabel(min) { const h = Math.floor(min / 60), m = min % 60; return (h ? h + '時間' : '') + (m || !h ? m + '分' : ''); }
  const hm = (min) => Math.floor(min / 60) + '時間' + (min % 60) + '分';
  const yen = (n) => n === 0 ? '0円' : '約' + n.toLocaleString('ja-JP') + '円';
  function newSeed() { try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return (Math.random() * 4294967296) >>> 0; } }
  const qById = (id) => S.qs.find((q) => q.id === id);
  function optLabel(id, v) { const q = qById(id); const o = q && (q.options || []).find((x) => x.v === v); return o ? o.label : ''; }
  const parseVal = (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw);

  let toastTimer;
  function toast(msg, action) {
    const t = document.getElementById('toast');
    t.innerHTML = esc(msg) + (action ? ` <button type="button" class="toast-act">${esc(action.label)}</button>` : '');
    t.classList.toggle('has-action', !!action);
    t.classList.add('show');
    if (action) t.querySelector('.toast-act').onclick = () => { t.classList.remove('show'); action.run(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2200);
  }

  // ---------- 質問の流れ ----------
  const flow = () => F.visible(S.qs, S.answers);
  function goTo(id) { S.cur = id; S.cw = null; S.screen = 'q'; renderQuestion(true); }
  function goNextFrom(id) {
    F.prune(S.qs, S.answers);
    const f = flow();
    const i = f.findIndex((q) => q.id === id);
    const next = f[i + 1];
    if (!next) { showResult(); return; }
    goTo(next.id);
  }
  function goBack() {
    if (S.cw) { cwBack(); return; }
    const f = flow();
    const i = f.findIndex((q) => q.id === S.cur);
    if (i <= 0) { S.screen = 'start'; renderStart(); return; }
    goTo(f[i - 1].id);
  }

  // ---------- 画面：スタート ----------
  function renderStart() {
    const last = load(KEY_LAST);
    let lastOk = false;
    if (last && last.answers) { const a = JSON.parse(JSON.stringify(last.answers)); F.prune(S.qs, a); lastOk = F.firstUnanswered(S.qs, a) === -1; }
    app.innerHTML = `
      <section class="start">
        <div class="start-hero">
          <div class="start-emoji" aria-hidden="true">🌙</div>
          <h1>あしたプランナー</h1>
          <p>質問に答えて、選ぶだけ。<br>明日1日の予定ができあがります。</p>
        </div>
        <ul class="start-points">
          <li><span aria-hidden="true">👆</span>基本はタップするだけ。やりたいことは「その他」で足せます</li>
          <li><span aria-hidden="true">🔀</span>答えに合わせて、次の質問が変わります（2分以内）</li>
          <li><span aria-hidden="true">🔒</span>ログイン不要。回答はこの端末の中だけに保存されます</li>
        </ul>
        <div class="start-actions">
          <button class="btn btn-primary" data-act="begin">明日の予定をつくる</button>
          ${lastOk ? `<button class="btn btn-secondary" data-act="reuse">前回と同じ条件で始める</button>
          <div class="last-summary">前回：${esc(summary(last.answers))}</div>` : ''}
        </div>
      </section>`;
  }
  function summary(a) {
    const parts = [optLabel('day', a.day)];
    if (a.wake != null) parts.push(optLabel('wake', a.wake) + '起床');
    const names = (a.wants || []).filter((w) => w !== 'custom' && String(w).indexOf('preset:') !== 0).map((w) => optLabel('wants', w));
    (a.custom || []).concat(a.presets || []).forEach((c) => names.push(c.name));
    if (names.length) parts.push(names.join('・'));
    if (a.bed != null) parts.push(optLabel('bed', a.bed) + 'に寝る');
    return parts.join(' / ');
  }

  // ---------- 画面：質問 ----------
  function topbar(sub) {
    const f = flow();
    const i = Math.max(0, f.findIndex((q) => q.id === S.cur));
    const n = i + 1, left = f.length - n;
    return `
      <div class="topbar">
        <div class="topbar-row">
          <button class="back" data-act="back" aria-label="前の画面に戻る">← 戻る</button>
          <div class="progress-text" aria-label="${n}問目、残り約${left}問">${n}問目<small>・残り約${left}問</small></div>
          <span class="topbar-spacer" aria-hidden="true"></span>
        </div>
        <div class="progress" aria-hidden="true"><div style="width:${Math.round((i / f.length) * 100)}%" data-to="${Math.round((n / f.length) * 100)}"></div></div>
        ${sub ? `<div class="subprogress">${esc(sub)}</div>` : ''}
      </div>`;
  }
  function frame(title, hint, body, sub) {
    app.innerHTML = `
      <section class="q">
        ${topbar(sub)}
        <div class="q-head"><h2 tabindex="-1" id="qtitle">${esc(title)}</h2>${hint ? `<p class="q-hint">${esc(hint)}</p>` : ''}</div>
        ${body}
      </section>`;
    requestAnimationFrame(() => {
      const bar = app.querySelector('.progress > div');
      if (bar) bar.style.width = bar.dataset.to + '%';
    });
  }
  function focusTitle() { const h = document.getElementById('qtitle'); if (h) h.focus({ preventScroll: true }); window.scrollTo(0, 0); }

  function optionButtons(qid, options, cur, dataAttr) {
    return `<div class="opts" role="group">` + options.map((o) => {
      const dis = F.optionDisabled(o, S.answers);
      const sub = dis ? (o.disabledNote || '選べません') : (o.sub || '');
      return `<button class="opt ${cur === o.v ? 'selected' : ''}" ${dataAttr}="${esc(qid)}" data-v="${esc(o.v)}" ${dis ? 'disabled' : ''}>
        <span class="em" aria-hidden="true">${o.em || ''}</span><span>${esc(o.label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span></button>`;
    }).join('') + '</div>';
  }

  function renderQuestion(focus) {
    if (S.cw) { renderCustomStep(focus); return; }
    const q = qById(S.cur);
    const a = S.answers;
    if (q.type === 'single') {
      frame(q.title, q.hint, optionButtons(q.id, q.options, a[q.id], 'data-key'));
    } else if (q.type === 'multi') {
      const sel = a[q.id] || [];
      const full = sel.length >= q.max;
      const presets = q.presets ? loadPresets().slice(0, 3) : [];
      const chip = (v, label, em, extra) => {
        const on = sel.includes(v);
        return `<button class="chip ${on ? 'selected' : ''} ${extra || ''}" data-multi="${esc(q.id)}" data-v="${esc(v)}" aria-pressed="${on}" ${!on && full ? 'disabled' : ''}>
          <span class="em" aria-hidden="true">${em}</span><span class="chip-label">${esc(label)}</span></button>`;
      };
      let body = `<div class="chips" role="group">` + q.options.map((o) => chip(o.v, o.label, o.em, o.v === 'custom' ? 'chip-custom' : '')).join('') + '</div>';
      if (presets.length) {
        body += `<h3 class="chips-head">よく使う「その他」</h3><div class="chips">` + presets.map((p) => chip('preset:' + p.name, p.name, p.fixed ? '📍' : '✏️', 'chip-preset')).join('') + '</div>';
      }
      body += `<div class="multi-foot">
          <div class="multi-count">${sel.length ? sel.length + 'つ選択中' + (full ? '（いっぱいです）' : '・あと' + (q.max - sel.length) + 'つ選べます') : '1つ以上選んでください'}</div>
          <button class="btn btn-primary" data-act="next" ${sel.length ? '' : 'disabled'}>決定して次へ</button>
        </div>`;
      frame(q.title, q.hint, body);
    } else if (q.type === 'text') {
      const v = a[q.id] || '';
      frame(q.title, q.hint, textInput(q, v, 'text-' + q.id) + `<div class="multi-foot"><button class="btn btn-primary" data-act="text-next" ${cleanText(v, q.maxLength) ? '' : 'disabled'}>次へ</button></div>`);
    } else if (q.type === 'custom') {
      renderCustomList();
    }
    if (focus) focusTitle();
  }

  function textInput(q, v, id) {
    const len = Array.from(v).length;
    return `<div class="text-wrap">
      <label class="sr-only" for="${id}">${esc(q.title)}</label>
      <input id="${id}" class="text-in" type="text" inputmode="text" autocomplete="off" enterkeyhint="next"
        maxlength="${q.maxLength}" placeholder="${esc(q.placeholder || '')}" value="${esc(v)}">
      <div class="counter"><span id="${id}-n">${len}</span> / ${q.maxLength}文字</div>
    </div>`;
  }

  // ---------- 「その他」 ----------
  const customQ = () => qById('custom');
  const customMax = () => customQ().max - (S.answers.presets || []).length;
  function optLabelFrom(options, v) { const o = options.find((x) => x.v === v); return o ? o.label : ''; }
  function renderCustomList() {
    const q = customQ();
    const list = S.answers.custom || [];
    const room = customMax() - list.length;
    const st = q.steps;
    const items = list.map((c, i) => `
      <li class="cl-item">
        <div class="cl-main">
          <div class="cl-name"><span class="mark mark-custom">その他</span> ${esc(c.name)}</div>
          <div class="cl-meta">${esc(optLabelFrom(st.dur.options, c.dur))}・${c.fixed ? esc(fmt(c.start) + 'から') : esc(optLabelFrom(st.when.options, c.when))}・${c.place === 'outdoor' ? '外' : '家'}</div>
        </div>
        <button class="icon-btn" data-cdel="${i}" aria-label="${esc(c.name)}を消す">✕</button>
      </li>`).join('');
    frame(q.title, (S.answers.presets || []).length ? `よく使う「その他」と合わせて${q.max}つまで追加できます` : q.hint, `
      ${list.length ? `<ul class="cl">${items}</ul>` : '<p class="empty">まだありません。下のボタンから追加してください。</p>'}
      <div class="cl-actions">
        ${room > 0 ? `<button class="btn btn-secondary" data-act="cadd">＋ やりたいことを追加${list.length ? '（あと' + room + 'つ）' : ''}</button>` : `<p class="empty">追加できるのは${q.max}つまでです</p>`}
      </div>
      <div class="multi-foot">
        <button class="btn btn-primary" data-act="cnext" ${list.length ? '' : 'disabled'}>次へ</button>
        ${list.length ? '' : '<button class="btn btn-ghost" data-act="cskip">「その他」はやめる</button>'}
      </div>`);
  }

  const CW_ORDER = ['name', 'dur', 'when', 'fixed', 'start', 'place'];
  function cwSteps() { return CW_ORDER.filter((s) => s !== 'start' || (S.cw && S.cw.draft.fixed)); }
  function renderCustomStep(focus) {
    const q = customQ();
    const { step, draft } = S.cw;
    const steps = cwSteps();
    const nth = (S.answers.custom || []).length + 1;
    const sub = `その他 ${nth}つ目：${steps.indexOf(step) + 1} / ${steps.length}`;
    if (step === 'name') {
      const presets = loadPresets().filter((p) => !(S.answers.custom || []).some((c) => c.name === p.name)).slice(0, 4);
      frame('やりたいことを入力してください', `${q.maxLength}文字まで`, textInput({ title: 'やりたいこと', maxLength: q.maxLength, placeholder: q.placeholder }, draft.name || '', 'cw-name') +
        (presets.length ? `<div class="suggest"><span>前に入れたもの：</span>${presets.map((p) => `<button class="mini-chip" data-cwname="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div>` : '') +
        `<div class="multi-foot"><button class="btn btn-primary" data-act="cw-name-next" ${cleanText(draft.name, q.maxLength) ? '' : 'disabled'}>次へ</button></div>`, sub);
    } else if (step === 'start') {
      const def = q.steps.start;
      let html = '<div class="time-grid" role="group">';
      for (let m = def.from; m <= def.to; m += def.step) {
        const outOfDay = m < S.answers.wake * 60 + 15 || m >= S.answers.bed * 60;
        html += `<button class="time-chip ${draft.start === m ? 'selected' : ''}" data-cwstart="${m}" ${outOfDay ? 'disabled' : ''}>${fmt(m)}</button>`;
      }
      html += '</div><p class="q-hint">起きる前・寝たあとの時間は選べません</p>';
      frame(def.title, '30分きざみで選べます', html, sub);
    } else {
      const def = q.steps[step];
      frame(def.title, `「${draft.name}」について`, optionButtons(step, def.options, draft[step === 'fixed' ? 'fixedV' : step], 'data-cw'), sub);
    }
    if (focus) focusTitle();
  }
  function cwBack() {
    const steps = cwSteps();
    const i = steps.indexOf(S.cw.step);
    if (i <= 0) { S.cw = null; renderQuestion(true); return; }
    S.cw.step = steps[i - 1];
    renderCustomStep(true);
  }
  function cwAdvance() {
    const steps = cwSteps();
    const i = steps.indexOf(S.cw.step);
    if (i + 1 < steps.length) { S.cw.step = steps[i + 1]; renderCustomStep(true); return; }
    const d = S.cw.draft;
    const item = { name: d.name, dur: d.dur, when: d.when, fixed: !!d.fixed, place: d.place };
    if (d.fixed) item.start = d.start;
    S.answers.custom = (S.answers.custom || []).concat([item]).slice(0, customMax());
    savePreset(item);
    S.cw = null;
    renderQuestion(true);
    toast('「' + item.name + '」を追加しました');
  }

  // ---------- 回答を記録 ----------
  function setSingle(id, v) { S.answers[id] = v; F.prune(S.qs, S.answers); }
  function toggleMulti(id, v) {
    const q = qById(id);
    const sel = new Set(S.answers[id] || []);
    if (sel.has(v)) sel.delete(v); else if (sel.size < q.max) sel.add(v); else return;
    const order = q.options.map((o) => o.v);
    S.answers[id] = Array.from(sel).sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
    if (String(v).indexOf('preset:') === 0) {
      const name = v.slice(7);
      const list = (S.answers.presets || []).filter((p) => p.name !== name);
      if (sel.has(v)) {
        const p = loadPresets().find((x) => x.name === name);
        if (p) list.push({ name: p.name, dur: p.dur, when: p.when, fixed: !!p.fixed, start: p.start, place: p.place });
      }
      S.answers.presets = list;
      // 「その他」の合計が3つを超えないように
      if (S.answers.custom) S.answers.custom = S.answers.custom.slice(0, Math.max(0, customQ().max - list.length));
    }
    F.prune(S.qs, S.answers);
  }

  // ---------- 画面：結果 ----------
  function showResult(keepPlan) {
    F.prune(S.qs, S.answers);
    store(KEY_LAST, { answers: S.answers, savedAt: Date.now() });
    if (!keepPlan) S.plan = P.buildPlan(S.answers, S.data, newSeed());
    S.screen = 'result'; S.openKey = null;
    renderResult();
    window.scrollTo(0, 0);
  }
  const itemKey = (d) => d.kind + '@' + d.start + ':' + (d.ref.fillerKey || '');

  function renderResult() {
    const plan = S.plan, a = plan.answers;
    S.view = P.displayItems(plan, S.data);
    const sleep = plan.sleepMin, short = sleep < 420;
    const tags = [optLabel('day', a.day), optLabel('energy', a.energy)];
    if (a.offstyle) tags.push(optLabel('offstyle', a.offstyle));
    if (a.afterwork) tags.push('帰宅後：' + optLabel('afterwork', a.afterwork));
    if (a.budget != null) tags.push('予算 ' + optLabel('budget', a.budget));
    const items = S.view.map((d, i) => {
      if (d.kind === 'bed') {
        return `<li class="tl kind-bed"><div class="tl-time">${fmt(d.start)}</div><div class="tl-dot" aria-hidden="true">${d.emoji}</div>
          <div class="tl-body"><div class="tl-title"><span><span class="mark">就寝</span> おやすみなさい</span></div></div></li>`;
      }
      const meta = [];
      if (d.place) meta.push(d.place === 'outdoor' ? '🚶 外' : '🏠 室内');
      if (d.cost != null) meta.push('💴 ' + yen(d.cost));
      if (d.energy) meta.push({ low: '体力：低', mid: '体力：中', high: '体力：高' }[d.energy]);
      const editable = d.swappable || d.canShift || d.canDelete;
      const open = editable && S.openKey === itemKey(d);
      return `<li class="tl kind-${d.kind} ${d.custom ? 'is-custom' : ''} ${open ? 'open' : ''}" data-i="${i}">
        <div class="tl-time">${fmt(d.start)}<small>〜${fmt(d.end)}</small></div>
        <div class="tl-dot" aria-hidden="true">${d.emoji}</div>
        <div class="tl-body">
          ${editable ? `<button class="tl-hit" data-toggle="${i}" aria-expanded="${open}" aria-label="${esc(d.title)}を調整する"></button>` : ''}
          <div class="tl-title"><span>${d.mark ? `<span class="mark">${esc(d.mark)}</span> ` : ''}${d.custom ? '<span class="mark mark-custom">その他</span> ' : ''}${esc(d.title)}</span><span class="dur">${durLabel(d.end - d.start)}</span>${editable ? `<span class="chev" aria-hidden="true">${open ? '▲' : '▼'}</span>` : ''}</div>
          ${d.desc ? `<div class="tl-desc">${esc(d.desc)}</div>` : ''}
          ${meta.length ? `<div class="tl-meta">${meta.join('　')}</div>` : ''}
          ${open ? `<div class="tools" role="group" aria-label="${esc(d.title)}の調整">
            ${d.swappable ? `<button class="tool" data-tool="swap" data-i="${i}">↻ 入れ替える</button>` : ''}
            ${d.canShift ? `<button class="tool" data-tool="minus" data-i="${i}">－30分</button><button class="tool" data-tool="plus" data-i="${i}">＋30分</button>` : ''}
            ${d.canDelete ? `<button class="tool tool-del" data-tool="del" data-i="${i}">🗑 削除</button>` : ''}
          </div>` : ''}
        </div></li>`;
    }).join('');
    const unplaced = plan.unplaced.length ? `
      <section class="card unplaced" id="unplaced">
        <h3>入りきらなかった予定</h3>
        <ul>${plan.unplaced.map((u) => `<li>${u.custom ? '<span class="mark mark-custom">その他</span> ' : ''}<strong>${esc(u.label)}</strong><span>${esc(u.reason)}</span></li>`).join('')}</ul>
      </section>` : '';
    app.innerHTML = `
      <section class="result">
        <div class="result-head">
          <h2>明日の予定</h2>
          <div class="date">${dateLabel(tomorrow())}</div>
          <ul class="tags">${tags.filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        </div>
        <div class="card sleep ${short ? 'short' : ''}" id="sleep-card">
          <div class="em" aria-hidden="true">${short ? '⚠️' : '😴'}</div>
          <div>
            <strong>${fmt(a.bed * 60)}に寝れば、${hm(sleep)}眠れます</strong>
            <p>${short ? '少し睡眠が短めです。寝る時間を早めると明日がラクになります。' : '起きる時間（' + fmt(a.wake * 60) + '）までの睡眠時間です。7時間以上とれていて安心です。'}</p>
          </div>
        </div>
        ${plan.notes.length ? `<div class="card notes">${plan.notes.map((n) => `<p>💡 ${esc(n)}</p>`).join('')}</div>` : ''}
        <p class="tl-hint">予定をタップすると「入れ替える・時間をずらす・削除」ができます</p>
        <ol class="timeline" id="timeline">${items}</ol>
        ${unplaced}
        <div class="sticky-again"><button class="btn btn-primary" data-act="again">🔀 別の案にする</button></div>
        <div class="actions">
          <h3>予定を持ち出す</h3>
          <div class="export-grid">
            <button class="btn btn-secondary" data-act="copy">📋 テキストでコピー</button>
            <button class="btn btn-secondary" data-act="image">🖼️ 画像で保存</button>
            <button class="btn btn-secondary" data-act="ics">📅 カレンダーに追加（.ics）</button>
          </div>
          <h3>もう一度</h3>
          <button class="btn btn-ghost" data-act="restart">↺ 最初からやり直す</button>
        </div>
        <p class="privacy">回答はこの端末のブラウザにだけ保存され、外部には送られません。</p>
      </section>`;
  }

  function snapshot() { return S.plan.items.map((i) => Object.assign({}, i)); }
  function tool(kind, i) {
    const d = S.view[i];
    const before = snapshot();
    const keepY = window.scrollY;
    let res, msg;
    if (kind === 'swap') { res = P.swapItem(S.plan, S.data, d.ref, d.ref.fillerKey != null ? d.ref.fillerKey : null); msg = res.ok ? '入れ替えました' : 'ほかに入る候補がありませんでした'; }
    if (kind === 'minus' || kind === 'plus') { res = P.shiftItem(S.plan, d.ref, kind === 'plus' ? 30 : -30); msg = res.ok ? (kind === 'plus' ? '30分うしろにずらしました' : '30分まえにずらしました') : res.reason; }
    if (kind === 'del') { res = P.deleteItem(S.plan, d.ref); msg = res.ok ? '「' + d.title + '」を削除しました' : '削除できませんでした'; }
    if (!res.ok) { toast(msg); return; }
    S.openKey = kind === 'del' ? null : d.kind + '@' + d.ref.start + ':' + (d.ref.fillerKey || '');
    renderResult();
    window.scrollTo(0, keepY);
    const li = app.querySelector('.tl.open');
    if (li) li.classList.add('flash');
    if (kind === 'swap') toast(msg);
    else toast(msg, { label: '元に戻す', run: () => { S.plan.items = before; S.openKey = null; renderResult(); window.scrollTo(0, keepY); } });
  }

  // ---------- 持ち出し：テキスト ----------
  function planText() {
    const a = S.plan.answers;
    const lines = ['【明日の予定】' + dateLabel(tomorrow())];
    for (const d of S.view) {
      if (d.kind === 'bed') { lines.push(fmt(d.start) + ' 🌙 就寝'); continue; }
      lines.push(fmt(d.start) + '〜' + fmt(d.end) + ' ' + d.emoji + ' ' + (d.custom ? '［その他］' : '') + d.title + (d.desc ? '：' + d.desc : ''));
    }
    if (S.plan.unplaced.length) lines.push('（入りきらなかった予定：' + S.plan.unplaced.map((u) => u.label).join('、') + '）');
    lines.push('😴 睡眠 ' + hm(S.plan.sleepMin) + '（' + fmt(a.bed * 60) + '〜' + fmt(a.wake * 60) + '）');
    return lines.join('\n');
  }
  async function copyText() {
    const text = planText();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    toast(ok ? 'コピーしました。LINEやメモに貼りつけできます' : 'コピーできませんでした');
  }

  // ---------- 持ち出し：画像（Canvasに直接描く） ----------
  function drawImage() {
    const W = 1080, PAD = 64, a = S.plan.answers;
    const font = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const textX = PAD + 210, textW = W - textX - PAD;
    function wrap(text, size, weight) {
      ctx.font = weight + ' ' + size + 'px ' + font;
      const out = []; let line = '';
      for (const ch of Array.from(text)) {
        if (ctx.measureText(line + ch).width > textW && line) { out.push(line); line = ch; } else line += ch;
      }
      if (line) out.push(line);
      return out;
    }
    const rows = S.view.map((d) => {
      const title = d.kind === 'bed' ? '就寝' : (d.custom ? '［その他］' : '') + d.title;
      const t = wrap((d.emoji ? d.emoji + ' ' : '') + title, 38, '800');
      const desc = d.desc && d.kind !== 'bed' ? wrap(d.desc, 32, '500') : [];
      return { d, t, desc, h: t.length * 52 + desc.length * 44 + 34 };
    });
    const headH = 250, footH = 190;
    const H = headH + rows.reduce((s, r) => s + r.h, 0) + footH;
    c.width = W; c.height = H;
    ctx.fillStyle = '#FFF7EE'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#776B61'; ctx.font = '700 34px ' + font; ctx.fillText('明日の予定', PAD, 64);
    ctx.fillStyle = '#2B2622'; ctx.font = '800 64px ' + font; ctx.fillText(dateLabel(tomorrow()), PAD, 110);
    ctx.strokeStyle = '#F0DCC8'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(PAD + 175, headH + 10); ctx.lineTo(PAD + 175, H - footH - 20); ctx.stroke();
    let y = headH;
    for (const r of rows) {
      const act = r.d.kind === 'activity';
      ctx.fillStyle = '#2B2622'; ctx.font = '800 36px ' + font; ctx.textAlign = 'right';
      ctx.fillText(fmt(r.d.start), PAD + 150, y + 6);
      ctx.textAlign = 'left';
      const dot = r.d.custom ? '#2F8F7B' : act ? '#E8743B' : null;
      ctx.fillStyle = dot || '#FFFFFF'; ctx.strokeStyle = dot || '#E2C9B2'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(PAD + 175, y + 26, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      let yy = y;
      ctx.fillStyle = r.d.custom ? '#22705F' : act ? '#C9561F' : '#2B2622'; ctx.font = '800 38px ' + font;
      for (const l of r.t) { ctx.fillText(l, textX, yy); yy += 52; }
      ctx.fillStyle = '#5E544B'; ctx.font = '500 32px ' + font;
      for (const l of r.desc) { ctx.fillText(l, textX, yy); yy += 44; }
      y += r.h;
    }
    const sleepShort = S.plan.sleepMin < 420;
    ctx.fillStyle = sleepShort ? '#FFF3D1' : '#FFE2CF';
    roundRect(ctx, PAD, H - footH + 10, W - PAD * 2, 110, 28); ctx.fill();
    ctx.fillStyle = sleepShort ? '#6E4C00' : '#2B2622'; ctx.font = '800 36px ' + font;
    ctx.fillText((sleepShort ? '⚠️ ' : '😴 ') + fmt(a.bed * 60) + 'に寝れば ' + hm(S.plan.sleepMin) + ' 眠れます', PAD + 32, H - footH + 46);
    ctx.fillStyle = '#A0938A'; ctx.font = '600 24px ' + font; ctx.textAlign = 'right';
    ctx.fillText('あしたプランナー', W - PAD, H - 50);
    return c;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fileStamp() { const d = tomorrow(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function saveImage() {
    drawImage().toBlob(async (blob) => {
      if (!blob) { toast('画像をつくれませんでした'); return; }
      const name = 'ashita-plan-' + fileStamp() + '.png';
      const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        try { await navigator.share({ files: [file], title: '明日の予定' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      download(blob, name);
      toast('画像を保存しました');
    }, 'image/png');
  }

  // ---------- 持ち出し：.ics ----------
  const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  function foldLine(line) {
    const enc = new TextEncoder();
    const out = []; let cur = '', bytes = 0;
    for (const ch of Array.from(line)) {
      const b = enc.encode(ch).length;
      if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  function icsTime(base, min) {
    const d = new Date(base.getTime()); d.setMinutes(min);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T' + p(d.getHours()) + p(d.getMinutes()) + '00';
  }
  function makeIcs() {
    const base = tomorrow();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ashita-planner//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:明日の予定'];
    S.view.forEach((d, i) => {
      if (d.kind === 'bed' || d.kind === 'free' || d.end <= d.start) return;
      lines.push('BEGIN:VEVENT', 'UID:' + fileStamp() + '-' + i + '-' + S.plan.seed + '@ashita-planner', 'DTSTAMP:' + stamp,
        'DTSTART:' + icsTime(base, d.start), 'DTEND:' + icsTime(base, d.end),
        'SUMMARY:' + icsEscape(d.emoji + ' ' + d.title), 'DESCRIPTION:' + icsEscape(d.desc || ''), 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }
  function saveIcs() {
    download(new Blob([makeIcs()], { type: 'text/calendar;charset=utf-8' }), 'ashita-plan-' + fileStamp() + '.ics');
    toast('.ics を保存しました。カレンダーアプリで開いてください');
  }

  // ---------- 操作 ----------
  app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.classList.contains('text-in')) return;
    const max = Number(el.getAttribute('maxlength')) || 20;
    const arr = Array.from(el.value);
    if (arr.length > max) el.value = arr.slice(0, max).join('');
    const n = document.getElementById(el.id + '-n');
    if (n) n.textContent = Array.from(el.value).length;
    const v = cleanText(el.value, max);
    if (el.id === 'cw-name') {
      S.cw.draft.name = v;
      app.querySelector('[data-act="cw-name-next"]').disabled = !v;
    } else if (el.id.indexOf('text-') === 0) {
      const qid = el.id.slice(5);
      if (v) S.answers[qid] = v; else delete S.answers[qid];
      app.querySelector('[data-act="text-next"]').disabled = !v;
    }
  });
  app.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !ev.target.classList.contains('text-in') || ev.isComposing) return;
    ev.preventDefault();
    const btn = app.querySelector('[data-act="cw-name-next"], [data-act="text-next"]');
    if (btn && !btn.disabled) btn.click();
  });

  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'begin' || act === 'restart') { S.answers = {}; goTo(S.qs[0].id); return; }
    if (act === 'reuse') { const last = load(KEY_LAST); if (last) { S.answers = last.answers; showResult(); } return; }
    if (act === 'back') { goBack(); return; }
    if (act === 'next' || act === 'text-next') { goNextFrom(S.cur); return; }
    if (act === 'cadd') { S.cw = { step: 'name', draft: {} }; renderCustomStep(true); return; }
    if (act === 'cnext') { goNextFrom('custom'); return; }
    if (act === 'cskip') { toggleMulti('wants', 'custom'); goNextFrom('wants'); return; }
    if (act === 'cw-name-next') { cwAdvance(); return; }
    if (act === 'again') {
      S.plan = P.buildDifferentPlan(S.plan.answers, S.data, S.plan, newSeed());
      S.openKey = null; renderResult(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('別の案にしました'); return;
    }
    if (act === 'copy') { copyText(); return; }
    if (act === 'image') { saveImage(); return; }
    if (act === 'ics') { saveIcs(); return; }
    if (el.dataset.key) {
      const id = el.dataset.key;
      setSingle(id, parseVal(el.dataset.v));
      app.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b === el));
      setTimeout(() => goNextFrom(id), 180);
      return;
    }
    if (el.dataset.multi) {
      const y = window.scrollY;
      toggleMulti(el.dataset.multi, el.dataset.v);
      renderQuestion(false); window.scrollTo(0, y); return;
    }
    if (el.dataset.cdel != null) {
      const list = (S.answers.custom || []).slice();
      const [gone] = list.splice(Number(el.dataset.cdel), 1);
      S.answers.custom = list;
      renderQuestion(false);
      toast('「' + gone.name + '」を消しました');
      return;
    }
    if (el.dataset.cwname) {
      const p = loadPresets().find((x) => x.name === el.dataset.cwname);
      S.cw.draft = p ? { name: p.name, dur: p.dur, when: p.when, fixed: !!p.fixed, fixedV: p.fixed ? 'yes' : 'no', start: p.start, place: p.place } : { name: el.dataset.cwname };
      renderCustomStep(false);
      return;
    }
    if (el.dataset.cw) {
      const step = el.dataset.cw, v = parseVal(el.dataset.v);
      if (step === 'fixed') { S.cw.draft.fixedV = v; S.cw.draft.fixed = v === 'yes'; if (v !== 'yes') delete S.cw.draft.start; }
      else S.cw.draft[step] = v;
      app.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b === el));
      setTimeout(cwAdvance, 180);
      return;
    }
    if (el.dataset.cwstart) {
      S.cw.draft.start = Number(el.dataset.cwstart);
      app.querySelectorAll('.time-chip').forEach((b) => b.classList.toggle('selected', b === el));
      setTimeout(cwAdvance, 180);
      return;
    }
    if (el.dataset.toggle != null) {
      const k = itemKey(S.view[Number(el.dataset.toggle)]);
      S.openKey = S.openKey === k ? null : k;
      const y = window.scrollY; renderResult(); window.scrollTo(0, y);
      return;
    }
    if (el.dataset.tool) tool(el.dataset.tool, Number(el.dataset.i));
  });

  // ---------- 起動 ----------
  Promise.all([
    fetch('data/activities.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch('data/questions.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  ]).then(([acts, qs]) => {
    S.data = acts;
    S.qs = qs.questions;
    const errs = F.validateStatic(S.qs);
    if (errs.length) console.warn('questions.json の確認：', errs);
    renderStart();
  }).catch(() => {
    app.innerHTML = '<p class="loading">データを読みこめませんでした。ページを再読みこみしてください。</p>';
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  window.__ashita = { state: S, planText, makeIcs };
})();
