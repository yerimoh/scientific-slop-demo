// Static mirror (GitHub Pages) support: window.SCISLOP_STATIC = { base, live } makes every API read a pre-built file.
const STATIC_MODE = window.SCISLOP_STATIC || null;
const BASE = STATIC_MODE ? STATIC_MODE.base.replace(/\/$/, '') : '';
const API = BASE + '/api';
const STATIC = BASE + '/static';
const LIVE = STATIC_MODE ? STATIC_MODE.live.replace(/\/$/, '') : '';
const STATIC_KEYS = new Set(STATIC_MODE ? (STATIC_MODE.keys || []) : []);
const LIVE_API = STATIC_MODE ? LIVE + '/api' : API;
// Job URLs: pre-rendered on the mirror for shipped reports, the live backend for everything analyzed after the build.
const J = key => (STATIC_MODE && !STATIC_KEYS.has(key)) ? LIVE_API : API;
if (STATIC_MODE) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith(API + '/')) {
      const rest = url.slice(API.length + 1).split('?')[0];
      if (opts && opts.method && opts.method !== 'GET') return realFetch(LIVE_API + '/' + rest, opts);    // analyses, proposals, flags
      if (rest === 'proposals') return fetchProposalsFromGitHub();
      if (!/\.(jpg|png|json|csv|pdf)$/.test(rest) && !/\/files\//.test(rest) && !/\/pdf$/.test(rest)) url = API + '/' + rest + '.json';
    }
    return realFetch(url, opts);
  };
}
async function fetchProposalsFromGitHub() {
  const repo = STATIC_MODE.repo || 'yerimoh/scientific-slop-demo';
  const STATUS = { accepted: 'Accepted', 'not-adopted': 'Not adopted', testing: 'Testing on SciSlopBench', 'under-review': 'Under review' };
  let items = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/issues?labels=proposal&state=all&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
    for (const it of await r.json()) {
      const labels = (it.labels || []).map(l => l.name); const status = ['accepted', 'not-adopted', 'testing', 'under-review'].find(k => labels.includes(k)) || 'under-review';
      const body = it.body || ''; const plane = (body.match(/\*\*Plane:\*\* (\w+)/) || [])[1]; const what = (body.match(/\*\*What it is:\*\* (.+)/) || [])[1]; const by = (body.match(/Proposed by (.+?)\./) || [])[1];
      items.push({ id: 'gh-' + it.number, name: it.title.replace(/^Proposal:\s*/, ''), plane: plane ? plane.toLowerCase() : null, what: (what || '').trim(), author: by || 'Anonymous', status, status_label: STATUS[status], url: it.html_url, created: it.created_at });
    }
  } catch (_) { /* offline */ }
  return new Response(JSON.stringify({ items, github: false, repo, static: true }), { headers: { 'Content-Type': 'application/json' } });
}
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
  cross_refs: { name: 'Cross-section references', short: 'Cross-refs', plane: 'structure', method: 'Rule', unit: 'Body sections and labeled objects', num: 'objects never referenced outside their own section', den: 'all objects', one: 'No object is ever referred to from another section.', pairacc: 0.905, what: 'Sections and labeled objects that no other section ever refers to.' },
  macro_redundancy: { name: 'Macro redundancy', short: 'Redundancy', plane: 'structure', method: 'Rule', unit: 'Sentences with at least eight tokens', num: 'sentences half or more copied as 8-grams from an earlier section', den: 'all sentences', one: 'Every sentence mostly repeats earlier sections.', pairacc: 0.723, what: 'Later sections that repeat earlier material instead of developing the argument.' },
  argument_graph: { name: 'Argument graph', short: 'Claims', plane: 'argument', method: 'LLM', unit: 'Key claims in the Introduction', num: 'shallow claims: nothing earlier leads up to them', den: 'all key claims', one: 'The argument is flat. Every claim stands alone with no build-up behind it.', pairacc: 0.586, what: 'Key claims in the Introduction stated before the context that supports them.' },
  citation_isolation: { name: 'Citation isolation', short: 'Citations', plane: 'argument', method: 'Rule', unit: 'Citation sentences (Intro., Related Work)', num: 'citations not grouped, compared, or related to other works', den: 'all citations', one: 'Every citation stands alone.', pairacc: 0.793, what: 'Prior work cited without relating it to any other work.' },
  figure_exposition: { name: 'Figure exposition', short: 'Figure', plane: 'artifacts', method: 'LLM', unit: 'Content types in method figures', num: 'content types not needed to show the method', den: 'all content types in the figure', one: 'Nothing in the figure shows the method itself.', pairacc: 0.809, what: 'Method diagrams crowded with material that belongs in the text.' },
  evidence_gap: { name: 'Evidence gap', short: 'Evidence', plane: 'artifacts', method: 'Rule', unit: 'Papers with a body result table', num: 'papers showing no concrete input, output, or case', den: 'all papers', one: 'The paper gives no concrete example at all.', pairacc: 0.764, what: 'Aggregate results reported without a single concrete input, output, or case.' },
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
function setError(msg) { $('#form-error').textContent = msg || ''; if (msg && state.autoFlag) toast(msg); }
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
const PAGES = ['home', 'leaderboard', 'how', 'gallery', 'view', 'propose', 'report'];
function showPage(name) {
  for (const p of PAGES) $('#page-' + p).hidden = p !== name;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  hideTip();
  if (name !== 'report') document.title = { home: 'Science Slop Index', leaderboard: 'Leaderboard · Science Slop Index', how: 'How it works · Science Slop Index', gallery: 'Gallery · Science Slop Index', view: 'View report · Science Slop Index', propose: 'Propose a pattern · Science Slop Index' }[name];
}
function go(path) { history.pushState({}, '', BASE + path); route(); scrollTo({ top: 0 }); }
function route() {
  clearTimeout(state.timer);
  let p = location.pathname; if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
  const m = p.match(/^\/r\/([A-Za-z0-9_-]+)/);
  if (m) { const q = new URLSearchParams(location.search); showPage('report'); openReport(m[1], q.get('tab'), q.get('p')); return; }
  state.key = null; state.job = null; state.sig = '';
  if (p.startsWith('/leaderboard')) { showPage('leaderboard'); loadLeaderboard(); }
  else if (p.startsWith('/how')) { showPage('how'); buildHow(); }
  else if (p.startsWith('/gallery')) { showPage('gallery'); loadGallery(); }
  else if (p.startsWith('/view')) { showPage('view'); renderRecent(); }
  else if (p.startsWith('/propose')) { showPage('propose'); initPropose(); loadProposals(); }
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
    const r = await fetch(API + '/analyze', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Something went wrong. Try again.');
    state.autoReader = d.key;
    go('/r/' + d.key);
  } catch (e) { setError(e.message); } finally { btn.disabled = false; }
}
function initKey() { $('#bib-copy').addEventListener('click', () => copy($('#bib').textContent, 'BibTeX copied')); }
function submitFile(file) {
  if (!file) return;
  const maxMb = state.config?.max_upload_mb || 50;
  if (file.size > maxMb * 1024 * 1024) { setError(`That file is larger than ${maxMb} MB.`); return; }
  const fd = new FormData(); fd.append('file', file);
  submit(fd);
}
function initContribute() {
  const f = $('#ct-ask'); if (!f) return;
  f.addEventListener('submit', e => { e.preventDefault(); const v = $('#ct-url').value.trim(); if (!v) { $('#ct-url').focus(); return; } state.autoFlag = true; const fd = new FormData(); fd.append('url', v); submit(fd); });
  $('#ct-file').addEventListener('change', e => { state.autoFlag = true; submitFile(e.target.files[0]); e.target.value = ''; });
  document.querySelectorAll('[data-scroll]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); const t = $(a.dataset.scroll); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.querySelector('input')?.focus(); } }));
}
function initInputs() {
  const pre = new URLSearchParams(location.search).get('url'); if (pre) { $('#url').value = pre; }
  $('#ask').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#url').value.trim();
    if (!v) { setError('Paste a link, or upload a file below.'); $('#url').focus(); return; }
    const fd = new FormData(); fd.append('url', v); submit(fd);
  });
  $('#file').addEventListener('change', e => { submitFile(e.target.files[0]); e.target.value = ''; });
  let depth = 0; const drop = $('#drop');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (!hasFiles(e) || $('#page-home').hidden) return; e.preventDefault(); depth++; drop.hidden = false; });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
  addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; drop.hidden = true; if (!$('#page-home').hidden) { if (e.target.closest && e.target.closest('.propose-teaser')) state.autoFlag = true; submitFile(e.dataTransfer.files[0]); } });
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
function openReport(key, tab, page) {
  state.jump = page != null && page !== '' ? +page : null;
  if (state.key !== key) { state.open.clear(); state.showAll.clear(); state.hidden.clear(); state.sig = ''; state.tab = 'findings'; state.job = null; }
  if (tab === 'paper' || tab === 'findings') { state.tab = tab; state.sig = ''; }
  state.key = key;
  const R = $('#page-report');
  if (!state.job) R.replaceChildren(h('p', { class: 'muted' }, 'Opening the report…'));
  poll(key, 0);
}
async function poll(key, fails) {
  if (state.key !== key) return;
  try {
    const r = await fetch(J(key) + '/jobs/' + encodeURIComponent(key));
    if (r.status === 404) {
      const cached = store.get('ssi-r-' + key, null);
      if (cached) { state.job = { id: key, key, status: 'done', result: cached, local: 'cache' }; render(state.job); }
      else renderError('No report with this key. Reports on this server are kept until it restarts, so an older key may have expired.');
      return;
    }
    const job = await r.json();
    state.job = job; render(job);
    if (state.jump != null && job.status === 'done') { const n = state.jump; state.jump = null; requestAnimationFrame(() => { const row = document.querySelector(`.pv-row[data-page="${n}"]`); if (row) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 80 }); }); }
    if (job.status === 'running') state.timer = setTimeout(() => poll(key, 0), 700);
    else if (job.status === 'done') { remember(job.result); if (state.autoReader === key && job.result?.pdf?.available) { state.autoReader = null; state.tab = 'paper'; if (state.autoFlag) { state.autoFlag = false; state.flags = { on: true, items: [], pending: [], extend: null, disputed: new Map(), sent: null, mode: store.get('ssi-flagmode', 'auto') }; state.notes = true; } state.sig = ''; render(job); } }
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
      h('div', { class: 'meta-grid' },
        h('div', {}, h('span', { class: 'ml', text: 'Read from' }), h('span', { class: 'mv', title: doc.fidelity, text: doc.source === 'latex' ? 'LaTeX source' : 'PDF' })),
        st.body_sections != null ? h('div', {}, h('span', { class: 'ml', text: 'Sections' }), h('span', { class: 'mv', text: String(st.body_sections) })) : null,
        st.body_words != null ? h('div', {}, h('span', { class: 'ml', text: 'Words' }), h('span', { class: 'mv', text: Number(st.body_words).toLocaleString() })) : null,
        st.objects != null ? h('div', {}, h('span', { class: 'ml', text: 'Referable objects' }), h('span', { class: 'mv', text: String(st.objects) })) : null,
        doc.url ? h('div', {}, h('span', { class: 'ml', text: 'Paper' }), h('a', { class: 'mv', href: doc.url, target: '_blank', rel: 'noopener', text: 'Open ↗' })) : null)));
  } else {
    frag.push(h('div', { class: 'paper-head' }, h('p', { class: 'eyebrow', text: 'Analyzing' }), h('h2', { text: trunc(job.label || 'Your paper', 120) })));
  }
  frag.push(keyBar(job));
  if (!running) frag.push(h('div', { class: 'v2-strip' }, h('b', { text: 'Become a co-author of SciSlop v2. ' }), 'Flag slop the index missed or dispute what it flagged, right on the paper. Contributors are credited; substantial contributions earn ', h('mark', { class: 'coauthor', text: 'co-author credit on the v2 paper' }), '. ',
    h('button', { type: 'button', class: 'link-btn', onclick: () => { state.tab = 'paper'; if (state.flags) state.flags.on = true; else state.flags = { on: true, items: [], pending: [], extend: null, disputed: new Map(), sent: null, mode: store.get('ssi-flagmode', 'auto') }; state.notes = true; state.sig = ''; render(state.job); } }, 'Start flagging →')));
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
  const listed = !!job.gallery;
  const toggle = job.seed ? null : h('label', { class: 'check list-toggle', title: 'Listed reports appear on the public leaderboard and gallery' },
    h('input', { type: 'checkbox', checked: listed ? true : null, onchange: async e => { e.target.disabled = true;
      try { const r = await fetch(`${J(key)}/jobs/${encodeURIComponent(key)}/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listed: e.target.checked }) });
        if (!r.ok) throw new Error('Could not change the listing.'); job.gallery = e.target.checked; state.gallery = null; toast(e.target.checked ? 'Listed on the public leaderboard' : 'Removed from the leaderboard'); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message); } finally { e.target.disabled = false; } } }),
    listed ? 'Listed on the public leaderboard' : 'List on the public leaderboard');
  return h('div', { class: 'keybar' },
    h('span', {}, 'Report key'), h('span', { class: 'key', text: key }),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(key, 'Key copied') }, 'Copy key'),
    toggle,
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
    const t = h('button', { class: `tile band-${p.key}`, type: 'button', onclick: () => { if (!state.job) return; state.tab = 'findings'; state.sig = ''; render(state.job); setTimeout(() => document.getElementById('plane-' + p.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); } },
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
    h('a', { href: pdfOk ? `${J(key)}/jobs/${encodeURIComponent(key)}/pdf` : '#', class: pdfOk ? '' : 'disabled', download: '', role: 'menuitem' },
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
  if (state.notes == null) state.notes = true;
  if (state.spine == null) state.spine = true;
  if (!state.flags) state.flags = { on: new URLSearchParams(location.search).get('flag') === '1', items: [], pending: [], extend: null, disputed: new Map(), sent: null, mode: store.get('ssi-flagmode', 'auto') };
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
          byPage.get(loc.p).push({ m, it, i, r, box: !!loc.box, first: !byPage.get(loc.p).some(o => o.m === m && o.i === i) });
        }
      }
    });
  }
  const rerender = () => { state.sig = ''; render(state.job); };
  const side = h('div', { class: 'pv-side' }, h('h4', { text: 'On the paper' }),
    ORDER.map(k => {
      const meta = MEASURES[k]; const c = counts[k] || { found: 0, total: 0 }; const on = !state.hidden.has(k);
      const toggle = () => { state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); rerender(); };
      return h('div', { class: `pv-toggle ${meta.plane}` + (on ? ' on' : '') },
        h('button', { type: 'button', class: 'pv-main', title: 'Open the graph and findings for this measure', onclick: () => openMeasureModal(k) },
          h('span', { class: 'pv-n', text: String(c.found) }),
          h('span', { class: 'pv-l' }, h('span', { class: 'pv-name', text: meta.name }), h('span', { class: 'pv-sub', text: c.total ? `${c.found} of ${c.total} placed · graph ↗` : 'nothing flagged' }))),
        h('button', { type: 'button', class: 'pv-eye', 'aria-pressed': String(on), title: on ? 'Hide on the paper' : 'Show on the paper', onclick: toggle }, on ? '●' : '○'));
    }),
    h('h4', { text: 'Layers', style: { marginTop: '10px' } }),
    h('label', { class: 'pv-layer' }, h('input', { type: 'checkbox', checked: state.notes ? true : null, onchange: e => { state.notes = e.target.checked; rerender(); } }), h('span', {}, h('b', { text: 'Margin notes' }), h('small', { text: 'why each highlight was flagged, beside the page' }))),
    h('label', { class: 'pv-layer' }, h('input', { type: 'checkbox', checked: state.spine ? true : null, onchange: e => { state.spine = e.target.checked; rerender(); } }), h('span', {}, h('b', { text: 'Reference spine' }), h('small', { text: 'sections and the figures, tables, and equations they refer to' }))),
    h('a', { class: 'btn ghost small', href: `${J(key)}/jobs/${encodeURIComponent(key)}/pdf`, download: '', style: { textAlign: 'center', textDecoration: 'none', marginTop: '8px' } }, 'Download highlighted PDF'));
  const pagesHost = h('div', { class: 'pv-pages' + (state.notes ? ' with-notes' : '') + (state.spine ? ' with-spine' : '') });
  const pageEls = [];
  const maxPages = (STATIC_MODE && STATIC_KEYS.has(key)) ? (state.config?.max_pages || 40) : Infinity;
  (pdf.sizes || []).forEach(([w, hgt], n) => {
    if (n === maxPages) { pagesHost.append(h('div', { class: 'pv-row' }, h('div', { class: 'pv-gutter-l' }), h('div', { class: 'card pv-empty' }, `Pages ${n + 1}–${pdf.sizes.length}: `, h('a', { href: `${LIVE_API}/jobs/${encodeURIComponent(key)}/pdf`, text: 'download the highlighted PDF' }), ' to read them with the findings.'), h('div', {}))); }
    if (n >= maxPages) return;
    const page = h('div', { class: 'pv-page', style: { aspectRatio: `${w} / ${hgt}` } },
      h('span', { class: 'pl', text: `Loading page ${n + 1}…` }),
      h('img', { src: `${J(key)}/jobs/${encodeURIComponent(key)}/pages/${n}.jpg`, alt: `Page ${n + 1}`, loading: n < 3 ? 'eager' : 'lazy', width: 1100, height: Math.round(1100 * hgt / w) }),
      h('span', { class: 'pno', text: `${n + 1}` }));
    const notesL = h('div', { class: 'pv-notes pv-notes-l' });
    const row = h('div', { class: 'pv-row', 'data-page': n }, notesL, h('div', { class: 'pv-gutter-l' }), page);
    pageEls.push({ page, w, hgt, row });
    for (const hl of byPage.get(n) || []) {
      if (state.hidden.has(hl.m.key)) continue;
      const [x0, y0, x1, y1] = hl.r; const id = `${hl.m.key}-${hl.i}`;
      const d = h('div', { class: `hl ${hl.m.plane}${hl.box ? ' box' : ''}`, 'data-hl': id, tabindex: 0,
        style: { left: `${100 * x0 / w}%`, top: `${100 * y0 / hgt}%`, width: `${100 * (x1 - x0) / w}%`, height: `${100 * (y1 - y0) / hgt}%` } });
      if (!state.notes) bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 160));
      const openFindings = () => { hideTip(); state.tab = 'findings'; state.open.add(hl.m.key); if (hl.i >= 8) state.showAll.add(hl.m.key); if (hl.m.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.flash = `f-${hl.m.key}-${hl.i}`; state.sig = ''; render(state.job); };
      const open = e => { if (e && e.stopPropagation) e.stopPropagation(); hideTip(); hlCard(page, hl, { x0, y0, x1, y1 }, w, hgt, openFindings); };
      d.addEventListener('click', open);
      d.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
      const sync = on => { d.classList.toggle('lit', on); row.querySelectorAll(`[data-for="${id}"]`).forEach(x => x.classList.toggle('lit', on)); };
      d.addEventListener('pointerenter', () => sync(true)); d.addEventListener('pointerleave', () => sync(false));
      page.append(d);
      // margin note, once per finding, at the highlight's height
      if (state.notes && hl.first) {
        const it = hl.it; const body = it.why || (it.coverage != null ? `${Math.round(it.coverage * 100)}% copied from ${it.source_title}` : '') || it.text || it.caption || '';
        const note = h('div', { class: `pv-note ${hl.m.plane}`, 'data-for': id, 'data-y': String(y0 / hgt), tabindex: 0,
          onclick: openFindings, onkeydown: e => { if (e.key === 'Enter') openFindings(); } },
          h('span', { class: 'pv-note-h' }, h('i', { class: `swatch sw-${hl.m.plane}` }), h('b', { text: hl.m.name }), it.section_title ? h('span', { class: 'pv-note-sec', text: it.section_title }) : null),
          h('span', { class: 'pv-note-b', text: trunc(body, 150) }),
          state.flags.on ? h('span', { class: 'pv-dispute-row', onclick: e => e.stopPropagation() },
            h('button', { type: 'button', class: 'pv-dispute' + (state.flags.disputed.get(id) === '' ? ' on' : ''), title: 'Dispute: this is not slop',
              onclick: () => { state.flags.disputed.get(id) === '' ? state.flags.disputed.delete(id) : state.flags.disputed.set(id, ''); rerender(); } }, state.flags.disputed.get(id) === '' ? '✓ not slop' : '✕ not slop'),
            h('select', { class: 'pv-rekind' + (state.flags.disputed.get(id) ? ' on' : ''), title: 'It is slop, but of another kind', onchange: e => { e.target.value ? state.flags.disputed.set(id, e.target.value) : state.flags.disputed.delete(id); rerender(); } },
              h('option', { value: '', text: state.flags.disputed.get(id) ? 'kind: ' + (MEASURES[state.flags.disputed.get(id)]?.short || 'other') : 'wrong kind?' }),
              ...ORDER.filter(k => k !== hl.m.key).map(k => h('option', { value: k, text: MEASURES[k].name, selected: state.flags.disputed.get(id) === k ? true : null })), h('option', { value: 'other', text: 'Other' }))) : null);
        note.addEventListener('pointerenter', () => sync(true)); note.addEventListener('pointerleave', () => sync(false));
        notesL.append(note);
      }
    }
    // reader flags already drawn on this page
    const drawPiece = (pc, cls, label, onRemove) => {
      const rects = pc.rects && pc.rects.length ? pc.rects : [pc.r];
      rects.forEach(([x0, y0, x1, y1], ri) => {
        const box = h('div', { class: cls + (pc.mode === 'text' ? ' text' : ''), style: { left: `${100 * x0 / w}%`, top: `${100 * y0 / hgt}%`, width: `${100 * (x1 - x0) / w}%`, height: `${100 * (y1 - y0) / hgt}%` } },
          ri === 0 && label ? h('span', { class: 'uf-label' }, label, h('button', { type: 'button', 'aria-label': 'Remove', onclick: e => { e.stopPropagation(); onRemove(); } }, '×')) : null);
        if (pc._tip) bindTip(box, pc._tip[0], pc._tip[1]);
        page.append(box); return box;
      });
    };
    state.flags.items.forEach((fl, fi) => {
      fl.pieces.forEach((pc, pi) => { if (pc.p !== n) return;
        pc._tip = [`${fl.title || 'Your flag'} · ${MEASURES[fl.kind]?.name || 'New pattern'}`, (pc.text ? '“' + trunc(pc.text, 120) + '” ' : '') + (fl.note || '')];
        const label = h('span', {}, `${fi + 1} · ${trunc(fl.title || MEASURES[fl.kind]?.short || 'Slop', 22)}`, fl.pieces.length > 1 ? h('small', { text: ` ${pi + 1}/${fl.pieces.length}` }) : null,
          state.flags.on ? h('button', { type: 'button', class: 'uf-add' + (state.flags.extend === fi ? ' on' : ''), title: 'Add more pieces to this slop', onclick: e => { e.stopPropagation(); state.flags.extend = state.flags.extend === fi ? null : fi; rerender(); } }, '+') : null);
        drawPiece(pc, 'user-flag' + (state.flags.extend === fi ? ' extending' : ''), label, () => { fl.pieces.splice(pi, 1); if (!fl.pieces.length) state.flags.items.splice(fi, 1); if (state.flags.extend === fi) state.flags.extend = null; rerender(); });
      });
    });
    state.flags.pending.forEach((pc, pi) => { if (pc.p !== n) return;
      drawPiece(pc, 'user-flag pending', h('span', { text: `piece ${pi + 1}` }), () => { state.flags.pending.splice(pi, 1); rerender(); });
    });
    if (state.flags.on) enableDragFlag(page, n, w, hgt, rerender, key);
    pagesHost.append(row);
  });
  const spine = h('div', { class: 'pv-spine', hidden: !state.spine });
  pagesHost.prepend(spine);
  if (state.zoom == null) state.zoom = 100;
  const nPages = (pdf.sizes || []).length;
  const pageNo = h('span', { class: 'rd-page', text: `1 / ${nPages}` });
  const zoomLbl = h('span', { class: 'rd-zoom-v', text: `${state.zoom}%` });
  const setZoom = z => { state.zoom = Math.max(60, Math.min(160, z)); pagesHost.style.setProperty('--zoom', state.zoom / 100); zoomLbl.textContent = `${state.zoom}%`; setTimeout(() => { layoutNotes(pagesHost); if (state.spine) drawSpine(spine, pagesHost, pageEls, res, key); }, 60); };
  const F = state.flags; const nF = F.items.length + F.disputed.size;
  const brand = h('span', { class: 'rd-brand', title: 'The SciSlop Finder: the paper with every finding on its pages' }); brand.innerHTML = FINDER_INNER.replace('<small>open in</small>', '').replace(/<span class="fb-arrow"[^<]*<\/span>/, '');
  const toolbar = h('div', { class: 'rd-bar' },
    brand,
    h('span', { class: 'rd-title', text: trunc((res.document || {}).title || '', 70) }),
    h('span', { class: 'rd-idx' }, h('b', { text: res.index?.index != null ? String(res.index.index) : '—' }), ' / 100'),
    h('span', { class: 'rd-sp' }),
    h('button', { type: 'button', class: 'ib small', title: 'Previous page (k)', onclick: () => rdGo(-1) }, '‹'), pageNo, h('button', { type: 'button', class: 'ib small', title: 'Next page (j)', onclick: () => rdGo(1) }, '›'),
    h('span', { class: 'rd-sep' }),
    h('button', { type: 'button', class: 'ib small', title: 'Zoom out', onclick: () => setZoom(state.zoom - 10) }, '−'), zoomLbl, h('button', { type: 'button', class: 'ib small', title: 'Zoom in', onclick: () => setZoom(state.zoom + 10) }, '+'),
    h('span', { class: 'rd-sep' }),
    h('button', { type: 'button', class: 'btn small' + (F.on ? '' : ' ghost'), onclick: () => { F.on = !F.on; if (F.on) state.notes = true; rerender(); } }, F.on ? `Flagging · ${nF}` : 'Flag slop'),
    F.on && F.pending.length ? h('span', { class: 'rd-pending', text: `${F.pending.length} piece${F.pending.length === 1 ? '' : 's'} pending` }) : null,
    F.on && nF ? h('button', { type: 'button', class: 'btn small', onclick: () => $('#flag-submit')?.click() }, `Submit ${nF}`) : null,
    h('button', { type: 'button', class: 'btn ghost small', onclick: () => { state.tab = 'findings'; state.sig = ''; render(state.job); } }, 'Findings'));
  const rdGo = dir => { const rows = [...pagesHost.querySelectorAll('.pv-row[data-page]')]; const tops = rows.map(r => r.getBoundingClientRect().top + window.scrollY); const y = window.scrollY + 90; let cur = tops.findIndex((t, i) => t + rows[i].offsetHeight > y + 4); if (cur < 0) cur = rows.length - 1; const to = Math.max(0, Math.min(rows.length - 1, cur + dir)); window.scrollTo({ top: tops[to] - 80, behavior: 'smooth' }); };
  const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) pageNo.textContent = `${+e.target.dataset.page + 1} / ${nPages}`; }, { rootMargin: '-45% 0px -45% 0px' });
  pageEls.forEach(pe => io.observe(pe.row));
  if (!state._rdKeys) { state._rdKeys = true; document.addEventListener('keydown', e => { if (state.tab !== 'paper' || $('#page-report').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.key === 'j') rdGo(1); if (e.key === 'k') rdGo(-1); if (e.key === 'f') { state.flags.on = !state.flags.on; state.sig = ''; render(state.job); } }); }
  pagesHost.style.setProperty('--zoom', state.zoom / 100);
  const layout = h('div', { class: 'pv-layout wide' }, side, h('div', { class: 'rd-main' }, toolbar, pagesHost), h('div', { class: 'pv-contrib' }, flagPanel(key, res)));
  // after the DOM is in place: stack the notes without overlap, draw the spine, redo both on resize
  const settle = () => { layoutNotes(pagesHost); if (state.spine) drawSpine(spine, pagesHost, pageEls, res, key); };
  requestAnimationFrame(() => requestAnimationFrame(settle));
  if (pagesHost._ro) pagesHost._ro.disconnect();
  let lastW = 0; pagesHost._ro = new ResizeObserver(() => { const w = pagesHost.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; settle(); } }); pagesHost._ro.observe(pagesHost);
  return layout;
}
function flagPanel(key, res) {
  const F = state.flags; const n = F.items.length + F.disputed.size;
  const rerender = () => { state.sig = ''; render(state.job); };
  const modeSwitch = h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': 'How to mark' }, ...[['auto', 'Auto', 'Text where there are words, a box elsewhere'], ['text', 'Text', 'Always snap to words'], ['box', 'Box', 'Always draw a box']].map(([m, l, t]) =>
    h('button', { type: 'button', class: 'seg-b', 'aria-pressed': String(F.mode === m), title: t, onclick: () => { F.mode = m; store.set('ssi-flagmode', m); rerender(); } }, l)));
  if (F.sent) return h('div', { class: 'flag-panel sent' }, h('h4', { text: 'Contribute' }), h('p', {}, '✓ Thank you. ', h('b', { text: `${F.sent.flags} slop${F.sent.flags === 1 ? '' : 's'}, ${F.sent.disputed} dispute${F.sent.disputed === 1 ? '' : 's'}` }), F.sent.proposals ? `, ${F.sent.proposals} new pattern${F.sent.proposals === 1 ? '' : 's'} proposed` : '', ' submitted.', F.sent.name ? ` ${F.sent.name} is now listed among the contributors.` : ''),
    (F.sent.proposal_urls || []).length ? h('p', { class: 'muted' }, 'Follow the review: ', ...F.sent.proposal_urls.map((u, i) => h('a', { href: u, target: '_blank', rel: 'noopener', text: `pattern ${i + 1}` }))) : null);
  if (!F.on) return h('div', { class: 'flag-panel' }, h('h4', { text: 'Contribute' }),
    h('button', { type: 'button', class: 'btn small', onclick: () => { F.on = true; state.notes = true; rerender(); } }, 'Flag slop on this paper'),
    h('p', { class: 'muted', text: 'Drag over anything the index missed; dispute anything it got wrong. One click to submit.' }),
    h('div', { class: 'flag-v2' }, h('b', { text: 'Become a co-author of SciSlop v2.' }), ' Mark what the index missed, name patterns it does not know yet. Credited on the site; substantial contributions earn ', h('mark', { class: 'coauthor', text: 'co-author credit on the v2 paper' }), '.'));
  const whoOk = () => !!(nameInp.value.trim() && affInp.value.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailInp.value.trim()));
  const syncBtn = () => { const b = $('#flag-submit'); if (b) b.disabled = !(whoOk() && (F.items.length + F.disputed.size)); };
  const nameInp = h('input', { type: 'text', required: true, placeholder: 'Your name (required)', value: store.get('ssi-name', ''), maxlength: 80, oninput: e => { store.set('ssi-name', e.target.value); syncBtn(); } });
  const affInp = h('input', { type: 'text', required: true, placeholder: 'Affiliation (required)', value: store.get('ssi-aff', ''), maxlength: 120, oninput: e => { store.set('ssi-aff', e.target.value); syncBtn(); } });
  const mailInp = h('input', { type: 'email', required: true, placeholder: 'Email (required; never shown, for co-author contact)', value: store.get('ssi-mail', ''), maxlength: 120, oninput: e => { store.set('ssi-mail', e.target.value); syncBtn(); } });
  const v2 = h('div', { class: 'flag-v2' }, h('b', { text: 'Submitting is contributing.' }), ' Your flags, disputes, and any new pattern you name go straight into the SciSlop v2 review. Credited on the site; substantial contributions earn ', h('mark', { class: 'coauthor', text: 'co-author credit on the v2 paper' }), '.');
  const submit = async () => {
    if (!nameInp.value.trim()) { toast('Add your name: contributions are credited'); nameInp.focus(); return; }
    if (!affInp.value.trim()) { toast('Add your affiliation'); affInp.focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailInp.value.trim())) { toast('Add a valid email so we can reach you about co-authorship'); mailInp.focus(); return; }
    const btn = $('#flag-submit'); btn.disabled = true;
    try {
      const r = await fetch(`${J(key)}/jobs/${encodeURIComponent(key)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: F.items, disputed: [...F.disputed].map(([id, kind]) => ({ id, kind })), name: nameInp.value.trim(), affiliation: affInp.value.trim(), email: mailInp.value.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || 'Could not submit.');
      F.sent = { ...d, name: nameInp.value.trim() }; F.on = false; rerender(); loadContributorsQuiet();
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
  // pending basket: pieces gathered so far, saved as one slop or as separate slops
  let basket = null;
  if (F.pending.length) {
    const title = h('input', { type: 'text', class: 'flag-note', required: true, placeholder: 'Name it, e.g. Claim stated before its evidence (required)', maxlength: 80, value: F.pendingTitle || '', oninput: e => { F.pendingTitle = e.target.value; } });
    const note = h('textarea', { class: 'flag-note', rows: 3, required: true, placeholder: 'Describe it: what a reader notices, and why it is slop (required)', maxlength: 600, oninput: e => { F.pendingNote = e.target.value; } }, F.pendingNote || '');
    const fields = h('div', { class: 'flag-fields' },
      h('label', {}, h('span', { class: 'mc-l', text: 'Name' }), title),
      h('label', {}, h('span', { class: 'mc-l', text: 'Description' }), note));
    const newHint = h('p', { class: 'muted fb-hint', hidden: (F.pendingKind || null) !== 'other', text: 'New pattern: the name and description above are filed as a proposal for the v2 index, with this paper as the example.' });
    let kind = F.pendingKind || null;
    const kinds = h('div', { class: 'flag-kinds' }, ...ORDER.map(k => h('button', { type: 'button', class: `chip-b ${MEASURES[k].plane}` + (kind === k ? ' on' : ''), text: MEASURES[k].short, title: MEASURES[k].name, onclick: e => { kind = k; F.pendingKind = k; kinds.querySelectorAll('.chip-b').forEach(c => c.classList.toggle('on', c === e.currentTarget)); } })),
      h('button', { type: 'button', class: 'chip-b' + (kind === 'other' ? ' on' : ''), text: 'New pattern', onclick: e => { kind = 'other'; F.pendingKind = 'other'; kinds.querySelectorAll('.chip-b').forEach(c => c.classList.toggle('on', c === e.currentTarget)); newHint.hidden = false; title.focus(); } }));
    kinds.querySelectorAll('.chip-b').forEach(c => { if (c.textContent !== 'New pattern') c.addEventListener('click', () => { newHint.hidden = true; }); });
    const save = separate => { if (!kind) { toast('Pick what kind of slop it is'); return; }
      if (!title.value.trim()) { toast('Give it a name'); title.focus(); return; }
      if (note.value.trim().length < 10) { toast('Describe it: what a reader notices, and why it is slop'); note.focus(); return; }
      const base = { kind, title: title.value.trim(), note: note.value.trim() };
      const extra = kind === 'other' ? { pattern_name: title.value.trim(), pattern_what: note.value.trim() } : {};
      if (separate) F.pending.forEach(pc => F.items.push({ ...base, pieces: [pc], ...extra })); else F.items.push({ ...base, pieces: F.pending.slice(), ...extra });
      F.pending = []; F.pendingKind = null; F.pendingTitle = ''; F.pendingNote = ''; rerender(); };
    const pages = [...new Set(F.pending.map(pc => pc.p + 1))].sort((a, b) => a - b);
    basket = h('div', { class: 'flag-basket' },
      h('div', { class: 'fb-h' }, h('b', { text: `${F.pending.length} piece${F.pending.length === 1 ? '' : 's'} selected` }), h('span', { class: 'muted', text: ` · p. ${pages.join(', ')}` })),
      h('p', { class: 'muted fb-hint', text: 'Keep dragging to add pieces (any page), then save.' }),
      h('span', { class: 'mc-l', text: 'Kind' }), kinds, newHint, fields,
      h('div', { class: 'flag-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => save(false) }, F.pending.length > 1 ? 'Save as one slop' : 'Save'),
        F.pending.length > 1 ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => save(true) }, `Save as ${F.pending.length} separate`) : null,
        h('button', { type: 'button', class: 'link-btn', onclick: () => { F.pending = []; rerender(); } }, 'Clear')));
  }
  const list = F.items.length ? h('ol', { class: 'flag-list' }, ...F.items.map((fl, fi) => h('li', { class: F.extend === fi ? 'on' : '' },
    h('span', { class: `swatch sw-${MEASURES[fl.kind]?.plane || 'structure'}` }), h('b', { text: fl.title || MEASURES[fl.kind]?.short || 'Slop' }), h('span', { class: 'muted', text: fl.kind === 'other' ? ' · new pattern' : ` · ${MEASURES[fl.kind]?.short || ''}` }), h('span', { class: 'muted', text: ` · ${fl.pieces.length} piece${fl.pieces.length === 1 ? '' : 's'}, p. ${[...new Set(fl.pieces.map(pc => pc.p + 1))].join(', ')}` }),
    h('button', { type: 'button', class: 'uf-add' + (F.extend === fi ? ' on' : ''), title: 'Add more pieces to this slop', onclick: () => { F.extend = F.extend === fi ? null : fi; rerender(); } }, F.extend === fi ? 'adding…' : '+'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { F.items.splice(fi, 1); if (F.extend === fi) F.extend = null; rerender(); } }, 'remove')))) : null;
  return h('div', { class: 'flag-panel on' }, h('h4', { text: 'Contribute' }),
    modeSwitch,
    h('p', { class: 'flag-how', text: F.extend != null ? `Adding pieces to slop ${F.extend + 1}. Drag on any page; click + again to stop.` : 'Drag on the page: over words it snaps to the text, elsewhere it draws a box. Several drags can form one slop. On a note: “✕ not slop”, or pick the kind it should be.' }),
    basket,
    h('div', { class: 'flag-count' }, h('b', { text: String(F.items.length) }), ' slop', F.items.length === 1 ? '' : 's', ' · ', h('b', { text: String(F.disputed.size) }), ' disputed'),
    list,
    h('div', { class: 'flag-who' }, h('span', { class: 'mc-l', text: 'You · required, credited on the site' }), nameInp, affInp, mailInp),
    h('div', { class: 'flag-actions' },
      h('button', { type: 'button', class: 'btn small', id: 'flag-submit', disabled: (n && whoOk()) ? null : true, onclick: submit }, n ? `Submit ${n}` : 'Submit'),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { F.on = false; F.extend = null; rerender(); } }, 'Done')),
    v2);
}
async function loadContributorsQuiet() { try { await loadContributors(); } catch (_) { /* home only */ } }
const WORDS_CACHE = {};
async function pageWords(key, n) {
  const ck = key + ':' + n;
  if (!WORDS_CACHE[ck]) WORDS_CACHE[ck] = fetch(`${J(key)}/jobs/${encodeURIComponent(key)}/words/${n}`).then(r => r.ok ? r.json() : { w: [] }).then(d => d.w || []).catch(() => []);
  return WORDS_CACHE[ck];
}
function lineRects(words) {
  // merge consecutive words on one visual line into one rect
  const out = []; let cur = null;
  for (const [x0, y0, x1, y1] of words) {
    if (cur && Math.abs(cur[1] - y0) < 3 && x0 >= cur[0] - 2) { cur[2] = Math.max(cur[2], x1); cur[1] = Math.min(cur[1], y0); cur[3] = Math.max(cur[3], y1); }
    else { cur = [x0, y0, x1, y1]; out.push(cur); }
  }
  return out.map(r => r.map(v => Math.round(v * 10) / 10));
}
function enableDragFlag(page, n, w, hgt, rerender, key) {
  page.classList.add('flagging');
  const F = state.flags; pageWords(key, n);
  let start = null, box = null, words = null, textMode = false, startIdx = -1, curIdx = -1, sel = [];
  const pos = e => { const r = page.getBoundingClientRect(); return [Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1) * w, Math.min(Math.max(0, (e.clientY - r.top) / r.height), 1) * hgt]; };
  const nearest = (x, y, maxD) => { let best = -1, bd = 1e9; words.forEach((wd, i) => { const [x0, y0, x1, y1] = wd; const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0; const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0; const d = dx * dx + dy * dy * 4; if (d < bd) { bd = d; best = i; } }); return bd < maxD * maxD ? best : -1; };
  const drawSel = () => { sel.forEach(e => e.remove()); sel = []; if (startIdx < 0 || curIdx < 0) return; const a = Math.min(startIdx, curIdx), b = Math.max(startIdx, curIdx);
    for (const [x0, y0, x1, y1] of lineRects(words.slice(a, b + 1))) { const d = h('div', { class: 'user-flag pending text drawing', style: { left: `${100 * x0 / w}%`, top: `${100 * y0 / hgt}%`, width: `${100 * (x1 - x0) / w}%`, height: `${100 * (y1 - y0) / hgt}%` } }); page.append(d); sel.push(d); } };
  page.addEventListener('pointerdown', async e => {
    if (e.button !== 0 || e.target.closest('.user-flag:not(.drawing), .hl-card, .flag-pop, .uf-label')) return;
    start = pos(e); e.preventDefault(); page.setPointerCapture(e.pointerId);
    words = await pageWords(key, n);
    const onWord = words.length ? nearest(start[0], start[1], 6) : -1;      // started on (or right next to) a word?
    textMode = F.mode === 'text' ? words.length > 0 : F.mode === 'box' ? false : onWord >= 0;
    if (e.shiftKey) textMode = false;
    if (textMode) { startIdx = onWord >= 0 ? onWord : nearest(start[0], start[1], 40); curIdx = startIdx; drawSel(); }
    else { box = h('div', { class: 'user-flag pending drawing' }); page.append(box); }
  });
  page.addEventListener('pointermove', e => {
    if (!start) return; const [x, y] = pos(e);
    if (textMode) { const i = nearest(x, y, 60); if (i >= 0 && i !== curIdx) { curIdx = i; drawSel(); } return; }
    if (!box) return;
    const x0 = Math.min(start[0], x), y0 = Math.min(start[1], y), x1 = Math.max(start[0], x), y1 = Math.max(start[1], y);
    Object.assign(box.style, { left: `${100 * x0 / w}%`, top: `${100 * y0 / hgt}%`, width: `${100 * (x1 - x0) / w}%`, height: `${100 * (y1 - y0) / hgt}%` });
  });
  page.addEventListener('pointerup', e => {
    if (!start) return; const [x, y] = pos(e); const s0 = start; start = null;
    let piece;
    if (textMode) {
      sel.forEach(el => el.remove()); sel = [];
      if (startIdx < 0 || curIdx < 0) return;
      const a = Math.min(startIdx, curIdx), b = Math.max(startIdx, curIdx); const run = words.slice(a, b + 1);
      const rects = lineRects(run); const bb = [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
      piece = { p: n, r: bb, rects, mode: 'text', text: run.map(wd => wd[4]).join(' ') };
    } else {
      if (box) box.remove(); box = null;
      const r = [Math.min(s0[0], x), Math.min(s0[1], y), Math.max(s0[0], x), Math.max(s0[1], y)];
      if (r[2] - r[0] < 8 || r[3] - r[1] < 6) return;
      piece = { p: n, r: r.map(v => Math.round(v * 10) / 10), rects: [], mode: 'box', text: '' };
    }
    if (F.extend != null && F.items[F.extend]) F.items[F.extend].pieces.push(piece); else F.pending.push(piece);
    rerender();
  });
}
function layoutNotes(host) {
  host.querySelectorAll('.pv-row').forEach(row => {
    const page = row.querySelector('.pv-page'); const H = page.clientHeight; if (!H) return;
    let cursor = 0;
    [...row.querySelectorAll('.pv-note')].sort((a, b) => +a.dataset.y - +b.dataset.y).forEach(n => {
      const want = +n.dataset.y * H; const top = Math.max(want, cursor);
      n.style.top = top + 'px'; n.style.setProperty('--lead', Math.max(0, top - want) + 'px'); n.classList.toggle('pushed', top - want > 6);
      cursor = top + n.offsetHeight + 6;
    });
  });
}
const SPINE_CACHE = {};
async function drawSpine(host, pagesHost, pageEls, res, key) {
  let data = SPINE_CACHE[key];
  if (!data) { try { data = await (await fetch(`${J(key)}/jobs/${encodeURIComponent(key)}/layout`)).json(); } catch (_) { return; } SPINE_CACHE[key] = data; }
  if (!host.isConnected) return;
  const nodes = (data.nodes || []).filter(n => pageEls[n.p]); if (!nodes.length) { host.replaceChildren(); return; }
  const hostTop = pagesHost.getBoundingClientRect().top;
  const yOf = n => { const pe = pageEls[n.p]; const r = pe.page.getBoundingClientRect(); return r.top - hostTop + (n.y / pe.hgt) * r.height; };
  const W = host.clientWidth || 170; const H = pagesHost.scrollHeight; const X = W - 14;   // the spine line sits at the right edge of the gutter, next to the pages
  const svg = s('svg', { class: 'spine', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.append(s('line', { x1: X, x2: X, y1: 0, y2: H, class: 'sp-axis' }));
  const secY = new Map(nodes.filter(n => n.kind === 'section').map(n => [n.sec, yOf(n)]));
  const objY = new Map(nodes.filter(n => n.kind !== 'section').map(n => [n.id, yOf(n)]));
  const flagged = new Set(nodes.filter(n => n.kind !== 'section' && !(n.from || []).length).map(n => n.id));
  const secTitle = new Map(nodes.filter(n => n.kind === 'section').map(n => [n.sec, n.label]));
  // edges: referencing section → object, bulging into the gutter; deeper bulge for longer spans
  for (const e of data.edges || []) {
    const y1 = secY.get(e.src), y2 = objY.get(e.target); if (y1 == null || y2 == null) continue;
    const span = Math.abs(y2 - y1); const bulge = Math.min(W - 30, 26 + span * 0.08);
    const path = s('path', { class: 'sp-edge', d: `M${X},${y1} C${X - bulge},${y1} ${X - bulge},${y2} ${X},${y2}` });
    const tn = nodes.find(n => n.id === e.target);
    bindTip(path, `${secTitle.get(e.src) || '§' + e.src} → ${tn ? tn.label : e.target}`, e.roadmap ? 'Referred to in a roadmap sentence' : `Referred to from ${secTitle.get(e.src) || 'this section'}`);
    svg.append(path);
  }
  for (const n of nodes) {
    const y = yOf(n);
    if (n.kind === 'section') {
      svg.append(s('line', { class: 'sp-tick', x1: X - 8, x2: X + 6, y1: y, y2: y }));
      const t = s('text', { class: 'sp-sec', x: X - 12, y: y - 4, 'text-anchor': 'end', text: trunc(n.label, Math.floor((W - 20) / 6.2)) });
      svg.append(t);
    } else {
      const miss = flagged.has(n.id);
      const dot = s('circle', { class: 'sp-obj' + (miss ? ' miss' : ''), cx: X, cy: y, r: miss ? 5 : 4 });
      bindTip(dot, n.label, miss ? 'Never referred to from another section' : `Referred to from ${(n.from || []).map(f => secTitle.get(f) || '§' + f).join(', ')}`);
      svg.append(dot, s('text', { class: 'sp-lab' + (miss ? ' miss' : ''), x: X - 10, y: y + 4, 'text-anchor': 'end', text: n.label.replace(/^Eq\. \((.*)\)$/, 'Eq. $1') }));
    }
  }
  host.replaceChildren(svg, h('div', { class: 'sp-legend' }, h('span', {}, h('i', { class: 'sp-lg-line' }), 'section refers to it'), h('span', {}, h('i', { class: 'sp-lg-miss' }), 'never referred to')));
}
function hlCard(page, hl, r, w, hgt, openFindings) {
  document.querySelectorAll('.hl-card').forEach(n => n.remove());
  const it = hl.it; const m = hl.m;
  const where = [it.section_title, it.label && it.kind ? `${it.label} (${it.kind})` : null].filter(Boolean).join(' · ');
  const body = it.why || (it.coverage != null ? `${Math.round(it.coverage * 100)}% copied from ${it.source_title}` : '') || it.text || it.caption || '';
  const card = h('div', { class: 'hl-card', role: 'dialog', onclick: e => e.stopPropagation() },
    h('div', { class: 'hl-head' }, h('span', { class: `tag ${m.plane}`, text: (PLANES.find(p => p.key === m.plane) || {}).label || m.plane }), h('b', { text: m.name }),
      h('button', { class: 'hl-x', type: 'button', 'aria-label': 'Close', onclick: () => card.remove() }, '×')),
    where ? h('div', { class: 'hl-where', text: where }) : null,
    it.text && it.why ? h('div', { class: 'hl-quote', text: '“' + trunc(it.text, 220) + '”' }) : null,
    h('div', { class: 'hl-body', text: trunc(body, 320) }),
    h('div', { class: 'hl-actions' }, h('button', { class: 'link-btn', type: 'button', onclick: openFindings }, 'Open in findings →')));
  const below = r.y1 / hgt < 0.72;
  card.style.left = `${Math.min(100 * r.x0 / w, 58)}%`;
  if (below) card.style.top = `calc(${100 * r.y1 / hgt}% + 6px)`; else card.style.bottom = `calc(${100 * (1 - r.y0 / hgt)}% + 6px)`;
  page.append(card);
  setTimeout(() => document.addEventListener('click', () => card.remove(), { once: true }), 0);
}
function showOnPaper(key, i) { state.tab = 'paper'; state.flashHl = `${key}-${i}`; state.hidden.delete(key); state.sig = ''; render(state.job); }

// ------------------------------------------------------------------ paper map
function drawMap(host, doc, ms, onOpen) {
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
      const open = () => { hideTip(); if (onOpen) { onOpen(); return; } state.open.add(it.key); state.flash = `f-${it.key}-${it.i}`; if (it.i >= 8) state.showAll.add(it.key); if (it.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.sig = ''; render(state.job); };
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
    h('img', { src: `${STATIC}/img/${m.key}.svg`, alt: '', class: `band-${meta.plane}` }),
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
    const viz = measureViz(m, state.job?.result?.document || state.job?.document);
    return [...(viz ? [h('div', { class: 'd-sub', text: 'Section graph' }), viz] : []), h('div', { class: 'd-sub', text: 'Reference map' }), h('div', { class: 'refmap' }, rows),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--structure)' } }), 'used by another section'),
        h('span', {}, h('span', { class: 'lg-box', style: { border: '1.5px dashed var(--structure)' } }), 'never pointed to from another section')), ...list];
  },
  macro_redundancy(m, pdfOk) {
    if (!m.instances.length) return [okLine(`No sentence repeats half of itself from an earlier section (${m.den} sentences checked).`)];
    const viz = measureViz(m, state.job?.result?.document || state.job?.document);
    return [...(viz ? [h('div', { class: 'd-sub', text: 'Section graph' }), viz] : []), h('div', { class: 'd-sub', text: `Recycled sentences · ${m.instances.length}` }),
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
    const viz = m.instances.length ? measureViz(m, state.job?.result?.document || state.job?.document) : null;
    const out = [...(viz ? [h('div', { class: 'd-sub', text: 'Isolated citations by section' }), viz] : []), h('div', { class: 'd-sub', text: `${det.woven ?? 0} of ${m.den} citing sentences relate works to one another` })];
    if (m.instances.length) out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text }),
      h('div', { class: 'keys' }, (it.keys || []).map(k => h('code', { text: k }))), h('div', { class: 'where', style: { marginTop: '6px', marginBottom: 0 }, text: it.why })], pdfOk));
    else out.push(okLine('Every citing sentence groups, compares, or relates its work to another.'));
    return out;
  },
  figure_exposition(m, pdfOk) {
    const det = m.details || {}; const fig = det.figure || {}; const out = [];
    if ((det.candidates || []).length > 1 && !state.job?.local) out.push(figurePicker(m, 'Method figure'));
    const key = state.job?.key || state.job?.id;
    const viz = measureViz(m, state.job?.result?.document || state.job?.document);
    if (viz) { out.push(viz); return out; }
    const imgs = (fig.images || []).map(n => h('div', { class: 'fig-img' }, h('img', { src: `${J(key)}/jobs/${encodeURIComponent(key)}/files/${n}`, alt: `Figure ${fig.number || ''}`, loading: 'lazy' })));
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
    const viz = measureViz(m, state.job?.result?.document || state.job?.document); if (viz) out.push(h('div', { class: 'd-sub', style: { marginTop: 0 }, text: 'Result tables and exhibits by section' }), viz);
    if (m.score === 0) {
      const ex = (det.exhibits || [])[0];
      out.push(okLine(`Closed: ${det.exhibit_count} concrete exhibit${det.exhibit_count === 1 ? '' : 's'} found` + (ex ? `, e.g. ${ex.where}: “${trunc(ex.snippet, 140)}”` : '.')));
    } else out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text })], pdfOk));
    if ((det.result_tables || []).length) out.push(h('div', { class: 'd-sub', text: 'Result tables that make the measure apply' }),
      h('ul', { class: 'findings' }, det.result_tables.slice(0, 4).map(t => h('li', { class: 'finding' }, h('div', { class: 'where' }, h('span', { text: t.section_title }), h('span', { text: `${t.rows} data rows · ${t.numeric_cells} numeric cells` })), h('div', { class: 'txt', text: trunc(t.caption || t.label, 180) })))));
    return out;
  },
};

