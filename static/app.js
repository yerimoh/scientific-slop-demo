// Science Slop Index — front end. Plain DOM, no build step. Paper text is untrusted: it is always
// inserted with textContent, never innerHTML.

const $ = (sel, root = document) => root.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) n.append(c);
  return n;
}

// ------------------------------------------------------------------ model
const PLANES = [
  { key: 'structure', label: 'Structure', q: 'Do the sections build on one another?', measures: ['cross_refs', 'macro_redundancy'] },
  { key: 'argument', label: 'Argument', q: 'Are claims and citations argued, not just stated?', measures: ['argument_graph', 'citation_isolation'] },
  { key: 'artifacts', label: 'Artifacts', q: 'Can a reader inspect the method and the evidence?', measures: ['figure_exposition', 'evidence_gap'] },
];
const MEASURES = {
  cross_refs: { name: 'Cross-section references', short: 'Cross-refs', plane: 'structure', method: 'Rule', unit: 'Body sections and labeled objects', num: 'objects never referenced outside their own section', den: 'all objects', one: 'No object is ever referred to from another section.', pairacc: 0.905 },
  macro_redundancy: { name: 'Macro redundancy', short: 'Redundancy', plane: 'structure', method: 'Rule', unit: 'Sentences with at least eight tokens', num: 'sentences half or more copied as 8-grams from an earlier section', den: 'all sentences', one: 'Every sentence mostly repeats earlier sections.', pairacc: 0.723 },
  argument_graph: { name: 'Argument graph', short: 'Claims', plane: 'argument', method: 'LLM', unit: 'Key claims in the Introduction', num: 'shallow claims: nothing earlier leads up to them', den: 'all key claims', one: 'The argument is flat. Every claim stands alone with no build-up behind it.', pairacc: 0.586 },
  citation_isolation: { name: 'Citation isolation', short: 'Citations', plane: 'argument', method: 'Rule', unit: 'Citation sentences (Intro., Related Work)', num: 'citations not grouped, compared, or related to other works', den: 'all citations', one: 'Every citation stands alone.', pairacc: 0.793 },
  figure_exposition: { name: 'Figure exposition', short: 'Figure', plane: 'artifacts', method: 'LLM', unit: 'Content types in method figures', num: 'content types not needed to show the method', den: 'all content types in the figure', one: 'Nothing in the figure shows the method itself.', pairacc: 0.809 },
  evidence_gap: { name: 'Evidence gap', short: 'Evidence', plane: 'artifacts', method: 'Rule', unit: 'Papers with a body result table', num: 'papers showing no concrete input, output, or case', den: 'all papers', one: 'The paper gives no concrete example at all.', pairacc: 0.764 },
};
const ORDER = PLANES.flatMap(p => p.measures);
const PLANE_VAR = { structure: 'var(--structure)', argument: 'var(--argument)', artifacts: 'var(--artifacts)' };
const BANDS = [
  { max: 20, label: 'Low', color: 'var(--idx-1)' }, { max: 40, label: 'Moderate', color: 'var(--idx-2)' },
  { max: 60, label: 'High', color: 'var(--idx-3)' }, { max: 101, label: 'Very high', color: 'var(--idx-4)' },
];
const BENCH = [
  ['Science Slop Index', 0.859, 0.854, true], ['Binoculars', 0.687, 0.683], ['CycleReviewer', 0.685, 0.689],
  ['DetectGPT', 0.638, 0.623], ['NTS', 0.626, 0.607], ['AI Scientist reviewer', 0.615, 0.613],
];

const state = {
  key: null, job: null, sig: '', open: new Set(), showAll: new Set(), hidden: new Set(), tab: 'findings',
  timer: null, config: null, flash: null, flashHl: null, menu: false, gallery: null,
};

// ------------------------------------------------------------------ utilities
const band = v => BANDS.find(b => v < b.max) || BANDS[BANDS.length - 1];
function fmt(x) { if (x == null) return '—'; const v = 100 * x; if (v > 0 && v < 1) return '<1'; return String(Math.round(v)); }
function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); }
function trunc(t, n) { t = t || ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function toast(msg) { const t = h('div', { class: 'toast', text: msg, role: 'status' }); document.body.append(t); setTimeout(() => t.remove(), 2400); }
function setError(msg) { $('#form-error').textContent = msg || ''; }
function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function safeName(t) { return (t || 'paper').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'paper'; }
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); } catch (_) { prompt('Copy this', text); }
}

// browser storage (a convenience only; the page works without it)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
};
function remember(res) {
  if (!res?.key) return;
  const recent = store.get('ssi-recent', []).filter(r => r.key !== res.key);
  recent.unshift({ key: res.key, title: res.document?.title, index: res.index?.index, at: Date.now() });
  store.set('ssi-recent', recent.slice(0, 30));
  // keep a copy of the last few reports so they survive a server restart
  const cached = store.get('ssi-cached', []).filter(k => k !== res.key);
  cached.unshift(res.key);
  while (cached.length > 6) store.del('ssi-r-' + cached.pop());
  let ok = store.set('ssi-r-' + res.key, res);
  while (!ok && cached.length > 1) { store.del('ssi-r-' + cached.pop()); ok = store.set('ssi-r-' + res.key, res); }
  store.set('ssi-cached', cached);
}

// tooltip
const tip = $('#tip');
function placeTip(e) {
  const pad = 14; const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
function showTip(e, title, body) { tip.replaceChildren(h('b', { text: title }), document.createTextNode(body || '')); tip.hidden = false; placeTip(e); }
function hideTip() { tip.hidden = true; }
function bindTip(node, title, body) {
  node.addEventListener('pointerenter', e => showTip(e, title, body));
  node.addEventListener('pointermove', placeTip);
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.bottom }, title, body); });
  node.addEventListener('blur', hideTip);
}

// ------------------------------------------------------------------ theme
function initTheme() {
  const saved = store.get('ssi-theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('ssi-theme', next);
    if (state.job && !$('#page-report').hidden) { state.sig = ''; render(state.job); }
    if (!$('#page-leaderboard').hidden && lb.data) renderLeaderboard();
  });
}

// ------------------------------------------------------------------ routing
const PAGES = ['home', 'leaderboard', 'how', 'gallery', 'view', 'report'];
function showPage(name) {
  for (const p of PAGES) $('#page-' + p).hidden = p !== name;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  hideTip();
  if (name !== 'report') document.title = { home: 'Science Slop Index', leaderboard: 'Leaderboard · Science Slop Index', how: 'How it works · Science Slop Index', gallery: 'Gallery · Science Slop Index', view: 'View report · Science Slop Index' }[name];
}
function go(path) { history.pushState({}, '', path); route(); scrollTo({ top: 0 }); }
function route() {
  clearTimeout(state.timer);
  const p = location.pathname;
  const m = p.match(/^\/r\/([A-Za-z0-9_-]+)/);
  if (m) { showPage('report'); openReport(m[1]); return; }
  state.key = null; state.job = null; state.sig = '';
  if (p.startsWith('/leaderboard')) { showPage('leaderboard'); loadLeaderboard(); }
  else if (p.startsWith('/how')) { showPage('how'); buildHow(); }
  else if (p.startsWith('/gallery')) { showPage('gallery'); loadGallery(); }
  else if (p.startsWith('/view')) { showPage('view'); renderRecent(); }
  else { showPage('home'); loadHome(); }
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault(); go(a.getAttribute('href'));
});
addEventListener('popstate', route);

// ------------------------------------------------------------------ submit
async function submit(fd) {
  setError('');
  const btn = $('#go'); btn.disabled = true;
  try {
    const r = await fetch('/api/analyze', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Something went wrong. Try again.');
    go('/r/' + d.key);
  } catch (e) { setError(e.message); } finally { btn.disabled = false; }
}
function submitFile(file) {
  if (!file) return;
  const maxMb = state.config?.max_upload_mb || 50;
  if (file.size > maxMb * 1024 * 1024) { setError(`That file is larger than ${maxMb} MB.`); return; }
  const fd = new FormData(); fd.append('file', file);
  if ($('#to-gallery').checked) fd.append('gallery', '1');
  submit(fd);
}
function initInputs() {
  $('#ask').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#url').value.trim();
    if (!v) { setError('Paste a link, or upload a file below.'); $('#url').focus(); return; }
    const fd = new FormData(); fd.append('url', v); submit(fd);
  });
  $('#file').addEventListener('change', e => { submitFile(e.target.files[0]); e.target.value = ''; });
  $('#example').addEventListener('click', () => {
    const ex = state.config?.examples?.[0]; if (!ex) return;
    const fd = new FormData(); fd.append('example', ex.id); submit(fd);
  });
  let depth = 0; const drop = $('#drop');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (!hasFiles(e) || $('#page-home').hidden) return; e.preventDefault(); depth++; drop.hidden = false; });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
  addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; drop.hidden = true; if (!$('#page-home').hidden) submitFile(e.dataTransfer.files[0]); });
  $('#view-form').addEventListener('submit', e => {
    e.preventDefault();
    let k = $('#view-key').value.trim().toLowerCase().replace(/\s+/g, '');
    if (/^[a-z0-9]{12}$/.test(k)) k = `${k.slice(0, 4)}-${k.slice(4, 8)}-${k.slice(8)}`;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(k)) { $('#view-error').textContent = 'That does not look like a report key.'; return; }
    go('/r/' + k);
  });
  $('#open-json').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const res = JSON.parse(await f.text());
      if (!res.measures || !res.index) throw new Error('bad');
      state.key = res.key || 'file'; state.sig = ''; state.open.clear(); state.tab = 'findings';
      state.job = { id: state.key, status: 'done', result: res, local: 'file' };
      showPage('report'); render(state.job);
    } catch (_) { $('#view-error').textContent = 'That file is not a Science Slop Index report.'; }
  });
  document.addEventListener('click', e => { if (state.menu && !e.target.closest('.export')) { state.menu = false; const m = $('.export .menu'); if (m) m.hidden = true; } });
}

