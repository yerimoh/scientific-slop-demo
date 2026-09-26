// Science Slop Index — front end. Plain DOM, no build step. All paper text is inserted with
// textContent (it is untrusted), never innerHTML.

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

// ------------------------------------------------------------------ static model
const PLANES = [
  { key: 'structure', label: 'Structure', q: 'Do the sections build on one another?', measures: ['cross_refs', 'macro_redundancy'] },
  { key: 'argument', label: 'Argument', q: 'Are claims and citations argued, not just stated?', measures: ['argument_graph', 'citation_isolation'] },
  { key: 'artifacts', label: 'Artifacts', q: 'Can a reader inspect the method and the evidence?', measures: ['figure_exposition', 'evidence_gap'] },
];
const MEASURES = {
  cross_refs: { name: 'Cross-section references', short: 'Cross-refs', plane: 'structure', method: 'Rule', unit: 'objects', pairacc: 0.905, counts: 'Sections and labeled objects never referred to from another section' },
  macro_redundancy: { name: 'Macro redundancy', short: 'Redundancy', plane: 'structure', method: 'Rule', unit: 'sentences', pairacc: 0.723, counts: 'Sentences at least half copied, as 8-grams, from an earlier section' },
  argument_graph: { name: 'Argument graph', short: 'Claims', plane: 'argument', method: 'LLM', unit: 'key claims', pairacc: 0.586, counts: 'Introduction claims whose strongest support comes after them' },
  citation_isolation: { name: 'Citation isolation', short: 'Citations', plane: 'argument', method: 'Rule', unit: 'citing sentences', pairacc: 0.793, counts: 'Citing sentences that relate the cited work to no other work' },
  figure_exposition: { name: 'Figure exposition', short: 'Figure', plane: 'artifacts', method: 'LLM', unit: 'content kinds', pairacc: 0.809, counts: 'Kinds of expository material in the method figure, out of six' },
  evidence_gap: { name: 'Evidence gap', short: 'Evidence', plane: 'artifacts', method: 'Rule', unit: 'paper', pairacc: 0.764, counts: 'Papers with result tables but no concrete example anywhere' },
};
const ORDER = PLANES.flatMap(p => p.measures);
const PLANE_VAR = { structure: 'var(--structure)', argument: 'var(--argument)', artifacts: 'var(--artifacts)' };
const BANDS = [
  { max: 20, label: 'Low', color: 'var(--good)', icon: '●' },
  { max: 40, label: 'Moderate', color: 'var(--warning)', icon: '▲' },
  { max: 60, label: 'High', color: 'var(--serious)', icon: '◆' },
  { max: 101, label: 'Very high', color: 'var(--critical)', icon: '■' },
];
const BENCH = [
  ['Science Slop Index', 0.859, 0.854, true], ['Binoculars', 0.687, 0.683], ['CycleReviewer', 0.685, 0.689],
  ['DetectGPT', 0.638, 0.623], ['NTS', 0.626, 0.607], ['AI Scientist reviewer', 0.615, 0.613],
];

const state = { jid: null, job: null, sig: '', open: new Set(), showAll: new Set(), timer: null, config: null, flash: null };

// ------------------------------------------------------------------ utilities
const band = v => BANDS.find(b => v < b.max) || BANDS[BANDS.length - 1];
const pct = x => (x == null ? null : Math.round(100 * x));
function fmt(x) {
  if (x == null) return '—';
  const v = 100 * x;
  if (v > 0 && v < 1) return '<1';
  return String(Math.round(v));
}
function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); }
function toast(msg) {
  const t = h('div', { class: 'toast', text: msg, role: 'status' });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
function setError(msg) { $('#form-error').textContent = msg || ''; }
function trunc(t, n) { t = t || ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; }

// tooltip
const tip = $('#tip');
function placeTip(e) {
  const pad = 14; const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
function showTip(e, title, body) {
  tip.replaceChildren(h('b', { text: title }), document.createTextNode(body || ''));
  tip.hidden = false; placeTip(e);
}
function hideTip() { tip.hidden = true; }
function bindTip(node, title, body) {
  node.addEventListener('pointerenter', e => showTip(e, title, body));
  node.addEventListener('pointermove', placeTip);
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip({ clientX: r.right, clientY: r.bottom }, title, body);
  });
  node.addEventListener('blur', hideTip);
}

