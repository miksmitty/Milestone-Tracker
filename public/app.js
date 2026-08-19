/* Milestone Tracker frontend — CSV-backed editor + SVG gantt. */

const RAG_COLORS = {
  Green: { base: '#16a34a', light: '#4ade80', dark: '#166534' },
  Amber: { base: '#f59e0b', light: '#fcd34d', dark: '#92400e' },
  Red:   { base: '#dc2626', light: '#f87171', dark: '#7f1d1d' },
};
const LANE_ACCENTS = ['#4f46e5', '#0891b2', '#c026d3', '#ea580c', '#0d9488', '#7c3aed', '#db2777'];
const SHAPES = ['diamond', 'triangle', 'square'];
const RAGS = ['Green', 'Amber', 'Red'];
const MS_DAY = 86400000;

const state = {
  milestones: [],       // {name, description, rag, date, shape, swimlane}
  pxPerDay: 6,
  rangeStart: null,     // Date
  rangeEnd: null,       // Date
  showMonths: true,
  showQuarters: true,
  showToday: true,
  userZoomed: false, // once the user touches zoom, stop auto-fitting on resize
};

/* ================= CSV ================= */

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function toCSV(milestones) {
  const lines = ['name,description,rag,date,shape,swimlane'];
  for (const m of milestones) {
    lines.push([m.name, m.description, m.rag, m.date, m.shape, m.swimlane].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

function rowsToMilestones(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const [iN, iD, iR, iDt, iS, iL] = ['name', 'description', 'rag', 'date', 'shape', 'swimlane'].map(idx);
  return rows.slice(1).map(r => ({
    name: r[iN] ?? '',
    description: r[iD] ?? '',
    rag: normaliseRag(r[iR]),
    date: (r[iDt] ?? '').trim(),
    shape: normaliseShape(r[iS]),
    swimlane: (r[iL] ?? '').trim() || 'General',
  }));
}

function normaliseRag(v) {
  const s = (v ?? '').trim().toLowerCase();
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('a') || s.startsWith('y')) return 'Amber';
  return 'Green';
}
function normaliseShape(v) {
  const s = (v ?? '').trim().toLowerCase();
  return SHAPES.includes(s) ? s : 'diamond';
}

/* ================= data load/save ================= */

async function loadData() {
  const res = await fetch('/api/milestones');
  const text = await res.text();
  state.milestones = rowsToMilestones(parseCSV(text));
  autoRange();
}

async function saveData() {
  syncEditorToState();
  const res = await fetch('/api/milestones', { method: 'POST', body: toCSV(state.milestones) });
  const out = await res.json().catch(() => ({ ok: false }));
  flashStatus(out.ok ? 'Saved ✓' : 'Save failed', out.ok);
  return out.ok;
}

function flashStatus(msg, ok) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + (ok ? 'ok' : 'err');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 3000);
}

/* ================= date helpers ================= */

function parseDate(s) {
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? null : d;
}
function fmtISO(d) {
  return d.toISOString().slice(0, 10);
}
function fmtNice(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function autoRange() {
  const dates = state.milestones.map(m => parseDate(m.date)).filter(Boolean);
  if (!dates.length) {
    const now = new Date();
    state.rangeStart = new Date(now.getFullYear(), 0, 1);
    state.rangeEnd = new Date(now.getFullYear(), 11, 31);
  } else {
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    state.rangeStart = new Date(min.getFullYear(), min.getMonth(), 1);
    state.rangeEnd = new Date(max.getFullYear(), max.getMonth() + 1, 0);
    // pad by ~half a month each side
    state.rangeStart = new Date(state.rangeStart.getTime() - 14 * MS_DAY);
    state.rangeEnd = new Date(state.rangeEnd.getTime() + 14 * MS_DAY);
  }
  document.getElementById('range-start').value = fmtISO(state.rangeStart);
  document.getElementById('range-end').value = fmtISO(state.rangeEnd);
}

/* ================= gantt rendering ================= */

const LANE_LABEL_W = 170;
const PAD_RIGHT = 30;
const QUARTER_H = 26;
const MONTH_H = 24;
const SUBROW_H = 58;
const LANE_PAD = 10;

function svgEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}