// ------------------------------------------------------------------ report loading
function openReport(key) {
  if (state.key !== key) { state.open.clear(); state.showAll.clear(); state.hidden.clear(); state.sig = ''; state.tab = 'findings'; state.job = null; }
  state.key = key;
  const R = $('#page-report');
  if (!state.job) R.replaceChildren(h('p', { class: 'muted' }, 'Opening the report…'));
  poll(key, 0);
}
async function poll(key, fails) {
  if (state.key !== key) return;
  try {
    const r = await fetch('/api/jobs/' + encodeURIComponent(key));
    if (r.status === 404) {
      const cached = store.get('ssi-r-' + key, null);
      if (cached) { state.job = { id: key, key, status: 'done', result: cached, local: 'cache' }; render(state.job); }
      else renderError('No report with this key. Reports on this server are kept until it restarts, so an older key may have expired.');
      return;
    }
    const job = await r.json();
    state.job = job; render(job);
    if (job.status === 'running') state.timer = setTimeout(() => poll(key, 0), 700);
    else if (job.status === 'done') remember(job.result);
  } catch (e) {
    if (fails < 8) state.timer = setTimeout(() => poll(key, fails + 1), 1200 * (fails + 1));
    else renderError('Lost the connection to the server.');
  }
}

function measuresOf(job) {
  const out = {};
  if (job.result) for (const m of job.result.measures) out[m.key] = m;
  else Object.assign(out, job.measures || {});
  return out;
}
function signature(job) {
  const ms = measuresOf(job);
  return [job.status, job.document ? 1 : 0, (job.running || []).join(','),
    ...ORDER.map(k => (ms[k] ? ms[k].status + ':' + ms[k].score + ':' + (ms[k].instances || []).length : '-')),
    job.result ? job.result.index?.score : '', job.result?.measures?.find(m => m.key === 'figure_exposition')?.details?.figure?.index ?? '',
    [...state.open].join(','), [...state.showAll].join(','), [...state.hidden].join(','), state.tab,
  ].join('|');
}

function render(job) {
  if (job.status === 'error') { renderError(job.error); return; }
  const sig = signature(job);
  if (sig === state.sig) { updateProgress(job); return; }
  state.sig = sig;
  const R = $('#page-report');
  const running = job.status !== 'done';
  const ms = measuresOf(job);
  const res = job.result;
  const doc = res?.document || job.document;
  const idx = res?.index;
  const frag = [];

  if (doc) {
    document.title = trunc(doc.title, 60) + ' · Science Slop Index';
    const st = doc.stats || {};
    frag.push(h('div', { class: 'paper-head' },
      h('p', { class: 'eyebrow', text: doc.route || (doc.source === 'latex' ? 'LaTeX source' : 'PDF') }),
      h('h2', { text: doc.title }),
      h('p', { class: 'meta' },
        h('span', { class: 'chip', title: doc.fidelity }, doc.source === 'latex' ? 'Read from LaTeX source' : 'Rebuilt from PDF'),
        st.body_sections != null ? h('span', { text: `${st.body_sections} sections` }) : null,
        st.body_words != null ? h('span', { text: `${Number(st.body_words).toLocaleString()} words` }) : null,
        st.objects != null ? h('span', { text: `${st.objects} referable objects` }) : null,
        doc.url ? h('a', { href: doc.url, target: '_blank', rel: 'noopener', text: 'Open paper ↗' }) : null)));
  } else {
    frag.push(h('div', { class: 'paper-head' }, h('p', { class: 'eyebrow', text: 'Analyzing' }), h('h2', { text: trunc(job.label || 'Your paper', 120) })));
  }
  frag.push(keyBar(job));
  if (running) frag.push(progressBlock(job));
  frag.push(scoreCard(idx, ms, running));

  const pdfOk = !!res?.pdf?.available && !job.local;
  const tabBtn = (id, label, disabled) => h('button', { type: 'button', class: state.tab === id ? 'on' : '', disabled: disabled || null,
    onclick: () => { state.tab = id; state.sig = ''; render(state.job); } }, label);
  frag.push(h('div', { class: 'tabs', role: 'tablist' },
    tabBtn('findings', 'Findings'),
    tabBtn('paper', res && pdfOk ? `Paper · ${res.pdf.located} of ${res.pdf.findings} findings placed` : 'Paper', running),
    h('span', { class: 'spacer' }),
    res ? exportMenu(job) : null));

  const body = h('div', {});
  frag.push(body);
  let mapHost = null;
  if (state.tab === 'paper' && res) body.append(paperView(job));
  else {
    body.append(h('div', { class: 'section-title' }, h('h3', { text: 'Where it shows up' }),
      h('p', { text: 'Each dot is a flagged unit, placed where it occurs. Hover to read it, click to open it.' })));
    mapHost = h('div', { class: 'card map-card' });
    body.append(mapHost);
    body.append(h('div', { class: 'section-title' }, h('h3', { text: 'Six measures' }), h('p', { text: 'Open a measure to see every unit it flags.' })));
    for (const p of PLANES) body.append(planeGroup(p, ms, running, idx, pdfOk));
    if (res) body.append(footCard(res));
  }

  R.replaceChildren(...frag);
  if (mapHost) drawMap(mapHost, doc, ms);
  requestAnimationFrame(() => requestAnimationFrame(() => R.querySelectorAll('[data-w]').forEach(n => { n.style.width = n.dataset.w; })));
  if (state.flash) {
    const t = document.getElementById(state.flash); state.flash = null;
    if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1800); }
  }
  if (state.flashHl) {
    const id = state.flashHl; state.flashHl = null;
    setTimeout(() => {
      const all = document.querySelectorAll(`[data-hl="${id}"]`);
      if (all.length) { all[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); all.forEach(x => { x.classList.add('flash'); setTimeout(() => x.classList.remove('flash'), 2400); }); }
    }, 80);
  }
}

function renderError(msg) {
  const R = $('#page-report'); showPage('report');
  R.replaceChildren(h('div', { class: 'card error-card' },
    h('h2', { text: 'We could not open this report' }), h('p', { text: msg || 'Unknown error.' }),
    h('div', { class: 'actions', style: { justifyContent: 'center' } },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => go('/view') }, 'Enter another key'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('/') }, 'Analyze a paper'))));
}

function keyBar(job) {
  if (job.local === 'file') return h('div', { class: 'keybar' }, 'Opened from a report file. The paper view and the highlighted PDF need the report on the server.');
  if (job.local === 'cache') return h('div', { class: 'keybar' }, 'The server no longer has this report (it restarts from time to time), so this is the copy saved in your browser. The paper view is unavailable.');
  const key = job.key || job.id;
  const persistent = state.config?.persistent;
  return h('div', { class: 'keybar' },
    h('span', {}, 'Report key'), h('span', { class: 'key', text: key }),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(key, 'Key copied') }, 'Copy key'),
    h('span', { class: 'muted', text: persistent ? 'Open it later from View report.' : 'Open it later from View report. This server keeps reports until it restarts, so download the report to keep it for good.' }));
}