// ------------------------------------------------------------------ section arcs (cross-section references, macro redundancy)
function sectionArcs(doc, edges, opts) {
  // edges: [{from, to, label}] between outline indices; self edges are counted as loops.
  const outline = (doc?.outline || []).filter(o => o.idx != null);
  if (!outline.length) return h('div', { class: 'muted', text: 'The outline of the paper is not available.' });
  const host = h('div', { class: 'sarcs-host' });
  const draw = () => {
    const W = Math.max(320, host.clientWidth); const top = edges.length ? 96 : 10, segH = 22, H = top + segH + (opts.under2 ? 68 : 52);
    const weights = outline.map(o => Math.max(o.sentences || 0, 4)); const total = weights.reduce((a, b) => a + b, 0);
    let x = 0; const segs = outline.map((o, k) => { const w = (W) * weights[k] / total; const sg = { o, x, w, cx: x + w / 2 }; x += w; return sg; });
    const segOf = new Map(segs.map(sg => [sg.o.idx, sg]));
    const name = o => (o.idx === 0 && !o.number) ? 'Abstract' : (o.number ? '§' + o.number + ' ' : '') + o.title;
    const svg = s('svg', { class: 'sarcs', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.aria || 'Section graph' });
    const mk = s('marker', { id: 'arrow-' + opts.id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.append(s('path', { d: 'M0,0 L10,5 L0,10 z', fill: opts.color }));
    svg.append(s('defs', {}, mk));
    // segments
    for (const sg of segs) {
      svg.append(s('rect', { class: 'seg', x: sg.x + 1, y: top, width: Math.max(1, sg.w - 2), height: segH, rx: 5 }));
      const maxChars = Math.floor((sg.w - 8) / 6.4);
      if (maxChars >= 3) svg.append(s('text', { class: 'seg-label', x: sg.cx, y: top + segH / 2 + 4, 'text-anchor': 'middle', text: trunc(name(sg.o), maxChars) }));
      const hit = s('rect', { x: sg.x, y: top, width: sg.w, height: segH, fill: 'transparent' });
      bindTip(hit, name(sg.o), opts.section?.(sg.o.idx) || `${sg.o.sentences || 0} sentences`);
      svg.append(hit);
    }
    // aggregate edges
    const agg = new Map(); const loops = new Map();
    for (const e of edges) {
      if (!segOf.has(e.from) || !segOf.has(e.to)) continue;
      if (e.from === e.to) { loops.set(e.to, (loops.get(e.to) || 0) + 1); continue; }
      const k = e.from + '>' + e.to; if (!agg.has(k)) agg.set(k, { from: e.from, to: e.to, labels: [] });
      agg.get(k).labels.push(e.label);
    }
    const list = [...agg.values()].sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
    for (const e of list) {
      const a = segOf.get(e.from), b = segOf.get(e.to); const n = e.labels.length;
      const dx = Math.abs(b.cx - a.cx); const hgt = Math.min(top - 12, 26 + dx * 0.32);
      const x1 = a.cx, x2 = b.cx, y = top - 2;
      const path = s('path', { class: 'sarc', d: `M${x1},${y} C${x1},${y - hgt} ${x2},${y - hgt} ${x2},${y}`, fill: 'none', stroke: opts.color, 'stroke-width': Math.min(6, 1.4 + n * 0.9), 'stroke-linecap': 'round', opacity: .75, 'marker-end': `url(#arrow-${opts.id})` });
      bindTip(path, `${name(a.o)} → ${name(b.o)} · ${n} ${opts.unit}${n === 1 ? '' : 's'}`, e.labels.slice(0, 6).join(' · ') + (n > 6 ? ` · +${n - 6} more` : ''));
      svg.append(path);
      if (n > 1) svg.append(s('text', { class: 'sarc-n', x: (x1 + x2) / 2, y: y - hgt * 0.75 - 3, 'text-anchor': 'middle', text: String(n) }));
    }
    // loops and under-labels
    for (const sg of segs) {
      const parts = []; const lp = loops.get(sg.o.idx); const under = opts.under?.(sg.o.idx);
      if (lp) parts.push(`↺${lp}`); if (under) parts.push(under);
      if (parts.length && sg.w > 30) svg.append(s('text', { class: 'seg-under' + (under && opts.warnUnder !== false ? ' warn' : ''), x: sg.cx, y: top + segH + 16, 'text-anchor': 'middle', text: trunc(parts.join(' · '), Math.floor(sg.w / 6)) }));
      const u2 = opts.under2?.(sg.o.idx);
      if (u2 && sg.w > 30) svg.append(s('text', { class: 'seg-under' + (u2.warn ? ' warn' : u2.good ? ' good' : ''), x: sg.cx, y: top + segH + 32, 'text-anchor': 'middle', text: trunc(u2.text, Math.floor(sg.w / 6)) }));
    }
    svg.append(s('text', { class: 'seg-axis', x: 0, y: H - 6, text: 'start of paper' }), s('text', { class: 'seg-axis', x: W, y: H - 6, 'text-anchor': 'end', text: 'end of paper' }));
    host.replaceChildren(svg);
  };
  draw();
  new ResizeObserver(() => { if (host.clientWidth) draw(); }).observe(host);
  return host;
}
function measureViz(m, doc) {
  if (!m || m.status !== 'done') return null;
  const det = m.details || {};
  if (m.key === 'cross_refs') {
    const objs = det.objects || []; const edges = []; const never = new Map();
    for (const o of objs) { for (const f of o.from || []) edges.push({ from: f, to: o.home, label: o.label }); for (let i = 0; i < (o.own || 0); i++) edges.push({ from: o.home, to: o.home, label: o.label }); if (!(o.from || []).length) never.set(o.home, (never.get(o.home) || 0) + 1); }
    return h('div', { class: 'viz' },
      sectionArcs(doc, edges, { id: 'xr', color: 'var(--structure)', unit: 'reference', aria: 'Which sections refer to objects in which other sections',
        under: i => never.get(i) ? `${never.get(i)} never referenced` : '', section: i => { const own = objs.filter(o => o.home === i); return `${own.length} objects here · ${own.filter(o => (o.from || []).length).length} referred to from other sections · ${own.filter(o => !(o.from || []).length).length} never`; } }),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--structure)', height: '3px' } }), 'arrow: a section refers to an object in another section (thicker = more)'), h('span', {}, '↺n: references within the same section'), h('span', { class: 'warn-t' }, '“n never referenced”: objects no other section points to')));
  }
  if (m.key === 'macro_redundancy') {
    if (!(m.instances || []).length) return null;
    const edges = m.instances.filter(it => it.source_section != null && it.section != null).map(it => ({ from: it.source_section, to: it.section, label: `${Math.round((it.coverage || 0) * 100)}% “${trunc(it.text, 60)}”` }));
    return h('div', { class: 'viz' },
      sectionArcs(doc, edges, { id: 'mr', color: 'var(--structure-deep)', unit: 'repeated sentence', aria: 'Which earlier sections later sections repeat' }),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--structure-deep)', height: '3px' } }), 'arrow: from the section that said it first to the section that repeats it')));
  }
  if (m.key === 'argument_graph') return det.sentences && det.edges ? h('div', { class: 'viz' }, arcDiagram(det),
    h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--ink-4)', height: '2px' } }), 'support comes first (built up)'), h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--red)', height: '2px' } }), 'support comes after the claim (flagged)'))) : null;
  if (m.key === 'citation_isolation') {
    const secs = det.sections || []; if (!secs.length && !m.den) return null;
    const iso = new Map(); for (const it of m.instances || []) iso.set(it.section_title, (iso.get(it.section_title) || 0) + 1);
    const names = secs.length ? secs : [...iso.keys()];
    const max = Math.max(1, ...names.map(n => iso.get(n) || 0));
    return h('div', { class: 'viz' },
      h('div', { class: 'cbars' }, names.map(n => h('div', { class: 'cb-row' }, h('span', { class: 'cb-name', text: n }),
        h('span', { class: 'cb-bar' }, h('i', { style: { width: `${100 * (iso.get(n) || 0) / max}%` } })), h('span', { class: 'cb-val', text: String(iso.get(n) || 0) })))),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--argument)' } }), 'citing sentences that relate the work to nothing else'), h('span', { class: 'muted', text: `${det.woven ?? 0} of ${m.den} citing sentences relate works to one another` })));
  }
  if (m.key === 'figure_exposition') {
    const fig = det.figure || {}; const kinds = det.kinds || []; if (!kinds.length) return null;
    const key = state.job?.key || state.job?.id || opts_key.current;
    const imgs = (fig.images || []).map(n => h('div', { class: 'fig-img' }, h('img', { src: `${J(key)}/jobs/${encodeURIComponent(key)}/files/${n}`, alt: `Figure ${fig.number || ''}`, loading: 'lazy' })));
    const present = kinds.filter(k => k.present).length;
    return h('div', { class: 'viz fig-viz' },
      h('div', { class: 'fig-viz-grid' },
        h('div', {}, ...imgs, h('div', { class: 'fig-cap', text: `Figure ${fig.number || ''}${fig.section_title ? ' · ' + fig.section_title : ''}` })),
        h('div', {},
          h('div', { class: 'kind-meter' }, h('b', { text: `${present} of ${kinds.length}` }), ' expository kinds present in the method figure',
            h('span', { class: 'kind-dots' }, kinds.map(k => h('i', { class: k.present ? 'on' : '' })))),
          h('div', { class: 'kind-grid' }, kinds.map(k => {
            const t = h('div', { class: 'kind-tile' + (k.present ? ' on' : '') },
              h('span', { class: 'kt-ico', text: k.present ? '✕' : '' }), h('span', { class: 'kt-l', text: k.label }),
              h('span', { class: 'kt-ex', text: k.present ? (k.examples || []).slice(0, 2).map(e => `“${trunc(e, 40)}”`).join(' ') : 'not found' }));
            bindTip(t, k.label, k.present ? 'Present: ' + (k.examples || []).slice(0, 4).join(' · ') : 'Not found in the figure.');
            return t;
          })))),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--red)', width: '10px', height: '10px', borderRadius: '50%' } }), 'kind present: material that belongs in the text, not in the method figure'), h('span', {}, h('span', { class: 'lg-box', style: { border: '1px solid var(--line-2)', width: '10px', height: '10px', borderRadius: '50%' } }), 'not found')));
  }
  if (m.key === 'evidence_gap') {
    const tables = det.result_tables || []; const ex = det.exhibits || [];
    const outline = doc?.outline || []; const norm = t => (t || '').replace(/^§[\d.]+\s*/, '').toLowerCase();
    const find = title => { const n = norm(title); const o = outline.find(o => norm(o.title) === n) || outline.find(o => n && (norm(o.title).includes(n) || n.includes(norm(o.title)))); return o ? o.idx : -1; };
    const tCount = new Map(), eCount = new Map(); let tOther = 0, eOther = 0;
    for (const t of tables) { const i = find(t.section_title); if (i < 0) tOther++; else tCount.set(i, (tCount.get(i) || 0) + 1); }
    for (const e of ex) { const i = find(e.where); if (i < 0) eOther++; else eCount.set(i, (eCount.get(i) || 0) + 1); }
    const none = (det.exhibit_count || 0) === 0;
    return h('div', { class: 'viz' },
      sectionArcs(doc, [], { id: 'ev', color: 'var(--artifacts)', unit: '', aria: 'Result tables and concrete exhibits by section', warnUnder: false,
        under: i => tCount.get(i) ? `▤ ${tCount.get(i)} result table${tCount.get(i) > 1 ? 's' : ''}` : '',
        under2: i => eCount.get(i) ? { text: `✓ ${eCount.get(i)} exhibit${eCount.get(i) > 1 ? 's' : ''}`, good: true } : (tCount.get(i) && none ? { text: '✕ no example', warn: true } : null),
        section: i => `${tCount.get(i) || 0} result tables · ${eCount.get(i) || 0} concrete exhibits` }),
      h('div', { class: 'legend' },
        h('span', {}, `▤ result tables in the body (${tables.length})`),
        h('span', { class: none ? 'warn-t' : '' }, none ? '✕ no concrete input, output, or case anywhere in the paper' : `✓ concrete exhibits: inputs, outputs, or cases (${det.exhibit_count})${eOther ? `, ${eOther} in the appendix or elsewhere` : ''}`)));
  }
  return null;
}
const opts_key = { current: null };
async function openMeasureModal(k) {
  const job = state.job; if (!job) return;
  const m = measuresOf(job)[k]; const meta = MEASURES[k]; if (!m) return;
  const doc = job.result?.document || job.document; const pdfOk = !!job.result?.pdf?.available && !job.local;
  document.querySelectorAll('.modal-bg').forEach(n => n.remove());
  const close = () => { bg.remove(); hideTip(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const done = m.status === 'done' && m.score != null;
  const box = h('div', { class: 'modal card' },
    h('div', { class: 'modal-head' },
      h('div', {}, h('span', { class: `tag ${meta.plane}`, text: PLANES.find(p => p.key === meta.plane).label }), h('h3', { text: meta.name }),
        h('p', { class: 'muted', style: { margin: '4px 0 0' }, text: done ? `${fmt(m.score)} / 100 · ${fmtNum(m.num)} of ${m.den} ${m.unit || ''}` : (m.status === 'na' ? 'Not applicable to this paper' : 'Could not run') })),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { close(); state.tab = 'findings'; state.open.add(k); state.sig = ''; render(state.job); setTimeout(() => document.getElementById('d-' + k)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); } }, 'Open in findings →'),
        h('button', { class: 'hl-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'))),
    h('div', { class: 'modal-detail' }, detail(m, pdfOk)));
  const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(); } }, box);
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  // "Show on paper" links inside the detail should close the modal first
  box.querySelectorAll('.onpaper').forEach(b => b.addEventListener('click', close, { capture: true }));
}

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
    const r = await fetch(`${J(key)}/jobs/${encodeURIComponent(key)}/figure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
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
function exampleNode(ex) {
  const it = ex.it; const k = ex.key; const parts = [];
  const where = h('div', { class: 'ex-where' }, h('b', { text: trunc(ex.title, 70) }), h('span', { text: it.section_title ? ' · ' + it.section_title : '' }));
  if (k === 'cross_refs') parts.push(h('div', { class: 'ex-text' }, h('span', { class: 'obj miss', text: it.label }), ' ', it.caption ? trunc(it.caption, 160) : ''), h('div', { class: 'ex-why', text: it.text }));
  else if (k === 'macro_redundancy') parts.push(highlighted(it.text, it.highlights), h('div', { class: 'ex-why', text: `${Math.round((it.coverage || 0) * 100)}% copied from ${it.source_title}: “${trunc(it.source_text, 140)}”` }));
  else if (k === 'argument_graph') parts.push(h('div', { class: 'ex-text', text: `Claim (sentence ${it.sentence + 1}): “${trunc(it.text, 220)}”` }), h('div', { class: 'ex-why', text: `${it.why} Support: “${trunc(it.support_text, 140)}”` }));
  else if (k === 'citation_isolation') parts.push(h('div', { class: 'ex-text', text: '“' + trunc(it.text, 220) + '”' }), h('div', { class: 'ex-why', text: it.why }));
  else if (k === 'figure_exposition') parts.push(ex.img ? h('div', { class: 'ex-fig' }, h('img', { src: ex.img, alt: '', loading: 'lazy' })) : null, h('div', { class: 'ex-text' }, h('span', { class: 'kt-ico on', text: '✕' }), ' ', it.label + ': ' + (it.examples || []).slice(0, 4).map(e => `“${trunc(e, 36)}”`).join(' ')), h('div', { class: 'ex-why', text: 'Material that belongs in the text, found inside the method figure.' }));
  else parts.push(h('div', { class: 'ex-text', text: trunc(it.text || '', 220) }), h('div', { class: 'ex-why', text: it.why || '' }));
  const pages = [...new Set((it.pdf || []).map(l => l.p + 1))];
  parts.push(h('div', { class: 'ex-actions' }, h('a', { href: `/r/${ex.job}?tab=paper`, 'data-link': '', class: 'onpaper', text: pages.length ? `Show on paper · p. ${pages[0]}` : 'Open the report' })));
  return h('div', { class: 'ex-card' }, where, ...parts.filter(Boolean));
}
async function loadPlaneExplainer() {
  const host = $('#plane-explainer'); if (!host || host.dataset.built) return; host.dataset.built = '1';
  host.replaceChildren(h('p', { class: 'muted', text: 'Loading examples from the analyzed papers…' }));
  let items = [];
  try { if (!state.gallery) { const r = await fetch(API + '/gallery'); state.gallery = await r.json(); } items = state.gallery.items.filter(x => x.index != null).slice(0, 8); } catch (_) { host.replaceChildren(); return; }
  const jobs = (await Promise.all(items.map(x => fetchReport(x.key).catch(() => null)))).filter(Boolean);
  const pool = {}; for (const k of ORDER) pool[k] = [];
  for (const job of jobs) for (const m of job.result.measures) {
    if (m.status !== 'done') continue;
    const title = job.result.document?.title || job.title;
    const fig = m.details?.figure; const img = fig?.images?.length ? `${J(job.key || job.id)}/jobs/${job.key || job.id}/files/${fig.images[0]}` : null;
    for (const it of (m.instances || []).slice(0, 2)) pool[m.key].push({ key: m.key, job: job.key || job.id, title, it, img });
  }
  // interleave papers so the first examples are not all from one paper
  for (const k of ORDER) { const byJob = new Map(); for (const e of pool[k]) byJob.set(e.job, (byJob.get(e.job) || []).concat(e)); const out = []; const lists = [...byJob.values()]; for (let r = 0; lists.some(l => l.length > r); r++) for (const l of lists) if (l[r]) out.push(l[r]); const rot = out.length ? ORDER.indexOf(k) % out.length : 0; pool[k] = out.slice(rot).concat(out.slice(0, rot)); }
  host.replaceChildren(...PLANES.map(p => {
    const block = h('section', { class: `plane-block band-${p.key}` },
      h('div', { class: 'pb-head' }, h('span', { class: `tag ${p.key}`, text: p.label }), h('h3', { text: p.q })),
      h('div', { class: 'pb-grid' }, p.measures.map(k => {
        const m = MEASURES[k]; const exs = pool[k]; let i = 0;
        const stage = h('div', { class: 'ex-stage' }); const counter = h('span', { class: 'ex-n' });
        const draw = () => { if (!exs.length) { stage.replaceChildren(h('div', { class: 'ex-empty', text: 'None of the papers on this site is flagged by this measure.' })); counter.textContent = ''; return; } stage.replaceChildren(exampleNode(exs[i])); counter.textContent = `${i + 1} / ${exs.length}`; };
        draw();
        return h('div', { class: 'pb-measure' },
          h('div', { class: 'pb-pic' }, h('img', { src: `${STATIC}/img/${k}.svg`, alt: `Illustration of ${m.name}` })),
          h('h4', { text: m.name }), h('p', { class: 'pb-what', text: m.what }),
          h('div', { class: 'ex-nav' }, h('span', { class: 'ex-l', text: 'Real findings' }), counter,
            h('button', { type: 'button', class: 'ib small', 'aria-label': 'Previous example', onclick: () => { if (exs.length) { i = (i - 1 + exs.length) % exs.length; draw(); } } }, '‹'),
            h('button', { type: 'button', class: 'ib small', 'aria-label': 'Next example', onclick: () => { if (exs.length) { i = (i + 1) % exs.length; draw(); } } }, '›')),
          stage);
      })));
    return block;
  }));
}
function buildHow() {
  loadPlaneExplainer();
  if (howBuilt) return; howBuilt = true;
  const host = $('#spec');
  for (const p of PLANES) {
    const group = h('div', { class: `mgroup band-${p.key}` },
      h('div', { class: 'mgroup-head' }, h('span', { class: `tag ${p.key}`, text: p.label }), h('span', { class: 'mgroup-q', text: p.q })));
    const row = h('div', { class: 'mgroup-row' });
    for (const k of p.measures) {
      const m = MEASURES[k]; const pa = m.pairacc;
      row.append(h('div', { class: 'mcard' },
        h('div', { class: `mc-pic band-${p.key}` }, h('img', { src: `${STATIC}/img/${k}.svg`, alt: `Illustration of ${m.name}` })),
        h('div', { class: 'mc-head' }, h('h3', { text: m.name }), h('span', { class: 'method', text: m.method === 'LLM' ? 'Language model' : 'Counting rule', title: m.method === 'LLM' ? 'Asks a language model' : 'Exact counting rule' })),
        h('p', { class: 'mc-what', text: m.what }),
        h('div', { class: 'mc-score' },
          h('span', { class: 'mc-eq', text: 'Score =' }),
          h('span', { class: `frac ${p.key}` }, h('span', { text: m.num }), h('span', { text: m.den })),
          h('span', { class: 'mc-unit' }, h('span', { class: 'mc-l', text: 'Unit' }), m.unit)),
        h('div', { class: 'mc-scale' },
          h('div', { class: 'mc-track' }, h('i', { style: { background: PLANE_VAR[p.key] } })),
          h('div', { class: 'mc-ends' }, h('span', {}, h('b', { text: '0' }), ' none of the units'), h('span', {}, h('b', { text: '100' }), ' ' + m.one))),
        h('div', { class: 'mc-pa', title: 'How often this measure alone ranks the human-written paper above its AI-generated counterpart (0.5 is chance)' },
          h('span', { class: 'mc-l', text: 'Pair accuracy' }),
          h('div', { class: 'mc-pa-bar' }, h('i', { style: { width: `${100 * pa}%`, background: PLANE_VAR[p.key] } }), h('span', { class: 'mc-chance', style: { left: '50%' } })),
          h('span', { class: 'mc-pa-v', text: pa.toFixed(3) }))));
    }
    group.append(row); host.append(group);
  }
  const agg = $('#agg');
  agg.append(...PLANES.map(p => h('div', { class: 'agg-col' },
    h('div', { class: 'agg-ms' }, p.measures.map(k => h('span', { class: `agg-m band-${p.key}`, text: MEASURES[k].name }))),
    h('div', { class: 'agg-arrow', text: 'mean' }),
    h('div', { class: `agg-plane band-${p.key}` }, h('span', { class: `tag ${p.key}`, text: p.label }), h('span', { class: 'agg-pv', text: 'plane score' })))),
    h('div', { class: 'agg-final' }, h('div', { class: 'agg-arrow', text: 'mean of the three planes × 100' }), h('div', { class: 'agg-idx' }, h('b', { text: 'Science Slop Index' }), h('span', { text: '0 – 100' }))));
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
const lb = { metric: 'index', top: 30, picked: null, excluded: new Set(), hidePartial: false, view: 'list', sort: 'value', dir: -1, pop: null, data: null, q: '', open: new Set() };
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
  lb.view = ['list', 'chart', 'table'].includes(q.get('view')) ? q.get('view') : 'list';
  lb.q = q.get('q') || '';
}
function lbUrl() {
  const q = new URLSearchParams();
  if (lb.metric !== 'index') q.set('metric', lb.metric);
  if (lb.top !== 30) q.set('n', lb.top === Infinity ? 'all' : lb.top);
  if (lb.excluded.size) q.set('exclude', [...lb.excluded].join(','));
  if (lb.hidePartial) q.set('partial', '0');
  if (lb.view !== 'list') q.set('view', lb.view);
  if (lb.q) q.set('q', lb.q);
  const s = q.toString();
  return location.origin + BASE + '/leaderboard' + (s ? '?' + s : '');
}
async function loadLeaderboard() {
  lbReadParams();
  $('#lb-list').replaceChildren(h('div', { class: 'lb-empty', text: 'Loading…' }));
  try { lb.data = await fetchGallery(); state.gallery = lb.data; }
  catch (_) { $('#lb-list').replaceChildren(h('div', { class: 'lb-empty', text: 'Could not load the leaderboard.' })); return; }
  renderLeaderboard();
}
function lbRows() {
  const all = (lb.data?.items || []).filter(x => lbValue(x, lb.metric) != null);
  const ql = lb.q.trim().toLowerCase();
  const pool = all.filter(x => !lb.excluded.has(x.source) && !(lb.hidePartial && x.partial) && (!ql || (x.title || '').toLowerCase().includes(ql)));
  pool.sort((a, b) => lbValue(b, lb.metric) - lbValue(a, lb.metric));
  const shown = lb.picked ? pool.filter(x => lb.picked.has(x.key)) : pool.slice(0, lb.top);
  return { all, pool, shown };
}
function renderLeaderboard() {
  const { all, pool, shown } = lbRows();
  const metric = METRICS.find(m => m.id === lb.metric);
  $('#lb-count-t').textContent = `${shown.length} of ${all.length} papers`;
  $('#lb-metricname').textContent = metric.stacked ? 'Science Slop Index · contribution of each plane' : `${metric.label} · score out of 100`;
  // stats strip
  const items = lb.data?.items || []; const idx = items.map(x => x.index).filter(v => v != null).sort((a, b) => a - b);
  const median = idx.length ? idx[Math.floor(idx.length / 2)] : null; const newest = Math.max(0, ...items.map(x => x.created || 0));
  $('#lb-stats').replaceChildren(
    h('span', {}, h('b', { text: String(items.length) }), ' papers'),
    h('span', {}, h('b', { text: '6' }), ' measures · ', h('b', { text: '3' }), ' planes'),
    median != null ? h('span', {}, 'median index ', h('b', { text: String(median) })) : null,
    newest ? h('span', {}, 'updated ', h('b', { text: new Date(newest * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) })) : null);
  // rank-by chips and the single-measure select
  const cats = [['index', 'Overall'], ...PLANES.map(p => ['plane:' + p.key, p.label])];
  $('#lb-cats').replaceChildren(...cats.map(([id, label]) => h('button', { type: 'button', class: 'chip-b' + (lb.metric === id ? ' on' : '') + (id.startsWith('plane:') ? ' ' + id.slice(6) : ''), onclick: () => { lb.metric = id; lb.sort = 'value'; renderLeaderboard(); } }, label)));
  const sel = $('#lb-measure');
  if (sel.options.length === 1) for (const k of ORDER) sel.append(h('option', { value: 'm:' + k, text: MEASURES[k].name }));
  sel.value = lb.metric.startsWith('m:') ? lb.metric : ''; sel.classList.toggle('on', lb.metric.startsWith('m:'));
  document.querySelectorAll('.seg-b').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === lb.view)));
  $('#lb-filter').classList.toggle('on', lb.excluded.size > 0 || lb.hidePartial);
  $('#lb-list').hidden = lb.view !== 'list';
  $('#lb-scroll').parentElement.hidden = lb.view !== 'chart';
  $('#lb-tablewrap').hidden = lb.view !== 'table';
  if (lb.view === 'table') renderLbTable(shown); else if (lb.view === 'chart') drawLbChart(shown, metric); else renderLbList(shown, metric);
  $('#lb-legend').replaceChildren(...(metric.stacked
    ? [...PLANES.map(p => h('span', {}, h('span', { class: 'lg-box', style: { background: PLANE_VAR[p.key], borderRadius: '3px', width: '12px', height: '12px' } }), `${p.label} share`)),
      h('span', { class: 'muted', text: 'Each bar is the index; its segments show how much each plane adds.' })]
    : [h('span', {}, h('span', { class: 'lg-box', style: { background: PLANE_VAR[metric.plane], borderRadius: '3px', width: '12px', height: '12px' } }), metric.label)]));
  const partial = shown.some(x => x.partial) ? '* Partial: some measures could not run for this paper. ' : '';
  const smax = Math.min(100, Math.max(20, Math.ceil(Math.max(1, ...shown.map(x => lbValue(x, lb.metric))) * 1.15 / 10) * 10));
  $('#lb-note').textContent = '// ' + (metric.stacked ? `bar = index on a 0–${smax} scale; segments = what each plane adds` : `bar = ${metric.label.toLowerCase()} on a 0–${smax} scale`) + ' · click a row for its six measures · ' + partial + (pool.length > shown.length ? `showing the top ${shown.length} of ${pool.length} · ` : '')
    + (lb.data?.persistent ? 'reports persist' : 'reports added on this server last until it restarts; bundled papers always stay');
}
function renderLbList(rows, metric) {
  const host = $('#lb-list');
  if (!rows.length) { host.replaceChildren(h('div', { class: 'lb-empty' }, 'No paper to rank yet. ', h('a', { href: '/', 'data-link': '' }, 'Analyze one'))); return; }
  const max = Math.max(1, ...rows.map(x => lbValue(x, lb.metric)));
  const scaleMax = Math.min(100, Math.max(20, Math.ceil(max * 1.15 / 10) * 10));
  const bandBg = `linear-gradient(90deg, var(--surface-2) 0 ${2000 / scaleMax}%, color-mix(in oklab, var(--surface-2) 70%, var(--line)) ${2000 / scaleMax}% ${4000 / scaleMax}%, color-mix(in oklab, var(--surface-2) 45%, var(--line)) ${4000 / scaleMax}% ${6000 / scaleMax}%, color-mix(in oklab, var(--surface-2) 20%, var(--line)) ${6000 / scaleMax}%)`;
  host.replaceChildren(
    h('div', { class: 'lbl-head' },
      h('span', { class: 'lbl-c rank', text: '#' }), h('span', { class: 'lbl-c paper', text: 'Paper' }),
      h('span', { class: 'lbl-c track' }, metric.stacked ? h('span', { class: 'lbl-scale' }, ...[['Low', 0], ['Moderate', 20], ['High', 40], ['Very high', 60]].filter(([, v]) => v < scaleMax).map(([l, v]) => h('i', { style: { left: `${100 * v / scaleMax}%` }, text: l }))) : h('span', { text: `${metric.label} · 0 to ${scaleMax}` })),
      h('span', { class: 'lbl-c idx', text: metric.stacked ? 'Index' : 'Score' }),
      h('span', { class: 'lbl-c planes' }, PLANES.map(p => h('span', { class: `lbl-ph lbl-${p.key}`, title: p.label, text: p.label.slice(0, 3) })))),
    ...rows.map((x, i) => {
      const v = lbValue(x, lb.metric); const b = x.index != null ? band(x.index) : null;
      let segs;
      if (metric.stacked) { const planes = PLANES.filter(p => x.planes?.[p.key] != null); segs = planes.map(p => ({ k: p.key, v: 100 * x.planes[p.key] / planes.length, label: `${p.label} adds ${fmt(x.planes[p.key] / planes.length)}` })); }
      else segs = [{ k: metric.plane, v, label: `${metric.label} ${Math.round(v)}` }];
      const bar = h('span', { class: 'lbl-track', style: metric.stacked ? { background: bandBg } : {} }, ...segs.map(sg => { const e = h('i', { class: `sg sg-${sg.k}`, style: { width: '0%' }, 'data-w': `${100 * sg.v / scaleMax}%` }); bindTip(e, x.title, sg.label); return e; }));
      const isOpen = lb.open.has(x.key);
      const row = h('div', { class: 'lbl-row' + (i < 3 ? ` top${i + 1}` : '') + (isOpen ? ' open' : ''), role: 'button', tabindex: 0, 'aria-expanded': String(isOpen), title: x.title,
        onclick: () => { lb.open.has(x.key) ? lb.open.delete(x.key) : lb.open.add(x.key); renderLeaderboard(); },
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } },
        h('span', { class: 'lbl-c rank' }, h('span', { class: 'lbl-rank', text: String(i + 1) })),
        h('span', { class: 'lbl-c paper' },
          h('span', { class: 'lbl-thumb' }, x.thumb ? h('img', { src: `${J(x.key)}/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy' }) : null),
          h('span', { class: 'lbl-t' }, h('span', { class: 'lbl-title' }, x.ai_generated ? h('span', { class: 'ai-badge', text: 'AI-generated' }) : null, x.title || 'Untitled'), h('span', { class: 'lbl-meta', text: [x.source, fmtDate(x.created), x.partial ? 'partial' : null].filter(Boolean).join(' · ') }))),
        h('span', { class: 'lbl-c track' }, bar),
        h('span', { class: 'lbl-c idx' }, h('b', { style: { color: b ? b.color : 'inherit' }, text: v == null ? '—' : String(Math.round(v)) + (x.partial && metric.stacked ? '*' : '') }), b && metric.stacked ? h('small', { text: b.label }) : null),
        h('span', { class: 'lbl-c planes' }, PLANES.map(p => h('span', { class: `lbl-p lbl-${p.key}`, title: p.label, text: fmt(x.planes?.[p.key]) }))),
        h('span', { class: 'lbl-chev', 'aria-hidden': 'true', text: '›' }));
      if (!isOpen) return row;
      const detail = h('div', { class: 'lbl-detail', onclick: e => e.stopPropagation() },
        h('div', { class: 'lbl-dm' }, ORDER.map(k => { const m = MEASURES[k]; const sv = x.measures?.[k];
          const r = h('div', { class: 'lbl-dm-row' }, h('span', { class: 'lbl-dm-name' }, h('span', { class: `swatch sw-${m.plane}` }), m.name),
            h('span', { class: 'lbl-dm-bar' }, h('i', { style: { width: '0%', background: PLANE_VAR[m.plane] }, 'data-w': `${sv == null ? 0 : 100 * sv}%` })),
            h('span', { class: 'lbl-dm-v', text: sv == null ? 'n/a' : fmt(sv) }));
          bindTip(r, m.name, m.what); return r; })),
        h('div', { class: 'lbl-da' },
          h('button', { class: 'btn small', type: 'button', onclick: () => go(`/r/${x.key}`) }, 'Full report →'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => go(`/r/${x.key}?tab=paper`) }, 'On the paper'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => openPreview(x.key) }, 'Digest'),
          x.url ? h('a', { class: 'link-btn', href: x.url, target: '_blank', rel: 'noopener', text: 'Source ↗' }) : null));
      return h('div', { class: 'lbl-group' }, row, detail);
      return row;
    }));
  requestAnimationFrame(() => requestAnimationFrame(() => host.querySelectorAll('[data-w]').forEach(n => { n.style.width = n.dataset.w; })));
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
    ...PLANES.map(p => ({ k: 'plane:' + p.key, l: p.label, plane: p.key })),
    ...ORDER.map(k => ({ k: 'm:' + k, l: MEASURES[k].short, plane: MEASURES[k].plane })), { k: 'source', l: 'Source' },
  ];
  const val = (x, k) => k === 'title' ? (x.title || '') : k === 'source' ? (x.source || '') : k === 'index' ? x.index : lbValue(x, k);
  const raw = (x, k) => k.startsWith('plane:') ? x.planes?.[k.slice(6)] : k.startsWith('m:') ? x.measures?.[k.slice(2)] : null;   // 0–1 scores
  const ranked = rows.map((x, i) => ({ ...x, rank: i + 1 }));
  if (lb.sort !== 'value' && lb.sort !== 'rank') ranked.sort((a, b) => {
    const va = val(a, lb.sort), vb = val(b, lb.sort);
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * lb.dir;
  });
  // top three per numeric column are shaded (LiveBench-style)
  const topOf = {};
  for (const c of cols) if (c.plane) {
    const vs = ranked.map(x => raw(x, c.k)).filter(v => v != null && v > 0).sort((a, b) => b - a);
    topOf[c.k] = vs.length ? vs[Math.min(2, vs.length - 1)] : Infinity;
  }
  const thead = h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: lb.sort === c.k ? 'sorted' : '', title: 'Sort',
    onclick: () => { if (lb.sort === c.k) lb.dir *= -1; else { lb.sort = c.k; lb.dir = c.k === 'title' || c.k === 'source' ? 1 : -1; } renderLeaderboard(); } },
    c.l + (lb.sort === c.k ? (lb.dir > 0 ? ' ↑' : ' ↓') : '')))));
  const cell = (x, c) => {
    const v = raw(x, c.k);
    return h('td', { class: (c.plane && v != null && v >= topOf[c.k] && v > 0) ? `hi hi-${c.plane}` : '', text: fmt(v) });
  };
  const tbody = h('tbody', {}, ranked.map(x => h('tr', { onclick: () => go('/r/' + x.key), tabindex: 0, onkeydown: e => { if (e.key === 'Enter') go('/r/' + x.key); } },
    h('td', { class: 'rank', text: String(x.rank) }), h('td', { class: 'title', text: x.title, title: x.title }),
    h('td', { class: 'idx' }, h('span', { class: 'idx-v', text: x.index == null ? '—' : x.index + (x.partial ? '*' : '') }),
      h('span', { class: 'idx-bar' }, h('i', { style: { width: `${x.index || 0}%`, background: x.index != null ? band(x.index).color : 'var(--line-2)' } }))),
    ...cols.filter(c => c.plane).map(c => cell(x, c)),
    h('td', { class: 'src', text: x.source || '' }))));
  $('#lb-tablewrap').replaceChildren(h('table', { class: 'lb-table' }, thead, tbody),
    h('p', { class: 'lb-foot', text: '// shading = top 3 per column · bar under Index = score out of 100 · click a row for its report · click a header to sort' + (ranked.some(x => x.partial) ? ' · * partial: some measures could not run' : '') }));
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
  if (lb.view !== 'chart') { lb.view = 'chart'; renderLeaderboard(); }
  const svg = $('#lb-chart svg'); if (!svg) { toast('Nothing to draw yet'); return; }
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
    s('text', { x: 16, y: 52, 'font-size': '12', fill: cssVar('--ink-3'), 'font-family': 'Avenir Next, Avenir, Nunito Sans, Helvetica, sans-serif', text: `${$('#lb-metricname').textContent} · scientific-slop-demo.onrender.com` }));
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
  $('#lb-measure').addEventListener('change', e => { lb.metric = e.target.value || 'index'; lb.sort = 'value'; renderLeaderboard(); });
  $('#lb-q').addEventListener('input', e => { lb.q = e.target.value; lb.picked = null; renderLeaderboard(); });
  document.querySelectorAll('.seg-b').forEach(b => b.addEventListener('click', () => { lb.view = b.dataset.view; renderLeaderboard(); }));
  $('#lb-link').addEventListener('click', () => copy(lbUrl(), 'Link to this view copied'));
  $('#lb-png').addEventListener('click', lbDownloadPng);
  document.addEventListener('click', e => { if (lb.pop && !e.target.closest('#lb-pop')) { $('#lb-pop').hidden = true; lb.pop = null; } });
  let last = 0;
  new ResizeObserver(() => { const w = $('#lb-scroll').clientWidth; if (!$('#page-leaderboard').hidden && lb.data && lb.view === 'chart' && Math.abs(w - last) > 8) { last = w; renderLeaderboard(); } }).observe($('#lb-scroll'));
}