function estimateLabelWidth(m) {
  const nameW = m.name.length * 6.8;
  const dateW = 62;
  return Math.max(nameW, dateW) + 30; // shape + gap
}

function layoutLanes(ms, xOf) {
  // Group by swimlane preserving first-appearance order, then pack into subrows.
  const laneOrder = [];
  const laneMap = new Map();
  for (const m of ms) {
    if (!laneMap.has(m.swimlane)) { laneMap.set(m.swimlane, []); laneOrder.push(m.swimlane); }
    laneMap.get(m.swimlane).push(m);
  }
  return laneOrder.map(name => {
    const items = laneMap.get(name).slice().sort((a, b) => a._d - b._d);
    const subrowEnds = [];
    for (const m of items) {
      const x = xOf(m._d);
      const end = x + estimateLabelWidth(m);
      let placed = false;
      for (let r = 0; r < subrowEnds.length; r++) {
        if (x - 14 > subrowEnds[r]) { m._row = r; subrowEnds[r] = end; placed = true; break; }
      }
      if (!placed) { m._row = subrowEnds.length; subrowEnds.push(end); }
    }
    return { name, items, rows: Math.max(1, subrowEnds.length) };
  });
}

function drawShape(parent, shape, cx, cy, rag) {
  const c = RAG_COLORS[rag] || RAG_COLORS.Green;
  const s = 9; // half-size
  let el;
  if (shape === 'diamond') {
    el = svgEl('path', { d: `M ${cx} ${cy - s - 2} L ${cx + s + 2} ${cy} L ${cx} ${cy + s + 2} L ${cx - s - 2} ${cy} Z` });
  } else if (shape === 'triangle') {
    el = svgEl('path', { d: `M ${cx} ${cy - s - 2} L ${cx + s + 1} ${cy + s} L ${cx - s - 1} ${cy + s} Z` });
  } else {
    el = svgEl('rect', { x: cx - s, y: cy - s, width: s * 2, height: s * 2, rx: 2.5 });
  }
  el.setAttribute('fill', `url(#grad-${rag})`);
  el.setAttribute('stroke', c.dark);
  el.setAttribute('stroke-width', '1.4');
  el.setAttribute('filter', 'url(#ms-shadow)');
  parent.appendChild(el);
}