function progressBlock(job) {
  const p = job.progress || { pct: 0, label: job.stage || 'Working' };
  return h('div', { class: 'progress', 'aria-live': 'polite' },
    h('div', { class: 'p-top' }, h('span', { class: 'p-label', text: p.label || job.stage || 'Working' }), h('b', { class: 'p-pct', text: Math.round(p.pct || 0) + '%' })),
    h('div', { class: 'p-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p.pct || 0) },
      h('i', { style: { width: (p.pct || 0) + '%' } })));
}
function updateProgress(job) {
  const el = $('#page-report .progress'); if (!el || !job.progress) return;
  el.querySelector('.p-label').textContent = job.progress.label || job.stage || '';
  el.querySelector('.p-pct').textContent = Math.round(job.progress.pct) + '%';
  el.querySelector('.p-bar i').style.width = job.progress.pct + '%';
  el.querySelector('.p-bar').setAttribute('aria-valuenow', Math.round(job.progress.pct));
}

// ------------------------------------------------------------------ score card
function scoreCard(idx, ms, running) {
  const have = idx && idx.index != null;
  const v = have ? idx.index : null;
  const b = have ? band(v) : null;
  const nDone = ORDER.filter(k => ms[k]?.status === 'done').length;
  const sub = have ? `Averaged over the three planes, ${v}% of the units we measured show a slop pattern.` + (idx.partial ? ` Partial: ${nDone} of 6 measures could run.` : '')
    : running ? 'Measuring six patterns across the paper…' : 'No measure applied to this paper.';
  const hero = h('div', {},
    h('div', { class: 'hero-num' + (have ? '' : ' pending') }, h('span', { class: 'n', text: have ? String(v) : '··' }), h('span', { class: 'of', text: '/100' })),
    h('div', { class: 'hero-label' }, 'Science Slop Index',
      b ? h('span', { class: 'band', title: 'Descriptive cut-points on the share of flagged units, not a probability of AI authorship' },
        h('span', { class: 'ico', style: { background: b.color } }), b.label) : null),
    h('p', { class: 'hero-sub', text: sub }));
  const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': v ?? 0, 'aria-label': 'Science Slop Index' },
    h('i', { class: 'fill', style: { width: '0%', background: b ? b.color : 'var(--line-2)' }, 'data-w': (v ?? 0) + '%' }),
    ...[20, 40, 60].map(t => h('span', { class: 'tick', style: { left: `calc(${t}% - 1px)` } })));
  const labels = h('div', { class: 'scale-labels' },
    h('span', { style: { left: '0%' }, text: 'Low' }), h('span', { style: { left: '30%' }, text: 'Moderate' }),
    h('span', { style: { left: '50%' }, text: 'High' }), h('span', { style: { left: '100%' }, text: 'Very high' }));
  const tiles = h('div', { class: 'plane-tiles' }, PLANES.map(p => {
    const ps = idx?.planes?.[p.key]?.score;
    const t = h('button', { class: `tile band-${p.key}`, type: 'button', onclick: () => { state.tab = 'findings'; state.sig = ''; render(state.job); setTimeout(() => document.getElementById('plane-' + p.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); } },
      h('span', { class: `tag ${p.key}`, text: p.label }),
      h('div', { class: 't-val', text: ps == null ? (running ? '··' : '—') : fmt(ps) }),
      h('div', { class: 't-bar' }, h('i', { style: { width: '0%', background: PLANE_VAR[p.key] }, 'data-w': ((ps || 0) * 100) + '%' })));
    bindTip(t, `${p.label}: ${ps == null ? 'not measured' : fmt(ps) + ' / 100'}`, p.q);
    return t;
  }));
  return h('div', { class: 'card score-card' }, hero, h('div', { class: 'scale' }, meter, labels, tiles));
}

// ------------------------------------------------------------------ export
function csvOf(res) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['measure', 'plane', 'measure_score', 'section', 'pdf_pages', 'finding', 'detail']];
  for (const m of res.measures) {
    const sc = m.score == null ? '' : m.score.toFixed(4);
    if (!(m.instances || []).length) rows.push([m.name, m.plane, sc, '', '', '', (m.notes || []).join('; ')]);
    for (const it of m.instances || []) {
      const pages = [...new Set((it.pdf || []).map(l => l.p + 1))].sort((a, b) => a - b).join(' ');
      const detail = it.why || (it.coverage != null ? `${Math.round(it.coverage * 100)}% copied from ${it.source_title}` : it.caption || '');
      rows.push([m.name, m.plane, sc, it.section_title || '', pages, it.text || '', detail]);
    }
  }
  return rows.map(r => r.map(q).join(',')).join('\n');
}
function exportMenu(job) {
  const res = job.result; const key = job.key || job.id;
  const name = safeName(res.document?.title);
  const pdfOk = res.pdf?.available && !job.local;
  const menu = h('div', { class: 'menu', hidden: !state.menu, role: 'menu' },
    h('a', { href: pdfOk ? `/api/jobs/${encodeURIComponent(key)}/pdf` : '#', class: pdfOk ? '' : 'disabled', download: '', role: 'menuitem' },
      'Highlighted PDF', h('span', { text: pdfOk ? 'The paper with every finding highlighted, plus a summary page' : 'No PDF of this paper is available' })),
    h('button', { type: 'button', role: 'menuitem', onclick: () => download(`${name}.slop-report.json`, JSON.stringify(res, null, 2), 'application/json') },
      'Report (JSON)', h('span', { text: 'Every score and finding; open it again from View report' })),
    h('button', { type: 'button', role: 'menuitem', onclick: () => download(`${name}.slop-findings.csv`, csvOf(res), 'text/csv') },
      'Findings (CSV)', h('span', { text: 'One row per flagged unit' })));
  return h('div', { class: 'export' },
    h('button', { class: 'btn small', type: 'button', 'aria-haspopup': 'menu', onclick: e => { e.stopPropagation(); state.menu = !state.menu; menu.hidden = !state.menu; } }, 'Export ▾'),
    menu);
}

// ------------------------------------------------------------------ paper view
function paperView(job) {
  const res = job.result; const key = job.key || job.id;
  const pdf = res.pdf || {};
  if (!pdf.available || job.local) {
    return h('div', { class: 'card pv-empty' }, pdf.reason || (job.local ? 'The paper view needs the report on the server.' : 'No PDF of this paper is available.'));
  }
  const byPage = new Map();
  const seen = new Set();
  const counts = {};
  for (const m of res.measures) {
    counts[m.key] = { found: 0, total: (m.instances || []).length };
    (m.instances || []).forEach((it, i) => {
      if (!(it.pdf || []).length) return;
      counts[m.key].found++;
      for (const loc of it.pdf) {
        if (!byPage.has(loc.p)) byPage.set(loc.p, []);
        for (const r of loc.r) {
          const sig = `${m.key}:${loc.p}:${r.join(',')}`;   // one figure box, not one per detected kind
          if (seen.has(sig)) continue;
          seen.add(sig);
          byPage.get(loc.p).push({ m, it, i, r, box: !!loc.box });
        }
      }
    });
  }
  const side = h('div', { class: 'pv-side' }, h('h4', { text: 'Show on the paper' }),
    ORDER.map(k => {
      const meta = MEASURES[k]; const c = counts[k] || { found: 0, total: 0 };
      const cb = h('input', { type: 'checkbox', checked: !state.hidden.has(k) ? true : null,
        onchange: () => { state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); state.sig = ''; render(state.job); } });
      return h('label', { class: 'pv-toggle' }, cb, h('span', { class: 'sw', style: { background: PLANE_VAR[meta.plane] } }), meta.name, h('span', { class: 'cnt', text: `${c.found}/${c.total}` }));
    }),
    h('a', { class: 'btn ghost small', href: `/api/jobs/${encodeURIComponent(key)}/pdf`, download: '', style: { textAlign: 'center', textDecoration: 'none', marginTop: '6px' } }, 'Download highlighted PDF'));
  const pages = h('div', { class: 'pv-pages' });
  (pdf.sizes || []).forEach(([w, hgt], n) => {
    const page = h('div', { class: 'pv-page', style: { aspectRatio: `${w} / ${hgt}` } },
      h('span', { class: 'pl', text: `Loading page ${n + 1}…` }),
      h('img', { src: `/api/jobs/${encodeURIComponent(key)}/pages/${n}.jpg`, alt: `Page ${n + 1}`, loading: 'lazy', width: 1100, height: Math.round(1100 * hgt / w) }),
      h('span', { class: 'pno', text: `${n + 1}` }));
    for (const hl of byPage.get(n) || []) {
      if (state.hidden.has(hl.m.key)) continue;
      const [x0, y0, x1, y1] = hl.r;
      const d = h('div', { class: `hl ${hl.m.plane}${hl.box ? ' box' : ''}`, 'data-hl': `${hl.m.key}-${hl.i}`, tabindex: 0,
        style: { left: `${100 * x0 / w}%`, top: `${100 * y0 / hgt}%`, width: `${100 * (x1 - x0) / w}%`, height: `${100 * (y1 - y0) / hgt}%` } });
      bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 240));
      const open = () => { hideTip(); state.tab = 'findings'; state.open.add(hl.m.key); if (hl.i >= 8) state.showAll.add(hl.m.key); if (hl.m.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.flash = `f-${hl.m.key}-${hl.i}`; state.sig = ''; render(state.job); };
      d.addEventListener('click', open);
      d.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      page.append(d);
    }
    pages.append(page);
  });
  return h('div', { class: 'pv-layout' }, side, pages);
}
function showOnPaper(key, i) { state.tab = 'paper'; state.flashHl = `${key}-${i}`; state.hidden.delete(key); state.sig = ''; render(state.job); }

// ------------------------------------------------------------------ paper map
function drawMap(host, doc, ms) {
  const outline = doc?.outline || [];
  const bySec = new Map(outline.map(o => [o.idx, o]));
  const items = [];
  for (const k of ORDER) {
    const m = ms[k]; if (!m || m.status !== 'done') continue;
    (m.instances || []).forEach((it, i) => { if (it.section != null && bySec.has(it.section)) items.push({ key: k, i, sec: it.section, sent: it.sentence, text: it.text || it.label || '', where: it.section_title || '' }); });
  }
  if (!outline.length) { host.replaceChildren(h('div', { class: 'muted', text: 'The map appears once the paper is read.' })); return; }
  const draw = () => {
    const W = Math.max(300, host.clientWidth - 40);
    const labelW = W < 520 ? 70 : 92, laneH = 22, top = 4, H = top + laneH * ORDER.length + 26;
    const weights = outline.map(o => Math.max(o.sentences, 4)); const total = weights.reduce((a, b) => a + b, 0);
    let x = labelW; const segs = outline.map((o, k) => { const w = (W - labelW) * weights[k] / total; const seg = { o, x, w }; x += w; return seg; });
    const segOf = new Map(segs.map(sg => [sg.o.idx, sg]));
    const svg = s('svg', { class: 'map', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Where flagged units occur in the paper' });
    ORDER.forEach((k, li) => {
      const y = top + li * laneH;
      svg.append(s('text', { class: 'lane-label', x: 0, y: y + laneH / 2 + 4, text: MEASURES[k].short }));
      segs.forEach(sg => svg.append(s('rect', { class: 'seg', x: sg.x + 1, y: y + 3, width: Math.max(1, sg.w - 2), height: laneH - 6, rx: 4 })));
    });
    segs.forEach(sg => {
      const lab = sg.o.idx === 0 ? 'Abstract' : (sg.o.number ? '§' + sg.o.number + ' ' : '') + sg.o.title;
      const maxChars = Math.floor((sg.w - 4) / 6.2);
      if (maxChars >= 2) svg.append(s('text', { class: 'seg-label', x: sg.x + 3, y: H - 8, text: trunc(lab, maxChars) }));
    });
    const buckets = new Map();
    for (const it of items) if (it.sent == null) { const kk = it.key + ':' + it.sec; buckets.set(kk, (buckets.get(kk) || []).concat(it)); }
    for (const it of items) {
      const sg = segOf.get(it.sec); if (!sg) continue;
      let cx;
      if (it.sent != null && sg.o.sentences) cx = sg.x + 4 + (sg.w - 8) * (it.sent + 0.5) / sg.o.sentences;
      else { const b = buckets.get(it.key + ':' + it.sec); cx = sg.x + sg.w * (b.indexOf(it) + 1) / (b.length + 1); }
      const cy = top + ORDER.indexOf(it.key) * laneH + laneH / 2;
      const dot = s('circle', { class: 'dot', cx, cy, r: 4.5, fill: PLANE_VAR[MEASURES[it.key].plane] });
      const hit = s('circle', { class: 'hit', cx, cy, r: 11, tabindex: 0, role: 'button', 'aria-label': `${MEASURES[it.key].name}: ${trunc(it.text, 80)}` });
      const open = () => { hideTip(); state.open.add(it.key); state.flash = `f-${it.key}-${it.i}`; if (it.i >= 8) state.showAll.add(it.key); if (it.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.sig = ''; render(state.job); };
      hit.addEventListener('click', open);
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      hit.addEventListener('pointerenter', () => dot.setAttribute('r', 6.5));
      hit.addEventListener('pointerleave', () => dot.setAttribute('r', 4.5));
      bindTip(hit, `${MEASURES[it.key].name} · ${it.where}`, trunc(it.text, 240));
      svg.append(dot, hit);
    }
    host.replaceChildren(svg, h('div', { class: 'legend' },
      PLANES.map(p => h('span', {}, h('span', { class: `swatch sw-${p.key}` }), p.label)),
      h('span', { style: { color: 'var(--ink-3)' }, text: items.length ? `${items.length} flagged units` : 'No flagged unit is placed in the text yet' })));
  };
  draw();
  if (host._ro) host._ro.disconnect();
  let last = host.clientWidth;
  host._ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - last) > 8) { last = host.clientWidth; draw(); } });
  host._ro.observe(host);
}

