/* あしたプランナー：画面の動き */
(function () {
  'use strict';
  const P = window.Planner;
  const app = document.getElementById('app');
  const STORE_KEY = 'ashita-planner:v1:last';

  // ---------- 質問 ----------
  const Q = {
    day: {
      title: '明日はどんな日？',
      options: [
        { v: 'work', label: '仕事の日', em: '💼' },
        { v: 'school', label: '学校の日', em: '🏫' },
        { v: 'off', label: '休みの日', em: '🌿' },
        { v: 'half', label: '半日だけ予定がある', em: '🕐' }
      ]
    },
    wake: {
      title: '何時に起きる？',
      options: [6, 7, 8, 9].map((h) => ({ v: h, label: h + '時台', em: ['🌄', '🌅', '☀️', '🌤️'][h - 6] })).concat([{ v: 10, label: '10時以降', em: '😴' }])
    },
    depart: {
      title: '何時に家を出る？',
      hint: '仕事・学校に行く時間です',
      options: [6, 7, 8].map((h) => ({ v: h, label: h + '時台', em: '🚪' })).concat([{ v: 9, label: '9時以降', em: '🚪' }])
    },
    ret: {
      title: '何時に帰る？',
      hint: '家に着く時間です',
      options: [17, 18, 19].map((h) => ({ v: h, label: h + '時台', em: '🏠' })).concat([{ v: 20, label: '20時以降', em: '🏠' }])
    },
    half: {
      title: '予定があるのは？',
      options: [
        { v: 'am', label: '午前', em: '🌅', sub: 'だいたい 9時〜12時' },
        { v: 'pm', label: '午後', em: '🌞', sub: 'だいたい 13時〜17時' },
        { v: 'eve', label: '夕方以降', em: '🌆', sub: 'だいたい 18時半〜21時' }
      ]
    },
    wants: { title: '明日やりたいことは？', hint: '4つまで選べます', multi: true, max: 4 },
    energy: {
      title: '明日の体力・気分は？',
      options: [
        { v: 'genki', label: '元気いっぱい', em: '💪', sub: '予定を多めに入れます' },
        { v: 'normal', label: 'ふつう', em: '🙂', sub: 'ほどよく入れます' },
        { v: 'tired', label: 'ちょっと疲れ気味', em: '😮‍💨', sub: '休憩を多めにします' }
      ]
    },
    budget: {
      title: '使えるお金は？',
      hint: 'おでかけや食事に使う金額の目安です',
      options: [
        { v: 0, label: '0円がいい', em: '🆓' },
        { v: 1000, label: '〜1,000円', em: '🪙' },
        { v: 3000, label: '〜3,000円', em: '💴' },
        { v: 5000, label: '〜5,000円', em: '💴' },
        { v: 999999, label: 'それ以上でもOK', em: '✨' }
      ]
    },
    bed: {
      title: '何時までに寝たい？',
      hint: '明日の夜に寝る時間です',
      options: [
        { v: 22, label: '22時台', em: '🌙' },
        { v: 23, label: '23時台', em: '🌙' },
        { v: 24, label: '0時台', em: '🌌' },
        { v: 25, label: '1時以降', em: '🦉' }
      ]
    }
  };

  function flow(a) {
    const f = ['day', 'wake'];
    // 1問目の前は「仕事の日」と同じ問題数（7問）で数えておく
    if (a.day === 'work' || a.day === 'school' || a.day == null) f.push('depart', 'ret');
    if (a.day === 'half') f.push('half');
    f.push('wants', 'energy');
    if ((a.wants || []).some((w) => w === 'outing' || w === 'gourmet')) f.push('budget');
    f.push('bed');
    return f;
  }

  // ---------- 状態 ----------
  const S = { data: null, screen: 'start', answers: {}, step: 0, plan: null, view: [] };

  function loadLast() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveLast(answers) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ answers, savedAt: Date.now() })); } catch (e) { /* 保存できなくても動く */ }
  }

  // ---------- 小道具 ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = P.fmt;
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function tomorrow() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return d; }
  function dateLabel(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）'; }
  function durLabel(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '時間' : '') + (m || !h ? m + '分' : '');
  }
  function hm(min) { return Math.floor(min / 60) + '時間' + (min % 60) + '分'; }
  function yen(n) { return n === 0 ? '0円' : '約' + n.toLocaleString('ja-JP') + '円'; }
  function newSeed() {
    try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return (Math.random() * 4294967296) >>> 0; }
  }
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function optLabel(key, v) {
    const o = (Q[key].options || []).find((x) => x.v === v);
    return o ? o.label : '';
  }
  function summary(a) {
    const parts = [optLabel('day', a.day)];
    if (a.wake != null) parts.push(optLabel('wake', a.wake) + '起床');
    const labels = (a.wants || []).map((w) => (S.data.interests.find((i) => i.id === w) || {}).label).filter(Boolean);
    if (labels.length) parts.push(labels.join('・'));
    if (a.energy) parts.push(optLabel('energy', a.energy));
    if (a.bed != null) parts.push(optLabel('bed', a.bed) + 'に寝る');
    return parts.join(' / ');
  }

  // ---------- 画面：スタート ----------
  function renderStart() {
    const last = loadLast();
    const lastOk = last && last.answers && isComplete(last.answers);
    app.innerHTML = `
      <section class="start">
        <div class="start-hero">
          <div class="start-emoji" aria-hidden="true">🌙</div>
          <h1>あしたプランナー</h1>
          <p>質問に答えて、選ぶだけ。<br>明日1日の予定ができあがります。</p>
        </div>
        <ul class="start-points">
          <li><span aria-hidden="true">👆</span>文字の入力はありません。タップするだけ</li>
          <li><span aria-hidden="true">⏱️</span>質問は7つほど。1分以内に終わります</li>
          <li><span aria-hidden="true">🔒</span>ログイン不要。回答はこの端末の中だけに保存されます</li>
        </ul>
        <div class="start-actions">
          <button class="btn btn-primary" data-act="begin">明日の予定をつくる</button>
          ${lastOk ? `<button class="btn btn-secondary" data-act="reuse">前回と同じ条件で始める</button>
          <div class="last-summary">前回：${esc(summary(last.answers))}</div>` : ''}
        </div>
      </section>`;
  }

  function isComplete(a) {
    return flow(a).every((k) => k === 'wants' ? Array.isArray(a.wants) && a.wants.length > 0 : a[k] != null);
  }

  // ---------- 画面：質問 ----------
  function renderQuestion(focusFirst) {
    const f = flow(S.answers);
    const key = f[S.step];
    const q = Q[key];
    const n = S.step + 1, total = f.length;
    let body = '';
    if (q.multi) {
      const sel = S.answers.wants || [];
      const full = sel.length >= q.max;
      body = `<div class="chips" role="group" aria-label="${esc(q.title)}">` + S.data.interests.map((it) => {
        const on = sel.includes(it.id);
        return `<button class="chip ${on ? 'selected' : ''}" data-want="${it.id}" aria-pressed="${on}" ${!on && full ? 'disabled' : ''}>
          <span class="em" aria-hidden="true">${it.emoji}</span>${esc(it.label)}</button>`;
      }).join('') + `</div>
        <div class="multi-foot">
          <div class="multi-count">${sel.length ? sel.length + 'つ選択中' + (full ? '（いっぱいです）' : '・あと' + (q.max - sel.length) + 'つ選べます') : '1つ以上選んでください'}</div>
          <button class="btn btn-primary" data-act="next" ${sel.length ? '' : 'disabled'}>決定して次へ</button>
        </div>`;
    } else {
      const cur = S.answers[key];
      body = `<div class="opts" role="group" aria-label="${esc(q.title)}">` + q.options.map((o) => {
        let disabled = false, sub = o.sub || '';
        if (key === 'depart' && o.v < 9 && o.v < S.answers.wake) { disabled = true; sub = '起きる時間より前です'; }
        return `<button class="opt ${cur === o.v ? 'selected' : ''}" data-key="${key}" data-v="${o.v}" ${disabled ? 'disabled' : ''}>
          <span class="em" aria-hidden="true">${o.em}</span><span>${esc(o.label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span></button>`;
      }).join('') + '</div>';
    }
    app.innerHTML = `
      <section class="q">
        <div class="topbar">
          <div class="topbar-row">
            <button class="back" data-act="back" aria-label="前の画面に戻る">← 戻る</button>
            <div class="progress-text" aria-label="${total}問中${n}問目">${n}<small> / ${total}</small></div>
            <span style="width:64px" aria-hidden="true"></span>
          </div>
          <div class="progress" aria-hidden="true"><div style="width:${Math.round((S.step / total) * 100)}%"></div></div>
        </div>
        <div class="q-head">
          <h2 tabindex="-1" id="qtitle">${esc(q.title)}</h2>
          ${q.hint ? `<p class="q-hint">${esc(q.hint)}</p>` : ''}
        </div>
        ${body}
      </section>`;
    requestAnimationFrame(() => {
      const bar = app.querySelector('.progress > div');
      if (bar) bar.style.width = Math.round((n / total) * 100) + '%';
      if (focusFirst) { const h = document.getElementById('qtitle'); if (h) h.focus({ preventScroll: true }); }
    });
    window.scrollTo(0, 0);
  }

  function setAnswer(key, raw) {
    const a = S.answers;
    const v = /^\d+$/.test(raw) ? Number(raw) : raw;
    a[key] = v;
    if (key === 'day') {
      if (!(v === 'work' || v === 'school')) { delete a.depart; delete a.ret; }
      if (v !== 'half') delete a.half;
    }
    if (key === 'wake' && a.depart != null && a.depart < 9 && a.depart < v) delete a.depart;
  }

  function goNext() {
    const f = flow(S.answers);
    if (S.step + 1 >= f.length) { showResult(); return; }
    S.step++;
    renderQuestion(true);
  }

  // ---------- 画面：結果 ----------
  function showResult(keepPlan) {
    const a = S.answers;
    if (!(a.wants || []).some((w) => w === 'outing' || w === 'gourmet')) delete a.budget;
    saveLast(a);
    if (!keepPlan) S.plan = P.buildPlan(a, S.data, newSeed());
    S.screen = 'result';
    renderResult();
    window.scrollTo(0, 0);
  }

  function renderResult(flashIndex) {
    const plan = S.plan, a = plan.answers;
    S.view = P.displayItems(plan, S.data);
    const sleep = plan.sleepMin;
    const short = sleep < 420;
    const wakeT = fmt(a.wake * 60), bedT = fmt(a.bed * 60);
    const tags = [optLabel('day', a.day), optLabel('energy', a.energy)];
    if (a.budget != null) tags.push('予算 ' + optLabel('budget', a.budget));
    const items = S.view.map((d, i) => {
      if (d.kind === 'bed') {
        return `<li class="tl kind-bed"><div class="tl-time">${fmt(d.start)}</div><div class="tl-dot" aria-hidden="true">${d.emoji}</div>
          <div class="tl-body"><div class="tl-title"><span><span class="mark">就寝</span> おやすみなさい</span></div><div class="tl-desc">${esc(fmt(a.bed * 60))}に寝て、明日もいい1日に</div></div></li>`;
      }
      const meta = [];
      if (d.place) meta.push(d.place === 'outdoor' ? '🌳 屋外' : '🏠 室内');
      if (d.cost != null) meta.push('💴 ' + yen(d.cost));
      if (d.energy) meta.push({ low: '体力：低', mid: '体力：中', high: '体力：高' }[d.energy]);
      return `<li class="tl kind-${d.kind} ${flashIndex === i ? 'flash' : ''}">
        <div class="tl-time">${fmt(d.start)}<small>〜${fmt(d.end)}</small></div>
        <div class="tl-dot" aria-hidden="true">${d.emoji}</div>
        <div class="tl-body">
          <div class="tl-title"><span>${d.mark ? `<span class="mark">${esc(d.mark)}</span> ` : ''}${esc(d.title)}</span><span class="dur">${durLabel(d.end - d.start)}</span>${d.swappable && d.kind !== 'activity' ? `<button class="swap-mini" data-swap="${i}" aria-label="${esc(d.title)}の過ごし方を入れ替える" title="入れ替える">↻</button>` : ''}</div>
          ${d.desc ? `<div class="tl-desc">${esc(d.desc)}</div>` : ''}
          ${meta.length ? `<div class="tl-meta">${meta.join('　')}</div>` : ''}
          ${d.swappable && d.kind === 'activity' ? `<div class="tl-foot"><button class="swap" data-swap="${i}" aria-label="${esc(d.title)}を入れ替える">↻ 入れ替える</button></div>` : ''}
        </div></li>`;
    }).join('');
    app.innerHTML = `
      <section class="result">
        <div class="result-head">
          <h2>明日の予定</h2>
          <div class="date">${dateLabel(tomorrow())}</div>
          <ul class="tags">${tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        </div>
        <div class="card sleep ${short ? 'short' : ''}" id="sleep-card">
          <div class="em" aria-hidden="true">${short ? '⚠️' : '😴'}</div>
          <div>
            <strong>${bedT}に寝れば、${hm(sleep)}眠れます</strong>
            <p>${short ? '少し睡眠が短めです。寝る時間を早めると明日がラクになります。' : '起きる時間（' + wakeT + '）までの睡眠時間です。7時間以上とれていて安心です。'}</p>
          </div>
        </div>
        ${plan.notes.length ? `<div class="card notes">${plan.notes.map((n) => `<p>💡 ${esc(n)}</p>`).join('')}</div>` : ''}
        <ol class="timeline" id="timeline">${items}</ol>
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

  // ---------- 持ち出し：テキスト ----------
  function planText() {
    const a = S.plan.answers;
    const lines = ['【明日の予定】' + dateLabel(tomorrow())];
    for (const d of S.view) {
      if (d.kind === 'bed') { lines.push(fmt(d.start) + ' 🌙 就寝'); continue; }
      lines.push(fmt(d.start) + '〜' + fmt(d.end) + ' ' + d.emoji + ' ' + d.title + (d.desc ? '：' + d.desc : ''));
    }
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

  // ---------- 持ち出し：画像（Canvasに自前で描画） ----------
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
      const title = d.kind === 'bed' ? '就寝' : d.title;
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
      ctx.fillStyle = act ? '#E8743B' : '#FFFFFF'; ctx.strokeStyle = act ? '#E8743B' : '#E2C9B2'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(PAD + 175, y + 26, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      let yy = y;
      ctx.fillStyle = act ? '#C9561F' : '#2B2622'; ctx.font = '800 38px ' + font;
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
  function fileStamp() {
    const d = tomorrow();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function saveImage() {
    const c = drawImage();
    c.toBlob(async (blob) => {
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
  function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function foldLine(line) {
    // 1行75オクテットまで（UTF-8）で折り返す
    const enc = new TextEncoder();
    const out = []; let cur = ''; let bytes = 0;
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
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ashita-planner//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:明日の予定'];
    S.view.forEach((d, i) => {
      if (d.kind === 'bed' || d.kind === 'free' || d.end <= d.start) return;
      lines.push('BEGIN:VEVENT',
        'UID:' + fileStamp() + '-' + i + '-' + S.plan.seed + '@ashita-planner',
        'DTSTAMP:' + stamp,
        'DTSTART:' + icsTime(base, d.start),
        'DTEND:' + icsTime(base, d.end),
        'SUMMARY:' + icsEscape(d.emoji + ' ' + d.title),
        'DESCRIPTION:' + icsEscape(d.desc || ''),
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }
  function saveIcs() {
    download(new Blob([makeIcs()], { type: 'text/calendar;charset=utf-8' }), 'ashita-plan-' + fileStamp() + '.ics');
    toast('.ics を保存しました。カレンダーアプリで開いてください');
  }

  // ---------- 操作 ----------
  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'begin') { S.answers = {}; S.step = 0; S.screen = 'q'; renderQuestion(true); return; }
    if (act === 'reuse') { const last = loadLast(); if (last) { S.answers = last.answers; showResult(); } return; }
    if (act === 'back') {
      if (S.step === 0) { S.screen = 'start'; renderStart(); return; }
      S.step--; renderQuestion(true); return;
    }
    if (act === 'next') { goNext(); return; }
    if (act === 'again') {
      S.plan = P.buildDifferentPlan(S.plan.answers, S.data, S.plan, newSeed());
      renderResult(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('別の案にしました'); return;
    }
    if (act === 'restart') { S.answers = {}; S.step = 0; S.screen = 'q'; renderQuestion(true); return; }
    if (act === 'copy') { copyText(); return; }
    if (act === 'image') { saveImage(); return; }
    if (act === 'ics') { saveIcs(); return; }
    if (el.dataset.key) {
      setAnswer(el.dataset.key, el.dataset.v);
      app.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b === el));
      setTimeout(goNext, 180);
      return;
    }
    if (el.dataset.want) {
      const id = el.dataset.want;
      const sel = new Set(S.answers.wants || []);
      if (sel.has(id)) sel.delete(id); else if (sel.size < Q.wants.max) sel.add(id);
      S.answers.wants = S.data.interests.map((i) => i.id).filter((x) => sel.has(x));
      const y = window.scrollY;
      renderQuestion(false);
      window.scrollTo(0, y);
      return;
    }
    if (el.dataset.swap != null) {
      const i = Number(el.dataset.swap);
      const d = S.view[i];
      const res = P.swapItem(S.plan, S.data, d.ref, d.ref.fillerKey != null ? d.ref.fillerKey : null);
      if (!res.ok) { toast('ほかに入る候補がありませんでした'); return; }
      const y = window.scrollY;
      renderResult();
      const ni = S.view.findIndex((v) => v.start === d.start);
      const li = app.querySelectorAll('.timeline > li')[ni];
      if (li) li.classList.add('flash');
      window.scrollTo(0, y);
      toast('入れ替えました');
    }
  });

  // ---------- 起動 ----------
  fetch('data/activities.json')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => { S.data = data; renderStart(); })
    .catch(() => {
      app.innerHTML = '<p class="loading">データを読みこめませんでした。ページを再読みこみしてください。</p>';
    });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // テスト用（Playwright から状態を確認するため）
  window.__ashita = { state: S, planText, makeIcs };
})();