// ------------------------------------------------------------------ theme
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('ssi-theme'); } catch (_) { /* storage may be blocked */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ssi-theme', next); } catch (_) { /* ignore */ }
    if (state.job) { state.sig = ''; render(state.job); }
  });
}

// ------------------------------------------------------------------ submit
async function submit(fd) {
  setError('');
  const go = $('#go'); go.disabled = true;
  try {
    const r = await fetch('/api/analyze', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Something went wrong. Try again.');
    history.pushState({}, '', '/r/' + d.id);
    openReport(d.id);
  } catch (e) {
    setError(e.message);
  } finally { go.disabled = false; }
}
function submitFile(file) {
  if (!file) return;
  const maxMb = state.config?.max_upload_mb || 50;
  if (file.size > maxMb * 1024 * 1024) { setError(`That file is larger than ${maxMb} MB.`); return; }
  const fd = new FormData(); fd.append('file', file); submit(fd);
}
function initInputs() {
  $('#ask').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#url').value.trim();
    if (!v) { setError('Paste a link, or upload a file below.'); $('#url').focus(); return; }
    const fd = new FormData(); fd.append('url', v); submit(fd);
  });
  $('#file').addEventListener('change', e => submitFile(e.target.files[0]));
  $('#example').addEventListener('click', () => {
    const ex = state.config?.examples?.[0]; if (!ex) return;
    const fd = new FormData(); fd.append('example', ex.id); submit(fd);
  });
  // drop anywhere
  let depth = 0; const drop = $('#drop');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.hidden = false; });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0; drop.hidden = true;
    submitFile(e.dataTransfer.files[0]);
  });
  $('#home').addEventListener('click', e => { e.preventDefault(); history.pushState({}, '', '/'); route(); });
  addEventListener('popstate', route);
}

// ------------------------------------------------------------------ routing & polling
function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)/);
  clearTimeout(state.timer);
  if (m) openReport(m[1]);
  else {
    state.jid = null; state.job = null; state.sig = '';
    $('#report').hidden = true; $('#landing').hidden = false;
    document.title = 'Science Slop Index';
  }
}
function openReport(id) {
  if (state.jid !== id) { state.open.clear(); state.showAll.clear(); state.sig = ''; }
  state.jid = id;
  $('#landing').hidden = true;
  const R = $('#report'); R.hidden = false;
  if (!state.job || state.job.id !== id) R.replaceChildren(h('p', { class: 'stage' }, h('span', { class: 'spinner' }), 'Starting…'));
  scrollTo({ top: 0 });
  poll(id, 0);
}
async function poll(id, fails) {
  if (state.jid !== id) return;
  try {
    const r = await fetch('/api/jobs/' + id);
    if (r.status === 404) { renderError('This report does not exist, or it has expired.'); return; }
    const job = await r.json();
    state.job = job; render(job);
    if (job.status === 'running') state.timer = setTimeout(() => poll(id, 0), 650);
  } catch (e) {
    if (fails < 8) state.timer = setTimeout(() => poll(id, fails + 1), 1200 * (fails + 1));
    else renderError('Lost the connection to the server.');
  }
}

// ------------------------------------------------------------------ render
function measuresOf(job) {
  const out = {};
  if (job.result) for (const m of job.result.measures) out[m.key] = m;
  else Object.assign(out, job.measures || {});
  return out;
}
function signature(job) {
  const ms = measuresOf(job);
  return [job.status, job.stage, job.document ? 1 : 0, (job.running || []).join(','),
    ...ORDER.map(k => (ms[k] ? ms[k].status + ':' + ms[k].score + ':' + (ms[k].instances || []).length : '-')),
    job.result ? job.result.index?.score : '', JSON.stringify(job.result?.measures?.find(m => m.key === 'figure_exposition')?.details?.figure?.index ?? ''),
    [...state.open].join(','), [...state.showAll].join(','),
  ].join('|');
}
function render(job) {
  if (job.status === 'error') { renderError(job.error); return; }
  const sig = signature(job);
  if (sig === state.sig) return;
  state.sig = sig;
  const R = $('#report');
  const running = job.status !== 'done';
  const ms = measuresOf(job);
  const doc = job.result?.document || job.document;
  const idx = job.result?.index;
  const frag = [];

  // header
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
  if (running) frag.push(h('p', { class: 'stage', 'aria-live': 'polite' }, h('span', { class: 'spinner' }), (job.stage || 'Working') + '…'));

  frag.push(scoreCard(idx, ms, running));
  frag.push(h('div', { class: 'section-title' }, h('h3', { text: 'Where it shows up' }),
    h('p', { text: 'Each dot is a flagged unit, placed where it occurs. Hover to read it, click to open it.' })));
  const mapHost = h('div', { class: 'card map-card' });
  frag.push(mapHost);
  frag.push(h('div', { class: 'section-title' }, h('h3', { text: 'Six measures' }),
    h('p', { text: 'Open a measure to see every unit it flags.' })));
  for (const p of PLANES) frag.push(planeGroup(p, ms, running, idx));
  if (job.result) frag.push(footCard(job.result));

  R.replaceChildren(...frag);
  drawMap(mapHost, doc, ms);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    R.querySelectorAll('[data-w]').forEach(n => { n.style.width = n.dataset.w; });
  }));
  if (state.flash) {
    const t = document.getElementById(state.flash); state.flash = null;
    if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1600); }
  }
}