// ------------------------------------------------------------------ measure rows
function planeGroup(p, ms, running, idx, pdfOk) {
  const ps = idx?.planes?.[p.key]?.score;
  const card = h('div', { class: 'plane-group', id: 'plane-' + p.key },
    h('div', { class: `pg-head band-${p.key}` },
      h('div', {}, h('span', { class: `tag ${p.key}`, text: p.label }), h('span', { class: 'q', text: p.q })),
      h('span', { class: 'pv', text: ps == null ? '' : `plane ${fmt(ps)}` })));
  for (const k of p.measures) {
    const m = ms[k]; const meta = MEASURES[k]; const isOpen = state.open.has(k);
    const row = h('button', { class: 'row', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': 'd-' + k,
      onclick: () => { if (!m) return; state.open.has(k) ? state.open.delete(k) : state.open.add(k); state.sig = ''; render(state.job); } });
    row.append(h('span', { class: 'name', text: meta.name }));
    if (!m) {
      const isRunning = (state.job?.running || []).includes(k);
      row.append(h('span', { class: 'shimmer' }), h('span', { class: 'val', text: '' }), h('span', { class: 'state', text: running ? (isRunning ? 'measuring…' : 'queued') : '' }),
        h('span', { class: 'method', text: meta.method }), h('span', { class: 'chev', text: '' }));
    } else {
      const done = m.status === 'done' && m.score != null;
      let frac;
      if (done) frac = `${fmtNum(m.num)} / ${m.den} ${m.unit || ''}` + (m.weak ? ' · weak' : '');
      else if (m.status === 'na') frac = 'not applicable';
      else if (m.status === 'skipped') frac = 'needs a language model';
      else frac = 'could not run';
      row.append(h('span', { class: 'bar' }, h('i', { style: { width: '0%', background: PLANE_VAR[p.key] }, 'data-w': (done ? m.score * 100 : 0) + '%' })),
        h('span', { class: 'val', text: done ? fmt(m.score) : '—' }), h('span', { class: 'frac', text: frac, title: frac }),
        h('span', { class: 'method', text: meta.method, title: meta.method === 'LLM' ? 'Uses a language model' : 'Exact counting rule' }), h('span', { class: 'chev', text: '›' }));
    }
    card.append(row);
    if (isOpen && m) card.append(detail(m, pdfOk));
  }
  return card;
}

function findingsList(m, renderItem, pdfOk) {
  const all = m.instances || []; const showAll = state.showAll.has(m.key);
  const list = h('ul', { class: 'findings' });
  (showAll ? all : all.slice(0, 8)).forEach((it, i) => {
    const li = h('li', { class: 'finding', id: `f-${m.key}-${i}` }, renderItem(it, i));
    if (pdfOk && (it.pdf || []).length) {
      const where = li.querySelector('.where');
      const pages = [...new Set(it.pdf.map(l => l.p + 1))].join(', ');
      (where || li).append(h('button', { class: 'onpaper', type: 'button', onclick: () => showOnPaper(m.key, i) }, `Show on paper · p. ${pages}`));
    }
    list.append(li);
  });
  const out = [list];
  if (all.length > 8 && !showAll) out.push(h('button', { class: 'link-btn more', type: 'button', onclick: () => { state.showAll.add(m.key); state.sig = ''; render(state.job); } }, `Show all ${all.length}`));
  return out;
}
function whereLine(...parts) { return h('div', { class: 'where' }, h('span', { class: 'x', text: '⊗' }), parts.filter(Boolean).map(p => h('span', { text: p }))); }
function highlighted(text, spans) {
  const out = h('div', { class: 'txt' }); let pos = 0;
  for (const [a, b] of spans || []) { if (a > pos) out.append(document.createTextNode(text.slice(pos, a))); out.append(h('mark', { text: text.slice(a, b) })); pos = b; }
  out.append(document.createTextNode(text.slice(pos)));
  return out;
}
function okLine(text) { return h('div', { class: 'ok-line' }, h('span', { class: 'ico', style: { background: 'var(--good)' }, text: '✓' }), h('span', { text })); }

function detail(m, pdfOk) {
  const meta = MEASURES[m.key];
  const d = h('div', { class: 'detail', id: 'd-' + m.key });
  d.append(h('div', { class: 'd-lead' },
    h('img', { src: `/static/img/${m.key}.svg`, alt: '', class: `band-${meta.plane}` }),
    h('div', {}, m.what || '', ' ', h('b', { text: 'A score of 100 means: ' }), m.one_means || meta.one)));
  const R = RENDERERS[m.key];
  if (m.status === 'done' && R) d.append(...R(m, pdfOk));
  if (m.status !== 'done') d.append(h('div', { class: 'ok-line' }, h('span', { class: 'ico', style: { background: 'var(--ink-3)' }, text: 'i' }), h('span', { text: (m.notes && m.notes[0]) || 'This measure did not apply.' })));
  if (m.key === 'figure_exposition' && m.status === 'na' && (m.details?.candidates || []).length && !state.job?.local)
    d.append(h('div', { style: { marginTop: '12px' } }, figurePicker(m, 'Score a figure you choose')));
  const notes = (m.notes || []).slice(m.status === 'done' ? 0 : 1);
  d.append(h('ul', { class: 'notes' }, notes.map(n => h('li', { text: n })),
    h('li', { text: `In the paper's evaluation on SciSlopBench, this measure alone picks the AI-generated paper in ${Math.round((m.paper_pairacc ?? meta.pairacc) * 1000) / 10}% of matched pairs.` })));
  return d;
}