// ------------------------------------------------------------------ home
function shortTitle(t) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  const cut = t.split(/[:：]/)[0];
  const w = (cut.length >= 8 ? cut : t).split(' ');
  return w.length > 4 ? w.slice(0, 4).join(' ') + '…' : w.join(' ');
}
function fmtDate(ts) { if (!ts) return ''; const d = new Date(ts * 1000); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
function galleryCard(x, rankNo) {
  const b = x.index != null ? band(x.index) : null;
  const [pw, ph] = x.page0 || [612, 792];
  const marks = (x.marks || []).map(k => {
    const el = h('span', { class: `g-mark ${k.plane}${k.box ? ' box' : ''}`, 'data-plane': k.plane,
      style: { left: `${100 * k.r[0] / pw}%`, top: `${100 * k.r[1] / ph}%`, width: `${100 * (k.r[2] - k.r[0]) / pw}%`, height: `${100 * (k.r[3] - k.r[1]) / ph}%` } });
    bindTip(el, k.name || k.m, k.t || '');
    return el;
  });
  const page = h('div', { class: 'g-page' }, x.thumb ? h('img', { src: `${J(x.key)}/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy' }) : h('div', { class: 'ph', text: x.title }), ...marks);
  const card = h('div', { class: 'g-card' },
    h('button', { type: 'button', class: 'g-thumb', style: { borderBottomColor: b ? b.color : 'var(--line-2)' }, title: 'Preview: findings on the paper, map, and charts', onclick: () => openPreview(x.key) }, page,
      marks.length ? h('span', { class: 'g-count', text: `${marks.length} on p.1` }) : null,
      h('span', { class: 'g-zoom', 'aria-hidden': 'true', text: 'Preview' })),
    h('a', { class: 'g-body', href: `/r/${x.key}?tab=paper`, 'data-link': '', title: x.title },
      h('div', { class: 'g-rank' }, h('span', { text: rankNo ? `Science Slop Index #${rankNo}` : '—' }), h('span', { class: 'score', text: x.index != null ? `${x.index} / 100${x.partial ? '*' : ''}` : '—' })),
      h('div', { class: 'g-title' }, x.ai_generated ? h('span', { class: 'ai-badge', text: 'AI-generated' }) : null, x.title)),
    h('div', { class: 'g-planes' }, PLANES.map(p => {
      const v = x.planes?.[p.key];
      const t = h('button', { type: 'button', class: `gp gp-${p.key}`, title: `${p.label}: ${p.q} Click to show only this plane on the page.`,
        onclick: () => { const on = card.dataset.focus === p.key; card.dataset.focus = on ? '' : p.key; card.querySelectorAll('.gp').forEach(g => g.classList.toggle('on', !on && g === t)); } },
        h('span', { class: 'gp-l', text: p.label }), h('b', { text: v == null ? '—' : fmt(v) }));
      return t;
    })));
  return card;
}

// ------------------------------------------------------------------ preview (gallery)
function measureBars(ms, onPick) {
  const rows = ORDER.map(k => {
    const m = ms[k]; const meta = MEASURES[k]; const done = m && m.status === 'done' && m.score != null;
    const frac = done ? `${fmtNum(m.num)} / ${m.den} ${m.unit || ''}` : m?.status === 'na' ? 'not applicable' : m?.status === 'skipped' ? 'needs a language model' : '—';
    const row = h('div', { class: 'mb-row' },
      h('span', { class: 'mb-name' }, h('span', { class: `swatch sw-${meta.plane}` }), meta.name),
      h('span', { class: 'mb-bar' }, h('i', { style: { width: `${done ? m.score * 100 : 0}%`, background: PLANE_VAR[meta.plane] } })),
      h('span', { class: 'mb-val', text: done ? fmt(m.score) : '—' }),
      h('span', { class: 'mb-frac', text: frac }));
    bindTip(row, meta.name, (m?.what || '') + (done ? ` ${frac}.` : '') + (onPick ? ' Click to see its graph.' : ''));
    if (onPick) { row.classList.add('pick'); row.tabIndex = 0; row.dataset.k = k; row.addEventListener('click', () => onPick(k, row)); row.addEventListener('keydown', e => { if (e.key === 'Enter') onPick(k, row); }); }
    return row;
  });
  return h('div', { class: 'mbars' }, rows);
}
async function fetchReport(key) {
  const r = await fetch(J(key) + '/jobs/' + encodeURIComponent(key)); const job = await r.json();
  if (!r.ok || !job.result) throw new Error('no report');
  return job;
}

// ------------------------------------------------------------------ The SciSlop Finder (the reader)
const FINDER_INNER = '<svg class="fb-ico" viewBox="0 0 34 34" aria-hidden="true"><circle cx="15" cy="15" r="9.5" fill="rgba(255,255,255,.08)"/><path d="M15 4.5A10.5 10.5 0 0 1 24.1 20.25" fill="none" stroke="#b98aa3" stroke-width="3.2"/><path d="M24.1 20.25A10.5 10.5 0 0 1 5.9 20.25" fill="none" stroke="#e8a1a9" stroke-width="3.2"/><path d="M5.9 20.25A10.5 10.5 0 0 1 15 4.5" fill="none" stroke="#90aebb" stroke-width="3.2"/><circle cx="12.5" cy="12.5" r="2.1" fill="#b98aa3"/><circle cx="18.5" cy="16.5" r="2.4" fill="#e8a1a9"/><circle cx="12.8" cy="19.2" r="1.8" fill="#90aebb"/><path d="M22.5 22.5 30 30" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg><span class="fb-l"><small>open in</small><b>The SciSlop Finder</b></span><span class="fb-arrow" aria-hidden="true">→</span>';
function finderBtn(onclick, cls = '') {
  const b = h('button', { type: 'button', class: 'finder-btn' + (cls ? ' ' + cls : ''), onclick, title: 'Read the paper with every finding drawn on its pages, and flag what the index missed' });
  b.innerHTML = FINDER_INNER;
  return b;
}
// ------------------------------------------------------------------ page stage (home example)
// One page shown large with its findings drawn on it; a filmstrip of every page below it.
// Hover or click a thumbnail to show that page; hover a mark to read why; click a mark for the card.
function pageStage(key, res, openFindings) {
  const pdf = res.pdf || {}; const sizes = pdf.sizes || [];
  const n = Math.min(sizes.length, (STATIC_MODE && STATIC_KEYS.has(key)) ? (state.config?.max_pages || 40) : sizes.length);
  const per = Array.from({ length: n }, () => []);
  for (const m of res.measures) (m.instances || []).forEach((it, i) => (it.pdf || []).forEach(loc => { if (loc.p < n) for (const r of loc.r) per[loc.p].push({ m, it, i, r, box: !!loc.box }); }));
  const src = p => `${J(key)}/jobs/${encodeURIComponent(key)}/pages/${p}.jpg`;
  const big = h('div', { class: 'pv-page stage-page' });
  const label = h('span', { class: 'stage-label' });
  const strip = h('div', { class: 'stage-strip' });
  let cur = -1;
  const show = p => {
    if (p === cur) return; cur = p;
    const [pw, ph] = sizes[p] || [612, 792]; const marks = per[p];
    big.replaceChildren(h('img', { src: src(p), alt: `Page ${p + 1}`, width: pw, height: ph, decoding: 'async' }));
    for (const hl of marks) {
      const [x0, y0, x1, y1] = hl.r;
      const d = h('div', { class: `hl ${hl.m.plane}${hl.box ? ' box' : ''}`, tabindex: 0, style: { left: `${100 * x0 / pw}%`, top: `${100 * y0 / ph}%`, width: `${100 * (x1 - x0) / pw}%`, height: `${100 * (y1 - y0) / ph}%` } });
      bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 160));
      d.addEventListener('click', e => { e.stopPropagation(); hideTip(); hlCard(big, hl, { x0, y0, x1, y1 }, pw, ph, openFindings); });
      big.append(d);
    }
    label.textContent = `Page ${p + 1} of ${sizes.length}` + (marks.length ? ` · ${marks.length} finding${marks.length === 1 ? '' : 's'}` : ' · nothing flagged');
    strip.querySelectorAll('.stage-thumb').forEach((t, i) => t.classList.toggle('on', i === p));
  };
  per.forEach((marks, p) => {
    const [pw, ph] = sizes[p] || [612, 792];
    const t = h('button', { type: 'button', class: 'stage-thumb', title: `Page ${p + 1}`, onpointerenter: () => show(p), onclick: () => show(p), onfocus: () => show(p) },
      h('span', { class: 'g-page' }, h('img', { src: src(p), alt: '', loading: 'lazy', decoding: 'async', style: { aspectRatio: `${pw} / ${ph}` } }),
        ...marks.map(k => h('span', { class: `g-mark ${k.m.plane}${k.box ? ' box' : ''}`, style: { left: `${100 * k.r[0] / pw}%`, top: `${100 * k.r[1] / ph}%`, width: `${100 * (k.r[2] - k.r[0]) / pw}%`, height: `${100 * (k.r[3] - k.r[1]) / ph}%` } }))),
      h('span', { class: 'st-no', text: String(p + 1) }), marks.length ? h('span', { class: 'st-n', text: String(marks.length) }) : null);
    strip.append(t);
  });
  if (n < sizes.length) strip.append(h('a', { class: 'stage-thumb stage-more', href: `/r/${key}?tab=paper&p=${n}`, 'data-link': '', text: `+${sizes.length - n}` }));
  show(0);
  const el = h('div', { class: 'stage' }, big, h('div', { class: 'stage-foot' }, label, h('span', { class: 'muted', text: 'Hover a thumbnail to switch pages' })), strip);
  // jump to the first page where a measure left a mark and flash those marks
  el.showMeasure = mk => {
    const p = per.findIndex(marks => marks.some(x => x.m.key === mk));
    if (p < 0) return null;
    show(p);
    const hls = [...big.querySelectorAll('.hl')].filter((d, i) => per[p][i]?.m.key === mk);
    hls.forEach(d => d.classList.add('flash')); setTimeout(() => hls.forEach(d => d.classList.remove('flash')), 2200);
    return p;
  };
  return el;
}
// The report digest: score card, first page with highlights, paper map, six measures with a graph stage.
function previewBody(key, job, openReportAt, opts = {}) {
  const res = job.result; const doc = res.document || {}; const ms = measuresOf(job);
  const pdf = res.pdf || {}; const [pw, ph] = (pdf.sizes || [])[0] || [612, 792];
  const marks = [];
  for (const m of res.measures) (m.instances || []).forEach((it, i) => (it.pdf || []).forEach(loc => { if (loc.p !== 0) return; for (const r of loc.r) marks.push({ m, it, i, r, box: !!loc.box }); }));
  const compact = !!opts.compact;
  const page = compact ? null : h('div', { class: 'pv-page prev-page' }, pdf.available ? h('img', { src: `${J(key)}/jobs/${encodeURIComponent(key)}/pages/0.jpg`, alt: 'Page 1', width: 1100, height: Math.round(1100 * ph / pw) }) : h('div', { class: 'pv-empty', text: 'No PDF available.' }));
  for (const hl of compact ? [] : marks) {
    const [x0, y0, x1, y1] = hl.r;
    const d = h('div', { class: `hl ${hl.m.plane}${hl.box ? ' box' : ''}`, tabindex: 0, style: { left: `${100 * x0 / pw}%`, top: `${100 * y0 / ph}%`, width: `${100 * (x1 - x0) / pw}%`, height: `${100 * (y1 - y0) / ph}%` } });
    bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 160));
    d.addEventListener('click', e => { e.stopPropagation(); hideTip(); hlCard(page, hl, { x0, y0, x1, y1 }, pw, ph, () => openReportAt('findings')); });
    page.append(d);
  }
  opts_key.current = key;
  const stage = h('div', { class: 'viz-stage' }); const stageTitle = h('h3', { text: 'Graph' }); const stageSub = h('p', { text: '' });
  let stageEl = null;
  const bars = measureBars(ms, (k, row) => {
    bars.querySelectorAll('.mb-row').forEach(r => r.classList.toggle('on', r === row));
    if (compact && k === 'figure_exposition' && ms[k]?.status === 'done') {
      const p = stageEl?.showMeasure(k); stageTitle.textContent = MEASURES[k].name;
      stageSub.textContent = p != null ? `Boxed on page ${p + 1}. Hover the box to read what was found in the figure.` : 'No method figure was placed on the paper.';
      stage.replaceChildren(); return;
    }
    const v = measureViz(ms[k], doc); stageTitle.textContent = MEASURES[k].name;
    stageSub.textContent = v ? MEASURES[k].unit : (ms[k]?.status === 'done' ? 'No graph for this measure on this paper.' : 'This measure did not run.');
    stage.replaceChildren(v || h('div', { class: 'muted', text: ms[k]?.status === 'done' ? 'Nothing to draw.' : ((ms[k]?.notes || [])[0] || 'Not measured.') }));
  });
  const map = h('div', { class: 'card map-card' });
  const body = h('div', { class: 'prev-body' + (compact ? ' compact' : '') },
    scoreCard(res.index, ms, false),
    compact
      ? h('div', { class: 'prev-grid3' },
        h('div', { class: 'prev-col' },
          h('div', { class: 'section-title' }, h('h3', { text: 'On the paper' }), h('p', { text: `${res.measures.reduce((a, m) => a + (m.instances || []).length, 0)} findings over ${pdf.sizes?.length || 0} pages. Hover a mark to read why, click it for details.` })),
          (stageEl = pageStage(key, res, () => openReportAt('findings')))),
        h('div', { class: 'prev-col' },
          h('div', { class: 'section-title' }, h('h3', { text: 'Where it shows up' }), h('p', { text: 'One row per measure, left to right through the paper.' })),
          map,
          h('div', { class: 'section-title' }, h('h3', { text: 'Six measures' }), h('p', { text: 'Click a measure to see its graph.' })),
          bars,
          h('div', { class: 'section-title' }, stageTitle, stageSub),
          stage))
      : h('div', { class: 'prev-grid' },
        h('div', { class: 'prev-left' },
          h('div', { class: 'section-title' }, h('h3', { text: 'First page' }), h('p', { text: marks.length ? `${marks.length} findings placed here. Hover one to read why; click it for details.` : 'Nothing flagged on the first page.' })),
          page),
        h('div', { class: 'prev-right' },
          h('div', { class: 'section-title' }, h('h3', { text: 'Where it shows up' }), h('p', { text: 'One row per measure, left to right through the paper.' })),
          map,
          h('div', { class: 'section-title' }, h('h3', { text: 'Six measures' }), h('p', { text: 'Click a measure to see its graph.' })),
          bars,
          h('div', { class: 'section-title' }, stageTitle, stageSub),
          stage)));
  const init = () => {
    // open on the most telling graph: copied sentences first, then claims, then the reference map
    const PREF = ['figure_exposition', 'macro_redundancy', 'argument_graph', 'cross_refs', 'citation_isolation', 'evidence_gap'];
    const first = PREF.find(k => ms[k]?.status === 'done' && (ms[k].instances || []).length && measureViz(ms[k], doc)) || ORDER.find(k => measureViz(ms[k], doc));
    if (first && !compact) bars.querySelector(`.mb-row[data-k="${first}"]`)?.click();
    else if (compact) { stageTitle.textContent = 'Graph'; stageSub.textContent = 'Pick a measure above.'; }
    drawMap(map, doc, ms, () => openReportAt('findings'));
    requestAnimationFrame(() => requestAnimationFrame(() => body.querySelectorAll('[data-w]').forEach(n => { n.style.width = n.dataset.w; })));
  };
  return { body, init, doc };
}
async function openPreview(key) {
  document.querySelectorAll('.modal-bg').forEach(n => n.remove());
  const box = h('div', { class: 'modal card' }, h('p', { class: 'muted', text: 'Loading…' }));
  const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(); } }, box);
  const close = () => { bg.remove(); hideTip(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  let job;
  try { job = await fetchReport(key); } catch (_) { box.replaceChildren(h('p', { class: 'muted', text: 'Could not load this report.' })); return; }
  const openReportAt = tab => { close(); go(`/r/${key}?tab=${tab}`); };
  const { body, init, doc } = previewBody(key, job, openReportAt);
  box.replaceChildren(
    h('div', { class: 'modal-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: 'Preview' }), h('h3', { text: doc.title || job.title || 'Paper' })),
      h('div', { class: 'modal-actions' },
        finderBtn(() => openReportAt('paper'), 'small'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReportAt('findings') }, 'Findings'),
        h('button', { class: 'hl-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'))),
    body);
  init();
}

async function loadTeam() {
  const host = $('#team'); if (!host || host.dataset.built) return; host.dataset.built = '1';
  let team = []; try { team = await (await fetch(STATIC + '/team.json')).json(); } catch (_) { return; }
  host.replaceChildren(...team.map(m => {
    const initials = m.name.split(/[\s-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const avatar = h('div', { class: 'tm-avatar' }, h('span', { text: initials }));
    if (m.photo) { const img = h('img', { src: `${STATIC}/img/team/${m.photo}`, alt: m.name, loading: 'lazy' }); img.addEventListener('error', () => img.remove()); avatar.append(img); }
    const name = h('span', { class: 'tm-name', text: m.name });
    const kids = [avatar, name, m.affiliation ? h('span', { class: 'tm-aff', text: m.affiliation }) : null, m.role ? h('span', { class: 'tm-role', text: m.role }) : null];
    return m.url ? h('a', { class: 'tm', href: m.url, target: '_blank', rel: 'noopener', title: m.name + ' ↗' }, ...kids) : h('div', { class: 'tm' }, ...kids);
  }));
}
// ------------------------------------------------------------------ proposals
const PLANE_LABEL = { structure: 'Structure', argument: 'Argument', artifacts: 'Artifacts', other: 'New plane' };
function proposalCard(pr) {
  const plane = pr.plane || ''; const tagCls = ['structure', 'argument', 'artifacts'].includes(plane) ? plane : '';
  const ph = (v, t) => v ? h('span', { text: v }) : h('span', { class: 'pp-ph', text: t });
  return [
    h('div', { class: `mc-pic band-${tagCls || 'structure'} pp-pic` }, h('span', { class: `tag ${tagCls}`, text: PLANE_LABEL[plane] || 'Plane' }), h('span', { class: 'pp-pic-t', text: pr.name || 'Your pattern' })),
    h('div', { class: 'mc-head' }, h('h3', {}, ph(pr.name, 'Pattern name')), h('span', { class: 'method', text: pr.detect ? (/(llm|language model|model)/i.test(pr.detect) ? 'Language model' : 'Counting rule') : 'Proposed' })),
    h('p', { class: 'mc-what' }, ph(pr.what, 'One sentence: what a reader would notice.')),
    h('div', { class: 'mc-score' }, h('span', { class: 'mc-eq', text: 'Score =' }),
      h('span', { class: `frac ${tagCls || 'structure'}` }, h('span', {}, ph(pr.numerator, 'units that show the pattern')), h('span', {}, ph(pr.denominator, 'all units'))),
      h('span', { class: 'mc-unit' }, h('span', { class: 'mc-l', text: 'Unit' }), ph(pr.unit, 'What gets counted'))),
    h('div', { class: 'mc-scale' }, h('div', { class: 'mc-track' }, h('i', { style: { background: PLANE_VAR[tagCls] || 'var(--ink-3)' } })),
      h('div', { class: 'mc-ends' }, h('span', {}, h('b', { text: '0' }), ' none of the units'), h('span', {}, h('b', { text: '100' }), ' ', ph(pr.one_means, 'what the extreme means')))),
    h('div', { class: 'mc-pa' }, h('span', { class: 'mc-l', text: 'Pair accuracy' }), h('div', { class: 'mc-pa-bar' }, h('i', { style: { width: '0%' } }), h('span', { class: 'mc-chance', style: { left: '50%' } })), h('span', { class: 'mc-pa-v muted', text: 'to be tested' })),
  ];
}
function ppRead() {
  const f = $('#pp-form'); const d = Object.fromEntries(new FormData(f).entries());
  d.credit_site = !!(f.credit_site && f.credit_site.checked); d.credit_paper = !!(f.credit_paper && f.credit_paper.checked); return d;
}
let ppInit = false;
function initPropose() {
  if (ppInit) return; ppInit = true;
  const f = $('#pp-form'); const prev = $('#pp-preview');
  const draw = () => prev.replaceChildren(...proposalCard(ppRead()));
  f.addEventListener('input', draw);
  $('#pp-planes').querySelectorAll('.chip-b').forEach(b => b.addEventListener('click', () => {
    $('#pp-planes').querySelectorAll('.chip-b').forEach(c => c.classList.toggle('on', c === b)); f.plane.value = b.dataset.plane; draw();
  }));
  draw();
  f.addEventListener('submit', async e => {
    e.preventDefault(); const err = $('#pp-error'); err.textContent = '';
    const d = ppRead();
    if (!d.plane) { err.textContent = 'Pick a plane, or "Something else".'; return; }
    const btn = $('#pp-go'); btn.disabled = true;
    try {
      const r = await fetch(API + '/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.detail || 'Could not submit. Try again.');
      const done = h('div', { class: 'pp-done card' },
        h('h3', { text: 'Thank you. Your proposal is in.' }),
        h('p', {}, `Proposal ${res.id}: `, h('b', { text: d.name }), '. We will implement it, run it on SciSlopBench, and update its status below.'),
        res.issue_url ? h('p', {}, 'Follow the review here: ', h('a', { href: res.issue_url, target: '_blank', rel: 'noopener', text: res.issue_url }))
          : h('p', {}, 'To make it public and trackable, also file it as an issue in one click: ', h('a', { class: 'btn small', href: res.fallback_issue_url, target: '_blank', rel: 'noopener', text: 'Open as GitHub issue ↗' })),
        h('div', { class: 'pp-done-a' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { f.reset(); f.hidden = false; done.remove(); $('#pp-planes').querySelectorAll('.chip-b').forEach(c => c.classList.remove('on')); draw(); } }, 'Propose another')));
      f.hidden = true; f.parentElement.insertBefore(done, f);
      loadProposals();
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });
}
async function loadProposals() {
  const host = $('#pp-list'); host.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  let d; try { d = await (await fetch(API + '/proposals')).json(); } catch (_) { host.replaceChildren(); return; }
  const items = d.items || [];
  $('#pp-list-note').replaceChildren(items.length ? h('span', {}, `${items.length} proposal${items.length === 1 ? '' : 's'} · reviewed in the open at `, h('a', { href: `https://github.com/${d.repo}/issues?q=label%3Aproposal`, target: '_blank', rel: 'noopener', text: d.repo })) : h('span', { text: 'None yet. Yours could be the first.' }));
  const order = { accepted: 0, testing: 1, 'under-review': 2, 'not-adopted': 3 };
  items.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.created || '').localeCompare(a.created || ''));
  host.replaceChildren(...items.map(pr => {
    const tagCls = ['structure', 'argument', 'artifacts'].includes(pr.plane) ? pr.plane : '';
    const row = h(pr.url ? 'a' : 'div', { class: `pp-row st-${pr.status}`, href: pr.url || null, target: pr.url ? '_blank' : null, rel: pr.url ? 'noopener' : null },
      h('span', { class: `pp-status st-${pr.status}`, text: pr.status_label }),
      h('span', { class: 'pp-row-main' }, h('span', { class: 'pp-row-name' }, h('span', { class: `tag ${tagCls}`, text: PLANE_LABEL[pr.plane] || 'Plane' }), ' ', pr.name), pr.what ? h('span', { class: 'pp-row-what', text: pr.what }) : null),
      h('span', { class: 'pp-row-by', text: pr.author || 'Anonymous' }));
    return row;
  }));
}
async function loadContributors() {
  const host = $('#contributors'); if (!host) return;
  let d; try { d = await (await fetch(API + '/contributors')).json(); } catch (_) { return; }
  const items = d.items || [];
  $('#pt-count').textContent = items.length ? `${items.length} so far` : '';
  if (!items.length) { host.replaceChildren(h('div', { class: 'contrib-empty' }, h('span', { class: 'contrib ghost' }, h('i', { text: '?' }), h('b', { text: 'Your name' })), h('span', { class: 'contrib ghost' }, h('i', { text: '?' }), h('b', { text: 'and yours' })), h('p', { text: 'The list starts with the first flag or proposal.' }))); return; }
  const KIND = { flags: 'flagged slop', pattern: 'proposed a pattern', code: 'code', data: 'data' };
  host.replaceChildren(...items.slice(0, 60).map(c => {
    const el = h(c.url ? 'a' : 'span', { class: 'contrib', href: c.url || null, target: c.url ? '_blank' : null, rel: c.url ? 'noopener' : null },
      h('i', { text: c.name.split(/[\s-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() }), h('b', { text: c.name }), c.n > 1 ? h('small', { text: `×${c.n}` }) : null);
    bindTip(el, c.name + (c.affiliation ? ' · ' + c.affiliation : ''), (c.kinds || []).map(k => KIND[k] || k).join(', ') || 'contributor');
    return el;
  }), items.length > 60 ? h('span', { class: 'muted', text: `+${items.length - 60} more` }) : null);
}
async function loadProposalCount() {
  try { const d = await (await fetch(API + '/proposals')).json(); const n = (d.items || []).length; const acc = (d.items || []).filter(x => x.status === 'accepted').length;
    const el = $('#pt-proposals'); if (el) el.textContent = n ? `${n} proposal${n === 1 ? '' : 's'} so far${acc ? `, ${acc} adopted` : ''}` : ''; } catch (_) { /* optional */ }
}
// Home counter: analyses run on the site so far (server reads the submissions sheet). Mirror shows its build-time copy first, then the live one.
let usageShown = 0, usageAnim = 0;
function drawUsage(st) {
  const n = st && st.analyses; if (!n) return;
  $('#usage').hidden = false;
  // count up from what is already on screen; a newer value (the live server's, arriving while the first
  // count-up still runs) takes over the animation instead of being overwritten by its last frame
  const el = $('#u-n'), from = usageShown; usageShown = n;
  const run = ++usageAnim;
  if (from === n) { el.textContent = n.toLocaleString('en-US'); return; }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = n.toLocaleString('en-US'); return; }
  const t0 = performance.now(), dur = from ? 600 : 1300;
  const step = t => { if (run !== usageAnim) return; const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (n - from) * e).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
async function loadUsage() {
  try { drawUsage(await (await fetch(API + '/stats')).json()); } catch (_) { /* optional */ }
  if (STATIC_MODE) try { drawUsage(await (await fetch(LIVE_API + '/stats')).json()); } catch (_) { /* live server asleep */ }
}
let homeFeatured = null;
async function loadHome() {
  if (!state.gallery) {
    try { state.gallery = await fetchGallery(); }
    catch (_) { return; }
  }
  const ranked = [...state.gallery.items].filter(x => x.index != null).sort((a, b) => b.index - a.index);
  buildCoverflow(ranked); loadTeam(); loadContributors(); if (!usageShown) loadUsage();
  const key = state.config?.featured || ranked[0]?.key;
  if (key && homeFeatured !== key) { homeFeatured = key; renderDeepDive(key, ranked); }
}
async function renderDeepDive(key, ranked) {
  const host = $('#dive'); host.replaceChildren(h('p', { class: 'muted', text: 'Loading the example…' }));
  let job; try { job = await fetchReport(key); } catch (_) { host.replaceChildren(); return; }
  const openReportAt = tab => go(`/r/${key}?tab=${tab}`);
  const { body, init, doc } = previewBody(key, job, openReportAt, { compact: true });
  const x = ranked.find(r => r.key === key); const rank = x ? ranked.indexOf(x) + 1 : null;
  host.replaceChildren(
    h('div', { class: 'dive-head' },
      h('div', { class: 'dive-head-l' },
        h('span', { class: 'eyebrow dive-eyebrow', text: 'Example report' }),
        h('h2', { class: 'dive-title', title: doc.title || job.title }, x?.ai_generated ? h('span', { class: 'ai-badge', text: 'AI-generated' }) : null, doc.title || job.title),
        h('span', { class: 'dive-meta', text: [x?.source, rank ? `#${rank} of ${ranked.length}` : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'modal-actions' },
        finderBtn(() => openReportAt('paper'), 'small'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReportAt('findings') }, 'Findings'))),
    body);
  init();
}
// ------------------------------------------------------------------ coverflow
const cf = { items: [], i: 0, timer: null };
function buildCoverflow(items) {
  const stage = $('#cf-stage'); const dots = $('#cf-dots');
  cf.items = items; if (!items.length) { stage.replaceChildren(h('div', { class: 'g-empty', text: 'No paper has been analyzed yet.' })); return; }
  stage.replaceChildren(...items.map((x, i) => {
    const b = x.index != null ? band(x.index) : null;
    const [pw, ph] = x.page0 || [612, 792];
    const marks = (x.marks || []).map(k => h('span', { class: `g-mark ${k.plane}${k.box ? ' box' : ''}`, style: { left: `${100 * k.r[0] / pw}%`, top: `${100 * k.r[1] / ph}%`, width: `${100 * (k.r[2] - k.r[0]) / pw}%`, height: `${100 * (k.r[3] - k.r[1]) / ph}%` } }));
    const card = h('div', { class: 'cf-card', 'data-i': i, role: 'button', tabindex: 0, 'aria-label': x.title,
      onclick: () => { if (cf.i === i) go(`/r/${x.key}`); else cfGo(i); },
      onkeydown: e => { if (e.key === 'Enter') { cf.i === i ? go(`/r/${x.key}`) : cfGo(i); } } },
      h('div', { class: 'cf-thumb' }, h('div', { class: 'g-page' }, x.thumb ? h('img', { src: `${J(x.key)}/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy', draggable: false }) : h('div', { class: 'ph', text: x.title }), ...marks),
        marks.length ? h('span', { class: 'g-count', text: `${marks.length} on p.1` }) : null),
      h('div', { class: 'cf-cap' },
        h('button', { type: 'button', class: 'cf-digest', title: 'Quick digest without leaving this page', 'aria-label': 'Digest', onclick: e => { e.stopPropagation(); openPreview(x.key); } }, '◫'),
        h('div', { class: 'cf-title' }, x.ai_generated ? h('span', { class: 'ai-badge', text: 'AI-generated' }) : null, x.title),
        h('div', { class: 'cf-sub' }, h('span', { class: 'cf-idx', style: { color: b ? 'var(--red)' : 'var(--ink-3)' }, text: x.index != null ? `Science Slop Index ${x.index}` : '—' }),
          h('span', { class: 'cf-planes' }, PLANES.map(p => h('span', { class: `cf-p cf-${p.key}`, title: p.label, text: `${p.label.slice(0, 3)} ${fmt(x.planes?.[p.key])}` }))))));
    return card;
  }));
  dots.replaceChildren(...items.map((x, i) => h('button', { type: 'button', class: 'cf-dot', 'aria-label': `Paper ${i + 1}`, onclick: () => cfGo(i) })));
  cf.i = Math.min(cf.i, items.length - 1); cfLayout();
  if (!cf.timer) {
    cf.timer = setInterval(() => { if (!document.hidden && !$('#page-home').hidden && !$('#coverflow').matches(':hover')) cfGo((cf.i + 1) % cf.items.length); }, 5000);
    $('#cf-prev').addEventListener('click', () => cfGo((cf.i - 1 + cf.items.length) % cf.items.length));
    $('#cf-next').addEventListener('click', () => cfGo((cf.i + 1) % cf.items.length));
    $('#coverflow').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') $('#cf-prev').click(); if (e.key === 'ArrowRight') $('#cf-next').click(); });
    let sx = null;
    $('#cf-stage').addEventListener('pointerdown', e => { sx = e.clientX; });
    $('#cf-stage').addEventListener('pointerup', e => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) (dx < 0 ? $('#cf-next') : $('#cf-prev')).click(); });
    new ResizeObserver(cfLayout).observe($('#cf-stage'));
  }
}
function cfGo(i) { cf.i = i; cfLayout(); }
function cfLayout() {
  const stage = $('#cf-stage'); if (!stage) return;
  const W = stage.clientWidth; const n = cf.items.length; const narrow = W < 700;
  const step = narrow ? W * 0.44 : W * 0.30;
  stage.querySelectorAll('.cf-card').forEach(c => {
    let off = Number(c.dataset.i) - cf.i;                      // circular: cards sit on both sides
    if (n > 2) { off = ((off % n) + n) % n; if (off > n / 2) off -= n; }
    const a = Math.abs(off);
    const x = Math.sign(off) * (step * Math.min(a, 1) + step * 0.55 * Math.max(a - 1, 0));
    c.style.transform = `translateX(-50%) translateX(${x}px) translateZ(${-170 * Math.min(a, 3)}px) rotateY(${-Math.sign(off) * Math.min(a, 1) * 42}deg)`;
    c.style.zIndex = String(20 - a); c.style.opacity = a > 2 ? '0' : String(1 - a * 0.12);
    c.classList.toggle('on', off === 0); c.setAttribute('aria-hidden', String(a > 2));
  });
  $('#cf-dots').querySelectorAll('.cf-dot').forEach((d, i) => d.classList.toggle('on', i === cf.i));
  $('#cf-label').textContent = cf.items[cf.i] ? `${cf.i + 1} / ${cf.items.length}` : '';
}

// ------------------------------------------------------------------ gallery
async function fetchGallery() {
  const r = await fetch(API + '/gallery'); const data = await r.json();
  if (STATIC_MODE && !data._merged) mergeLiveGallery(data);        // papers listed after the mirror was built
  return data;
}
async function mergeLiveGallery(data) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(LIVE_API + '/gallery', { signal: ctl.signal }); clearTimeout(t); const live = await r.json();
    const have = new Set(data.items.map(x => x.key)); const extra = (live.items || []).filter(x => !have.has(x.key));
    if (!extra.length) return;
    data.items.push(...extra); data._merged = true; state.gallery = data; if (lb.data) lb.data = data;
    if (!$('#page-gallery').hidden) renderGallery(); if (!$('#page-leaderboard').hidden) renderLeaderboard(); if (!$('#page-home').hidden) buildCoverflow([...data.items].filter(x => x.index != null).sort((a, b) => b.index - a.index));
  } catch (_) { /* live backend asleep or offline: the mirror's list stands */ }
}
async function loadGallery() {
  const grid = $('#g-grid');
  if (!state.gallery) grid.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  try { state.gallery = await fetchGallery(); }
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
  else grid.replaceChildren(...items.map(x => galleryCard(x, rank.get(x.key))));
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
  initTheme(); initInputs(); initContribute(); initKey(); initLeaderboard();
  $('#g-q').addEventListener('input', renderGallery);
  $('#g-sort').addEventListener('change', renderGallery);
  try {
    const r = await fetch(API + '/config'); state.config = await r.json();

  } catch (_) { /* the page works without config */ }
  route();
}
boot();