function renderError(msg) {
  const R = $('#report'); R.hidden = false; $('#landing').hidden = true;
  R.replaceChildren(h('div', { class: 'card error-card' },
    h('h2', { class: 'serif', text: 'We could not read this paper' }),
    h('p', { text: msg || 'Unknown error.' }),
    h('button', { class: 'btn', type: 'button', onclick: () => { history.pushState({}, '', '/'); route(); } }, 'Try another paper')));
}

// ------------------------------------------------------------------ score card
function scoreCard(idx, ms, running) {
  const have = idx && idx.index != null;
  const v = have ? idx.index : null;
  const b = have ? band(v) : null;
  const numEl = h('div', { class: 'hero-num' + (have ? '' : ' pending') }, h('span', { class: 'n', text: have ? String(v) : '··' }), h('span', { class: 'of', text: '/100' }));
  let sub;
  if (have) {
    const nDone = ORDER.filter(k => ms[k]?.status === 'done').length;
    sub = `Averaged over the three planes, ${v}% of the units we measured show a slop pattern.`
      + (idx.partial ? ` Partial: ${nDone} of 6 measures could run.` : '');
  } else sub = running ? 'Measuring six patterns across the paper…' : 'No measure applied to this paper.';
  const hero = h('div', {},
    numEl,
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
    const t = h('button', { class: 'tile', type: 'button', onclick: () => document.getElementById('plane-' + p.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      h('div', { class: 't-name' }, h('span', { class: `swatch sw-${p.key}` }), p.label),
      h('div', { class: 't-val', text: ps == null ? (running ? '··' : '—') : fmt(ps) }),
      h('div', { class: 't-bar' }, h('i', { style: { width: '0%', background: PLANE_VAR[p.key] }, 'data-w': ((ps || 0) * 100) + '%' })));
    bindTip(t, `${p.label}: ${ps == null ? 'not measured' : fmt(ps) + ' / 100'}`, p.q);
    return t;
  }));
  return h('div', { class: 'card score-card' }, hero, h('div', { class: 'scale' }, meter, labels, tiles));
}