const RENDERERS = {
  cross_refs(m, pdfOk) {
    const det = m.details || {};
    const bySec = new Map();
    for (const o of det.objects || []) bySec.set(o.home, (bySec.get(o.home) || []).concat(o));
    const titles = new Map((state.job?.result?.document || state.job?.document)?.outline?.map(o => [o.idx, (o.number ? '§' + o.number + ' ' : '') + o.title]) || []);
    const rows = [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([sec, objs]) => h('div', { class: 'refrow' },
      h('span', { class: 'sec', text: titles.get(sec) || '§' + sec }),
      h('span', { class: 'objs' }, objs.map(o => {
        const lab = o.kind === 'section' ? 'Section' : o.label.replace(/^Eq\. \((.*)\)$/, 'Eq.');
        const c = h('span', { class: 'obj ' + (o.from.length ? 'hit' : 'miss'), tabindex: 0, text: lab });
        bindTip(c, o.label, o.from.length ? 'Referred to from ' + o.from.map(f => titles.get(f) || '§' + f).join(', ') : `Never referred to from another section${o.own ? ` (${o.own}× inside its own)` : ''}.`);
        return c;
      }))));
    const list = m.instances.length ? (state.showAll.has('cross_refs:list')
      ? [h('div', { class: 'd-sub', text: `Unreferenced objects · ${m.instances.length}` }),
        h('ul', { class: 'findings' }, m.instances.map((it, i) => {
          const li = h('li', { class: 'finding', id: `f-${m.key}-${i}` }, whereLine(it.section_title, it.kind), h('div', { class: 'txt', text: it.caption ? `${it.label}: ${trunc(it.caption, 200)}` : it.label }));
          if (pdfOk && (it.pdf || []).length) li.querySelector('.where').append(h('button', { class: 'onpaper', type: 'button', onclick: () => showOnPaper(m.key, i) }, `Show on paper · p. ${it.pdf[0].p + 1}`));
          return li;
        }))]
      : [h('button', { class: 'link-btn more', type: 'button', style: { marginTop: '12px' }, onclick: () => { state.showAll.add('cross_refs:list'); state.sig = ''; render(state.job); } }, `List all ${m.instances.length} unreferenced objects`)]) : [];
    return [h('div', { class: 'd-sub', text: 'Reference map' }), h('div', { class: 'refmap' }, rows),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--structure)' } }), 'used by another section'),
        h('span', {}, h('span', { class: 'lg-box', style: { border: '1.5px dashed var(--structure)' } }), 'never pointed to from another section')), ...list];
  },
  macro_redundancy(m, pdfOk) {
    if (!m.instances.length) return [okLine(`No sentence repeats half of itself from an earlier section (${m.den} sentences checked).`)];
    return [h('div', { class: 'd-sub', text: `Recycled sentences · ${m.instances.length}` }),
      ...findingsList(m, it => {
        const src = h('div', { class: 'src', hidden: true, text: it.source_text });
        return [whereLine(it.section_title, `${Math.round(it.coverage * 100)}% copied from ${it.source_title}`), highlighted(it.text, it.highlights),
          h('button', { class: 'link-btn more', type: 'button', style: { fontSize: '12.5px' }, onclick: e => { src.hidden = !src.hidden; e.target.textContent = src.hidden ? 'Show the earlier sentence' : 'Hide the earlier sentence'; } }, 'Show the earlier sentence'), src];
      }, pdfOk)];
  },
  argument_graph(m, pdfOk) {
    const det = m.details || {}; const out = [];
    if (det.sentences && det.edges) out.push(h('div', { class: 'd-sub', text: 'Claims and their strongest support in the Introduction' }), arcDiagram(det),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--ink-4)', height: '2px' } }), 'support comes first (built up)'),
        h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--red)', height: '2px' } }), 'support comes after the claim (flagged)')));
    if (m.instances.length) out.push(h('div', { class: 'd-sub', text: `Claims stated before their support · ${m.instances.length}` }),
      ...findingsList(m, it => [whereLine(`Sentence ${it.sentence + 1}`, it.label), h('div', { class: 'txt', text: it.text }), h('div', { class: 'src', text: `Supported by sentence ${it.support_sentence}: ${it.support_text}` })], pdfOk));
    else out.push(okLine('Every key claim follows the context that supports it.'));
    return out;
  },
  citation_isolation(m, pdfOk) {
    const det = m.details || {};
    const out = [h('div', { class: 'd-sub', text: `${det.woven ?? 0} of ${m.den} citing sentences relate works to one another` })];
    if (m.instances.length) out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text }),
      h('div', { class: 'keys' }, (it.keys || []).map(k => h('code', { text: k }))), h('div', { class: 'where', style: { marginTop: '6px', marginBottom: 0 }, text: it.why })], pdfOk));
    else out.push(okLine('Every citing sentence groups, compares, or relates its work to another.'));
    return out;
  },
  figure_exposition(m, pdfOk) {
    const det = m.details || {}; const fig = det.figure || {}; const out = [];
    if ((det.candidates || []).length > 1 && !state.job?.local) out.push(figurePicker(m, 'Method figure'));
    const key = state.job?.key || state.job?.id;
    const imgs = (fig.images || []).map(n => h('div', { class: 'fig-img' }, h('img', { src: `/api/jobs/${encodeURIComponent(key)}/files/${n}`, alt: `Figure ${fig.number || ''}`, loading: 'lazy' })));
    const kinds = h('div', { class: 'kinds' }, (det.kinds || []).map(k => h('div', { class: 'kind' + (k.present ? ' on' : '') },
      h('span', { class: 'k-ico', text: k.present ? '✕' : '' }),
      h('div', {}, h('div', { text: k.label + (k.present ? '' : ' · not found') }), k.present && k.examples.length ? h('div', { class: 'k-ex', text: k.examples.slice(0, 3).map(e => `“${trunc(e, 50)}”`).join('  ') }) : null))));
    const side = h('div', {}, h('div', { class: 'd-sub', style: { marginTop: 0 }, text: `Expository kinds in Figure ${fig.number || ''}` }), kinds);
    if (pdfOk && (m.instances[0]?.pdf || []).length) side.append(h('button', { class: 'onpaper', type: 'button', style: { marginTop: '10px' }, onclick: () => showOnPaper(m.key, 0) }, `Show on paper · p. ${m.instances[0].pdf[0].p + 1}`));
    out.push(h('div', { class: 'fig-wrap' }, h('div', {}, imgs), side));
    return out;
  },
  evidence_gap(m, pdfOk) {
    const det = m.details || {}; const out = [];
    if (m.score === 0) {
      const ex = (det.exhibits || [])[0];
      out.push(okLine(`Closed: ${det.exhibit_count} concrete exhibit${det.exhibit_count === 1 ? '' : 's'} found` + (ex ? `, e.g. ${ex.where}: “${trunc(ex.snippet, 140)}”` : '.')));
    } else out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text })], pdfOk));
    if ((det.result_tables || []).length) out.push(h('div', { class: 'd-sub', text: 'Result tables that make the measure apply' }),
      h('ul', { class: 'findings' }, det.result_tables.slice(0, 4).map(t => h('li', { class: 'finding' }, h('div', { class: 'where' }, h('span', { text: t.section_title }), h('span', { text: `${t.rows} data rows · ${t.numeric_cells} numeric cells` })), h('div', { class: 'txt', text: trunc(t.caption || t.label, 180) })))));
    return out;
  },
};