function renderGantt() {
  const container = document.getElementById('gantt-container');
  container.innerHTML = '';

  const ms = state.milestones
    .map(m => ({ ...m, _d: parseDate(m.date) }))
    .filter(m => m._d && m._d >= state.rangeStart && m._d <= state.rangeEnd);

  const totalDays = Math.max(1, (state.rangeEnd - state.rangeStart) / MS_DAY);
  const chartW = totalDays * state.pxPerDay;
  const xOf = (d) => LANE_LABEL_W + ((d - state.rangeStart) / MS_DAY) * state.pxPerDay;

  const headerH = (state.showQuarters ? QUARTER_H : 0) + (state.showMonths ? MONTH_H : 0);
  const lanes = layoutLanes(ms, xOf);
  const laneHeights = lanes.map(l => l.rows * SUBROW_H + LANE_PAD * 2);
  const bodyH = laneHeights.reduce((a, b) => a + b, 0) || 120;
  const width = LANE_LABEL_W + chartW + PAD_RIGHT;
  const height = headerH + bodyH + 8;

  const svg = svgEl('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`,
    xmlns: 'http://www.w3.org/2000/svg',
    style: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
  });

  // defs: RAG gradients + drop shadow
  const defs = svgEl('defs', {});
  for (const rag of RAGS) {
    const c = RAG_COLORS[rag];
    const g = svgEl('linearGradient', { id: `grad-${rag}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': c.light }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': c.base }));
    defs.appendChild(g);
  }
  const f = svgEl('filter', { id: 'ms-shadow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  f.appendChild(svgEl('feDropShadow', { dx: 0, dy: 1.2, stdDeviation: 1.2, 'flood-color': '#0f172a', 'flood-opacity': '0.30' }));
  defs.appendChild(f);
  svg.appendChild(defs);

  // background
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: '#ffffff' }));

  // lane backgrounds (alternating) + labels
  let y = headerH;
  lanes.forEach((lane, i) => {
    const h = laneHeights[i];
    if (i % 2 === 1) {
      svg.appendChild(svgEl('rect', { x: 0, y, width, height: h, fill: '#f8fafc' }));
    }
    // accent bar + lane name
    const accent = LANE_ACCENTS[i % LANE_ACCENTS.length];
    svg.appendChild(svgEl('rect', { x: 0, y: y + 6, width: 4, height: h - 12, rx: 2, fill: accent }));
    svg.appendChild(svgEl('text', {
      x: 16, y: y + h / 2 + 5, 'font-size': 14, 'font-weight': 700, fill: '#1e293b',
    }, lane.name));
    svg.appendChild(svgEl('line', { x1: 0, y1: y + h, x2: width, y2: y + h, stroke: '#e2e8f0', 'stroke-width': 1 }));
    lane._y = y;
    y += h;
  });

  // vertical separator between labels and chart
  svg.appendChild(svgEl('line', { x1: LANE_LABEL_W, y1: 0, x2: LANE_LABEL_W, y2: height, stroke: '#cbd5e1', 'stroke-width': 1 }));

  // ---- month / quarter grid + headers ----
  const gridTop = headerH;
  const gridBottom = headerH + bodyH;

  // iterate month boundaries within range
  const firstMonth = new Date(state.rangeStart.getFullYear(), state.rangeStart.getMonth(), 1);
  const months = [];
  for (let d = new Date(firstMonth); d <= state.rangeEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push(new Date(d));
  }

  if (state.showMonths) {
    const bandY = state.showQuarters ? QUARTER_H : 0;
    svg.appendChild(svgEl('rect', { x: LANE_LABEL_W, y: bandY, width: chartW, height: MONTH_H, fill: '#f1f5f9' }));
    for (const m of months) {
      const x1 = Math.max(LANE_LABEL_W, xOf(m));
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      const x2 = Math.min(width - PAD_RIGHT + 10, xOf(next));
      if (x2 - x1 < 4) continue;
      // grid line
      if (xOf(m) >= LANE_LABEL_W) {
        svg.appendChild(svgEl('line', { x1: xOf(m), y1: bandY, x2: xOf(m), y2: gridBottom, stroke: '#e2e8f0', 'stroke-width': 1 }));
      }
      const label = (x2 - x1) > 58
        ? m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', ' ’')
        : m.toLocaleDateString('en-GB', { month: 'short' });
      if (x2 - x1 > 28) {
        svg.appendChild(svgEl('text', {
          x: (x1 + x2) / 2, y: bandY + MONTH_H / 2 + 4, 'text-anchor': 'middle',
          'font-size': 11.5, 'font-weight': 600, fill: '#475569',
        }, label));
      }
    }
    svg.appendChild(svgEl('line', { x1: LANE_LABEL_W, y1: bandY + MONTH_H, x2: width, y2: bandY + MONTH_H, stroke: '#cbd5e1', 'stroke-width': 1 }));
  }

  if (state.showQuarters) {
    svg.appendChild(svgEl('rect', { x: LANE_LABEL_W, y: 0, width: chartW, height: QUARTER_H, fill: '#e0e7ff' }));
    // quarter starts: months where month % 3 === 0
    const qStarts = months.filter(m => m.getMonth() % 3 === 0);
    // ensure the partial quarter at range start gets a label
    const firstQ = new Date(state.rangeStart.getFullYear(), Math.floor(state.rangeStart.getMonth() / 3) * 3, 1);
    if (!qStarts.length || qStarts[0] > firstQ) qStarts.unshift(firstQ);
    for (const q of qStarts) {
      const qx = xOf(q);
      const next = new Date(q.getFullYear(), q.getMonth() + 3, 1);
      const x1 = Math.max(LANE_LABEL_W, qx);
      const x2 = Math.min(width - PAD_RIGHT + 10, xOf(next));
      if (x2 - x1 < 8) continue;
      if (qx >= LANE_LABEL_W) {
        svg.appendChild(svgEl('line', { x1: qx, y1: 0, x2: qx, y2: gridBottom, stroke: '#94a3b8', 'stroke-width': 1.2 }));
      }
      const qNum = Math.floor(q.getMonth() / 3) + 1;
      if (x2 - x1 > 44) {
        svg.appendChild(svgEl('text', {
          x: (x1 + x2) / 2, y: QUARTER_H / 2 + 4.5, 'text-anchor': 'middle',
          'font-size': 12.5, 'font-weight': 700, fill: '#3730a3',
        }, `Q${qNum} ${q.getFullYear()}`));
      }
    }
    svg.appendChild(svgEl('line', { x1: LANE_LABEL_W, y1: QUARTER_H, x2: width, y2: QUARTER_H, stroke: '#cbd5e1', 'stroke-width': 1 }));
  }

  // ---- today line ----
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (state.showToday && today >= state.rangeStart && today <= state.rangeEnd) {
    const tx = xOf(today);
    svg.appendChild(svgEl('line', {
      x1: tx, y1: gridTop, x2: tx, y2: gridBottom,
      stroke: '#ef4444', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
    }));
    const pill = svgEl('g', {});
    pill.appendChild(svgEl('rect', { x: tx - 24, y: gridTop + 4, width: 48, height: 17, rx: 8.5, fill: '#ef4444' }));
    pill.appendChild(svgEl('text', { x: tx, y: gridTop + 16, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#fff' }, 'TODAY'));
    svg.appendChild(pill);
  }

  // ---- milestones ----
  for (const lane of lanes) {
    for (const m of lane.items) {
      const cx = xOf(m._d);
      const cy = lane._y + LANE_PAD + m._row * SUBROW_H + SUBROW_H / 2 - 6;
      // stem down to lane bottom for readability
      svg.appendChild(svgEl('line', {
        x1: cx, y1: cy + 12, x2: cx, y2: lane._y + laneHeights[lanes.indexOf(lane)] - 6,
        stroke: '#cbd5e1', 'stroke-width': 1, 'stroke-dasharray': '2 3',
      }));
      const g = svgEl('g', {});
      g.appendChild(svgEl('title', {}, `${m.name} — ${fmtNice(m._d)} [${m.rag}]\n${m.description}`));
      drawShape(g, m.shape, cx, cy, m.rag);
      g.appendChild(svgEl('text', {
        x: cx + 16, y: cy + 1, 'font-size': 12.5, 'font-weight': 600, fill: '#1e293b',
      }, m.name));
      g.appendChild(svgEl('text', {
        x: cx + 16, y: cy + 15, 'font-size': 10.5, fill: '#64748b',
      }, m._d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
      svg.appendChild(g);
    }
  }

  container.appendChild(svg);
}

/* ================= zoom / range controls ================= */

function setZoom(px) {
  state.pxPerDay = Math.min(30, Math.max(1, px));
  document.getElementById('zoom-slider').value = state.pxPerDay;
  renderGantt();
}

function fitZoom() {
  const wrap = document.getElementById('gantt-scroll');
  const totalDays = Math.max(1, (state.rangeEnd - state.rangeStart) / MS_DAY);
  const avail = wrap.clientWidth - LANE_LABEL_W - PAD_RIGHT - 2;
  setZoom(avail / totalDays);
}

/* ================= editor ================= */

function optionList(values, selected) {
  return values.map(v => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

function renderEditor() {
  const body = document.getElementById('editor-body');
  body.innerHTML = '';
  state.milestones.forEach((m, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-i="${i}" data-k="name" value="${escAttr(m.name)}" placeholder="Milestone name" /></td>
      <td><input data-i="${i}" data-k="description" value="${escAttr(m.description)}" placeholder="Description" /></td>
      <td><select data-i="${i}" data-k="rag" class="rag-${m.rag}">${optionList(RAGS, m.rag)}</select></td>
      <td><input data-i="${i}" data-k="date" type="date" value="${escAttr(m.date)}" /></td>
      <td><select data-i="${i}" data-k="shape">${optionList(SHAPES, m.shape)}</select></td>
      <td><input data-i="${i}" data-k="swimlane" value="${escAttr(m.swimlane)}" list="lane-list" placeholder="Swimlane" /></td>
      <td><button class="btn-del" data-del="${i}" title="Delete row">✕</button></td>`;
    body.appendChild(tr);
  });
  // datalist of existing lanes for quick reuse
  let dl = document.getElementById('lane-list');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'lane-list';
    document.body.appendChild(dl);
  }
  dl.innerHTML = [...new Set(state.milestones.map(m => m.swimlane))]
    .map(l => `<option value="${escAttr(l)}"></option>`).join('');
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function syncEditorToState() {
  document.querySelectorAll('#editor-body [data-i]').forEach(el => {
    state.milestones[+el.dataset.i][el.dataset.k] = el.value;
  });
}

