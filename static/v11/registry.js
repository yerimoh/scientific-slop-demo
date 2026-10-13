// SciSlop v1.1 slop registry. Content follows v2/overview.md (2026-10-10). Card examples are real sentences from v2/verification/metric_verification_1012.md (1013); the specimen page stays constructed.
// Pictograms use the Table-1 vocabulary: coloured chip = the unit, dashed box/arrow + red x = the missing connection,
// grey card = a part of the paper, red italic caption = what the pattern looks like.
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
};
{ const btn = $('#theme'); if (btn) btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ssi-theme', JSON.stringify(next)); } catch (_) { /* ignore */ } }); }

// ------------------------------------------------------------------ pictogram kit (viewBox 100 x 41, fixed colours on a white card)
const C = { struct: '#95627A', arg: '#C97C86', art: '#5C717D', ochre: '#A2823A', sage: '#5F8A62', ink: '#3A3D42', muted: '#6E7378', hair: '#C3C7CC', card: '#FFFFFF', bad: '#C8463C', ok: '#3F9A5A', tint: '#F4F1F2' };
const AREA_C = { 1: C.arg, 2: C.struct, 3: C.art, 4: C.ochre, 5: C.sage };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FS = 4.1, DASH = 'stroke-dasharray="2.2 1.6"';
const tw = (s, fs = FS, bold) => { let w = 0; for (const ch of String(s)) w += /[iljtfr.,:;'’|!·\s()\[\]]/.test(ch) ? .3 : /[mwMW@]/.test(ch) ? .86 : /[A-Z0-9%§→–−"“”?+]/.test(ch) ? .64 : .55; return w * fs * (bold ? 1.06 : 1) + 1; }; // text width in viewBox units
const K = {
  box: (x, y, w, h, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${(o.r != null ? o.r : 1.4)}" fill="${o.fc || C.card}" stroke="${o.ec || C.hair}" stroke-width="${(o.lw != null ? o.lw : .8)}" ${o.dashed ? DASH : ''}/>`,
  text: (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.fs || FS}" fill="${o.color || C.ink}" text-anchor="${o.anchor || 'start'}" dominant-baseline="central" ${o.bold ? 'font-weight="700"' : ''} ${o.italic ? 'font-style="italic"' : ''}>${esc(s)}</text>`,
  chip: (x, y, s, o = {}) => { const fs = o.fs || FS, w = o.w || tw(s, fs), hh = o.h || 8; return K.box(x, y, w, hh, { fc: o.fc || C.card, ec: o.ec || C.struct, r: Math.min(2.4, hh / 2), dashed: o.dashed, lw: o.lw }) + K.text(x + w / 2, y + hh / 2 + .1, s, { fs, color: o.tc || C.ink, anchor: 'middle', bold: o.bold, italic: o.italic }); },
  line: (x0, y0, x1, y1, o = {}) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${o.color || C.hair}" stroke-width="${(o.lw != null ? o.lw : 1)}" stroke-linecap="round" ${o.dashed ? DASH : ''}/>`,
  lines: (x, y, w, n, o = {}) => { let s = ''; for (let i = 0; i < n; i++) s += K.line(x, y + i * (o.gap || 2.6), x + w * (i === n - 1 ? (o.last || .6) : 1), y + i * (o.gap || 2.6), { color: o.color || C.hair, lw: .9 }); return s; },
  arrow: (p0, p1, o = {}) => { // quadratic arc; rad bends like matplotlib arc3 (positive = bulge to the left of travel)
    const [x0, y0] = p0, [x1, y1] = p1, dx = x1 - x0, dy = y1 - y0, rad = o.rad || 0;
    const cx = (x0 + x1) / 2 - dy * rad, cy = (y0 + y1) / 2 + dx * rad;
    const tx = x1 - cx, ty = y1 - cy, L = Math.hypot(tx, ty) || 1, ux = tx / L, uy = ty / L, hl = 3.4, hw = 2;
    const bx = x1 - ux * hl, by = y1 - uy * hl, col = o.color || C.struct;
    return `<path d="M${x0} ${y0} Q${cx} ${cy} ${bx} ${by}" fill="none" stroke="${col}" stroke-width="${(o.lw != null ? o.lw : 1.1)}" ${o.dashed ? DASH : ''}/>` +
      (o.head === false ? '' : `<polygon points="${x1},${y1} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}" fill="${col}"/>`);
  },
  cross: (x, y, r = 3.6) => { const d = r * .45; return `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.bad}" stroke="#fff" stroke-width=".6"/><path d="M${x - d} ${y - d}L${x + d} ${y + d}M${x - d} ${y + d}L${x + d} ${y - d}" stroke="#fff" stroke-width="1" stroke-linecap="round"/>`; },
  eq: (x, y) => `<circle cx="${x}" cy="${y}" r="3.6" fill="${C.bad}" stroke="#fff" stroke-width=".6"/>` + K.text(x, y + .1, '=', { fs: 6, color: '#fff', anchor: 'middle', bold: true }),
  check: (x, y, r = 3.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.ok}" stroke="#fff" stroke-width=".6"/><path d="M${x - 1.6} ${y}L${x - .4} ${y + 1.4}L${x + 1.7} ${y - 1.5}" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`,
  caption: s => K.text(50, 31.3, s, { fs: 4.3, color: C.bad, anchor: 'middle', italic: true, bold: true }),
  card: (x, y, w, h, title) => K.box(x, y, w, h, { r: 2 }) + (title ? K.text(x + 3, y + 3.8, title, { fs: FS - .5, color: C.muted, bold: true }) : ''),
  grid: (x, y, w, h, r, c, o = {}) => { let s = K.box(x, y, w, h, { fc: o.fc || C.tint, ec: o.ec || C.art }); for (let i = 1; i < r; i++) s += K.line(x, y + h * i / r, x + w, y + h * i / r, { color: o.ec || C.art, lw: .6 }); for (let j = 1; j < c; j++) s += K.line(x + w * j / c, y, x + w * j / c, y + h, { color: o.ec || C.art, lw: .6 }); return s; },
  svg: (inner, label) => `<svg viewBox="0 0 100 28" role="img" aria-label="${esc(label)}" font-family="Inter, Lato, system-ui, sans-serif">${inner}</svg>`,
};
// scene grammar: every scene is a row of elements centred on MID; widths come from the text, so nothing overflows.
const MID = 14;
const el = (w, draw) => ({ w, draw });
const inner = {
  chip: (s, col, o = {}) => ({ w: tw(s, FS - .3, !o.outline) + 5, h: 8, draw: (x, y, w) => K.chip(x, y, s, o.outline ? { fs: FS - .3, ec: col, lw: .9, w, h: 8 } : { fs: FS - .3, fc: col, ec: col, tc: '#fff', bold: true, w, h: 8 }) }),
  text: (lines, o = {}) => ({ w: Math.max(...lines.map(l => tw(l, FS - .3, o.bold0))) + 2, h: lines.length * 5 - 1.5, draw: (x, y, w) => lines.map((l, i) => K.text(x + w / 2, y + 2 + i * 5, l, { fs: FS - .3 - (o.mute1 && i ? .6 : 0), anchor: 'middle', bold: o.bold0 && i === 0, color: o.mute1 && i ? C.muted : C.ink })).join('') }),
  lines: (n = 3) => ({ w: 26, h: n * 3 - 2, draw: (x, y, w) => K.lines(x, y + .5, w, n, { gap: 3, last: .55 }) }),
  bars: () => ({ w: 36, h: 13.5, draw: (x, y) => [['L2', 55], ['L4', 39], ['L8', 69], ['L12', 66]].map(([l, v], i) => { const bad = i === 2, bh = v * .115, bx = x + 2 + i * 8.5; return K.box(bx, y + 9 - bh, 5.5, bh, { fc: bad ? C.bad : C.art, ec: bad ? C.bad : C.art, r: .5 }) + K.text(bx + 2.75, y + 11.8, l, { fs: FS - 1.1, anchor: 'middle', color: C.muted }) + (bad ? K.text(bx + 2.75, y + 9 - bh - 2.2, v, { fs: FS - 1, anchor: 'middle', color: C.bad, bold: true }) : ''); }).join('') }),
};
const E = {
  chip: (s, col) => { const w = tw(s, FS, true) + 6; return el(w, x => K.chip(x, MID - 4.75, s, { fc: col, ec: col, tc: '#fff', bold: true, w, h: 9.5 })); },
  say: (s, col) => { const w = tw(s, FS) + 6; return el(w, x => K.chip(x, MID - 4.75, s, { fc: C.card, ec: col, tc: C.ink, italic: true, w, h: 9.5, lw: .9 })); },
  ask: lines => { const hh = lines.length > 1 ? 14 : 9.5, w = Math.max(...lines.map(l => tw(l, FS))) + 7; return el(w, x => K.box(x, MID - hh / 2, w, hh, { dashed: true, ec: C.muted, lw: .9, r: 1.8 }) + lines.map((l, i) => K.text(x + w / 2, MID + (i - (lines.length - 1) / 2) * 5, l, { color: C.muted, anchor: 'middle', italic: true })).join('')); },
  card: (title, c, o = {}) => { const w = Math.max(c.w, tw(title, FS - .5, true) + 2) + 6, hh = 7 + c.h + (o.lines === false ? 3.5 : 5.5); return el(w, x => { const y = MID - hh / 2; return K.card(x, y, w, hh, title) + c.draw(x + 3, y + 7, w - 6) + (o.lines === false ? '' : K.lines(x + 3, y + hh - 3, w - 6, 1, { last: .55 })); }); },
  para: (title, s, col, o = {}) => { const cw = tw(s, FS - .3, !o.box) + 5, w = cw + 22, hh = 23; return el(w, x => { const y = MID - hh / 2; return K.card(x, y, w, hh, title) + K.lines(x + 3, y + 7.5, w - 6, 1) + (o.box ? K.box(x + 3, y + 10, cw, 7.5, { fc: C.tint, ec: col }) + K.text(x + 3 + cw / 2, y + 13.85, s, { fs: FS - .3, anchor: 'middle' }) : K.chip(x + 3, y + 10, s, { fs: FS - .3, fc: col, ec: col, tc: '#fff', w: cw, h: 7.5 })) + K.lines(x + 3, y + 20, w - 6, 1, { last: .5 }) + K.cross(x + 3 + cw, y + 13.75, 3.2); }); },
  miss: (col, o = {}) => el(17, x => (o.left ? K.arrow([x + 17, MID], [x, MID], { color: col, dashed: !o.solid }) : K.arrow([x, MID], [x + 17, MID], { color: col, dashed: !o.solid })) + K.cross(x + 8.5, MID)),
  eq: () => el(15, x => K.line(x, MID, x + 15, MID, { lw: 1 }) + K.eq(x + 7.5, MID)),
  clash: () => el(11, x => K.cross(x + 5.5, MID)),
};
const row = (els, gap = 2) => {
  const total = els.reduce((a, e) => a + e.w, 0) + gap * (els.length - 1), k = Math.min(1, 95 / total);
  let x = 50 - total / 2, s = '';
  for (const e of els) { s += e.draw(x); x += e.w + gap; }
  return k < 1 ? `<g transform="translate(50 ${MID}) scale(${k.toFixed(3)}) translate(-50 ${-MID})">${s}</g>` : s;
};
// one scene per item
const PIC = {
  '1-1': () => row([E.chip('near-low-k cost', C.arg), E.miss(C.arg), E.ask(['measured where?'])]),
  '1-2': () => row([E.card('tested', inner.chip('2 tasks: VT, MQ', C.arg, { outline: true })), E.miss(C.arg, { solid: true }), E.chip('all diffuse tasks', C.arg)]),
  '1-3': () => row([E.card('§4 Results', inner.text(['20 poisoned demos', 'ASR 18%']), { lines: false }), E.miss(C.arg), E.ask(['one demonstration?', 'one target action?'])]),
  '1-4': () => { const cw = tw('SparseVLM', FS - .3) + 6, ow = tw('ours', FS, true) + 8, gap = 22, total = cw + gap + ow, x0 = 50 - total / 2, xo = x0 + cw + gap;
    return K.chip(x0, MID - 10.5, 'FEATHER', { fs: FS - .3, ec: C.arg, lw: .9, w: cw, h: 8 }) + K.chip(x0, MID - 1, 'SparseVLM', { fs: FS - .3, ec: C.arg, lw: .9, w: cw, h: 8 }) + K.text(x0 + cw / 2, MID + 10.3, '+ 6 more, listed', { fs: FS - .8, color: C.muted, anchor: 'middle' }) +
      K.chip(xo, MID - 6.25, 'ours', { fc: C.arg, ec: C.arg, tc: '#fff', bold: true, w: ow, h: 9.5 }) +
      K.arrow([x0 + cw, MID - 6.5], [xo - .5, MID - 3], { color: C.arg, dashed: true, rad: -.1 }) + K.arrow([x0 + cw, MID + 3], [xo - .5, MID], { color: C.arg, dashed: true, rad: .1 }) + K.cross(x0 + cw + gap / 2, MID - 5.5) + K.cross(x0 + cw + gap / 2, MID + 2.5); },
  '2-1': () => row([E.card('Abstract', inner.chip('46% · 93% kept', C.struct, { outline: true })), E.miss(C.struct, { left: true }), E.card('§4 Results', inner.chip('MQ: 12.1 → 3.65', C.struct))]),
  '2-2': () => { const q = 'Does A help with little data?', qw = tw(q, FS - .2, true) + 6, labs = ['+3.1 @ 1k', '−A: gain lost', 'gap→0 @ 100k'], ws = labs.map(l => tw(l, FS - .5) + 5), total = ws.reduce((a, b) => a + b, 0) + 2 * 3; let x = 50 - total / 2, s = K.chip(50 - qw / 2, 2, q, { fc: C.struct, ec: C.struct, tc: '#fff', bold: true, fs: FS - .2, w: qw, h: 8 });
    labs.forEach((l, i) => { const cx = x + ws[i] / 2; s += K.box(x, 19.5, ws[i], 8, { r: 1.6 }) + K.text(cx, 23.6, l, { fs: FS - .5, anchor: 'middle' }) + K.arrow([cx, 19.5], [50 + (i - 1) * 9, 10.2], { color: C.struct, dashed: true, rad: (i - 1) * -.1 }); x += ws[i] + 3; });
    return s + K.cross(50, 14.8); },
  '2-3': () => row([E.card('§3 Method', inner.lines(3)), E.miss(C.struct, { left: true }), E.card('Table 3', inner.chip('Phase-0 analysis', C.struct))]),
  '3-1': () => row([E.chip('layer 12 of 32', C.art), E.miss(C.art), E.ask(['why 12?'])]),
  '4-1': () => row([E.para('§1 Introduction', 'this holds exciting promise …', C.struct)]),
  '4-2': () => row([E.chip('retrieval rate', C.art), E.miss(C.art), E.ask(['= ?'])]),
  '4-3': () => row([E.para('§4.1 Data', 'folder layout · renamed files · scratch dirs', C.struct, { box: true })]),
  '4-4': () => row([E.card('§4 · a line above', inner.chip('SRE, not attention', C.struct)), E.eq(), E.card('§4 · two lines below', inner.chip('SRE, not attention', C.struct))]),
  '4-5': () => row([E.card('Figure 1', inner.bars(), { lines: false }), E.miss(C.art), E.ask(['L8 in the text?'])]),
  '5-1': () => row([E.chip('limits deployment flexibility', C.arg), E.miss(C.arg), E.ask(['where', 'does it fail?'])]),
  '5-2': () => row([E.chip('H2O prunes high-attn tokens', C.arg), E.clash(), E.card('H2O in §2', inner.text(['keeps them', 'same paper'], { bold0: true, mute1: true }), { lines: false })]),
  '5-3': () => row([E.card('Table 4', inner.text(['AUROC 1.0 → 1.0', 'ASR 40.7 → 42.4']), { lines: false }), E.miss(C.arg), E.say('a fundamental trade-off', C.arg)]),
  '5-4': () => row([E.chip('0.3, "typically considered"', C.arg), E.miss(C.arg), E.ask(['by whom?', '[ ? ]'])]),
};
// what the pattern looks like, one line under each scene
const CAP = { '1-1': 'a claim with nothing behind it', '1-2': 'claim wider than its evidence', '1-3': 'numbers only, no example', '1-4': 'cited, related to nothing', '2-1': 'the bad news never reaches the front', '2-2': 'results never meet the question', '2-3': 'a name that points at nothing', '3-1': 'a choice with no reason', '4-1': 'delete it and nothing is lost', '4-2': 'a term with no meaning', '4-3': 'detail the reader never needs', '4-4': 'six places, one finding', '4-5': 'a result only the figure reports', '5-1': 'important, but never shown', '5-2': 'the contrast is not true', '5-3': 'nothing moved, yet it explains', '5-4': 'a source that is not there' };
// hero: a paper spine with the five kinds of broken connection
function heroSvg() {
  const secs = [['Abstract', 4], ['Introduction', 42], ['Method', 80], ['Experiments', 118], ['Conclusion', 156]];
  let s = '';
  for (const [t, x] of secs) s += K.card(x, 24, 34, 22, t) + K.lines(x + 3, 31, 28, 4, { gap: 3, last: .6 });
  s += K.chip(45, 34, 'important!', { fs: 2.9, fc: C.sage, ec: C.sage, tc: '#fff', w: 20, h: 5.4 }) + K.cross(66, 34.5, 2.2);
  s += K.chip(83, 34, 'why 512?', { fs: 2.9, fc: C.art, ec: C.art, tc: '#fff', w: 18, h: 5.4 }) + K.cross(102, 34.5, 2.2);
  s += K.chip(83, 40.5, 'anchoring = ?', { fs: 2.9, fc: C.ochre, ec: C.ochre, tc: '#fff', w: 24, h: 5.4 });
  s += K.chip(121, 34, 'robust to noise', { fs: 2.9, fc: C.arg, ec: C.arg, tc: '#fff', w: 26, h: 5.4 });
  s += K.arrow([134, 34], [134, 14], { color: C.arg, dashed: true }) + K.box(124, 6, 24, 8, { dashed: true, ec: C.muted }) + K.text(136, 10.2, 'evidence', { fs: 2.9, color: C.muted, anchor: 'middle', italic: true }) + K.cross(134, 24, 2.2);
  s += K.arrow([21, 24], [135, 24], { color: C.struct, dashed: true, rad: .22, head: true }) + K.cross(78, 10, 2.2) + K.text(78, 4.5, 'finding never reaches the front', { fs: 2.9, color: C.bad, anchor: 'middle', italic: true });
  return `<svg viewBox="0 0 194 50" role="img" aria-label="A paper's sections with the connections that fail" font-family="Inter, Lato, system-ui, sans-serif">${s}</svg>`;
}

// ------------------------------------------------------------------ content
const AREAS = [
  { n: 1, cls: 'a1', short: 'Claims', title: 'Claims and evidence', q: 'What backs each claim, and can the reader check it?' },
  { n: 2, cls: 'a2', short: 'Connections', title: 'Connections across the paper', q: 'Do the parts connect so the reader can follow the study from question to conclusion?' },
  { n: 3, cls: 'a3', short: 'Choices', title: 'Research choices', q: 'Can the reader see why the choices that affect validity were made?' },
  { n: 4, cls: 'a4', short: 'Delivery', title: 'Conveying information', q: 'Do sentences, terms, length, and figures deliver what the reader needs?' },
  { n: 5, cls: 'a5', short: 'Rhetoric', title: 'Rhetoric in place of evidence', q: 'When a sentence sounds like a reason, a comparison, an interpretation, or evidence, is the content actually there?' },
];
const ITEMS = [
  { id: '1-1', area: 1, v1: 'Argument graph', name: 'Unsupported Claims', what: 'A claim is stated as a result, and nothing in the paper backs it.',
    ex: { spec: 'our method is robust to label noise', specnote: 'Every experiment uses clean labels. No noise study, no proof, no citation.', src: 'AI paper · SciSlopBench FA0083 · §3 Method', pre: '', mark: 'This achieves near-high-k robustness at near-low-k average cost.', post: '', note: 'No cost, latency or compute is measured anywhere in the paper.' },
    judge: ['Decide what support this claim needs: an experiment, a proof, or a citation.', 'Look for it in the body, the appendix, and the supplement.', 'A claim too vague to pin down is logged separately, not as unsupported.'],
    not: ['Marked as a hypothesis or future work.', 'Backed by a proof, a citation, or an appendix result.'],
    fix: ['Connect the real support, or shrink the claim to it.', 'Not a fix: unrelated citations, invented runs, deleting the contribution.'],
    borders: [['5-4', 'support is described, but wrongly'], ['1-2', 'support exists, claim exceeds it']] },
  { id: '1-2', area: 1, v1: 'Argument graph', name: 'Overstated Claims', what: 'Support exists, but the claim reaches past it in scope, strength, or certainty.',
    ex: { spec: 'Our method consistently outperforms baselines across domains', specnote: 'Gains appear only in the few-shot setting on CIFAR-10. One dataset, one condition.', src: 'AI paper · SciSlopBench FA0002 · §1 Introduction', pre: 'Task-dependent analysis: ', mark: 'Diffuse-dependency tasks (Variable Tracking) benefit substantially from adaptive sizing, while distributed-information tasks (Multi-Query NIAH) require higher budgets', post: ', revealing a structural limit on cache reduction.', note: 'Two tasks were run, one per “class”. The classes are never defined, and no other task in either class is tested.' },
    judge: ['Compare claim and support on four axes: scope, conditions, effect and direction, certainty.', 'Observed, statistical, or causal are three different claims.', 'A strong adjective by itself decides nothing.'],
    not: ['Scope clear from context.', 'A generalization stated as a hypothesis after the verified range.'],
    fix: ['State the evaluated range and the uncertainty.', 'Not a fix: deleting “significantly” while keeping “across domains”.'],
    borders: [['1-1', 'no support at all'], ['5-3', 'observation turned into mechanism'], ['5-4', 'evidence described wrongly']] },
  { id: '1-3', area: 1, name: 'Missing Examples', v1: 'Evidence gap', what: 'The reader needs a concrete case to see what a claim means, and none is shown.',
    ex: { spec: 'meaning reversals', specnote: 'Definitions and counts only. No input, reference, or output is ever shown.', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments', pre: '', mark: 'We inject 20 poisoned demonstrations into the StrategyQA knowledge base', post: ' (9,251 entries total).', note: 'No poisoned demonstration, trigger context or target action is ever shown. The reader cannot tell what the attack makes the agent do.' },
    judge: ['Which claims or phenomena need an example?', 'Is a real input and output, an observed case, or a visualization given for it?', 'Relevance counts, not the number of examples.'],
    not: ['Checkable from definitions, proofs, or numbers alone.', 'Examples in the appendix or the supplement.'],
    fix: ['Show real cases from the study.', 'Not a fix: invented examples presented as observations.'],
    borders: [['1-1', 'missing examples is not missing all evidence']] },
  { id: '1-4', area: 1, name: 'Unclear Links to Prior Work', v1: 'Citation isolation', what: 'Prior work is cited, but how it relates to this study is never said.',
    ex: { spec: 'We propose C.', specnote: 'Does C follow A or B? Which limitation does it address? What differs? Not said.', src: 'AI paper · SciSlopBench FA0280 · §2 Related Work', pre: 'SparseVLM introduces text-aware sparsification that conditions token selection on the input query, and ', mark: 'FEATHER revisits pruning strategies with improved layer selection.', post: '', note: 'The paragraph lists eight pruning methods and never says how this paper relates to any of them. FEATHER also picks layers, which is this paper’s whole idea.' },
    judge: ['Does the citing passage explain the role of that work?', 'Relations among prior works are logged apart from relations to this study.', 'Judge when a relation needed to place the study is missing.'],
    not: ['Citations for background facts or standard tools.', 'The relation explained in another paragraph.'],
    fix: ['Explain the actual difference, inheritance, or limitation.', 'Not a fix: adding “Unlike prior work”; deleting citations.'],
    borders: [['5-2', 'a difference is stated but does not hold']] },

  { id: '2-1', area: 2, name: 'Buried Findings', what: 'The body’s key finding never reaches the Abstract or Introduction.',
    ex: { spec: 'a novel attention mechanism that improves performance', specnote: '§4.2 shows the gain comes almost entirely from sentences with negation. The front matter never says so.', src: 'AI paper · SciSlopBench FA0002 · §4 Experiments', pre: 'On Multi-Query, ', mark: 'we achieve 70% reduction but with larger accuracy loss (3.65% vs. 12.10%)', post: ', indicating that distributed-information tasks inherently require higher cache coverage.', note: 'The abstract reports only the favorable task (46% cache reduction, 93% of accuracy kept). The accuracy collapse on the other task never reaches it.' },
    judge: ['Pick the key findings from the research question and the main results.', 'Is the finding’s meaning and its condition conveyed, not just a number?'],
    not: ['Detailed numbers or side analyses left to the body.', 'An accurate summary at a higher level.'],
    fix: ['Bring the finding and its condition to the front.', 'Not a fix: adding one number; turning an association into a mechanism.'],
    borders: [['1-2', 'the omission lets the claim exceed its support']] },
  { id: '2-2', area: 2, name: 'Disconnected Experiments', what: 'Several results must be read together to answer the question, and no sentence connects them.',
    ex: { made: true, src: 'Constructed example · no instance in the three verified pairs', sec: '§4 Experiments', pre: '§4.1: +3.1 with 1k examples. §4.2: removing A loses the gain. §4.3: the gap shrinks at 100k. ', mark: 'Each subsection ends with its own score.', post: '', note: 'The question was “does A help with little data?” The three results answer it together. No sentence does.' },
    judge: ['Map the question, each experiment’s role, and where results must be read together.', 'Judge when the results are there but the link is not.', 'Reference counts and section order decide nothing.'],
    not: ['Independent claims, each verified on its own.', 'Experiments in an unusual order.'],
    fix: ['Say what each result contributes to the question.', 'Not a fix: “Together, these results demonstrate…” with no reasoning.'],
    borders: [['1-1', 'a needed experiment is absent'], ['1-2', 'the conclusion exceeds the results']] },
  { id: '2-3', area: 2, name: 'Missing Cross-Section Links', v1: 'Cross-section references', what: 'One section needs a definition or result from another, and the reader cannot match them.',
    ex: { spec: 'w/o regularization 68.0', specnote: '§3 defines two losses, L_a and L_b. Which one was removed? The text never says.', src: 'AI paper · SciSlopBench FA0280 · §4 Experiments', pre: 'Table 3 presents diagnostic metrics from our ', mark: 'Phase-0 analysis', post: ' on 30 COCO images with 5 prompt templates (150 forward passes).', note: '“Phase-0” is named nowhere else. Nothing in the method section corresponds to it.' },
    judge: ['Find the spots that depend on information elsewhere.', 'Can the reader confirm the correspondence? Consistent naming counts as a link.'],
    not: ['A figure or table that works in place.', 'A clear correspondence without a numbered reference.'],
    fix: ['Name the actual counterpart.', 'Not a fix: extra references to unrelated tables.'],
    borders: [['2-2', 'how results are read, not where they sit']] },

  { id: '3-1', area: 3, name: 'Unexplained Design Choices', what: 'A choice that affects validity is made, and no reason is given.',
    ex: { spec: 'Inputs longer than 512 tokens are excluded.', specnote: 'The method is sold for long inputs. Why exclude them, and what does that do to the evaluation?', src: 'AI paper · SciSlopBench FA0280 · §3 Method', pre: 'Our approach is straightforward: ', mark: 'extract attention weights from layer 12 (out of 32 LLM layers in InternVL2.5-8B)', post: ' and apply MIS selection directly without any debiasing.', note: 'Why layer 12 is never said, and no comparison across layers appears in the text. The overview figure shows an L8 bar that beats L12 and is reported nowhere.' },
    judge: ['Prioritize choices that affect the conclusion: architecture, data, comparisons, metrics.', 'Does the stated reason connect to this choice? “For efficiency” alone does not.', 'Keep apart: value unknown (reproducibility) and reason unknown (this item).'],
    not: ['A standard setting with a source.', 'Minor settings that do not touch the core claims.'],
    fix: ['Give the real rationale, constraint, or comparison.', 'Not a fix: inventing alternatives that were never run.'],
    borders: [['5-1', 'the problem itself is unmotivated']] },

  { id: '4-1', area: 4, name: 'Generic Filler', what: 'Stock prose that says nothing about this study and does no work.',
    ex: { spec: 'Our innovative framework unlocks new possibilities and addresses important challenges.', specnote: 'Delete it and nothing is lost. Which possibilities? Which challenges? Never specified.', src: 'Human paper · LoLCATs, arXiv 2410.10254 · §1 Introduction', pre: '', mark: 'This holds exciting promise for quickly scaling up subquadratic capabilities.', post: '', note: 'The two sentences before it already say what the promise is. Delete this one and nothing is lost.' },
    judge: ['What information or function is lost if the sentence goes?', '“Could be pasted into any paper” finds candidates; it is not the verdict.'],
    not: ['Needed background or standard definitions.', 'A short pointer to what comes next.'],
    fix: ['Delete it, or replace it with the study’s content.', 'Not a fix: inserting model and dataset names.'],
    borders: [['5-1', 'importance stands in for motivation'], ['4-4', 'repeated rather than empty']] },
  { id: '4-2', area: 4, name: 'Undefined Terms', what: 'A term the reader needs is never given a meaning.',
    ex: { spec: 'semantic anchoring', specnote: 'No definition, equation, citation, or example says what semantic anchoring does.', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments', pre: 'This occurs because LLaMA-3.1-8B-Instruct has a ', mark: 'low retrieval rate (<14%)', post: ', limiting the effectiveness of consensus-based validation.', note: '“Retrieval rate” explains the paper’s main negative result. It is never defined, and no table reports it.' },
    judge: ['Fix the intended reader and field.', 'Can the meaning be recovered from context, equations, or a cited definition?', 'Several names for one thing is a naming inconsistency, logged separately.'],
    not: ['Standard terms in their usual sense.', 'Meaning clear from an equation.'],
    fix: ['Explain the operation, object, or role.', 'Not a fix: expanding an acronym; swapping in another abstract word.'] },
  { id: '4-3', area: 4, name: 'Irrelevant Detail', what: 'Detail that helps no one understand, check, or reproduce the study.',
    ex: { made: true, src: 'Constructed example · no instance in the three verified pairs', sec: '§4.1 Data', pre: 'After tokenization, ', mark: 'we reorganized the working directory, renamed intermediate files by date, and merged two scratch folders', post: ' before training.', note: 'None of this affects a result. It buries the preprocessing steps that do.' },
    judge: ['Would removing it lose anything needed to understand, check, or reproduce?', 'Keep needed method and data detail even when it is off the core contribution.', 'Section-length balance decides nothing.'],
    not: ['Preprocessing and collection details needed to reproduce.', 'Information about failure conditions.'],
    fix: ['Remove content with no role; keep what reproduction needs.', 'Not a fix: cutting reproduction detail to shorten.'],
    borders: [['4-4', 'the same content again'], ['4-1', 'empty rather than extra']] },
  { id: '4-4', area: 4, name: 'Redundant Repetition', v1: 'Macro redundancy', what: 'Content is said again with no new information and no summary role.',
    ex: { spec: 'In other words, our approach achieves higher scores than every compared method on the two benchmarks.', specnote: 'Same comparison, new words, no new analysis.', src: 'AI paper · SciSlopBench FA0002 · §4 Experiments', pre: '', mark: 'This validates the theoretical motivation: SRE directly measures the approximation gap, not just attention statistics.', post: '', note: 'The sentence two lines above says the same. So do the abstract, the introduction, the related work and the conclusion: six places, one finding.' },
    judge: ['Match the repeat to the original. What does the later passage add?', 'Different wording still counts.', '8-gram overlap only finds candidates.'],
    not: ['The Abstract, the contribution list, a needed recap in the Conclusion.', 'A brief reminder of a key definition.'],
    fix: ['Cut it, or put the missing analysis there.', 'Not a fix: paraphrase.'],
    borders: [['4-1', 'empty regardless of repetition'], ['4-3', 'extra detail']] },
  { id: '4-5', area: 4, name: 'Unclear Figures', v1: 'Figure exposition', what: 'A figure’s parts and relations cannot be read from the figure, its caption, or the text.',
    ex: { spec: 'Overview of the proposed framework.', specnote: 'Which arrows carry data and which carry gradients? What do the colors mean? Nothing says.', src: 'AI paper · SciSlopBench FA0280 · Figure 1, text inside the figure', pre: 'Key Insight: Deeper Layers = Better Token Selection · ', mark: 'L2 55% · L4 39% · L8 69% · L12 66%', post: '', note: 'The L8 result appears in no table or sentence, and it is higher than the layer the paper chose. The L2 bar is D²Pruner with debiasing, not raw L2.' },
    judge: ['Fix the figure’s purpose first.', 'Can the needed elements, symbols, axes, and flows be read from the figure plus its explanation?', 'Decoration count and caption length decide nothing.'],
    not: ['A short caption whose meaning is clear from the legend and text.', 'A simplified overview whose detail is clearly located.'],
    fix: ['Explain the notation and tie it to the method.', 'Not a fix: a longer caption; deleting the figure.'] },

  { id: '5-1', area: 5, v1: 'Argument graph', name: 'Unexplained Importance', link: ['a concrete problem or gap', 'why it is worth studying'], what: 'Something is called important, but which problem, and why it matters, is never said.',
    ex: { spec: 'Existing models face important challenges. Addressing these challenges is essential for future progress.', specnote: 'Which challenge? What fails, for whom? The rest of the paper gives only the architecture and the scores.', src: 'AI paper · SciSlopBench FA0280 · §1 Introduction', pre: 'However, this offline calibration requirement limits deployment flexibility: ', mark: 'the prior may not transfer across domains, prompt styles, or model updates.', post: '', note: 'This is the whole motivation for the paper’s second contribution. The transfer failure is never shown, on any domain or prompt.' },
    judge: ['Map: the thing called important → its concrete problem → the reason to study it.', 'A theoretical question counts as a reason; practical cost is not required.', '“Crucial” and “pivotal” decide nothing.'],
    not: ['A brief recall of a known problem, then a concrete question.', 'Motivation given by the body or the cited literature.'],
    fix: ['Say which question or constraint is addressed and why it matters.', 'If motivation already exists, just delete the stock line.', 'Not a fix: swapping adjectives; inventing numbers.'],
    borders: [['4-1', 'motivation exists elsewhere, the line is just empty'], ['3-1', 'the problem is clear, a design choice is not'], ['5-3', 'importance inferred from results']] },
  { id: '5-2', area: 5, v1: 'Argument graph', name: 'Unsupported Comparisons', link: ['what the compared method actually does', 'the difference claimed'], what: 'A difference from other methods is claimed, and the target is unclear or the difference is not true.',
    ex: { spec: 'Unlike baselines A and B, which assign fixed weights to all inputs,', specnote: 'The paper’s own equations for A and B compute weights from the input too. The contrast does not hold.', src: 'AI paper · SciSlopBench FA0002 · §1 Introduction', pre: 'This is fundamentally different from attention-based methods like H2O, ', mark: 'which prune high-attention tokens', post: '; we prune tokens with low approximation error.', note: 'The paper’s own related work says H2O keeps the high-attention tokens and drops the rest. The contrast is with a method that does not exist.' },
    judge: ['Log the target, the compared property, and the claimed property; check each.', 'A structural difference is checked in the equations; a performance difference needs an evaluation.', 'The target may be named by citation, name, definition, or context.'],
    not: ['A structural difference confirmed by the equations.', 'A contrast with a standard setting that is clear from context.'],
    fix: ['Name the target and the property precisely, or withdraw the distinction and align the Abstract and conclusion.', 'Not a fix: deleting “unlike”; attaching unrelated citations.'],
    borders: [['1-4', 'the relation is never explained'], ['1-2', 'the difference holds but is inflated']] },
  { id: '5-3', area: 5, v1: 'Argument graph', name: 'Unsupported Interpretations', link: ['the observed result', 'what it is said to mean'], what: 'A result is given a meaning, a cause or a mechanism, that nothing in the paper supports.',
    ex: { spec: 'demonstrating that the model learns to align semantic structure across languages.', specnote: 'The table shows +1.8. Nothing checks alignment or rules out other causes.', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments', pre: 'LDA detection remains perfect (AUROC=1.0) against the adaptive attack, while the attack’s effectiveness is unchanged (ASR 40.68% → 42.37%). ', mark: 'This robustness stems from a fundamental trade-off: reducing the uniqueness weight makes triggers less detectable but also reduces their retrieval effectiveness.', post: '', note: 'The sentence before it says neither side moved: detection stayed perfect and the attack stayed as effective. The trade-off is asserted against the paper’s own table.' },
    judge: ['Separate the observation from the added interpretation.', 'What assumption or evidence does the step need, and is it anywhere in the paper?', 'Not measured directly is not a defect; sound inference is accepted.', 'Same standard for captions and conclusions.'],
    not: ['A summary within the observed range.', 'A mechanism backed by another analysis.', 'A possibility marked as unverified.'],
    fix: ['Limit the interpretation to what the results allow, or supply the support.', 'If it is withdrawn, fix the Abstract and Conclusion too.', 'Not a fix: “demonstrating” → “suggesting” with the same conclusion.'],
    borders: [['1-2', 'same property, inflated'], ['1-1', 'no link to results at all'], ['2-2', 'no joint reading of experiments']] },
  { id: '5-4', area: 5, v1: 'Argument graph', name: 'Misrepresented Evidence', link: ['the evidence as described', 'the actual source or experiments'], what: 'The paper says evidence exists, and the evidence does not say that.',
    ex: { spec: 'Prior studies established that update rule A converges under adaptive step sizes [12].', specnote: 'The theorem in [12] covers fixed step sizes only. Nothing extends it.', src: 'AI paper · SciSlopBench FA0280 · §4 Experiments', pre: 'All values are well below ', mark: 'the 0.3 threshold typically considered indicative of meaningful positional bias.', post: '', note: 'No source for the threshold, and none for who considers it. The paper’s central diagnostic rests on it.' },
    judge: ['Check four things against the material: existence, content, scope, consensus.', '“Extensive”, “numerous”, and citation counts are not the criterion.', 'Source unreachable means undecidable, not a defect.'],
    not: ['A citation that describes its source and conditions accurately.', 'A single survey backing a consensus statement.'],
    fix: ['Describe what the support actually shows.', 'If a support statement goes, recheck the remaining claim.', 'Not a fix: more citations; deleting “extensive”.'],
    borders: [['1-1', 'no support is claimed at all'], ['1-2', 'range reported right, then generalized'], ['5-2', 'a misdescribed comparison target']] },
];
// Definitions tab text, 1013: one plain definition, one or two real sentences (the second shows where the support should be), two-sentence note.
const DEF = {
  '1-1': { what: 'The paper states a result and never shows the experiment, proof, or source behind it.',
    q: [{ pre: '', mark: 'This achieves near-high-k robustness at near-low-k average cost.', post: '', src: 'AI paper · SciSlopBench FA0083 · §3 Method' }],
    note: '“Cost” promises a measurement: latency, compute, or memory. No table or figure in the paper measures any of them, so the sentence is the only evidence for itself.' },
  '1-2': { what: 'The paper has evidence for a small claim and makes a bigger one.',
    q: [{ pre: 'We focus on ', mark: 'two tasks', post: ' that stress recall.', src: 'AI paper · SciSlopBench FA0002 · §4 Experiments' },
        { pre: 'Task-dependent analysis: ', mark: 'Diffuse-dependency tasks (Variable Tracking) benefit substantially from adaptive sizing, while distributed-information tasks (Multi-Query NIAH) require higher budgets', post: ', revealing a structural limit on cache reduction.', src: 'Same paper · §1 Introduction' }],
    note: 'Two tasks were run, one of each kind. From one task each, the introduction states a rule for whole classes of tasks, and never says what else belongs to a class.' },
  '1-3': { what: 'The paper describes something it did and never shows one actual case of it.',
    q: [{ pre: 'We inject ', mark: '20 poisoned demonstrations', post: ' into the StrategyQA knowledge base (9,251 entries total).', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments' }],
    note: 'The whole attack is these demonstrations: what one looks like, which query triggers it, what the agent then does. None of the three is shown anywhere, so the reader never sees what the attack is.' },
  '1-4': { what: 'The paper cites related work and never says how its own work differs from it.',
    q: [{ pre: 'SparseVLM introduces text-aware sparsification that conditions token selection on the input query, and ', mark: 'FEATHER revisits pruning strategies with improved layer selection.', post: '', src: 'AI paper · SciSlopBench FA0280 · §2 Related Work' },
        { pre: 'Our approach is straightforward: ', mark: 'extract attention weights from layer 12', post: ' (out of 32 LLM layers in InternVL2.5-8B) and apply MIS selection directly without any debiasing.', src: 'Same paper · §3 Method' }],
    note: 'FEATHER’s contribution is choosing the layer, and choosing the layer is this paper’s whole method. The related-work paragraph lists FEATHER with seven other methods and never says what this paper does differently.' },
  '2-1': { what: 'The results have a bad side, and the abstract tells only the good side.',
    q: [{ pre: 'On RULER long-context benchmarks, our method achieves ', mark: '46% cache reduction on Variable Tracking while preserving 93% baseline accuracy', post: ' (16.52% vs. 17.72%).', src: 'AI paper · SciSlopBench FA0002 · Abstract' },
        { pre: 'On Multi-Query, we achieve 70% reduction but with ', mark: 'larger accuracy loss (3.65% vs. 12.10%)', post: ', indicating that distributed-information tasks inherently require higher cache coverage.', src: 'Same paper · §4 Experiments' }],
    note: 'Read the abstract and the method works. Read §4 and on the second task accuracy falls to a third. The abstract never mentions the second task.' },
  '2-2': { what: 'The paper runs several experiments that answer one question together, and never puts them together.',
    q: [{ pre: '§4.1: +3.1 with 1k examples. §4.2: removing A loses the gain. §4.3: the gap shrinks at 100k. ', mark: 'Each subsection ends with its own score.', post: '', src: 'Constructed example · no instance in the three verified pairs' }],
    note: 'The question was whether A helps when data are scarce. The three results say yes, and only then, and no sentence in the paper says it.' },
  '2-3': { what: 'One section refers to something in another section by a name the other section never uses.',
    q: [{ pre: 'Table 3 presents diagnostic metrics from our ', mark: 'Phase-0 analysis', post: ' on 30 COCO images with 5 prompt templates (150 forward passes).', src: 'AI paper · SciSlopBench FA0280 · §4 Experiments' },
        { pre: '', mark: 'Diagnostic analysis on 30 COCO images with 5 prompt templates', post: ' revealed that shallow-layer attention in InternVL2.5-8B is highly prompt-stable but exhibits weak positional bias.', src: 'Same paper · §3 Method' }],
    note: 'The two sentences describe the same analysis. “Phase-0” appears only in §4, so the reader has to guess that they match.' },
  '3-1': { what: 'The paper makes a choice its results depend on and gives no reason for it.',
    q: [{ pre: 'Our approach is straightforward: extract attention weights from ', mark: 'layer 12 (out of 32 LLM layers in InternVL2.5-8B)', post: ' and apply MIS selection directly without any debiasing.', src: 'AI paper · SciSlopBench FA0280 · §3 Method' },
        { pre: 'Key Insight: Deeper Layers = Better Token Selection · L2 55% · L4 39% · ', mark: 'L8 69% · L12 66%', post: '', src: 'Same paper · Figure 1, text inside the figure' }],
    note: 'The method is the choice of layer, and the paper never says why 12. Its own figure shows layer 8 scoring higher, and the text never mentions it.' },
  '4-1': { what: 'A sentence says nothing about this study and could be deleted without loss.',
    q: [{ pre: 'Linearizing aims to start with openly available LLMs … and (i) swap their softmax attentions with subquadratic analogs, before (ii) further finetuning to recover quality. ', mark: 'This holds exciting promise for quickly scaling up subquadratic capabilities.', post: '', src: 'Human paper · LoLCATs, arXiv 2410.10254 · §1 Introduction' }],
    note: 'The sentence before already says what the promise is: cheaper models of the same quality. The marked sentence adds only “exciting”, and deleting it loses nothing.' },
  '4-2': { what: 'The paper leans on a term it never defines.',
    q: [{ pre: 'This occurs because LLaMA-3.1-8B-Instruct has a ', mark: 'low retrieval rate (<14%)', post: ', limiting the effectiveness of consensus-based validation.', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments' }],
    note: 'The paper’s main negative result is explained by this number. “Retrieval rate” is never defined and no table reports it, so the reader cannot tell what 14% is a share of.' },
  '4-3': { what: 'The paper spends words on details that help no one understand, check, or repeat the study.',
    q: [{ pre: 'After tokenization, ', mark: 'we reorganized the working directory, renamed intermediate files by date, and merged two scratch folders', post: ' before training.', src: 'Constructed example · no instance in the three verified pairs' }],
    note: 'None of this changes a result. It sits between the preprocessing steps that do, and hides them.' },
  '4-4': { what: 'The paper says the same thing again, with nothing new and no reason to repeat it.',
    q: [{ pre: 'This demonstrates that ', mark: 'the SRE signal is not interchangeable with attention weights', post: ': attention scores identify “heavy hitter” tokens that receive concentrated attention mass, while SRE identifies tokens whose values cannot be reconstructed from linear state.', src: 'AI paper · SciSlopBench FA0002 · §4 Experiments' },
        { pre: '', mark: 'This validates the theoretical motivation: SRE directly measures the approximation gap, not just attention statistics.', post: '', src: 'Same paper · §4 Experiments, two sentences later' }],
    note: 'Two sentences apart, the same finding is stated twice. The abstract, the introduction, the related work, and the conclusion each state it once more.' },
  '4-5': { what: 'The figure shows something the reader cannot interpret from the figure, its caption, or the text.',
    q: [{ pre: 'Key Insight: Deeper Layers = Better Token Selection · ', mark: 'L2 55% · L4 39% · L8 69% · L12 66%', post: '', src: 'AI paper · SciSlopBench FA0280 · Figure 1, text inside the figure' }],
    note: 'Nothing says what the four bars measure, or that the L2 bar is a different method with debiasing. The highest bar, L8, is never mentioned in the text, so the reader cannot tell what the figure is showing.' },
  '5-1': { what: 'The paper says a problem matters and never shows that it does.',
    q: [{ pre: 'However, this offline calibration requirement limits deployment flexibility: ', mark: 'the prior may not transfer across domains, prompt styles, or model updates.', post: '', src: 'AI paper · SciSlopBench FA0280 · §1 Introduction' }],
    note: 'This sentence is the whole reason for the paper’s second contribution. The paper never tests a transfer to any other domain, prompt, or model, so the problem it solves is only asserted.' },
  '5-2': { what: 'The paper says it differs from another method, and describes that method wrongly.',
    q: [{ pre: 'This is fundamentally different from attention-based methods like H2O, ', mark: 'which prune high-attention tokens', post: '; we prune tokens with low approximation error.', src: 'AI paper · SciSlopBench FA0002 · §1 Introduction' },
        { pre: 'H2O identifies “heavy hitter” tokens that consistently receive high attention scores and ', mark: 'retains only these tokens', post: ' plus recent context.', src: 'Same paper · §2 Related Work' }],
    note: 'H2O keeps the high-attention tokens; the introduction says it prunes them. The claimed difference is with a method that does not exist.' },
  '5-3': { what: 'The paper gives a result a cause or a meaning that nothing in the paper tests.',
    q: [{ pre: 'LDA detection remains perfect (AUROC=1.0) against the adaptive attack, while the attack’s effectiveness is ', mark: 'unchanged (ASR 40.68% → 42.37%)', post: '.', src: 'AI paper · SciSlopBench FA0083 · §4 Experiments' },
        { pre: 'This robustness ', mark: 'stems from a fundamental trade-off', post: ': reducing the uniqueness weight makes triggers less detectable but also reduces their retrieval effectiveness.', src: 'Same paper · §4 Experiments, next sentence' }],
    note: 'A trade-off means one side goes down when the other goes up. The sentence before says neither side moved, so the explanation is contradicted by the number it explains.' },
  '5-4': { what: 'The paper says a source or a standard backs a claim, and the source is not there or does not say that.',
    q: [{ pre: 'All values are well below the 0.3 threshold ', mark: 'typically considered', post: ' indicative of meaningful positional bias.', src: 'AI paper · SciSlopBench FA0280 · §4 Experiments' }],
    note: '“Typically considered” points to a convention someone established. No citation is given here or anywhere in the paper, and the paper’s central diagnostic rests on this threshold.' },
};
for (const it of ITEMS) { const d = DEF[it.id]; if (!d) continue; it.what = d.what; const [a, b] = d.q; it.ex.pre = a.pre; it.ex.mark = a.mark; it.ex.post = a.post; it.ex.src = a.src; it.ex.note = d.note; it.ex2 = b || null; }

const PRINCIPLES = [
  ['Whole paper', 'Body, appendix, and supplement are read together. Absence from the material is not “never done”.'],
  ['Only what is needed', 'A missing example, explanation, or link counts only if the paper needs it.'],
  ['Context, not keywords', 'No judgment from one sentence or one word. Surrounding text, figures, and citations may do the job.'],
  ['Evidence on record', 'Each judgment notes the place, the affected claim, what is missing, and what was checked.'],
  ['Counts are signals', 'Reference counts, overlap, section length: supporting signals, never the definition.'],
  ['No double counting', 'One omission logged under two items is linked and counted once.'],
  ['Real fixes only', 'Invented explanations, or deleting a needed claim to lower the score, are not fixes.'],
];
const CUES = [
  ['Importance words', 'crucial, pivotal, paramount, growing attention', ['5-1']],
  ['Evaluative words', 'novel, robust, significantly, state-of-the-art', ['1-2', '5-3']],
  ['Contrast frames', 'unlike …, rather than …, not X but Y', ['5-2']],
  ['Interpretive tails', '…, demonstrating / highlighting / suggesting that …', ['5-3']],
  ['Evidence talk', 'it is well established that, extensive experiments show', ['5-4']],
  ['Rule of three', 'novel, efficient, and scalable', ['1-1', '1-2', '5-4']],
  ['Empty signposting', 'it is worth noting that, in summary, overall', ['4-1', '4-4']],
  ['Circular phrasing', 'the extraction module extracts features', ['4-1', '4-2', '3-1']],
  ['Scope limiting', 'beyond the scope, left for future work', ['3-1', '1-2', '4-1']],
  ['Surface style', 'em dashes, title case, bold run-in headings', []],
];
const MAP = [['1-3', 'Evidence gap'], ['1-4', 'Citation isolation'], ['2-3', 'Cross-section references'], ['4-4', 'Macro redundancy'], ['4-5', 'Figure exposition']];

// ------------------------------------------------------------------ findings (verified numbers: paper Table 2, §4; live index)
const BENCH = [['Science Slop Index', .859, true], ['Binoculars', .687], ['CycleReviewer', .685], ['DetectGPT', .638], ['NTS', .626], ['AI Scientist reviewer', .615]];
const MEASURES = [['Cross-section references', .905, C.struct, '2-3'], ['Figure exposition', .809, C.art, '4-5'], ['Citation isolation', .793, C.arg, '1-4'], ['Evidence gap', .764, C.art, '1-3'], ['Macro redundancy', .723, C.struct, '4-4'], ['Argument graph', .586, C.arg, '1-1 · 5-x']];
const HARNESS = [['Review only', .30, '17% of rounds break a guard'], ['Definitions + review', .25, 'no located instances'], ['Definitions + locations', .11, '23% of rounds break a guard'], ['Full SciSlopHarness', .17, 'no guard breaks', true]];
function hbars(rows, o = {}) { // rows: [label, value, {color, bold, note}]
  const W = 320, LW = o.lw || 118, rh = 18, pad = 2, max = o.max || 1, H = rows.length * rh + pad * 2;
  let s = '';
  rows.forEach((r, i) => {
    const [label, v, opt = {}] = r; const y = pad + i * rh, bw = (W - LW - 44) * (v / max), col = opt.color || (opt.bold ? 'var(--red)' : 'var(--line-2)');
    s += `<text x="${LW - 8}" y="${y + rh / 2 + .5}" text-anchor="end" dominant-baseline="central" font-size="11.5" ${opt.bold ? 'font-weight="700"' : ''} fill="var(--ink)">${esc(label)}</text>`;
    s += `<rect x="${LW}" y="${y + 4}" width="${W - LW - 44}" height="${rh - 8}" rx="3" fill="var(--surface-2)"/><rect x="${LW}" y="${y + 4}" width="${bw}" height="${rh - 8}" rx="3" fill="${col}"/>`;
    s += `<text x="${W - 36}" y="${y + rh / 2 + .5}" dominant-baseline="central" font-size="11.5" font-weight="${opt.bold ? 700 : 500}" fill="var(--ink)">${o.fmt ? o.fmt(v) : v.toFixed(3)}</text>`;
  });
  if (o.chance) { const x = LW + (W - LW - 44) * (o.chance / max); s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="var(--ink-3)" stroke-dasharray="2 2"/><text x="${x + 3}" y="${H - 3}" font-size="9.5" fill="var(--ink-3)">chance</text>`; }
  return `<svg class="v-chart" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, sans-serif">${s}</svg>`;
}
const FINDINGS = [
  { id: 'f1', q: 'How does AI slop differ from human poor writing?', a: 'Human and AI papers on the same 17 items, author hidden.',
    compare: 'Human-written papers and AI-generated papers. The judge never sees the author; the label is joined afterwards.',
    measure: 'The distribution of each item in each group: how often, how severe, and in what concrete form. Which slop is shared, which is AI’s alone.',
    v1: 'Six counting measures already pick the AI paper in 85.9% of 390 matched pairs; the best AI-text detector reaches 68.7%.',
    chart: () => hbars(BENCH.map(([l, v, b]) => [l, v, { bold: !!b, color: b ? 'var(--red)' : 'var(--line-2)' }]), { chance: .5 }), cap: 'v1 result: pair accuracy on SciSlopBench (paper, Table 2). Chance is 0.5.', status: 'v1 result · v1.1 per item' },
  { id: 'f2', q: 'How does slop relate to review scores, and how does that differ by year and venue?', a: '60k ICLR 2027 submissions, ICLR 2017–2026 by year, NeurIPS, ICML and ACL by venue.',
    compare: 'Submissions with their review scores: the 60k ICLR 2027 submissions, every ICLR year from 2017 to 2026, and NeurIPS, ICML and ACL.',
    measure: 'How each item relates to the score, and whether the relation holds in every year and every venue.',
    v1: 'In every ICLR year from 2017 to 2025, papers with more slop received lower reviewer scores.',
    chart: () => `<div class="years">${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map(y => `<span class="yr"><b>${y}</b><i>more slop ↓ score</i></span>`).join('')}<span class="yr plan"><b>2026</b><i>planned</i></span><span class="yr plan"><b>2027</b><i>60k submissions · planned</i></span></div>`, cap: 'v1 result: paper §4, review alignment. The pattern holds within every year. v2 starts from the 60k ICLR 2027 submissions, then adds venues.', status: 'v1 result · v2: 60k ICLR 2027, venues' },
  { id: 'f3', q: 'Is an AI reviewer more tolerant of slop in AI papers than a human reviewer?', a: 'Same paper, one human review and one AI review. Does the AI reviewer miss more slop when the author is AI?',
    compare: 'The same papers reviewed by humans and by AI reviewers, with the author (human or AI) joined afterwards.',
    measure: 'Which items each kind of review misses, and whether the AI reviewer’s misses grow when the paper is AI-written.',
    v1: null, chart: () => '', cap: '', status: 'planned' },
  { id: 'f4', q: 'What problems do reviewers point out for each type of slop?', a: 'Reviewer weaknesses collected per item: does a 5-1 paper get “motivation unclear”, a 2-2 paper “disconnected”?',
    compare: 'High-slop papers and the weakness sections of their reviews.',
    measure: 'Which remark each item draws, and which items reviewers never name even when the paper has them.',
    v1: null, chart: () => '', cap: '', status: 'planned' },
];

// ------------------------------------------------------------------ specimen paper (two columns; every registry item planted once)
const M = id => ({ mark: id });
const A = (g, text) => ({ anchor: g, text });        // a real place in the paper another slop points at
const G = (g, text) => ({ ghost: g, text });         // the place where something should be, and is not
const PAGE = {
  title: 'Adaptive Token Weighting for Cross-Lingual Retrieval', authors: 'A. Author · B. Author · C. Author',
  left: [
    { h: 'Abstract', p: ['Cross-lingual retrieval models weight every token the same. We introduce ', M('2-1'), ' on three benchmarks. ', M('1-2'), ', with gains of up to 4 points.'], lines: 1 },
    { h: '1  Introduction', p: [M('5-1'), ' ', G('g51', 'which problem? what fails?'), ' We propose a new framework to tackle this critical problem.'], lines: 1 },
    { p: [M('4-1'), ' ', G('g41', 'delete it: nothing is lost')], lines: 1 },
    { h: '2  Related Work', p: ['Method A [3] uses contrastive pairs; method B [7] adds a memory module. ', A('gab', 'Both compute their weights w = f(x) from the input.'), ' ', M('1-4'), ' ', G('g14', 'follows A or B? what differs?')], lines: 1 },
    { p: [M('5-4')], lines: 1 },
    { h: '3  Method', p: ['We apply ', M('4-2'), ' ', G('g42', 'definition'), ' before fusion and then project to the shared space. ', A('gloss', 'Two regularizers, L_a and L_b, are added to the loss.')], lines: 1 },
    { p: [M('5-2'), ' our method learns input-dependent weights.'], lines: 1 },
    { fig: true, cap: [M('4-5'), ' Solid and dashed arrows; blue, green, and orange blocks.'] },
  ],
  right: [
    { h: '4  Experiments', sub: '4.1  Setup', p: [A('gqa', 'We evaluate on long-document QA.'), ' ', M('3-1'), ' ', G('g31', 'why? effect on the long-input claim?'), ' ', G('g11', 'no label-noise experiment')], lines: 1 },
    { p: ['After tokenization, ', M('4-3'), ' before training.'], lines: 1 },
    { sub: '4.2  Results', table: true },
    { p: ['Adding the auxiliary loss improves BLEU by 1.8 points, ', M('5-3'), ' ', G('g53', 'no analysis of alignment')], lines: 1 },
    { p: [A('g44', 'Table 2 shows our model beats all baselines on both datasets.'), ' ', M('4-4')], lines: 1 },
    { sub: '4.3  Analysis', p: ['We find 31% ', M('1-3'), ' and 12% entity substitutions (Table 4). ', G('g13', 'no example input · output')], lines: 1 },
    { p: [A('gneg', 'The gain concentrates on sentences that contain negation (Table 5).'), ' With 1k examples the gain is +3.1; removing A loses it; at 100k the gap shrinks. ', M('2-2'), ' ', G('g22', 'and together they mean…?')], lines: 1 },
    { h: '5  Discussion', p: ['Beyond accuracy, ', M('1-1'), ' and transfers to new domains.'], lines: 1 },
        { h: 'References', refs: ['[3] A. et al. Contrastive pairs for retrieval. 2023.', '[7] B. et al. Memory-augmented retrieval. 2024.', A('gref', '[12] C. et al. Convergence of rule A. Theorem 1: fixed step size.')], lines: 0, small: true },
  ],
};
// how each slop fails on this page: where the mark points, and what the reader finds there
const FAIL = {
  '1-1': { to: 'g11', label: 'no label-noise experiment anywhere in §4' },
  '1-2': { to: 'gqa', label: 'one task, one setting: not "across domains"' },
  '1-3': { to: 'g13', label: 'counts only, no example to check' },
  '1-4': { to: 'g14', label: 'the relation to A and B is never stated' },
  '2-1': { to: 'gneg', label: 'this finding never reaches the Abstract' },
  '2-2': { to: 'g22', label: 'three results, no sentence joins them' },
  '2-3': { to: 'gloss', label: 'two losses in §3: which one was removed?' },
  '3-1': { to: 'g31', label: 'excluded, no reason given' },
  '4-1': { to: 'g41', label: 'says nothing about this paper' },
  '4-2': { to: 'g42', label: 'never defined' },
  '4-3': { self: true, label: 'no result depends on this' },
  '4-4': { to: 'g44', label: 'same content again', eq: true },
  '4-5': { to: 'gfig', label: 'arrows and colors never explained' },
  '5-1': { to: 'g51', label: 'the problem is never named' },
  '5-2': { to: 'gab', label: 'A and B are input-dependent too' },
  '5-3': { to: 'g53', label: 'nothing tests the alignment claim' },
  '5-4': { to: 'gref', label: '[12] covers fixed step sizes only' },
};
const PLANES = { structure: { title: 'Structure', q: 'Do the sections build on one another?' }, argument: { title: 'Argument', q: 'Are the claims and citations argued?' }, artifacts: { title: 'Artifacts', q: 'Can the method and the evidence be inspected?' } };
const PLANE_OF = { '2-1': 'structure', '2-2': 'structure', '2-3': 'structure', '4-1': 'structure', '4-3': 'structure', '4-4': 'structure',
  '1-1': 'argument', '1-2': 'argument', '1-4': 'argument', '5-1': 'argument', '5-2': 'argument', '5-3': 'argument', '5-4': 'argument',
  '1-3': 'artifacts', '3-1': 'artifacts', '4-2': 'artifacts', '4-5': 'artifacts' };
const PLANE_C = { structure: '#7E4E66', argument: '#E4959E', artifacts: '#56717B' };   // site planes: structure/artifacts in their deep shade so structure and argument separate
// the page groups the seventeen items by the index's three planes; the 1-5 area numbers stay in the item ids
const GROUPS = [
  { n: 1, key: 'structure', cls: 'p-structure', title: 'Structure', q: 'Do the sections build on one another?' },
  { n: 2, key: 'argument', cls: 'p-argument', title: 'Argument', q: 'Are the claims and citations argued?' },
  { n: 3, key: 'artifacts', cls: 'p-artifacts', title: 'Artifacts', q: 'Can the method and the evidence be inspected?' },
];
for (const it of ITEMS) { it.plane = PLANE_OF[it.id]; it.ar = GROUPS.find(g => g.key === it.plane); it.g = it.ar.n; }
const SHORT = { '1-1': 'A claim with no evidence behind it.', '1-2': 'The claim goes further than the evidence.', '1-3': 'Results, but not one example shown.', '1-4': 'Cited, but never related to this paper.',
  '2-1': 'The key finding is missing from the abstract.', '2-2': 'Experiments never tied back to the question.', '2-3': 'Refers to something the reader cannot locate.', '3-1': 'A design choice with no reason given.',
  '4-1': 'Says nothing about this paper.', '4-2': 'A term that is never defined.', '4-3': 'Detail that no result depends on.', '4-4': 'The same content said twice.', '4-5': 'Figure arrows and colors never explained.',
  '5-1': 'Called important, but which problem?', '5-2': 'A claimed difference that does not hold.', '5-3': 'A result read as a mechanism never tested.', '5-4': 'The cited source says something else.' };
for (const it of ITEMS) it.short = SHORT[it.id];
const BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));
function renderPage() {
  const col = blocks => h('div', { class: 'pcol' }, ...blocks.map(b => {
    const out = [];
    if (b.h) out.push(h('h4', { text: b.h }));
    if (b.sub) out.push(h('h5', { text: b.sub }));
    if (b.fig) out.push(h('div', { class: 'pfig' }, h('div', { class: 'pfig-d', 'data-g': 'gfig', html: '<svg viewBox="0 0 100 30"><rect x="6" y="9" width="18" height="12" rx="2" fill="#D9E5EA" stroke="#5C717D" stroke-width=".6"/><rect x="41" y="9" width="18" height="12" rx="2" fill="#E6EFDF" stroke="#5C717D" stroke-width=".6"/><rect x="76" y="9" width="18" height="12" rx="2" fill="#F6E7D2" stroke="#5C717D" stroke-width=".6"/><path d="M24 15H40" stroke="#5C717D" stroke-width=".8"/><path d="M59 15H75" stroke="#5C717D" stroke-width=".8" stroke-dasharray="2 1.5"/><path d="M15 21C30 32 70 32 85 21" fill="none" stroke="#5C717D" stroke-width=".8" stroke-dasharray="2 1.5"/></svg>' }), h('p', { class: 'pcap' }, ...b.cap.map(seg))));
    if (b.table) out.push(h('table', { class: 'ptab' }, h('caption', { text: 'Table 3: Ablation on the dev set.' }), h('tr', {}, h('th', { text: 'Model' }), h('th', { text: 'R@10' })), h('tr', {}, h('td', { text: 'Full model' }), h('td', { text: '71.2' })), h('tr', {}, h('td', {}, seg(M('2-3'))), h('td', { text: '68.0' })), h('tr', {}, h('td', { text: 'w/o auxiliary loss' }), h('td', { text: '69.4' }))));
    if (b.refs) out.push(h('div', { class: 'prefs' }, ...b.refs.map(r => h('p', {}, seg(r)))));
    if (b.p) out.push(h('p', {}, ...b.p.map(seg)));
    if (b.lines) out.push(h('div', { class: 'plines' + (b.small ? ' small' : ''), style: `height:${b.lines * (b.small ? 7 : 8.5)}px` }));
    return out;
  }).flat());
  function seg(x) { if (typeof x === 'string') return x; if (x.anchor) return h('span', { class: 'pa', 'data-g': x.anchor, text: x.text }); if (x.ghost) return h('span', { class: 'pg', 'data-g': x.ghost, text: x.text }); const it = BY_ID[x.mark]; return h('mark', { class: 'mk ' + it.ar.cls, 'data-id': it.id, tabindex: 0, 'aria-label': it.name, text: it.ex.spec || it.ex.mark }); }
  $('#spec-page').replaceChildren(h('h3', { class: 'ptitle', text: PAGE.title }), h('p', { class: 'pauth', text: PAGE.authors }), h('div', { class: 'pcols' }, col(PAGE.left), col(PAGE.right)));
}
function sideCard(it) {
  const c = h('div', { class: 'v-sc ' + it.ar.cls, 'data-id': it.id, tabindex: 0 },
    h('div', { class: 'sc-h' }, h('span', { class: 'sc-t' }, h('span', { class: 'sc-pl', text: it.ar.title }), h('b', { text: it.name })), h('span', { class: 'sc-votes', 'data-votes': it.id }, ...voteBtns(it.id))),
    h('p', { class: 'sc-w', text: it.short }),
    h('div', { class: 'sc-more' }, h('p', { class: 'sc-n', text: it.what }), h('p', { class: 'sc-n sc-note', text: it.ex.specnote || it.ex.note }), h('a', { href: '#' + it.id, 'data-xref': it.id, class: 'sc-def', text: 'Definition →' }), ' ', h('a', { href: '#hub-' + it.id, 'data-xref': 'hub-' + it.id, class: 'sc-def', text: 'Seen it? Add a case →' })));
  return c;
}
let specLaidOut = false;
function layoutSpecimen() {
  const spec = $('#specimen'); if (spec.offsetWidth === 0) return;
  const wide = spec.offsetWidth >= 960; spec.classList.toggle('narrow', !wide);
  const svg = $('#leaders'); svg.innerHTML = '';
  if (!wide) return;
  const sr = spec.getBoundingClientRect(); svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`); svg.setAttribute('width', sr.width); svg.setAttribute('height', sr.height);
  const pageMid = $('#spec-page').getBoundingClientRect().left + $('#spec-page').offsetWidth / 2;
  const marks = [...document.querySelectorAll('#spec-page .mk')].map(m => { const r = m.getClientRects()[0] || m.getBoundingClientRect(); return { id: m.dataset.id, r, left: (r.left + r.right) / 2 < pageMid }; });
  for (const side of ['l', 'r']) {
    const host = $('#side-' + side); const list = marks.filter(m => m.left === (side === 'l')).sort((a, b) => a.r.top - b.r.top);
    host.replaceChildren(...list.map(m => sideCard(BY_ID[m.id])));
    let y = 0; const hr = host.getBoundingClientRect();
    list.forEach((m, i) => {
      const c = host.children[i]; const want = m.r.top - sr.top - 4; y = Math.max(want, y); c.style.top = y + 'px'; const ch = c.offsetHeight; y += ch + 5;
      const cr = c.getBoundingClientRect();
      const x0 = side === 'l' ? cr.right - sr.left : cr.left - sr.left, y0 = cr.top - sr.top + Math.min(16, cr.height / 2);
      const x1 = side === 'l' ? m.r.left - sr.left - 2 : m.r.right - sr.left + 2, y1 = m.r.top - sr.top + m.r.height / 2;
      const dx = (x1 - x0) / 2;
      svg.insertAdjacentHTML('beforeend', `<path data-id="${m.id}" d="M${x0} ${y0} C${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}" class="ld" style="--lc:${PLANE_C[BY_ID[m.id].plane]}"/><circle cx="${x1}" cy="${y1}" r="2.6" style="fill:${PLANE_C[BY_ID[m.id].plane]}"/>`);
    });
    host.style.height = y + 'px';
  }
  spec.style.minHeight = Math.max($('#side-l').offsetHeight, $('#side-r').offsetHeight, $('#spec-page').offsetHeight + 24) + 'px';
  specLaidOut = true;
}
function overEl() { let o = $('#spec-over'); if (!o) { o = h('div', { id: 'spec-over', class: 'spec-over' }); $('.spec-page-wrap').append(o); } return o; }
function clearOver() { const o = $('#spec-over'); if (o) o.replaceChildren(); document.querySelectorAll('.pg.hot, .pa.hot').forEach(el => el.classList.remove('hot')); }
function drawOver(id) {
  clearOver(); const f = FAIL[id]; if (!f) return;
  const wrap = $('.spec-page-wrap'); const wr = wrap.getBoundingClientRect(); const o = overEl();
  const mk = document.querySelector(`#spec-page .mk[data-id="${id}"]`); if (!mk) return;
  const mr = mk.getClientRects(); const m0 = mr[0], m1 = mr[mr.length - 1];
  const svg = `<svg class="over-svg" width="${wr.width}" height="${wrap.offsetHeight}" viewBox="0 0 ${wr.width} ${wrap.offsetHeight}">`;
  let inner = ''; let lx, ly;
  if (f.self || !f.to) { lx = m0.left - wr.left; ly = m1.bottom - wr.top + 3; }
  else {
    const tg = document.querySelector(`#spec-page [data-g="${f.to}"]`); if (!tg) return; tg.classList.add('hot');
    const tr = tg.getClientRects(); const t0 = tr[0], t1 = tr[tr.length - 1];
    // route through the gutter between the two columns, like a margin note: mark → gutter → target
    const gx = wr.width / 2; const page = $('#spec-page').getBoundingClientRect();
    const colOf = r => ((r.left + r.right) / 2 < page.left + page.width / 2 ? 'l' : 'r');
    const mc = colOf(m0), tc = colOf(t0);
    const mEdge = mc === 'l' ? m1 : m0, tEdge = tc === 'l' ? t1 : t0;     // the line segment nearest the gutter
    const x0 = (mc === 'l' ? mEdge.right : mEdge.left) - wr.left, y0 = (mEdge.top + mEdge.bottom) / 2 - wr.top;
    const x1 = (tc === 'l' ? tEdge.right : tEdge.left) - wr.left, y1 = (tEdge.top + tEdge.bottom) / 2 - wr.top;
    const r = 6, sy = y1 > y0 ? 1 : -1, sx0 = x0 < gx ? 1 : -1, sx1 = x1 < gx ? -1 : 1;
    let d;
    if (Math.abs(y1 - y0) < 2 * r) d = `M${x0} ${y0} L${x1} ${y1}`;
    else d = `M${x0} ${y0} H${gx - sx0 * r} Q${gx} ${y0} ${gx} ${y0 + sy * r} V${y1 - sy * r} Q${gx} ${y1} ${gx + sx1 * r} ${y1} H${x1}`;
    inner += `<path class="over-path" d="${d}"/><circle class="over-dot" cx="${x0}" cy="${y0}" r="2.6"/>`;
    inner += f.eq ? `<circle class="over-x" cx="${x1}" cy="${y1}" r="6.5"/><text class="over-eq" x="${x1}" y="${y1 + .5}">=</text>` : `<circle class="over-x" cx="${x1}" cy="${y1}" r="5.8"/><path class="over-xm" d="M${x1 - 2.3} ${y1 - 2.3}L${x1 + 2.3} ${y1 + 2.3}M${x1 - 2.3} ${y1 + 2.3}L${x1 + 2.3} ${y1 - 2.3}"/>`;
    lx = t0.left - wr.left; ly = t1.bottom - wr.top + 3;
  }
  o.innerHTML = svg + inner + '</svg>';
  const lab = h('div', { class: 'over-label', text: '✕ ' + f.label }); o.append(lab);
  lx = Math.max(6, Math.min(lx, wr.width - 6 - Math.min(260, wr.width - 12))); ly = Math.min(ly, wrap.offsetHeight - 26); lab.style.left = lx + 'px'; lab.style.top = ly + 'px'; lab.style.maxWidth = Math.min(260, wr.width - 12) + 'px';
}
let popPinned = null, popTimer = null;
function popEl() { let p = $('#spec-pop'); if (!p) { p = h('div', { id: 'spec-pop', class: 'spec-pop', hidden: true }); $('.spec-page-wrap').append(p); p.addEventListener('mouseenter', () => clearTimeout(popTimer)); p.addEventListener('mouseleave', () => { if (!popPinned) hidePop(); }); } return p; }
function showPop(id) {
  clearTimeout(popTimer);
  const it = BY_ID[id]; if (!it) return; const a = it.ar;
  const mk = document.querySelector(`#spec-page .mk[data-id="${id}"]`); const wrap = $('.spec-page-wrap'); if (!mk || !wrap) return;
  const p = popEl(); p.className = 'spec-pop ' + it.ar.cls; p.dataset.id = id;
  p.replaceChildren(...[
    h('div', { class: 'pop-h' }, h('b', { text: it.name }), h('span', { class: 'pop-area', text: it.ar.title })),
    h('p', { class: 'pop-what', text: it.what }),
    it.link ? h('div', { class: 'v-link' }, h('span', { text: it.link[0] }), h('i', { text: '→' }), h('span', { text: it.link[1] })) : null,
    h('p', { class: 'pop-note', text: it.ex.specnote || it.ex.note }),
    h('p', { class: 'pop-links' }, h('a', { href: '#' + id, 'data-xref': id, text: 'Full definition →' }), ' ', h('a', { href: '#hub-' + id, 'data-xref': 'hub-' + id, text: 'Seen it? Add a case →' }))].filter(Boolean));
  p.hidden = false; p.style.visibility = 'hidden';
  const wr = wrap.getBoundingClientRect(); const rects = mk.getClientRects(); const r0 = rects[0], r1 = rects[rects.length - 1];
  const W = Math.min(330, wr.width - 16); p.style.width = W + 'px';
  const ph = p.offsetHeight, H = wrap.offsetHeight;
  drawOver(id);                                                     // draw first, then place the popover around what was drawn
  const f = FAIL[id] || {}; const tg = f.to ? document.querySelector(`#spec-page [data-g="${f.to}"]`) : null;
  const rel = r => ({ l: r.left - wr.left, t: r.top - wr.top, r: r.right - wr.left, b: r.bottom - wr.top });
  const hard = [...rects].map(rel); if (tg) for (const r of tg.getClientRects()) hard.push(rel(r));
  const lab = document.querySelector('#spec-over .over-label'); if (lab) hard.push(rel(lab.getBoundingClientRect()));
  const soft = [...hard]; const pathEl = document.querySelector('#spec-over .over-path'); if (pathEl) { const bb = pathEl.getBoundingClientRect(); if (bb.width || bb.height) soft.push(rel(bb)); }
  const hits = (l, t, list) => list.some(a => !(l + W < a.l - 6 || l > a.r + 6 || t + ph < a.t - 6 || t > a.b + 6));
  const col = wr.width / 2; const lefts = [Math.max(8, Math.min(r0.left - wr.left, wr.width - W - 8)), r0.left - wr.left < col ? wr.width - W - 8 : 8];
  const tops = [r1.bottom - wr.top + 10, r0.top - wr.top - ph - 10, (tg ? rel(tg.getClientRects()[0]).b : r1.bottom - wr.top) + 30, 8, H - ph - 8];
  let best = null;
  for (const list of [soft, hard]) { for (const l of lefts) for (const t of tops) { if (t < 0 || t + ph > H) continue; if (!hits(l, t, list)) { best = [l, t]; break; } } if (best) break; }
  if (!best) for (const l of lefts) for (const t of [r1.bottom - wr.top + 10, H - 40]) { if (!best && t >= 0 && !hits(l, t, hard)) best = [l, t]; }   // may hang below the page
  if (!best) { const t = r1.bottom - wr.top + 10; best = [lefts[1], Math.max(8, Math.min(t, H - ph - 8))]; }
  p.style.left = best[0] + 'px'; p.style.top = best[1] + 'px'; p.style.visibility = '';
}
function hidePop() { const p = $('#spec-pop'); if (p) { p.hidden = true; } clearOver(); }
function litSpec(id, on) {
  document.querySelectorAll(`#spec-page .mk[data-id="${id}"], .v-sc[data-id="${id}"], #leaders path[data-id="${id}"]`).forEach(el => el.classList.toggle('lit', on));
}
$('#specimen').addEventListener('click', e => {
  if (e.target.closest('#spec-pop')) return;
  const t = e.target.closest('.mk, .v-sc'); if (!t || e.target.closest('a, button')) return;
  const id = t.dataset.id; const card = document.querySelector(`.v-sc[data-id="${id}"]`);
  const open = popPinned !== id;
  document.querySelectorAll('.v-sc.open').forEach(c => { c.classList.remove('open'); litSpec(c.dataset.id, false); });
  popPinned = open ? id : null;
  if (open) { card.classList.add('open'); litSpec(id, true); showPop(id); } else hidePop();
  layoutSpecimen(); if (open) { litSpec(id, true); showPop(id); }
});
document.addEventListener('click', e => { if (popPinned && !e.target.closest('#specimen')) { popPinned = null; hidePop(); document.querySelectorAll('.v-sc.open').forEach(c => { c.classList.remove('open'); litSpec(c.dataset.id, false); }); } });
$('#specimen').addEventListener('mouseover', e => { const t = e.target.closest('.mk, .v-sc'); if (t) { litSpec(t.dataset.id, true); if (!popPinned) showPop(t.dataset.id); } });
$('#specimen').addEventListener('mouseout', e => { const t = e.target.closest('.mk, .v-sc'); if (!t) return; if (!document.querySelector(`.v-sc.open[data-id="${t.dataset.id}"]`)) litSpec(t.dataset.id, false); if (!popPinned) { clearTimeout(popTimer); popTimer = setTimeout(hidePop, 160); } });
$('#specimen').addEventListener('focusin', e => { const t = e.target.closest('.mk, .v-sc'); if (t) { litSpec(t.dataset.id, true); showPop(t.dataset.id); } });
$('#legend').replaceChildren(...GROUPS.map(a => h('span', { class: 'v-lg ' + a.cls, title: a.q }, h('i'), a.title)));


// ------------------------------------------------------------------ render the rest
const xref = id => `<a class="xref" href="#${id}" data-xref="${id}">${id}</a>`;
renderPage();
// one small scene per analysis, in the pictogram vocabulary
const PAPER = (x, y, w, h, label, marks) => K.card(x, y, w, h, label) + K.lines(x + 3, y + 7, w - 6, 3, { gap: 3.2, last: .6 }) + (marks || []).map(([mx, my, mw, col]) => K.box(x + mx, y + my, mw, 2.6, { fc: col, ec: col, r: .8 })).join('');
const PERSON = (x, y, col) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${col}"/><path d="M${x - 4.6} ${y + 9.5} a4.6 4.6 0 0 1 9.2 0z" fill="${col}"/>`;
const ROBOT = (x, y, col) => K.box(x - 3.4, y - 2.6, 6.8, 6, { fc: col, ec: col, r: 1 }) + `<rect x="${x - 2}" y="${y - 1}" width="1.4" height="1.4" fill="#fff"/><rect x="${x + .6}" y="${y - 1}" width="1.4" height="1.4" fill="#fff"/><line x1="${x}" y1="${y - 2.6}" x2="${x}" y2="${y - 4.5}" stroke="${col}" stroke-width=".8"/>` + K.box(x - 4.6, y + 4.4, 9.2, 5, { fc: col, ec: col, r: 1 });
const MINI_CAP = {"f1": "Human and AI papers, same 17 items, author hidden", "f2": "Slop against review scores, year by year and venue by venue", "f3": "One paper, one human review and one AI review", "f4": "Each review remark matched to the slop it points at"};
const MINI = {
  f1: () => `<img src="img/q1.png" alt="An AI paper that looks polished next to a human paper full of red marks">`,
  f2: () => `<img src="img/q2_v2.png" alt="Clean and sloppy AI papers, reviewers' star ratings, and the scores plotted by year and by venue">`,
  f3: () => `<img src="img/q3.png" alt="The same AI paper: the AI reviewer gives four stars, the human reviewer two">`,
  f4: () => `<img src="img/q4.png" alt="Slop types in an AI paper and the reviewer's remark for each">`,
};
$('#qtiles').replaceChildren(...FINDINGS.map((f, i) => h('li', {}, h('a', { class: 'ql', href: '#' + f.id },
  h('span', { class: 'ql-pic', html: MINI[f.id]() }),
  h('span', { class: 'ql-n', text: 'Q' + (i + 1) }),
  h('b', { class: 'ql-q', text: f.q })))));
$('#findings').replaceChildren(...FINDINGS.map((f, i) => h('section', { class: 'v-finding card', id: f.id },
  h('div', { class: 'fd-t' }, h('p', { class: 'fd-q', text: f.status }), h('h3', { text: f.q }), h('p', { class: 'fd-b', text: f.a }),
    h('dl', { class: 'fd-dl' }, h('dt', { text: 'We compare' }), h('dd', { text: f.compare }), h('dt', { text: 'We measure' }), h('dd', { text: f.measure }), f.v1 ? h('dt', { text: 'v1 already showed' }) : null, f.v1 ? h('dd', { text: f.v1 }) : null)),
  h('div', { class: 'fd-c' }, h('div', { html: f.chart() }), f.cap ? h('p', { class: 'cap', text: f.cap }) : null))));
$('#principles-grid').replaceChildren(...PRINCIPLES.map(([t, p]) => h('div', { class: 'pr' }, h('b', { text: t }), h('span', { text: p }))));
$('#area-tiles').replaceChildren(...GROUPS.map(a => h('a', { class: 'atile ' + a.cls, href: '#area-' + a.n }, h('span', { class: 'an', text: ITEMS.filter(i => i.g === a.n).length + ' items' }), h('b', { text: a.title }), h('span', { class: 'aq', text: a.q }))));
function excerpt(ex) { return h('div', { class: 'v-ex' + (ex.made ? ' made' : '') }, h('div', { class: 'ex-h', text: ex.src || ex.sec }), h('p', { class: 'ex-t' }, ex.pre, h('mark', { text: ex.mark }), ex.post), h('p', { class: 'ex-n', text: ex.note })); }
function bullets(cls, label, arr) { return h('div', { class: 'dl ' + cls }, h('span', { class: 'l', text: label }), h('ul', {}, ...arr.map(t => h('li', { text: t })))); }
function card(it, area) {
  const d = h('article', { class: 'slop ' + area.cls, id: it.id });
  const more = [bullets('j', 'How it is judged', it.judge), bullets('n', 'Not a defect', it.not), bullets('f', 'What counts as a fix', it.fix),
    it.link ? bullets('k', 'What must connect', [it.link[0] + ' → ' + it.link[1]]) : null,
    it.borders ? h('div', { class: 'dl b' }, h('span', { class: 'l', text: 'Borders on' }), h('ul', { class: 'bl' }, ...it.borders.map(([id, why]) => h('li', { html: xref(id) + ' <span>' + esc(why) + '</span>' })))) : null];
  d.append(h('details', { class: 'e-text e-open' },
    h('summary', { class: 'e-sum' },
      h('h3', { class: 'e-name', text: it.name }),
      h('p', { class: 'e-what', text: it.what })),
    h('div', { class: 'e-body' },
      h('blockquote', { class: 'e-q' + (it.ex.made ? ' made' : '') }, h('p', { class: 'e-qt' }, it.ex.pre, h('mark', { text: it.ex.mark }), it.ex.post), h('p', { class: 'e-src', text: it.ex.src || it.ex.sec })),
      it.ex2 ? h('blockquote', { class: 'e-q' }, h('p', { class: 'e-qt' }, it.ex2.pre, h('mark', { text: it.ex2.mark }), it.ex2.post), h('p', { class: 'e-src', text: it.ex2.src })) : null,
      h('p', { class: 'e-note', text: it.ex.note }),
      h('details', { class: 'v-more' }, h('summary', {}, h('span', { text: 'How it is judged, what is not a defect, what counts as a fix' })), h('div', { class: 'more-b' }, ...more)),
      h('div', { class: 'hubline' }))));
  d.append(h('div', { class: 'e-pic', html: K.svg(PIC[it.id](), 'Illustration of ' + it.name) }));
  return d;
}
$('#areas').replaceChildren(...GROUPS.map(a => h('section', { class: 'v-area ' + a.cls, id: 'area-' + a.n, 'data-area': a.n },
  h('div', { class: 'area-head' }, h('h2', { text: a.title }), h('p', { class: 'aq', text: a.q })),
  h('div', { class: 'v-cards' }, ...ITEMS.filter(i => i.g === a.n).map(it => card(it, a))))));
$('#cue-grid').replaceChildren(...CUES.map(([c, ex, ids]) => h('div', { class: 'cue' }, h('b', { text: c }), h('i', { text: ex }), h('span', { class: 'cue-to', html: ids.length ? '→ ' + ids.map(xref).join(' ') : '→ <span class="muted">no item · style only</span>' }))));
$('#map-list').replaceChildren(...MAP.map(([id, v1]) => h('li', { html: `<span>${esc(v1)}</span><i>→</i>${xref(id)} <b>${esc(BY_ID[id].name)}</b>` })));


// ------------------------------------------------------------------ hub: votes, cases, fix prompts
const PROMPTS = {
  '1-1': `# Fix · Unsupported Claims (1-1)
For every sentence that states a result or a property as fact:
1. Name the support it needs: an experiment, a proof, or a citation. Find it in the paper.
2. If it exists, point to it in the sentence (table, section, or reference).
3. If it does not exist, narrow the claim to what the paper shows, or mark it as a hypothesis.
Never add a citation you have not read, invent a run, or delete the contribution to escape the check.`,
  '1-2': `# Fix · Overstated Claims (1-2)
For every claim with supporting results, compare four things against the evidence: subjects and scope, conditions, effect size and direction, certainty (observed, statistical, causal).
Rewrite the claim to the evaluated range and state the uncertainty.
Deleting "significantly" while keeping "across domains" is not a fix.`,
  '1-3': `# Fix · Missing Examples (1-3)
List the claims and phenomena a reader cannot check without a concrete case (an input with its output, an error, a sample).
For each, add one real case from the study, in the body or an appendix, and refer to it from the claim.
Do not invent cases or present constructed ones as observations.`,
  '1-4': `# Fix · Unclear Links to Prior Work (1-4)
For every cited work that the study builds on, differs from, or compares against, write one sentence that says the relation: what this study follows, which limitation it addresses, or what it does differently.
Adding "unlike prior work" without the relation, or deleting citations, is not a fix.`,
  '2-1': `# Fix · Buried Findings (2-1)
Identify the key findings of the body from the research question and the main results, including the condition under which each holds.
Check the Abstract and Introduction: if a key finding or its condition is missing, add it in one sentence.
Adding a single number is not enough; do not turn an observed association into a mechanism.`,
  '2-2': `# Fix · Disconnected Experiments (2-2)
State the research question. For each experiment, write what it examines and what its result contributes to the answer.
Where several results must be read together, add the sentence that reads them together and says what they jointly support or limit.
"Together, these results demonstrate…" without the reasoning is not a fix.`,
  '2-3': `# Fix · Missing Cross-Section Links (2-3)
Find every place that depends on a definition, method, or result given elsewhere (an ablation row, a symbol, a setting).
Name the counterpart exactly (which loss, which equation, which table) so the reader can match them.
Do not add references to unrelated tables or sections.`,
  '3-1': `# Fix · Unexplained Design Choices (3-1)
List the choices that affect the conclusion: architecture, data selection, exclusions, comparison conditions, metrics.
For each, give the actual rationale, constraint, or comparison. "For efficiency" alone is not a reason.
Do not invent alternatives that were never run; a value that is given but unexplained is the target here, not a missing value.`,
  '4-1': `# Fix · Generic Filler (4-1)
For each sentence, ask what information or function is lost if it is deleted.
If nothing is lost, delete it. If it stands where motivation or a definition should be, replace it with the study's own content.
Inserting model or dataset names to make a sentence look specific is not a fix.`,
  '4-2': `# Fix · Undefined Terms (4-2)
For every term or abbreviation the intended reader cannot interpret from context, give its operation, object, or role where it first appears, or cite the definition.
Expanding an acronym or swapping in another abstract word is not enough. If one thing has several names, pick one.`,
  '4-3': `# Fix · Irrelevant Detail (4-3)
For each passage, ask whether removing it loses anything needed to understand, check, or reproduce the study.
Remove what has no role; keep every preprocessing, data, and failure-condition detail that reproduction needs.
Cutting reproduction detail to shorten the paper is not a fix.`,
  '4-4': `# Fix · Redundant Repetition (4-4)
Match each repeated passage to its original and ask what the later one adds.
If it adds nothing, cut it or put the missing analysis in its place. Keep the Abstract, the contribution list, and a needed recap in the Conclusion.
Paraphrase is not a fix.`,
  '4-5': `# Fix · Unclear Figures (4-5)
State the figure's purpose. List every element, symbol, arrow type, and color the reader must interpret.
Explain each in the figure, the legend, or the caption, and tie it to the method or result it shows.
A longer caption, or deleting the figure, is not by itself a fix.`,
  '5-1': `# Fix · Unexplained Importance (5-1)
Where the paper calls a problem or contribution important, write the concrete problem (which question is open, what fails, under which constraint) and why it is worth studying.
If the motivation is already given elsewhere, delete the stock sentence.
Swapping adjectives, or inventing numbers to support importance, is not a fix.`,
  '5-2': `# Fix · Unsupported Comparisons (5-2)
For every "unlike …" or "rather than …", name the compared method, the compared property, and the claimed difference.
Verify a structural difference in the equations or method description; verify a performance difference with an evaluation.
If the difference does not hold, withdraw it and align the Abstract and conclusion. Deleting "unlike" is not a fix.`,
  '5-3': `# Fix · Unsupported Interpretations (5-3)
Separate each result sentence into the observation and the added interpretation (cause, mechanism, meaning).
State what assumption or evidence the step between them needs and whether the paper has it.
If it does not, limit the interpretation to what the results allow, or mark it as a hypothesis, and fix the Abstract and Conclusion to match.
Changing "demonstrating" to "suggesting" while keeping the conclusion is not a fix.`,
  '5-4': `# Fix · Misrepresented Evidence (5-4)
For every sentence that says evidence exists ("prior work shows", "extensive experiments", "[12] established"), check existence, content, scope, and consensus against the actual source or experiment list.
Describe what the support actually shows. If a support statement is withdrawn, recheck that the remaining claim is still supported.
Adding citations or deleting "extensive" is not a fix.`,
};
const LIVE_API = 'https://scientific-slop-demo.onrender.com';
const hub = { mode: 'local', api: '', token: '', uid: null, db: null, canWrite: true, votes: {}, mine: {}, cases: [], prompts: [], pups: {}, mineUps: {} };
const hubOpen = new Set();
function hubTok() { try { let t = localStorage.getItem('ssi-hub-token'); if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('ssi-hub-token', t); } return t; } catch (_) { return 'anon'; } }
function hubLocalLoad() { try { const j = JSON.parse(localStorage.getItem('ssi-hub') || '{}'); hub.mine = j.mine || {}; hub.cases = j.cases || []; hub.prompts = j.prompts || []; hub.mineUps = j.mineUps || {}; } catch (_) { /* empty */ } hubLocalAgg(); }
function hubLocalAgg() { hub.votes = {}; for (const [k, v] of Object.entries(hub.mine)) hub.votes[k] = { up: v === 1 ? 1 : 0, down: v === -1 ? 1 : 0 }; hub.pups = {}; for (const k of Object.keys(hub.mineUps)) hub.pups[k] = 1; }
function hubLocalSave() { try { localStorage.setItem('ssi-hub', JSON.stringify({ mine: hub.mine, cases: hub.cases, prompts: hub.prompts, mineUps: hub.mineUps })); } catch (_) { /* ignore */ } }
function applyServer(j) { hub.votes = j.items || {}; hub.mine = j.mine || {}; hub.cases = j.cases || []; hub.prompts = j.prompts || []; hub.pups = {}; hub.mineUps = {}; for (const p of hub.prompts) { hub.pups[p.id] = p.ups || 0; if (p.mine) hub.mineUps[p.id] = 1; } }
async function hubInit() {
  hub.token = hubTok();
  if (window.claude && typeof window.claude.use === 'function') {
    const db = await window.claude.use('db');
    if (db) {
      hub.mode = 'db'; hub.db = db;
      const user = await window.claude.use('user'); hub.uid = user ? await user.id() : null;
      if (user) { const w = await user.can('data.write'); if (w === false) hub.canWrite = false; }
      if (!hub.uid) hub.canWrite = false;
      db.collection('votes').onSnapshot(snap => { const agg = {}; let mine = {}; snap.docs.forEach(d => { const it = (d.data() || {}).items || {}; if (d.id === hub.uid) mine = it; for (const [k, v] of Object.entries(it)) { agg[k] = agg[k] || { up: 0, down: 0 }; if (v === 1) agg[k].up++; else if (v === -1) agg[k].down++; } }); hub.votes = agg; hub.mine = mine; renderHub(); }, () => {});
      db.collection('cases').onSnapshot(snap => { hub.cases = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); renderHub(); }, () => {});
      db.collection('prompts').onSnapshot(snap => { hub.prompts = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); renderHub(); }, () => {});
      db.collection('promptups').onSnapshot(snap => { const ups = {}; let mine = {}; snap.docs.forEach(d => { const ids = (d.data() || {}).ids || {}; if (d.id === hub.uid) mine = ids; for (const k of Object.keys(ids)) ups[k] = (ups[k] || 0) + 1; }); hub.pups = ups; hub.mineUps = mine; renderHub(); }, () => {});
      renderHub(); return;
    }
  }
  for (const base of ['', LIVE_API]) {
    try { const r = await fetch(base + '/api/hub?token=' + encodeURIComponent(hub.token)); if (r.ok) { const j = await r.json(); if (j && j.live) { hub.mode = 'server'; hub.api = base; applyServer(j); renderHub(); return; } } } catch (_) { /* next */ }
  }
  hubLocalLoad(); renderHub();
}
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
async function hubPost(path, body) { const r = await fetch(hub.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: hub.token }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Request failed'); return r.json(); }
async function vote(item, v) {
  if (!hub.canWrite) return;
  const cur = hub.mine[item] || 0; const next = cur === v ? 0 : v;
  const mine = { ...hub.mine }; if (next) mine[item] = next; else delete mine[item];
  if (hub.mode === 'db') { try { await hub.db.doc('votes/' + hub.uid).set({ items: mine, at: now() }); } catch (e) { hubMsg(item, 'Could not save the vote.', true); } return; }
  hub.mine = mine;
  if (hub.mode === 'server') { try { applyServer(await hubPost('/api/hub/vote', { item, v: next })); } catch (e) { hubMsg(item, e.message, true); } }
  else { hubLocalAgg(); hubLocalSave(); }
  renderHub();
}
async function addCase(item, f) {
  const c = { item, where: f.where.trim().slice(0, 300), quote: f.quote.trim().slice(0, 800), why: f.why.trim().slice(0, 400), by: f.by.trim().slice(0, 60), at: now(), status: 'pending' };
  if (c.quote.length < 10) throw new Error('Quote at least ten characters of the passage.');
  if (hub.mode === 'db') { await hub.db.collection('cases').add(c); return; }
  if (hub.mode === 'server') { const j = await hubPost('/api/hub/case', c); hub.cases.unshift(j.case); }
  else { hub.cases.unshift({ id: Math.random().toString(36).slice(2), ...c }); hubLocalSave(); }
  renderHub();
}
async function addPrompt(item, f) {
  const p = { item, text: f.text.trim().slice(0, 4000), by: f.by.trim().slice(0, 60), at: now() };
  if (p.text.length < 20) throw new Error('Write at least twenty characters of prompt.');
  if (hub.mode === 'db') { await hub.db.collection('prompts').add(p); return; }
  if (hub.mode === 'server') { const j = await hubPost('/api/hub/prompt', p); hub.prompts.unshift(j.prompt); }
  else { hub.prompts.unshift({ id: Math.random().toString(36).slice(2), ...p }); hubLocalSave(); }
  renderHub();
}
async function upPrompt(id) {
  if (!hub.canWrite) return;
  const ids = { ...hub.mineUps }; if (ids[id]) delete ids[id]; else ids[id] = 1;
  if (hub.mode === 'db') { try { await hub.db.doc('promptups/' + hub.uid).set({ ids, at: now() }); } catch (_) { /* ignore */ } return; }
  hub.mineUps = ids;
  if (hub.mode === 'server') { try { applyServer(await hubPost('/api/hub/prompt_up', { id })); } catch (_) { /* ignore */ } }
  else { hubLocalAgg(); hubLocalSave(); }
  renderHub();
}
function hubMsg(item, text, err) { const el = document.querySelector(`#hub-${item} .fmsg`); if (el) { el.textContent = text; el.classList.toggle('err', !!err); } }
function hubRank() {
  const net = id => { const v = hub.votes[id] || { up: 0, down: 0 }; return v.up - v.down; };
  return [...ITEMS].sort((a, b) => net(b.id) - net(a.id) || ((hub.votes[b.id] || {}).up || 0) - ((hub.votes[a.id] || {}).up || 0) || a.id.localeCompare(b.id));
}
function promptBox(title, text, id, meta) {
  const box = h('div', { class: 'pm' }, h('div', { class: 'pm-h' }, h('b', { text: title }), h('span', { class: 'acts' },
    h('button', { type: 'button', text: 'Copy', onclick: async e => { try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; setTimeout(() => e.target.textContent = 'Copy', 1500); } catch (_) { const r = document.createRange(); r.selectNodeContents(box.querySelector('pre')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } } }),
    h('a', { href: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text), download: 'fix-' + id + '.md', text: 'Download .md' }))), h('pre', { text }));
  if (meta) box.append(meta);
  return box;
}
function form(fields, submitLabel, onSubmit, openLabel) {
  const f = h('form', { hidden: !!openLabel }); const els = {};
  for (const [name, placeholder, kind] of fields) { els[name] = h(kind === 'area' ? 'textarea' : 'input', { 'data-f': name, placeholder, 'aria-label': placeholder, ...(kind === 'area' ? {} : { type: 'text' }) }); if (kind === 'row') continue; f.append(els[name]); }
  const row = h('div', { class: 'frow' }); const msg = h('span', { class: 'fmsg' });
  for (const [name] of fields.filter(x => x[2] === 'row')) row.append(els[name]);
  row.append(h('button', { class: 'btn small', type: 'submit', text: submitLabel }), msg); f.append(row);
  f.addEventListener('submit', async e => { e.preventDefault(); msg.className = 'fmsg'; msg.textContent = 'Saving…'; try { await onSubmit(Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value]))); msg.textContent = 'Saved.'; Object.values(els).forEach(el => el.value = ''); } catch (err) { msg.className = 'fmsg err'; msg.textContent = err.message || 'Could not save.'; } });
  if (!openLabel) return f;
  const opener = h('button', { class: 'btn ghost small', type: 'button', text: openLabel, onclick: () => { f.hidden = false; opener.hidden = true; els[fields[0][0]].focus(); } });
  return h('div', {}, opener, f);
}
function voteBtns(id) {
  const v = hub.votes[id] || { up: 0, down: 0 }; const mine = hub.mine[id] || 0;
  return [h('button', { class: 'vb' + (mine === 1 ? ' on' : ''), type: 'button', title: 'I have suffered this', disabled: !hub.canWrite, onclick: e => { e.stopPropagation(); vote(id, 1); } }, '👍 ', h('span', { text: String(v.up) })),
    h('button', { class: 'vb' + (mine === -1 ? ' on' : ''), type: 'button', title: 'Not a real problem', disabled: !hub.canWrite, onclick: e => { e.stopPropagation(); vote(id, -1); } }, '👎 ', h('span', { text: String(v.down) }))];
}
function hubRow(it, rank) {
  const a = it.ar; const v = hub.votes[it.id] || { up: 0, down: 0 }; const mine = hub.mine[it.id] || 0;
  const cases = hub.cases.filter(c => c.item === it.id); const prompts = hub.prompts.filter(p => p.item === it.id).sort((x, y) => (hub.pups[y.id] || 0) - (hub.pups[x.id] || 0));
  const li = h('li', { class: 'hr ' + a.cls + (hubOpen.has(it.id) ? ' open' : ''), id: 'hub-' + it.id });
  const row = h('div', { class: 'hr-row' },
    h('span', { class: 'hr-rank', text: String(rank) }), h('span', { class: 'v-id', text: it.id }), h('span', { class: 'hr-name', text: it.name }), h('span', { class: 'hr-what', text: it.what }),
    h('span', { class: 'hr-meta', text: `${cases.length} case${cases.length === 1 ? '' : 's'} · ${prompts.length + 1} prompt${prompts.length ? 's' : ''}` }),
    h('span', { class: 'votes' }, ...voteBtns(it.id)));
  row.addEventListener('click', e => { if (e.target.closest('button')) return; if (hubOpen.has(it.id)) hubOpen.delete(it.id); else hubOpen.add(it.id); li.classList.toggle('open'); });
  const caseList = h('div', {}, ...(cases.length ? cases.map(c => h('div', { class: 'case' }, h('q', { text: c.quote }), c.why ? h('div', { class: 'cw', text: c.why }) : null,
    h('div', { class: 'cm' }, [c.where, c.by ? 'by ' + c.by : '', c.at ? String(c.at).slice(0, 10) : ''].filter(Boolean).join(' · '), c.status === 'pending' ? h('span', { class: 'pend', text: ' · pending review' }) : null))) : [h('p', { class: 'fmsg', text: 'No case listed yet.' })]));
  const casesBox = h('div', { class: 'hb' }, h('h4', { text: 'Cases' }), caseList, hub.canWrite ? form([['quote', 'The passage, quoted', 'area'], ['why', 'What the reader cannot check (one line)', 'text'], ['where', 'Where: arXiv id, venue, or page', 'row'], ['by', 'Your name (optional)', 'row']], 'Add case', f => addCase(it.id, f), 'Add a case') : null);
  const promptsBox = h('div', { class: 'hb' }, h('h4', { text: 'Fix prompt' }), promptBox('fix-' + it.id + '.md', PROMPTS[it.id], it.id),
    ...prompts.map(p => h('div', { class: 'cp' }, h('div', {}, h('pre', { text: p.text }), h('div', { class: 'cm', text: [p.by ? 'by ' + p.by : 'anonymous', String(p.at || '').slice(0, 10)].filter(Boolean).join(' · ') })),
      h('button', { class: 'vb' + (hub.mineUps[p.id] ? ' on' : ''), type: 'button', disabled: !hub.canWrite, onclick: () => upPrompt(p.id) }, '👍 ', h('span', { text: String(hub.pups[p.id] || 0) })))),
    hub.canWrite ? form([['text', 'Your prompt for fixing this slop', 'area'], ['by', 'Your name (optional)', 'row']], 'Share prompt', f => addPrompt(it.id, f), 'Share your prompt') : null);
  li.append(row, h('div', { class: 'hr-body' }, casesBox, promptsBox));
  return li;
}
function renderHub() {
  const host = $('#hub'); if (!host) return;
  const saved = {}; host.querySelectorAll('.hr').forEach(li => { const vals = {}; li.querySelectorAll('[data-f]').forEach(el => { if (el.value) vals[el.closest('.hb').querySelector('h4').textContent + '/' + el.dataset.f] = el.value; }); if (Object.keys(vals).length) saved[li.id] = vals; });
  host.replaceChildren(...hubRank().map((it, i) => hubRow(it, i + 1)));
  for (const [id, vals] of Object.entries(saved)) { const li = document.getElementById(id); if (!li) continue; li.querySelectorAll('[data-f]').forEach(el => { const k = el.closest('.hb').querySelector('h4').textContent + '/' + el.dataset.f; if (vals[k]) el.value = vals[k]; }); }
  const total = Object.values(hub.votes).reduce((n, v) => n + (v.up || 0) + (v.down || 0), 0);
  $('#hub-status').textContent = (hub.mode === 'db' ? 'Shared with everyone who opens this page' : hub.mode === 'server' ? 'Live' : 'Saved in this browser only') + ` · ${total} vote${total === 1 ? '' : 's'} · ${hub.cases.length} case${hub.cases.length === 1 ? '' : 's'}`;
  document.querySelectorAll('[data-votes]').forEach(el => el.replaceChildren(...voteBtns(el.dataset.votes)));
  document.querySelectorAll('.slop').forEach(card => { const id = card.id; const v = hub.votes[id] || { up: 0, down: 0 }; const n = hub.cases.filter(c => c.item === id).length; let line = card.querySelector('.hubline'); if (!line) { line = h('div', { class: 'hubline' }); card.append(line); } line.replaceChildren(h('span', { text: `👍 ${v.up}` }), h('span', { text: `${n} case${n === 1 ? '' : 's'}` }), h('a', { href: '#hub-' + id, 'data-xref': 'hub-' + id, text: 'Seen it? →' })); });
}
// ------------------------------------------------------------------ tabs, chips, expand, deep links
const TABS = ['paper', 'defs', 'found', 'cues', 'hub'];
function showTab(name) {
  for (const t of TABS) $('#tab-' + t).hidden = t !== name;
  document.querySelectorAll('.v-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'paper') requestAnimationFrame(layoutSpecimen);
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.v-tab'); if (!b) return; history.replaceState({}, '', '#' + b.dataset.tab); showTab(b.dataset.tab); $('#tabs').scrollIntoView({ block: 'start' }); });
const chips = $('#area-chips'); let area = 0;
chips.append(h('button', { class: 'chip-b on', type: 'button', 'data-area': '0', text: 'All 17' }), ...GROUPS.map(a => h('button', { class: 'chip-b ' + a.cls, type: 'button', 'data-area': a.n, title: a.q, text: a.title })));
function apply() { document.querySelectorAll('.v-area').forEach(s => s.hidden = area !== 0 && +s.dataset.area !== area); chips.querySelectorAll('.chip-b').forEach(b => b.classList.toggle('on', +b.dataset.area === area)); }
chips.addEventListener('click', e => { const b = e.target.closest('.chip-b'); if (!b) return; area = +b.dataset.area; apply(); });
const expand = $('#expand');
expand.addEventListener('click', () => { const ms = [...document.querySelectorAll('.e-open')]; const open = ms.some(d => !d.open); ms.forEach(d => d.open = open); expand.textContent = open ? 'Hide all examples' : 'Show all examples'; });
function openHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const alias = { def: 'defs', definitions: 'defs', paper: 'paper', analyses: 'found', findings: 'found', cue: 'cues', vote: 'hub', registry: 'defs' };
  if (alias[id]) { history.replaceState({}, '', '#' + alias[id]); showTab(alias[id]); $('#tabs').scrollIntoView({ block: 'start' }); return; }
  if (TABS.includes(id)) { showTab(id); if (id === 'hub') $('#tabs').scrollIntoView({ block: 'start' }); return; }
  if (/^hub-\d-\d$/.test(id)) { showTab('hub'); hubOpen.add(id.slice(4)); renderHub(); const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'start' }); return; }
  if (/^f\d$/.test(id)) { showTab('found'); const el = document.getElementById(id); if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } return; }
  if (/^area-\d$/.test(id)) { showTab('defs'); area = 0; apply(); const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'start' }); return; }
  const d = id && document.getElementById(id);
  if (d && d.classList.contains('slop')) { showTab('defs'); area = 0; apply(); d.querySelector('.e-open').open = true; d.scrollIntoView({ block: 'start' }); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 1600); }
}
document.addEventListener('click', e => { const a = e.target.closest('a[data-xref], a.ql, a.atile'); if (!a) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); openHash(); });
addEventListener('hashchange', openHash);
addEventListener('resize', () => { if (!$('#tab-paper').hidden) layoutSpecimen(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!$('#tab-paper').hidden) layoutSpecimen(); });
$('#spec-list').replaceChildren(...['2-1', '1-2', '5-1', '4-1', '1-4', '5-4', '4-2', '5-2', '4-5', '3-1', '4-3', '2-3', '5-3', '4-4', '1-3', '2-2', '1-1'].map(id => sideCard(BY_ID[id])));
openHash(); if (!$('#tab-paper').hidden) layoutSpecimen();
hubInit();