function arcDiagram(det) {
  const n = det.sentences.length; const W = 760, H = 150, pad = 14, base = 74;
  const x = i => pad + (W - 2 * pad) * (i - 0.5) / n;
  const svg = s('svg', { class: 'arcs', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Claims and supporting sentences in the Introduction' });
  svg.append(s('rect', { class: 'tick', x: pad, y: base - 0.5, width: W - 2 * pad, height: 1 }));
  const claims = new Map((det.edges || []).map(e => [e.claim, e]));
  for (const e of det.edges || []) {
    const x1 = x(e.claim), x2 = x(e.support), up = !e.shallow, r = Math.min(58, Math.abs(x2 - x1) / 2);
    svg.append(s('path', { d: `M${x1},${base} Q${(x1 + x2) / 2},${up ? base - 2 * r : base + 2 * r} ${x2},${base}`, fill: 'none', stroke: up ? 'var(--ink-4)' : 'var(--red)', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: up ? 0.6 : 0.9 }));
  }
  for (let i = 1; i <= n; i++) {
    const e = claims.get(i); const lab = det.labels?.[i] || det.labels?.[String(i)] || 'other';
    svg.append(s('circle', { cx: x(i), cy: base, r: e ? 5 : 2.5, fill: e ? (e.shallow ? 'var(--red)' : 'var(--ink)') : 'var(--ink-4)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    const hit = s('circle', { cx: x(i), cy: base, r: 9, fill: 'transparent', tabindex: 0 });
    bindTip(hit, `Sentence ${i}${e ? ' · ' + lab.replace('_', ' ') + ' · support: ' + e.support : ''}`, trunc(det.sentences[i - 1], 260));
    svg.append(hit);
  }
  svg.append(s('text', { x: pad, y: H - 4, text: 'first sentence' }), s('text', { x: W - pad, y: H - 4, 'text-anchor': 'end', text: 'last sentence' }));
  return svg;
}
function figurePicker(m, label) {
  const det = m.details || {}; const fig = det.figure || {};
  const sel = h('select', { 'aria-label': 'Method figure' },
    fig.index == null ? h('option', { value: '', text: 'Choose a figure…', selected: true }) : null,
    (det.candidates || []).map(c => h('option', { value: c.index, selected: c.index === fig.index ? true : null, text: `Figure ${c.number || c.index + 1}: ${trunc(c.caption, 70)}` })));
  sel.addEventListener('change', () => { if (sel.value !== '') switchFigure(Number(sel.value), sel); });
  return h('div', { class: 'fig-pick' }, h('span', { text: label }), sel);
}
async function switchFigure(index, sel) {
  sel.disabled = true; toast('Reading the figure…');
  try {
    const key = state.job.key || state.job.id;
    const r = await fetch(`/api/jobs/${encodeURIComponent(key)}/figure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Could not re-score the figure.');
    state.job.result = d; state.sig = ''; render(state.job); remember(d);
  } catch (e) { toast(e.message); sel.disabled = false; }
}

function footCard(res) {
  const idx = res.index; const P = idx.planes || {};
  const parts = PLANES.filter(p => P[p.key]?.score != null).map(p => `${p.label} ${fmt(P[p.key].score)}`);
  const eng = res.engine || {};
  return h('div', { class: 'card foot-card' },
    h('div', { class: 'formula' },
      h('div', { class: 'd-sub', style: { marginTop: 0 }, text: 'How this number is computed' }),
      h('div', { class: 'eq', text: 'S(p) = mean over planes of the mean of its measures' }),
      h('div', { class: 'calc', text: parts.length ? `${parts.join('  ·  ')}  →  ${idx.index} / 100` : 'No plane could be measured.' }),
      h('div', { class: 'engine', text: `Language model: ${eng.llm?.model || '—'}` + (eng.llm?.provider ? ` via ${eng.llm.provider}` : '') + (eng.llm_available ? ` · ${eng.llm_calls} calls` : ' · not configured') + ` · ${eng.seconds}s` })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(location.href, 'Link copied') }, 'Copy link'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('/') }, 'Analyze another')));
}

// ------------------------------------------------------------------ how it works
let howBuilt = false;
function buildHow() {
  if (howBuilt) return; howBuilt = true;
  const t = $('#spec');
  t.append(h('thead', {}, h('tr', {}, ['', 'Item', 'Illustration', 'Unit of analysis', 'Score (share of units)', 'What 100 means', 'Pair acc.*'].map(c => h('th', { text: c })))));
  const tb = h('tbody');
  for (const p of PLANES) p.measures.forEach((k, i) => {
    const m = MEASURES[k];
    tb.append(h('tr', { class: `band-${p.key}` + (i === 0 ? ' plane-first' : '') },
      h('td', {}, i === 0 ? h('span', { class: `tag ${p.key}`, text: p.label }) : ''),
      h('td', { class: 'item', text: m.name }),
      h('td', {}, h('img', { src: `/static/img/${k}.svg`, alt: `Illustration of ${m.name}` })),
      h('td', { text: m.unit }),
      h('td', {}, h('span', { class: `frac ${p.key}` }, h('span', { text: m.num }), h('span', { text: m.den }))),
      h('td', { text: m.one }),
      h('td', { class: 'num', text: m.pairacc.toFixed(3) })));
  });
  t.append(tb);
  drawBench();
}
function drawBench() {
  const svg = $('#bench'); const host = svg.parentElement;
  const draw = () => {
    const W = Math.max(280, host.clientWidth - 44); const labelW = W < 420 ? 118 : 150; const rowH = 30; const top = 6; const H = top + rowH * BENCH.length + 22;
    const plotW = W - labelW - 44; const X = v => labelW + plotW * v;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.replaceChildren();
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { class: 'grid', x1: X(t), x2: X(t), y1: top, y2: top + rowH * BENCH.length }));
      svg.append(s('text', { x: X(t), y: H - 4, 'text-anchor': 'middle', text: t === 0.5 ? '0.5 chance' : String(t) }));
    }
    BENCH.forEach(([name, pa, au, ours], i) => {
      const y = top + i * rowH + 8; const bh = 14; const w = X(pa) - X(0);
      svg.append(s('text', { x: labelW - 10, y: y + 11, 'text-anchor': 'end', text: name, 'font-weight': ours ? 700 : 400 }));
      svg.append(s('path', { d: `M${X(0)},${y} h${w - 4} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z`, fill: ours ? 'var(--red)' : 'var(--line-2)' }));
      const hit = s('rect', { x: X(0), y: y - 6, width: plotW, height: rowH, fill: 'transparent' });
      bindTip(hit, `${pa.toFixed(3)} pair accuracy`, `${name} · AUROC ${au.toFixed(3)}`);
      svg.append(s('text', { class: 'v', x: X(pa) + 6, y: y + 11, text: pa.toFixed(3) }), hit);
    });
  };
  draw(); new ResizeObserver(draw).observe(host);
}

// ------------------------------------------------------------------ leaderboard
const METRICS = [
  { id: 'index', label: 'Science Slop Index', stacked: true },
  ...PLANES.map(p => ({ id: 'plane:' + p.key, label: `${p.label} plane`, plane: p.key })),
  ...ORDER.map(k => ({ id: 'm:' + k, label: MEASURES[k].name, plane: MEASURES[k].plane })),
];
const lb = { metric: 'index', top: 30, picked: null, excluded: new Set(), hidePartial: false, table: false, sort: 'value', dir: -1, pop: null, data: null };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function lbValue(x, metric) {
  if (metric === 'index') return x.index;
  if (metric.startsWith('plane:')) { const v = x.planes?.[metric.slice(6)]; return v == null ? null : 100 * v; }
  const v = x.measures?.[metric.slice(2)]; return v == null ? null : 100 * v;
}
function lbReadParams() {
  const q = new URLSearchParams(location.search);
  if (q.get('metric') && METRICS.some(m => m.id === q.get('metric'))) lb.metric = q.get('metric');
  if (q.get('n')) lb.top = q.get('n') === 'all' ? Infinity : Math.max(1, parseInt(q.get('n'), 10) || 30);
  if (q.get('exclude')) lb.excluded = new Set(q.get('exclude').split(','));
  lb.hidePartial = q.get('partial') === '0';
  lb.table = q.get('view') === 'table';
}
function lbUrl() {
  const q = new URLSearchParams();
  if (lb.metric !== 'index') q.set('metric', lb.metric);
  if (lb.top !== 30) q.set('n', lb.top === Infinity ? 'all' : lb.top);
  if (lb.excluded.size) q.set('exclude', [...lb.excluded].join(','));
  if (lb.hidePartial) q.set('partial', '0');
  if (lb.table) q.set('view', 'table');
  const s = q.toString();
  return location.origin + '/leaderboard' + (s ? '?' + s : '');
}
async function loadLeaderboard() {
  lbReadParams();
  $('#lb-chart').replaceChildren(h('div', { class: 'lb-empty', text: 'Loading…' }));
  try { const r = await fetch('/api/gallery'); lb.data = await r.json(); state.gallery = lb.data; }
  catch (_) { $('#lb-chart').replaceChildren(h('div', { class: 'lb-empty', text: 'Could not load the leaderboard.' })); return; }
  renderLeaderboard();
}
function lbRows() {
  const all = (lb.data?.items || []).filter(x => lbValue(x, lb.metric) != null);
  const pool = all.filter(x => !lb.excluded.has(x.source) && !(lb.hidePartial && x.partial));
  pool.sort((a, b) => lbValue(b, lb.metric) - lbValue(a, lb.metric));
  const shown = lb.picked ? pool.filter(x => lb.picked.has(x.key)) : pool.slice(0, lb.top);
  return { all, pool, shown };
}
function renderLeaderboard() {
  const { all, pool, shown } = lbRows();
  const metric = METRICS.find(m => m.id === lb.metric);
  $('#lb-count-t').textContent = `${shown.length} of ${all.length} papers`;
  $('#lb-metricname').textContent = metric.stacked ? 'Science Slop Index · contribution of each plane' : `${metric.label} · score out of 100`;
  $('#lb-table').setAttribute('aria-pressed', String(lb.table));
  $('#lb-filter').classList.toggle('on', lb.excluded.size > 0 || lb.hidePartial);
  $('#lb-metric').classList.toggle('on', lb.metric !== 'index');
  $('#lb-scroll').parentElement.hidden = lb.table;
  $('#lb-tablewrap').hidden = !lb.table;
  if (lb.table) renderLbTable(shown); else drawLbChart(shown, metric);
  $('#lb-legend').replaceChildren(...(metric.stacked
    ? [...PLANES.map(p => h('span', {}, h('span', { class: 'lg-box', style: { background: PLANE_VAR[p.key], borderRadius: '3px', width: '12px', height: '12px' } }), `${p.label} share`)),
      h('span', { class: 'muted', text: 'Each bar is the index; its segments show how much each plane adds.' })]
    : [h('span', {}, h('span', { class: 'lg-box', style: { background: PLANE_VAR[metric.plane], borderRadius: '3px', width: '12px', height: '12px' } }), metric.label)]));
  const partial = shown.some(x => x.partial) ? '* Partial: some measures could not run for this paper. ' : '';
  $('#lb-note').textContent = partial + (pool.length > shown.length ? `Showing the top ${shown.length} of ${pool.length}. ` : '')
    + (lb.data?.persistent ? '' : 'Papers analyzed on this server are listed until it restarts; bundled papers always stay.');
}
function drawLbChart(rows, metric) {
  const host = $('#lb-chart');
  if (!rows.length) { host.replaceChildren(h('div', { class: 'lb-empty' }, 'No paper to rank yet. ', h('a', { href: '/', 'data-link': '' }, 'Analyze one'))); return; }
  const colors = Object.fromEntries(PLANES.map(p => [p.key, cssVar('--' + p.key)]));
  const surface = cssVar('--surface');
  const avail = Math.max(320, $('#lb-scroll').clientWidth);
  const right = 8, top = 28, plotH = 300, badgeH = 30;
  const slot0 = (avail - 34 - right) / rows.length;
  const flat = slot0 >= 104;                         // few papers: titles sit flat under the bars
  const left = flat ? 34 : Math.max(34, 150 - Math.max(46, slot0) / 2);   // room for the first rotated title
  const slot = Math.max(46, (avail - left - right) / rows.length);
  const labelH = flat ? 64 : 150;
  const W = Math.max(avail, left + right + slot * rows.length);
  const H = top + plotH + badgeH + labelH;
  const vals = rows.map(x => lbValue(x, lb.metric));
  const maxV = Math.max(...vals, 1);
  const yMax = Math.min(100, Math.max(10, Math.ceil(maxV * 1.12 / 10) * 10));
  const Y = v => top + plotH - plotH * v / yMax;
  const bw = Math.min(58, slot * 0.74);
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${metric.label} for ${rows.length} papers, highest first`, xmlns: SVGNS });
  const step = yMax <= 20 ? 5 : yMax <= 50 ? 10 : 20;
  for (let t = 0; t <= yMax + 0.01; t += step) {
    svg.append(s('line', { class: 'grid', x1: left, x2: W - right, y1: Y(t), y2: Y(t) }));
    svg.append(s('text', { class: 'axis', x: left - 8, y: Y(t) + 4, 'text-anchor': 'end', text: String(t) }));
  }
  rows.forEach((x, i) => {
    const v = lbValue(x, lb.metric);
    const cx = left + slot * (i + 0.5); const x0 = cx - bw / 2;
    const g = s('g', { class: 'col', tabindex: 0, role: 'link', 'aria-label': `#${i + 1} ${x.title}: ${Math.round(v)}` });
    // segments: plane contributions for the index, one plane color otherwise
    let segs;
    if (metric.stacked) {
      const planes = PLANES.filter(p => x.planes?.[p.key] != null);
      segs = planes.map(p => ({ c: colors[p.key], v: 100 * x.planes[p.key] / planes.length }));
    } else segs = [{ c: colors[metric.plane], v }];
    let base = top + plotH;
    segs.forEach((sg, k) => {
      const hgt = plotH * sg.v / yMax; if (hgt <= 0) return;
      const last = k === segs.length - 1 || segs.slice(k + 1).every(o => o.v <= 0);
      const yTop = base - hgt; const r = last ? Math.min(5, hgt) : 0;
      const d = `M${x0},${base} V${yTop + r} ${r ? `Q${x0},${yTop} ${x0 + r},${yTop}` : ''} H${x0 + bw - r} ${r ? `Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r}` : ''} V${base} Z`;
      g.append(s('path', { class: 'seg', d, fill: sg.c }));
      if (!last) g.append(s('rect', { x: x0, y: yTop - 1, width: bw, height: 2, fill: surface }));   // 2px surface gap between segments
      base = yTop;
    });
    g.append(s('text', { class: 'cap', x: cx, y: Y(v) - 8, 'text-anchor': 'middle', text: String(Math.round(v)) + (x.partial && metric.stacked ? '*' : '') }));
    // source badge + rotated title
    const SHORT = { OpenReview: 'OR', Upload: 'PDF', Example: 'Ex' };
    const bt = slot < 76 ? (SHORT[x.source] || (x.source || '').slice(0, 5)) : (x.source || '');
    const bwid = Math.min(slot - 6, Math.max(28, bt.length * 6.2 + 12));
    g.append(s('rect', { class: 'badge', x: cx - bwid / 2, y: top + plotH + 8, width: bwid, height: 17, rx: 5 }));
    g.append(s('text', { class: 'badge-t', x: cx, y: top + plotH + 20, 'text-anchor': 'middle', text: bt }));
    if (flat) {
      // wrap the title into at most three centered lines that fit the slot
      const maxChars = Math.max(8, Math.floor((slot - 12) / 6.6));
      const words = (x.title || 'Untitled').split(/\s+/); const lines = [''];
      for (const w of words) {
        const cur = lines[lines.length - 1];
        if ((cur + ' ' + w).trim().length <= maxChars) lines[lines.length - 1] = (cur + ' ' + w).trim();
        else if (lines.length < 3) lines.push(w);
        else { lines[2] = trunc(lines[2] + ' ' + w, maxChars); break; }
      }
      lines.forEach((ln, li) => g.append(s('text', { class: 'xl', x: cx, y: top + plotH + badgeH + 16 + li * 15, 'text-anchor': 'middle', text: trunc(ln, maxChars) })));
    } else {
      g.append(s('text', { class: 'xl', transform: `translate(${cx + 4},${top + plotH + badgeH + 8}) rotate(-42)`, 'text-anchor': 'end', text: trunc(x.title || 'Untitled', 28) }));
    }
    g.append(s('rect', { class: 'hitr', x: cx - slot / 2 + 2, y: top - 20, width: slot - 4, height: plotH + badgeH + 30, fill: 'transparent', rx: 6 }));
    const tipBody = [`Rank #${i + 1} · ${metric.label} ${Math.round(v)}`,
      ...PLANES.map(p => `${p.label} ${fmt(x.planes?.[p.key])}`),
      ...ORDER.map(k => `${MEASURES[k].short} ${fmt(x.measures?.[k])}`)].join('  ·  ');
    bindTip(g, x.title, tipBody);
    const open = () => { hideTip(); go('/r/' + x.key); };
    g.addEventListener('click', open);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    svg.append(g);
  });
  svg.append(s('line', { x1: left, x2: W - right, y1: top + plotH, y2: top + plotH, stroke: cssVar('--line-2'), 'stroke-width': 1 }));
  host.replaceChildren(svg);
}
function renderLbTable(rows) {
  const cols = [
    { k: 'rank', l: '#' }, { k: 'title', l: 'Paper' }, { k: 'index', l: 'Index' },
    ...PLANES.map(p => ({ k: 'plane:' + p.key, l: p.label })),
    ...ORDER.map(k => ({ k: 'm:' + k, l: MEASURES[k].short })), { k: 'source', l: 'Source' },
  ];
  const val = (x, k) => k === 'title' ? (x.title || '') : k === 'source' ? (x.source || '') : k === 'index' ? x.index : lbValue(x, k);
  const ranked = rows.map((x, i) => ({ ...x, rank: i + 1 }));
  if (lb.sort !== 'value' && lb.sort !== 'rank') ranked.sort((a, b) => {
    const va = val(a, lb.sort), vb = val(b, lb.sort);
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * lb.dir;
  });
  const thead = h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: lb.sort === c.k ? 'sorted' : '', title: 'Sort',
    onclick: () => { if (lb.sort === c.k) lb.dir *= -1; else { lb.sort = c.k; lb.dir = c.k === 'title' || c.k === 'source' ? 1 : -1; } renderLeaderboard(); } },
    c.l + (lb.sort === c.k ? (lb.dir > 0 ? ' ↑' : ' ↓') : '')))));
  const tbody = h('tbody', {}, ranked.map(x => h('tr', { onclick: () => go('/r/' + x.key), tabindex: 0, onkeydown: e => { if (e.key === 'Enter') go('/r/' + x.key); } },
    h('td', { text: String(x.rank) }), h('td', { class: 'title', text: x.title, title: x.title }),
    h('td', { class: 'idx', text: x.index == null ? '—' : x.index + (x.partial ? '*' : '') }),
    ...PLANES.map(p => h('td', { text: fmt(x.planes?.[p.key]) })),
    ...ORDER.map(k => h('td', { text: fmt(x.measures?.[k]) })),
    h('td', { text: x.source || '' }))));
  $('#lb-tablewrap').replaceChildren(h('table', { class: 'lb-table' }, thead, tbody));
}
function lbPopover(kind, anchor) {
  const pop = $('#lb-pop');
  if (lb.pop === kind) { pop.hidden = true; lb.pop = null; return; }
  lb.pop = kind;
  const { all, pool } = lbRows();
  const close = () => { pop.hidden = true; lb.pop = null; };
  let body = [];
  if (kind === 'count') {
    const chip = (label, n) => h('button', { type: 'button', class: !lb.picked && lb.top === n ? 'on' : '', onclick: () => { lb.picked = null; lb.top = n; renderLeaderboard(); close(); } }, label);
    const search = h('input', { type: 'search', placeholder: 'Search papers', 'aria-label': 'Search papers' });
    const list = h('div', {});
    const shownKeys = new Set(lbRows().shown.map(x => x.key));
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...pool.filter(x => !q || (x.title || '').toLowerCase().includes(q)).map(x => {
        const cb = h('input', { type: 'checkbox', checked: shownKeys.has(x.key) ? true : null, onchange: () => {
          lb.picked = new Set(lb.picked || shownKeys);
          cb.checked ? lb.picked.add(x.key) : lb.picked.delete(x.key);
          cb.checked ? shownKeys.add(x.key) : shownKeys.delete(x.key);
          renderLeaderboard();
        } });
        return h('label', { class: 'lb-opt' }, cb, h('span', { class: 't', text: x.title, title: x.title }), h('span', { class: 'v', text: String(Math.round(lbValue(x, lb.metric))) }));
      }));
    };
    search.addEventListener('input', draw); draw();
    body = [h('h5', { text: 'Show' }), h('div', { class: 'chips' }, chip('Top 10', 10), chip('Top 20', 20), chip('Top 30', 30), chip('All', Infinity)),
      h('h5', { text: 'Or pick papers' }), search, list];
  } else if (kind === 'filter') {
    const sources = [...new Set(all.map(x => x.source).filter(Boolean))].sort();
    body = [h('h5', { text: 'Source' }), ...sources.map(src => {
      const n = all.filter(x => x.source === src).length;
      const cb = h('input', { type: 'checkbox', checked: !lb.excluded.has(src) ? true : null, onchange: () => { cb.checked ? lb.excluded.delete(src) : lb.excluded.add(src); lb.picked = null; renderLeaderboard(); } });
      return h('label', { class: 'lb-opt' }, cb, h('span', { class: 't', text: src }), h('span', { class: 'v', text: String(n) }));
    }), h('h5', { text: 'Reports', style: { marginTop: '12px' } }), (() => {
      const cb = h('input', { type: 'checkbox', checked: lb.hidePartial ? true : null, onchange: () => { lb.hidePartial = cb.checked; lb.picked = null; renderLeaderboard(); } });
      return h('label', { class: 'lb-opt' }, cb, h('span', { class: 't', text: 'Hide partial reports (some measures did not run)' }));
    })()];
  } else {
    const opt = m => {
      const r = h('input', { type: 'radio', name: 'lb-metric', checked: lb.metric === m.id ? true : null, onchange: () => { lb.metric = m.id; lb.sort = 'value'; renderLeaderboard(); close(); } });
      return h('label', { class: 'lb-opt' }, r, m.plane ? h('span', { class: 'sw', style: { background: PLANE_VAR[m.plane] } }) : h('span', { class: 'mark', style: { gap: '2px' } }, h('i'), h('i'), h('i')), h('span', { class: 't', text: m.label }));
    };
    body = [h('h5', { text: 'Rank by' }), opt(METRICS[0]), h('h5', { text: 'Planes', style: { marginTop: '10px' } }), ...METRICS.filter(m => m.id.startsWith('plane:')).map(opt),
      h('h5', { text: 'Measures', style: { marginTop: '10px' } }), ...METRICS.filter(m => m.id.startsWith('m:')).map(opt)];
  }
  pop.replaceChildren(...body);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(); const pr = $('#page-leaderboard').getBoundingClientRect();
  pop.style.top = `${r.bottom - pr.top + 8}px`;
  pop.style.left = `${Math.max(0, Math.min(r.right - pr.left - 340, pr.width - 340))}px`;
}
async function lbDownloadPng() {
  const svg = $('#lb-chart svg'); if (!svg) { toast('Switch to the chart first'); return; }
  const clone = svg.cloneNode(true);
  // inline the computed styles the CSS classes provide, so the image stands alone
  const map = [['.grid', { stroke: cssVar('--line') }], ['.axis', { fill: cssVar('--ink-4'), 'font-size': '11px' }], ['.cap', { fill: cssVar('--ink'), 'font-size': '14px', 'font-weight': '700' }],
    ['.xl', { fill: cssVar('--ink-2'), 'font-size': '11px' }], ['.badge-t', { fill: cssVar('--ink-2'), 'font-size': '9.5px', 'font-weight': '700' }], ['.badge', { fill: cssVar('--surface-2'), stroke: cssVar('--line-2') }]];
  for (const [sel, st] of map) clone.querySelectorAll(sel).forEach(n => Object.entries(st).forEach(([k, v]) => n.setAttribute(k, v)));
  clone.querySelectorAll('text').forEach(n => n.setAttribute('font-family', 'Avenir Next, Avenir, Nunito Sans, Helvetica, Arial, sans-serif'));
  const W = +svg.getAttribute('width'), Hh = +svg.getAttribute('height'), head = 64;
  const wrap = document.createElementNS(SVGNS, 'svg');
  wrap.setAttribute('xmlns', SVGNS); wrap.setAttribute('width', W); wrap.setAttribute('height', Hh + head);
  wrap.append(s('rect', { width: W, height: Hh + head, fill: cssVar('--surface') }),
    s('text', { x: 16, y: 32, 'font-size': '20', 'font-weight': '700', fill: cssVar('--ink'), 'font-family': 'Avenir Next, Avenir, Nunito Sans, Helvetica, sans-serif', text: 'Science Slop Index' }),
    s('text', { x: 16, y: 52, 'font-size': '12', fill: cssVar('--ink-3'), 'font-family': 'Avenir Next, Avenir, Nunito Sans, Helvetica, sans-serif', text: `${$('#lb-metricname').textContent} · scislop.open-galapagos.com` }));
  const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('transform', `translate(0,${head})`); g.append(...clone.childNodes); wrap.append(g);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(wrap)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = W * 2; c.height = (Hh + head) * 2;
    const ctx = c.getContext('2d'); ctx.scale(2, 2); ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url);
    c.toBlob(b => { const a = h('a', { href: URL.createObjectURL(b), download: 'science-slop-index-leaderboard.png' }); document.body.append(a); a.click(); a.remove(); });
  };
  img.src = url;
}
function initLeaderboard() {
  $('#lb-count').addEventListener('click', e => { e.stopPropagation(); lbPopover('count', e.currentTarget); });
  $('#lb-filter').addEventListener('click', e => { e.stopPropagation(); lbPopover('filter', e.currentTarget); });
  $('#lb-metric').addEventListener('click', e => { e.stopPropagation(); lbPopover('metric', e.currentTarget); });
  $('#lb-table').addEventListener('click', () => { lb.table = !lb.table; renderLeaderboard(); });
  $('#lb-link').addEventListener('click', () => copy(lbUrl(), 'Link to this view copied'));
  $('#lb-png').addEventListener('click', lbDownloadPng);
  document.addEventListener('click', e => { if (lb.pop && !e.target.closest('#lb-pop')) { $('#lb-pop').hidden = true; lb.pop = null; } });
  let last = 0;
  new ResizeObserver(() => { const w = $('#lb-scroll').clientWidth; if (!$('#page-leaderboard').hidden && lb.data && !lb.table && Math.abs(w - last) > 8) { last = w; renderLeaderboard(); } }).observe($('#lb-scroll'));
}

