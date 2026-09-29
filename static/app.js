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
  if (m) { showPage('report'); openReport(m[1], new URLSearchParams(location.search).get('tab')); return; }
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
  if (apiKey()) fd.append('api_key', apiKey());
  try {
    const r = await fetch('/api/analyze', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Something went wrong. Try again.');
    go('/r/' + d.key);
  } catch (e) { setError(e.message); } finally { btn.disabled = false; }
}
function apiKey() { return ($('#api-key')?.value || '').trim(); }
function initKey() {
  const inp = $('#api-key'), rem = $('#key-remember');
  const saved = store.get('ssi-key', '');
  if (saved) { inp.value = saved; rem.checked = true; }
  const sync = () => { if (rem.checked && inp.value.trim()) store.set('ssi-key', inp.value.trim()); else store.del('ssi-key'); };
  inp.addEventListener('input', sync); rem.addEventListener('change', sync);
  $('#bib-copy').addEventListener('click', () => copy($('#bib').textContent, 'BibTeX copied'));
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
function openReport(key, tab) {
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
  const side = h('div', { class: 'pv-side' }, h('h4', { text: 'On the paper' }),
    ORDER.map(k => {
      const meta = MEASURES[k]; const c = counts[k] || { found: 0, total: 0 }; const on = !state.hidden.has(k);
      const toggle = () => { state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); state.sig = ''; render(state.job); };
      return h('div', { class: `pv-toggle ${meta.plane}` + (on ? ' on' : '') },
        h('button', { type: 'button', class: 'pv-main', title: 'Open the graph and findings for this measure', onclick: () => openMeasureModal(k) },
          h('span', { class: 'pv-n', text: String(c.found) }),
          h('span', { class: 'pv-l' }, h('span', { class: 'pv-name', text: meta.name }), h('span', { class: 'pv-sub', text: c.total ? `${c.found} of ${c.total} placed · graph ↗` : 'nothing flagged' }))),
        h('button', { type: 'button', class: 'pv-eye', 'aria-pressed': String(on), title: on ? 'Hide on the paper' : 'Show on the paper', onclick: toggle }, on ? '●' : '○'));
    }),
    h('a', { class: 'btn ghost small', href: `/api/jobs/${encodeURIComponent(key)}/pdf`, download: '', style: { textAlign: 'center', textDecoration: 'none', marginTop: '8px' } }, 'Download highlighted PDF'));
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
      bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 160));
      const openFindings = () => { hideTip(); state.tab = 'findings'; state.open.add(hl.m.key); if (hl.i >= 8) state.showAll.add(hl.m.key); if (hl.m.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.flash = `f-${hl.m.key}-${hl.i}`; state.sig = ''; render(state.job); };
      const open = e => { if (e && e.stopPropagation) e.stopPropagation(); hideTip(); hlCard(page, hl, { x0, y0, x1, y1 }, w, hgt, openFindings); };
      d.addEventListener('click', open);
      d.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
      page.append(d);
    }
    pages.append(page);
  });
  return h('div', { class: 'pv-layout' }, side, pages);
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
    const imgs = (fig.images || []).map(n => h('div', { class: 'fig-img' }, h('img', { src: `/api/jobs/${encodeURIComponent(key)}/files/${n}`, alt: `Figure ${fig.number || ''}`, loading: 'lazy' })));
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
    const r = await fetch(`/api/jobs/${encodeURIComponent(key)}/figure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, api_key: store.get('ssi-key', '') || undefined }) });
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
  const host = $('#spec');
  for (const p of PLANES) {
    const group = h('div', { class: `mgroup band-${p.key}` },
      h('div', { class: 'mgroup-head' }, h('span', { class: `tag ${p.key}`, text: p.label }), h('span', { class: 'mgroup-q', text: p.q })));
    const row = h('div', { class: 'mgroup-row' });
    for (const k of p.measures) {
      const m = MEASURES[k]; const pa = m.pairacc;
      row.append(h('div', { class: 'mcard' },
        h('div', { class: `mc-pic band-${p.key}` }, h('img', { src: `/static/img/${k}.svg`, alt: `Illustration of ${m.name}` })),
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
function galleryCard(x, rankNo) {
  const b = x.index != null ? band(x.index) : null;
  const [pw, ph] = x.page0 || [612, 792];
  const marks = (x.marks || []).map(k => {
    const el = h('span', { class: `g-mark ${k.plane}${k.box ? ' box' : ''}`, 'data-plane': k.plane,
      style: { left: `${100 * k.r[0] / pw}%`, top: `${100 * k.r[1] / ph}%`, width: `${100 * (k.r[2] - k.r[0]) / pw}%`, height: `${100 * (k.r[3] - k.r[1]) / ph}%` } });
    bindTip(el, k.name || k.m, k.t || '');
    return el;
  });
  const page = h('div', { class: 'g-page' }, x.thumb ? h('img', { src: `/api/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy' }) : h('div', { class: 'ph', text: x.title }), ...marks);
  const card = h('div', { class: 'g-card' },
    h('button', { type: 'button', class: 'g-thumb', style: { borderBottomColor: b ? b.color : 'var(--line-2)' }, title: 'Preview: findings on the paper, map, and charts', onclick: () => openPreview(x.key) }, page,
      marks.length ? h('span', { class: 'g-count', text: `${marks.length} on p.1` }) : null,
      h('span', { class: 'g-zoom', 'aria-hidden': 'true', text: 'Preview' })),
    h('a', { class: 'g-body', href: `/r/${x.key}?tab=paper`, 'data-link': '', title: x.title },
      h('div', { class: 'g-rank' }, h('span', { text: rankNo ? `Science Slop Index #${rankNo}` : '—' }), h('span', { class: 'score', text: x.index != null ? `${x.index} / 100${x.partial ? '*' : ''}` : '—' })),
      h('div', { class: 'g-title', text: x.title })),
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
  const r = await fetch('/api/jobs/' + encodeURIComponent(key)); const job = await r.json();
  if (!r.ok || !job.result) throw new Error('no report');
  return job;
}
// The report digest: score card, first page with highlights, paper map, six measures with a graph stage.
function previewBody(key, job, openReportAt, opts = {}) {
  const res = job.result; const doc = res.document || {}; const ms = measuresOf(job);
  const pdf = res.pdf || {}; const [pw, ph] = (pdf.sizes || [])[0] || [612, 792];
  const marks = [];
  for (const m of res.measures) (m.instances || []).forEach((it, i) => (it.pdf || []).forEach(loc => { if (loc.p !== 0) return; for (const r of loc.r) marks.push({ m, it, i, r, box: !!loc.box }); }));
  const page = h('div', { class: 'pv-page prev-page' }, pdf.available ? h('img', { src: `/api/jobs/${encodeURIComponent(key)}/pages/0.jpg`, alt: 'Page 1', width: 1100, height: Math.round(1100 * ph / pw) }) : h('div', { class: 'pv-empty', text: 'No PDF available.' }));
  for (const hl of marks) {
    const [x0, y0, x1, y1] = hl.r;
    const d = h('div', { class: `hl ${hl.m.plane}${hl.box ? ' box' : ''}`, tabindex: 0, style: { left: `${100 * x0 / pw}%`, top: `${100 * y0 / ph}%`, width: `${100 * (x1 - x0) / pw}%`, height: `${100 * (y1 - y0) / ph}%` } });
    bindTip(d, hl.m.name, trunc(hl.it.why || hl.it.text || '', 160));
    d.addEventListener('click', e => { e.stopPropagation(); hideTip(); hlCard(page, hl, { x0, y0, x1, y1 }, pw, ph, () => openReportAt('findings')); });
    page.append(d);
  }
  opts_key.current = key;
  const stage = h('div', { class: 'viz-stage' }); const stageTitle = h('h3', { text: 'Graph' }); const stageSub = h('p', { text: '' });
  const bars = measureBars(ms, (k, row) => {
    bars.querySelectorAll('.mb-row').forEach(r => r.classList.toggle('on', r === row));
    const v = measureViz(ms[k], doc); stageTitle.textContent = MEASURES[k].name;
    stageSub.textContent = v ? MEASURES[k].unit : (ms[k]?.status === 'done' ? 'No graph for this measure on this paper.' : 'This measure did not run.');
    stage.replaceChildren(v || h('div', { class: 'muted', text: ms[k]?.status === 'done' ? 'Nothing to draw.' : ((ms[k]?.notes || [])[0] || 'Not measured.') }));
  });
  const map = h('div', { class: 'card map-card' });
  const body = h('div', { class: 'prev-body' },
    scoreCard(res.index, ms, false),
    h('div', { class: 'prev-grid' },
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
    const first = ORDER.find(k => measureViz(ms[k], doc));
    if (first) bars.querySelector(`.mb-row[data-k="${first}"]`)?.click();
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
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReportAt('paper') }, 'All pages'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openReportAt('findings') }, 'Full report →'),
        h('button', { class: 'hl-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'))),
    body);
  init();
}