// ------------------------------------------------------------------ paper map
function mapItems(doc, ms) {
  const outline = doc?.outline || [];
  const bySec = new Map(outline.map(o => [o.idx, o]));
  const items = [];
  for (const k of ORDER) {
    const m = ms[k]; if (!m || m.status !== 'done') continue;
    (m.instances || []).forEach((it, i) => {
      if (it.section == null || !bySec.has(it.section)) return;
      items.push({ key: k, i, sec: it.section, sent: it.sentence, text: it.text || it.label || '', where: it.section_title || '' });
    });
  }
  return { outline, items };
}
function drawMap(host, doc, ms) {
  const { outline, items } = mapItems(doc, ms);
  if (!outline.length) { host.replaceChildren(h('div', { class: 'map-empty', text: 'The map appears once the paper is read.' })); return; }
  const draw = () => {
    const W = Math.max(300, host.clientWidth - 40);
    const labelW = W < 520 ? 70 : 92, laneH = 22, top = 4;
    const H = top + laneH * ORDER.length + 26;
    const weights = outline.map(o => Math.max(o.sentences, 4));
    const total = weights.reduce((a, b) => a + b, 0);
    const plotW = W - labelW;
    let x = labelW; const segs = outline.map((o, k) => { const w = plotW * weights[k] / total; const seg = { o, x, w }; x += w; return seg; });
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
    // spread non-sentence items within their section
    const buckets = new Map();
    for (const it of items) if (it.sent == null) { const kk = it.key + ':' + it.sec; buckets.set(kk, (buckets.get(kk) || []).concat(it)); }
    for (const it of items) {
      const sg = segOf.get(it.sec); if (!sg) continue;
      const o = sg.o; let cx;
      if (it.sent != null && o.sentences) cx = sg.x + 4 + (sg.w - 8) * (it.sent + 0.5) / o.sentences;
      else { const b = buckets.get(it.key + ':' + it.sec); const j = b.indexOf(it); cx = sg.x + sg.w * (j + 1) / (b.length + 1); }
      const cy = top + ORDER.indexOf(it.key) * laneH + laneH / 2;
      const color = PLANE_VAR[MEASURES[it.key].plane];
      const dot = s('circle', { class: 'dot', cx, cy, r: 4.5, fill: color });
      const hit = s('circle', { class: 'hit', cx, cy, r: 11, tabindex: 0, role: 'button', 'aria-label': `${MEASURES[it.key].name}: ${trunc(it.text, 80)}` });
      const open = () => { hideTip(); state.open.add(it.key); state.flash = `f-${it.key}-${it.i}`; if (it.i >= 8) state.showAll.add(it.key); if (it.key === 'cross_refs') state.showAll.add('cross_refs:list'); state.sig = ''; render(state.job); };
      hit.addEventListener('click', open);
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      hit.addEventListener('pointerenter', () => dot.setAttribute('r', 6.5));
      hit.addEventListener('pointerleave', () => dot.setAttribute('r', 4.5));
      bindTip(hit, `${MEASURES[it.key].name} · ${it.where}`, trunc(it.text, 240));
      svg.append(dot, hit);
    }
    const legend = h('div', { class: 'legend' },
      PLANES.map(p => h('span', {}, h('span', { class: `swatch sw-${p.key}` }), p.label)),
      h('span', { style: { color: 'var(--ink-3)' }, text: items.length ? `${items.length} flagged units` : 'No flagged unit is placed in the text yet' }));
    host.replaceChildren(svg, legend);
  };
  draw();
  if (host._ro) host._ro.disconnect();
  let last = host.clientWidth;
  host._ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - last) > 8) { last = host.clientWidth; draw(); } });
  host._ro.observe(host);
}

// ------------------------------------------------------------------ measure rows
function planeGroup(p, ms, running, idx) {
  const ps = idx?.planes?.[p.key]?.score;
  const card = h('div', { class: 'card plane-group', id: 'plane-' + p.key },
    h('div', { class: 'pg-head' },
      h('h4', {}, h('span', { class: `swatch sw-${p.key}` }), p.label, h('span', { class: 'q', text: p.q })),
      h('span', { class: 'pv', text: ps == null ? '' : `plane ${fmt(ps)}` })));
  for (const k of p.measures) {
    const m = ms[k];
    const meta = MEASURES[k];
    const isOpen = state.open.has(k);
    const row = h('button', { class: 'row', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': 'd-' + k,
      onclick: () => { if (!m || running && !m) return; state.open.has(k) ? state.open.delete(k) : state.open.add(k); state.sig = ''; render(state.job); } });
    row.append(h('span', { class: 'name', text: meta.name }));
    if (!m) {
      const isRunning = (state.job?.running || []).includes(k);
      row.append(h('span', { class: 'shimmer' }), h('span', { class: 'val', text: '' }),
        h('span', { class: 'state', text: running ? (isRunning ? 'measuring…' : 'queued') : '' }),
        h('span', { class: 'method', text: meta.method }), h('span', { class: 'chev', text: '' }));
    } else {
      const done = m.status === 'done' && m.score != null;
      const fill = h('i', { style: { width: '0%', background: PLANE_VAR[p.key] }, 'data-w': (done ? m.score * 100 : 0) + '%' });
      let frac;
      if (done) frac = `${fmtNum(m.num)} / ${m.den} ${m.unit || meta.unit}` + (m.weak ? ' · weak' : '');
      else if (m.status === 'na') frac = 'not applicable';
      else if (m.status === 'skipped') frac = 'needs an LLM key';
      else frac = 'could not run';
      row.append(h('span', { class: 'bar' }, fill), h('span', { class: 'val', text: done ? fmt(m.score) : '—' }),
        h('span', { class: 'frac', text: frac, title: frac }), h('span', { class: 'method', text: meta.method, title: meta.method === 'LLM' ? 'Uses a language model' : 'Exact counting rule' }),
        h('span', { class: 'chev', text: '›' }));
    }
    card.append(row);
    if (isOpen && m) card.append(detail(m));
  }
  return card;
}