// ------------------------------------------------------------------ home
function shortTitle(t) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  const cut = t.split(/[:：]/)[0];
  const w = (cut.length >= 8 ? cut : t).split(' ');
  return w.length > 4 ? w.slice(0, 4).join(' ') + '…' : w.join(' ');
}
function fmtDate(ts) { if (!ts) return ''; const d = new Date(ts * 1000); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
function hcard(x, rankNo) {
  const b = x.index != null ? band(x.index) : null;
  return h('a', { class: 'hcard', href: `/r/${x.key}`, 'data-link': '', style: { '--hc-color': b ? b.color : 'var(--line-2)' } },
    h('div', { class: 'hc-main' },
      h('div', { class: 'hc-stamp' }, h('span', { class: 'no', text: rankNo ? `#${rankNo}` : '—' }), h('span', { text: [x.source, fmtDate(x.created)].filter(Boolean).join(' · ') })),
      h('div', { class: 'hc-title', text: x.title || 'Untitled' }),
      h('div', { class: 'hc-bars' },
        PLANES.map(p => h('span', { class: 'hc-bar', title: p.q }, h('span', { text: p.label }), h('i', {}, h('b', { style: { width: `${100 * (x.planes?.[p.key] || 0)}%`, background: PLANE_VAR[p.key] } })), h('span', { class: 'v', text: fmt(x.planes?.[p.key]) }))),
        h('span', { class: 'hc-idx' }, h('span', { text: x.index != null ? String(x.index) : '—' }), h('small', { text: x.partial ? '/ 100 · partial' : '/ 100' })))),
    h('div', { class: 'hc-thumb' }, x.thumb ? h('img', { src: `/api/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy' }) : h('div', { class: 'ph', text: shortTitle(x.title) })));
}
async function loadHome() {
  if (!state.gallery) {
    try { const r = await fetch('/api/gallery'); state.gallery = await r.json(); }
    catch (_) { return; }
  }
  const ranked = [...state.gallery.items].filter(x => x.index != null).sort((a, b) => b.index - a.index);
  const ex = $('#examples');
  const seeds = [...state.gallery.items].filter(x => x.index != null && x.source_kind !== 'upload').sort((a, b) => (a.created || 0) - (b.created || 0)).slice(0, 4);
  ex.hidden = !seeds.length;
  ex.replaceChildren(h('span', { class: 'ex-l', text: 'Try an example:' }), ...seeds.map(x => h('a', { class: 'ex', href: `/r/${x.key}`, 'data-link': '', title: x.title, text: shortTitle(x.title) })));
  $('#home-list').replaceChildren(...ranked.slice(0, 5).map((x, i) => hcard(x, i + 1)));
}

// ------------------------------------------------------------------ gallery
async function loadGallery() {
  const grid = $('#g-grid');
  if (!state.gallery) grid.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  try { const r = await fetch('/api/gallery'); state.gallery = await r.json(); }
  catch (_) { grid.replaceChildren(h('p', { class: 'g-empty', text: 'Could not load the gallery.' })); return; }
  renderGallery();
}
function renderGallery() {
  const data = state.gallery || { items: [] };
  const q = $('#g-q').value.trim().toLowerCase(); const sort = $('#g-sort').value;
  const ranked = [...data.items].filter(x => x.index != null).sort((a, b) => b.index - a.index);
  const rank = new Map(ranked.map((x, i) => [x.key, i + 1]));
  const items = data.items.filter(x => !q || (x.title || '').toLowerCase().includes(q));
  items.sort(sort === 'low' ? (a, b) => (a.index ?? 999) - (b.index ?? 999) : sort === 'new' ? (a, b) => (b.created || 0) - (a.created || 0) : (a, b) => (b.index ?? -1) - (a.index ?? -1));
  const grid = $('#g-grid');
  if (!items.length) grid.replaceChildren(h('div', { class: 'g-empty' }, data.items.length ? 'No paper matches your search.' : 'No paper has been analyzed yet. ', data.items.length ? null : h('a', { href: '/', 'data-link': '' }, 'Analyze one')));
  else grid.replaceChildren(...items.map(x => {
    const b = x.index != null ? band(x.index) : null;
    return h('a', { class: 'g-card', href: `/r/${x.key}`, 'data-link': '' },
      h('div', { class: 'g-thumb', style: { borderBottomColor: b ? b.color : 'var(--line-2)' } },
        x.thumb ? h('img', { src: `/api/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy' }) : h('div', { class: 'ph', text: x.title })),
      h('div', { class: 'g-body' },
        h('div', { class: 'g-rank' }, h('span', { text: rank.has(x.key) ? `Science Slop Index #${rank.get(x.key)}` : '—' }), h('span', { class: 'score', text: x.index != null ? `${x.index} / 100${x.partial ? '*' : ''}` : '—' })),
        h('div', { class: 'g-title', text: x.title }),
        h('div', { class: 'g-planes' }, PLANES.map(p => h('i', { title: `${p.label} ${fmt(x.planes?.[p.key])}` }, h('b', { style: { width: `${100 * (x.planes?.[p.key] || 0)}%`, background: PLANE_VAR[p.key] } }))))));
  }));
  $('#g-note').textContent = (data.items.some(x => x.partial) ? '* Partial: some measures could not run. ' : '')
    + (data.persistent ? '' : 'Reports added on this server are kept until it restarts; papers bundled with the site always stay.');
}

// ------------------------------------------------------------------ view report
function renderRecent() {
  const list = store.get('ssi-recent', []);
  $('#recent-h').hidden = !list.length;
  $('#recent').replaceChildren(...list.slice(0, 12).map(r => h('li', {}, h('a', { href: `/r/${r.key}`, 'data-link': '' },
    h('span', { class: 'r-score', text: r.index ?? '—' }), h('span', { class: 'r-title', text: r.title || 'Untitled' }), h('span', { class: 'r-key', text: r.key })))));
}

// ------------------------------------------------------------------ boot
async function boot() {
  initTheme(); initInputs(); initLeaderboard();
  $('#g-q').addEventListener('input', renderGallery);
  $('#g-sort').addEventListener('change', renderGallery);
  try {
    const r = await fetch('/api/config'); state.config = await r.json();
    if (state.config.examples?.length) { $('#example').hidden = false; $('#example').title = state.config.examples[0].title; }
    if (!state.config.llm_available) { const n = $('#llm-notice'); n.hidden = false; n.textContent = 'Argument graph and Figure exposition need a language model. Set LITELLM_PROXY_API_KEY (or OPENROUTER_API_KEY) on the server to enable them.'; }
  } catch (_) { /* the page works without config */ }
  route();
}
boot();