let homeFeatured = null;
async function loadHome() {
  if (!state.gallery) {
    try { const r = await fetch('/api/gallery'); state.gallery = await r.json(); }
    catch (_) { return; }
  }
  const ranked = [...state.gallery.items].filter(x => x.index != null).sort((a, b) => b.index - a.index);
  buildCoverflow(ranked);
  const key = state.config?.featured || ranked[0]?.key;
  if (key && homeFeatured !== key) { homeFeatured = key; renderDeepDive(key, ranked); }
}
async function renderDeepDive(key, ranked) {
  const host = $('#dive'); host.replaceChildren(h('p', { class: 'muted', text: 'Loading the example…' }));
  let job; try { job = await fetchReport(key); } catch (_) { host.replaceChildren(); return; }
  const openReportAt = tab => go(`/r/${key}?tab=${tab}`);
  const { body, init, doc } = previewBody(key, job, openReportAt);
  const x = ranked.find(r => r.key === key); const rank = x ? ranked.indexOf(x) + 1 : null;
  host.replaceChildren(
    h('div', { class: 'dive-head' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Example · what a report looks like' }),
        h('h2', { class: 'dive-title', text: doc.title || job.title }),
        h('p', { class: 'dive-meta', text: [x?.source, rank ? `ranked #${rank} of ${ranked.length} papers on this site` : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReportAt('paper') }, 'All pages'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openReportAt('findings') }, 'Full report →'))),
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
      onclick: () => { if (cf.i === i) openPreview(x.key); else cfGo(i); },
      onkeydown: e => { if (e.key === 'Enter') { cf.i === i ? openPreview(x.key) : cfGo(i); } } },
      h('div', { class: 'cf-thumb' }, h('div', { class: 'g-page' }, x.thumb ? h('img', { src: `/api/jobs/${x.key}/thumb.png`, alt: '', loading: 'lazy', draggable: false }) : h('div', { class: 'ph', text: x.title }), ...marks),
        marks.length ? h('span', { class: 'g-count', text: `${marks.length} on p.1` }) : null),
      h('div', { class: 'cf-cap' },
        h('div', { class: 'cf-title', text: x.title }),
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
  initTheme(); initInputs(); initKey(); initLeaderboard();
  $('#g-q').addEventListener('input', renderGallery);
  $('#g-sort').addEventListener('change', renderGallery);
  try {
    const r = await fetch('/api/config'); state.config = await r.json();
    if (state.config.examples?.length) { $('#example').hidden = false; $('#example').title = state.config.examples[0].title; }
    if (state.config.llm_available) { $('.key-note').textContent = 'This server already has a language model configured; your key is optional and, if given, is used instead.'; }
  } catch (_) { /* the page works without config */ }
  route();
}
boot();