function findingsList(m, renderItem) {
  const all = m.instances || [];
  const showAll = state.showAll.has(m.key);
  const list = h('ul', { class: 'findings' });
  (showAll ? all : all.slice(0, 8)).forEach((it, i) => list.append(h('li', { class: 'finding', id: `f-${m.key}-${i}` }, renderItem(it, i))));
  const out = [list];
  if (all.length > 8 && !showAll) out.push(h('button', { class: 'link-btn more', type: 'button', onclick: () => { state.showAll.add(m.key); state.sig = ''; render(state.job); } }, `Show all ${all.length}`));
  return out;
}
function whereLine(...parts) { return h('div', { class: 'where' }, parts.filter(Boolean).map(p => h('span', { text: p }))); }
function highlighted(text, spans) {
  const out = h('div', { class: 'txt' }); let pos = 0;
  for (const [a, b] of spans || []) {
    if (a > pos) out.append(document.createTextNode(text.slice(pos, a)));
    out.append(h('mark', { text: text.slice(a, b) })); pos = b;
  }
  out.append(document.createTextNode(text.slice(pos)));
  return out;
}

function detail(m) {
  const meta = MEASURES[m.key];
  const d = h('div', { class: 'detail', id: 'd-' + m.key });
  d.append(h('p', { class: 'd-lead' }, m.what || meta.counts, ' ', h('b', { text: 'A score of 100 means: ' }), m.one_means || ''));
  const R = RENDERERS[m.key];
  if (m.status === 'done' && R) d.append(...R(m));
  if (m.status !== 'done') d.append(h('div', { class: 'ok-line' }, h('span', { class: 'ico', style: { background: 'var(--ink-3)' }, text: 'i' }),
    h('span', { text: (m.notes && m.notes[0]) || 'This measure did not apply.' })));
  if (m.key === 'figure_exposition' && m.status === 'na' && (m.details?.candidates || []).length)
    d.append(h('div', { style: { marginTop: '12px' } }, figurePicker(m, 'Score a figure you choose')));
  const notes = (m.notes || []).slice(m.status === 'done' ? 0 : 1);
  const pairacc = m.paper_pairacc ?? meta.pairacc;
  d.append(h('ul', { class: 'notes' },
    notes.map(n => h('li', { text: n })),
    h('li', { text: `In the paper's evaluation on SciSlopBench, this measure alone picks the AI-generated paper in ${Math.round(pairacc * 1000) / 10}% of matched pairs.` })));
  return d;
}