/* ================= PNG export ================= */

function downloadPNG() {
  const svg = document.querySelector('#gantt-container svg');
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2; // retina-quality export
    const canvas = document.createElement('canvas');
    canvas.width = svg.width.baseVal.value * scale;
    canvas.height = svg.height.baseVal.value * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.download = 'milestone-gantt.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = url;
}

/* ================= wiring ================= */

function switchView(view) {
  const gantt = view === 'gantt';
  if (!gantt) {
    renderEditor();
  } else {
    syncEditorToState();
    renderGantt();
  }
  document.getElementById('view-gantt').classList.toggle('hidden', !gantt);
  document.getElementById('view-editor').classList.toggle('hidden', gantt);
  document.getElementById('tab-gantt').classList.toggle('active', gantt);
  document.getElementById('tab-editor').classList.toggle('active', !gantt);
}

function wireEvents() {
  document.getElementById('tab-gantt').onclick = () => switchView('gantt');
  document.getElementById('tab-editor').onclick = () => switchView('editor');

  document.getElementById('zoom-in').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay * 1.3); };
  document.getElementById('zoom-out').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay / 1.3); };
  document.getElementById('zoom-fit').onclick = () => { state.userZoomed = false; fitZoom(); };
  document.getElementById('zoom-slider').oninput = (e) => { state.userZoomed = true; setZoom(+e.target.value); };

  document.getElementById('range-start').onchange = (e) => {
    const d = parseDate(e.target.value);
    if (d) { state.rangeStart = d; renderGantt(); }
  };
  document.getElementById('range-end').onchange = (e) => {
    const d = parseDate(e.target.value);
    if (d) { state.rangeEnd = d; renderGantt(); }
  };
  document.getElementById('range-auto').onclick = () => { autoRange(); renderGantt(); };

  document.getElementById('toggle-months').onchange = (e) => { state.showMonths = e.target.checked; renderGantt(); };
  document.getElementById('toggle-quarters').onchange = (e) => { state.showQuarters = e.target.checked; renderGantt(); };
  document.getElementById('toggle-today').onchange = (e) => { state.showToday = e.target.checked; renderGantt(); };

  document.getElementById('btn-png').onclick = downloadPNG;

  document.getElementById('btn-add').onclick = () => {
    syncEditorToState();
    state.milestones.push({
      name: 'New milestone', description: '', rag: 'Green',
      date: fmtISO(new Date()), shape: 'diamond',
      swimlane: state.milestones.at(-1)?.swimlane || 'General',
    });
    renderEditor();
  };
  document.getElementById('btn-sort').onclick = () => {
    syncEditorToState();
    state.milestones.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    renderEditor();
  };
  document.getElementById('btn-save').onclick = saveData;
  document.getElementById('btn-reload').onclick = async () => {
    await loadData();
    renderEditor();
    flashStatus('Reloaded', true);
  };

  // live RAG colour + delete buttons (event delegation)
  document.getElementById('editor-body').addEventListener('change', (e) => {
    if (e.target.dataset.k === 'rag') e.target.className = 'rag-' + e.target.value;
  });
  document.getElementById('editor-body').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      syncEditorToState();
      state.milestones.splice(+del.dataset.del, 1);
      renderEditor();
    }
  });

  // Auto-fit while the user hasn't chosen a zoom; re-render otherwise.
  new ResizeObserver(() => {
    if (document.getElementById('view-gantt').classList.contains('hidden')) return;
    if (state.userZoomed) renderGantt();
    else fitZoom();
  }).observe(document.getElementById('gantt-scroll'));
}

(async function init() {
  wireEvents();
  await loadData();
  fitZoom(); // also renders; the ResizeObserver keeps it fitted as layout settles
})();