const RENDERERS = {
  cross_refs(m) {
    const det = m.details || {};
    const bySec = new Map();
    for (const o of det.objects || []) bySec.set(o.home, (bySec.get(o.home) || []).concat(o));
    const titles = new Map((state.job?.result?.document || state.job?.document)?.outline?.map(o => [o.idx, (o.number ? '§' + o.number + ' ' : '') + o.title]) || []);
    const rows = [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([sec, objs]) => h('div', { class: 'refrow' },
      h('span', { class: 'sec', text: titles.get(sec) || '§' + sec }),
      h('span', { class: 'objs' }, objs.map(o => {
        const lab = o.kind === 'section' ? 'Section' : o.label.replace(/^Eq\. \((.*)\)$/, 'Eq.');
        const c = h('span', { class: 'obj ' + (o.from.length ? 'hit' : 'miss'), tabindex: 0, text: lab });
        bindTip(c, o.label, o.from.length ? 'Referred to from ' + o.from.map(f => titles.get(f) || '§' + f).join(', ')
          : `Never referred to from another section${o.own ? ` (${o.own}× inside its own)` : ''}.`);
        return c;
      }))));
    return [
      h('div', { class: 'd-sub', text: 'Reference map' }),
      h('div', { class: 'refmap' }, rows),
      h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--structure)' } }), 'used by another section'),
        h('span', {}, h('span', { class: 'lg-box', style: { border: '1.5px solid var(--structure)' } }), 'never referred to from outside')),
      ...(m.instances.length ? (state.showAll.has(m.key + ':list')
        ? [h('div', { class: 'd-sub', text: `Unreferenced objects · ${m.instances.length}` }),
          h('ul', { class: 'findings' }, m.instances.map((it, i) => h('li', { class: 'finding', id: `f-${m.key}-${i}` },
            whereLine(it.section_title, it.kind), h('div', { class: 'txt', text: it.caption ? `${it.label}: ${trunc(it.caption, 200)}` : it.label }))))]
        : [h('button', { class: 'link-btn more', type: 'button', style: { marginTop: '12px' }, onclick: () => { state.showAll.add(m.key + ':list'); state.sig = ''; render(state.job); } },
          `List all ${m.instances.length} unreferenced objects`)]) : []),
    ];
  },
  macro_redundancy(m) {
    if (!m.instances.length) return [okLine(`No sentence repeats half of itself from an earlier section (${m.den} sentences checked).`)];
    return [h('div', { class: 'd-sub', text: `Recycled sentences · ${m.instances.length}` }),
      ...findingsList(m, it => {
        const src = h('div', { class: 'src', hidden: true, text: it.source_text });
        return [whereLine(it.section_title, `${Math.round(it.coverage * 100)}% copied from ${it.source_title}`),
          highlighted(it.text, it.highlights),
          h('button', { class: 'link-btn more', type: 'button', style: { fontSize: '12.5px' }, onclick: e => { src.hidden = !src.hidden; e.target.textContent = src.hidden ? 'Show the earlier sentence' : 'Hide the earlier sentence'; } }, 'Show the earlier sentence'),
          src];
      })];
  },
  argument_graph(m) {
    const det = m.details || {};
    const out = [];
    if (det.sentences && det.edges) out.push(h('div', { class: 'd-sub', text: 'Claims and their strongest support in the Introduction' }), arcDiagram(det), h('div', { class: 'legend' },
      h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--ink-3)', height: '2px' } }), 'support comes first (built up)'),
      h('span', {}, h('span', { class: 'lg-box', style: { background: 'var(--argument)', height: '2px' } }), 'support comes after the claim (flagged)')));
    if (m.instances.length) {
      out.push(h('div', { class: 'd-sub', text: `Claims stated before their support · ${m.instances.length}` }),
        ...findingsList(m, it => [whereLine(`Sentence ${it.sentence + 1}`, it.label), h('div', { class: 'txt', text: it.text }),
          h('div', { class: 'src', text: `Supported by sentence ${it.support_sentence}: ${it.support_text}` })]));
    } else out.push(okLine('Every key claim follows the context that supports it.'));
    return out;
  },
  citation_isolation(m) {
    const det = m.details || {};
    const out = [h('div', { class: 'd-sub', text: `${det.woven ?? 0} of ${m.den} citing sentences relate works to one another` })];
    if (m.instances.length) out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text }),
      h('div', { class: 'keys' }, it.keys.map(k => h('code', { text: k }))), h('div', { class: 'where', style: { marginTop: '6px', marginBottom: 0 }, text: it.why })]));
    else out.push(okLine('Every citing sentence groups, compares, or relates its work to another.'));
    return out;
  },
  figure_exposition(m) {
    const det = m.details || {};
    const fig = det.figure || {};
    const out = [];
    if ((det.candidates || []).length > 1) out.push(figurePicker(m, 'Method figure'));
    const imgs = (fig.images || []).map(n => h('div', { class: 'fig-img' }, h('img', { src: `/api/jobs/${state.jid}/files/${n}`, alt: `Figure ${fig.number || ''}`, loading: 'lazy' })));
    const kinds = h('div', { class: 'kinds' }, (det.kinds || []).map(k => h('div', { class: 'kind' + (k.present ? ' on' : '') },
      h('span', { class: 'k-ico', text: k.present ? '✕' : '' }),
      h('div', {}, h('div', { text: k.label + (k.present ? '' : ' · not found') }), k.present && k.examples.length ? h('div', { class: 'k-ex', text: k.examples.slice(0, 3).map(e => `“${trunc(e, 50)}”`).join('  ') }) : null))));
    out.push(h('div', { class: 'fig-wrap' }, h('div', {}, imgs), h('div', {}, h('div', { class: 'd-sub', style: { marginTop: 0 }, text: `Expository kinds in Figure ${fig.number || ''}` }), kinds)));
    return out;
  },
  evidence_gap(m) {
    const det = m.details || {};
    const out = [];
    if (m.score === 0) {
      const ex = (det.exhibits || [])[0];
      out.push(okLine(`Closed: ${det.exhibit_count} concrete exhibit${det.exhibit_count === 1 ? '' : 's'} found` + (ex ? `, e.g. ${ex.where}: “${trunc(ex.snippet, 140)}”` : '.')));
    } else {
      out.push(...findingsList(m, it => [whereLine(it.section_title), h('div', { class: 'txt', text: it.text })]));
    }
    if ((det.result_tables || []).length) out.push(h('div', { class: 'd-sub', text: 'Result tables that make the measure apply' }),
      h('ul', { class: 'findings' }, det.result_tables.slice(0, 4).map(t => h('li', { class: 'finding' }, whereLine(t.section_title, `${t.rows} data rows · ${t.numeric_cells} numeric cells`), h('div', { class: 'txt', text: trunc(t.caption || t.label, 180) })))));
    return out;
  },
};
function okLine(text) {
  return h('div', { class: 'ok-line' }, h('span', { class: 'ico', style: { background: 'var(--good)' }, text: '✓' }), h('span', { text }));
}

function arcDiagram(det) {
  const n = det.sentences.length; const W = 760, H = 150, pad = 14, base = 74;
  const x = i => pad + (W - 2 * pad) * (i - 0.5) / n;
  const svg = s('svg', { class: 'arcs', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Claims and supporting sentences in the Introduction' });
  svg.append(s('rect', { class: 'tick', x: pad, y: base - 0.5, width: W - 2 * pad, height: 1 }));
  const claims = new Map((det.edges || []).map(e => [e.claim, e]));
  for (const e of det.edges || []) {
    const x1 = x(e.claim), x2 = x(e.support); const up = !e.shallow;
    const r = Math.abs(x2 - x1) / 2; const cy = up ? base - Math.min(58, r) : base + Math.min(58, r);
    svg.append(s('path', { d: `M${x1},${base} Q${(x1 + x2) / 2},${up ? base - 2 * Math.min(58, r) : base + 2 * Math.min(58, r)} ${x2},${base}`,
      fill: 'none', stroke: up ? 'var(--ink-3)' : 'var(--argument)', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: up ? 0.55 : 1 }));
    void cy;
  }
  for (let i = 1; i <= n; i++) {
    const e = claims.get(i); const lab = det.labels?.[i] || det.labels?.[String(i)] || 'other';
    const isClaim = !!e;
    const c = s('circle', { cx: x(i), cy: base, r: isClaim ? 5 : 2.5, fill: isClaim ? (e.shallow ? 'var(--argument)' : 'var(--ink)') : 'var(--ink-3)', stroke: 'var(--surface)', 'stroke-width': 2 });
    const hit = s('circle', { cx: x(i), cy: base, r: 9, fill: 'transparent', tabindex: 0 });
    bindTip(hit, `Sentence ${i}${isClaim ? ' · ' + lab.replace('_', ' ') : ''}${e ? ` · support: ${e.support}` : ''}`, trunc(det.sentences[i - 1], 260));
    svg.append(c, hit);
  }
  svg.append(s('text', { x: pad, y: H - 4, text: 'first sentence' }), s('text', { x: W - pad, y: H - 4, 'text-anchor': 'end', text: 'last sentence' }));
  return svg;
}

function figurePicker(m, label) {
  const det = m.details || {}; const fig = det.figure || {};
  const cands = det.candidates || [];
  const sel = h('select', { 'aria-label': 'Method figure' },
    fig.index == null ? h('option', { value: '', text: 'Choose a figure…', selected: true }) : null,
    cands.map(c => h('option', { value: c.index, selected: c.index === fig.index ? true : null, text: `Figure ${c.number || c.index + 1}: ${trunc(c.caption, 70)}` })));
  sel.addEventListener('change', () => { if (sel.value !== '') switchFigure(Number(sel.value), sel); });
  return h('div', { class: 'fig-pick' }, h('span', { text: label }), sel);
}

async function switchFigure(index, sel) {
  sel.disabled = true; toast('Reading the figure…');
  try {
    const r = await fetch(`/api/jobs/${state.jid}/figure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Could not re-score the figure.');
    state.job.result = d; state.sig = ''; render(state.job);
  } catch (e) { toast(e.message); sel.disabled = false; }
}

// ------------------------------------------------------------------ foot
function footCard(res) {
  const idx = res.index; const P = idx.planes || {};
  const parts = PLANES.filter(p => P[p.key]?.score != null).map(p => `${p.label} ${fmt(P[p.key].score)}`);
  const eng = res.engine || {};
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied'); }
    catch (_) { prompt('Copy this link', location.href); }
  };
  const download = () => {
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'science-slop-index.json' }); document.body.append(a); a.click(); a.remove();
  };
  return h('div', { class: 'card foot-card' },
    h('div', { class: 'formula' },
      h('div', { class: 'd-sub', style: { marginTop: 0 }, text: 'How this number is computed' }),
      h('div', { class: 'eq', text: 'S(p) = mean over planes of the mean of its measures' }),
      h('div', { class: 'calc', text: parts.length ? `${parts.join('  ·  ')}  →  ${idx.index} / 100` : 'No plane could be measured.' }),
      h('div', { class: 'engine', text: `Language model: ${eng.llm?.model || '—'} via ${eng.llm?.provider || '—'}` + (eng.llm_available ? ` · ${eng.llm_calls} calls, ${eng.llm_cached} cached` : ' · not configured') + ` · ${eng.seconds}s` })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: copy }, 'Copy link'),
      h('button', { class: 'btn ghost', type: 'button', onclick: download }, 'Download JSON'),
      h('button', { class: 'btn', type: 'button', onclick: () => { history.pushState({}, '', '/'); route(); scrollTo({ top: 0 }); } }, 'Analyze another')));
}

// ------------------------------------------------------------------ how it works
function drawBench() {
  const svg = $('#bench'); const host = svg.parentElement;
  const draw = () => {
    const W = Math.max(280, host.clientWidth - 44); const labelW = W < 420 ? 118 : 150; const rowH = 30; const top = 6; const H = top + rowH * BENCH.length + 22;
    const plotW = W - labelW - 44; const X = v => labelW + plotW * v;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.replaceChildren();
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { class: 'grid', x1: X(t), x2: X(t), y1: top, y2: top + rowH * BENCH.length }));
      svg.append(s('text', { x: X(t), y: H - 4, 'text-anchor': 'middle', text: t === 0.5 ? '0.5 chance' : String(t) }));
    }
    BENCH.forEach(([name, pa, au, ours], i) => {
      const y = top + i * rowH + 8; const bh = 14; const w = X(pa) - X(0);
      svg.append(s('text', { x: labelW - 10, y: y + 11, 'text-anchor': 'end', text: name, 'font-weight': ours ? 600 : 400 }));
      const d = `M${X(0)},${y} h${w - 4} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z`;
      const bar = s('path', { d, fill: ours ? 'var(--ink)' : 'var(--line-2)' });
      const hit = s('rect', { x: X(0), y: y - 6, width: plotW, height: rowH, fill: 'transparent' });
      bindTip(hit, `${pa.toFixed(3)} pair accuracy`, `${name} · AUROC ${au.toFixed(3)}`);
      svg.append(bar, s('text', { class: 'v', x: X(pa) + 6, y: y + 11, text: pa.toFixed(3) }), hit);
    });
  };
  draw(); new ResizeObserver(draw).observe(host);
}
function fillMeasureTable() {
  const tb = $('#measure-table tbody');
  for (const p of PLANES) for (const k of p.measures) {
    const m = MEASURES[k];
    tb.append(h('tr', {}, h('td', {}, h('span', { class: `swatch sw-${p.key}`, style: { marginRight: '8px' } }), m.name, m.method === 'LLM' ? h('span', { class: 'mono', style: { marginLeft: '6px' }, text: 'LLM' }) : null),
      h('td', { text: m.unit }), h('td', { text: m.counts }), h('td', { class: 'num', text: m.pairacc.toFixed(3) })));
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  initTheme(); initInputs(); drawBench(); fillMeasureTable();
  try {
    const r = await fetch('/api/config'); state.config = await r.json();
    if (state.config.examples?.length) { $('#example').hidden = false; $('#ex-sep').hidden = false; $('#example').title = state.config.examples[0].title; }
    if (!state.config.llm_available) {
      const n = $('#llm-notice'); n.hidden = false;
      n.textContent = 'Argument graph and Figure exposition need a language model. Set LITELLM_PROXY_API_KEY (or OPENROUTER_API_KEY) on the server to enable them.';
    }
  } catch (_) { /* the page works without config */ }
  route();
}
boot();
