/* Milestone Tracker frontend — CSV-backed editor + SVG gantt.
 * An item whose start is before its end is a task (drawn as a bar); otherwise it
 * is a milestone (drawn as a shape). Tasks can roll up to a milestone, and any
 * item can depend on others (finish-to-start) — date changes cascade downstream.
 *
 * `id` is the primary key: an integer, unique, immutable and never reused. All links
 * (parent, depends_on) reference ids. `ref` (e.g. 4.1) is the human-facing label.
 *
 * Periodic status reports live in a second record set (reports.csv); each report
 * points at the item it covers through `item_id`. */

const STATUS = {
  'Green':       { base: '#16a34a', light: '#4ade80', dark: '#166534', text: '#ffffff' },
  'Amber':       { base: '#f59e0b', light: '#fcd34d', dark: '#92400e', text: '#422006' },
  'Red':         { base: '#dc2626', light: '#f87171', dark: '#7f1d1d', text: '#ffffff' },
  'Complete':    { base: '#2563eb', light: '#60a5fa', dark: '#1e3a8a', text: '#ffffff' },
  'Not Started': { base: '#94a3b8', light: '#cbd5e1', dark: '#475569', text: '#1e293b' },
};
const STATUSES = Object.keys(STATUS);
const statusSlug = (s) => s.replace(/\s+/g, '');
const SHAPES = ['diamond', 'circle', 'square', 'triangle'];
const LANE_ACCENTS = ['#4f46e5', '#0891b2', '#c026d3', '#ea580c', '#0d9488', '#7c3aed', '#db2777'];
const COLUMNS = ['id', 'ref', 'title', 'description', 'swimlane', 'subswimlane', 'owner', 'start', 'end', 'status', 'shape', 'parent', 'depends_on'];
const MS_DAY = 86400000;

const state = {
  items: [],            // {id, ref, title, description, swimlane, subswimlane, owner, start, end, status, shape, parent, deps[]}
  lastId: 0,            // highest id ever issued this session, so ids are never reused
  reports: [],          // {id, item_id, cadence, period_start, period_end, status, exec_summary, achievements, next_steps, get_to_green, author, created, updated}
  lastReportId: 0,
  pxPerDay: 6,
  rowH: 40,
  rangeStart: null,     // Date
  rangeEnd: null,       // Date
  showMonths: true,
  showQuarters: true,
  showToday: true,
  showLinks: true,
  userZoomed: false, // once the user touches zoom, stop auto-fitting on resize
};

const isTask = (m) => !!(m.start && m.end && m.start < m.end);
const itemLabel = (m) => m.ref || `#${m.id}`;
const fullLabel = (m) => (m.ref ? `${m.ref} ${m.title}` : m.title);
const cmpRef = (a, b) => (!a.ref) - (!b.ref) || a.ref.localeCompare(b.ref, undefined, { numeric: true });

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

function toCSV(items) {
  const lines = [COLUMNS.join(',')];
  for (const m of items) {
    lines.push([m.id, m.ref, m.title, m.description, m.swimlane, m.subswimlane, m.owner, m.start, m.end,
      m.status, m.shape, m.parent, m.deps.join(';')].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

// Header names are matched loosely; legacy columns (name, date, rag) still load.
const HEADER_ALIASES = {
  id: ['id'],
  ref: ['ref', 'reference'],
  title: ['title', 'name'],
  description: ['description', 'desc'],
  swimlane: ['swimlane', 'lane'],
  subswimlane: ['subswimlane', 'sublane'],
  owner: ['owner'],
  start: ['start', 'startdate'],
  end: ['end', 'enddate', 'date'],
  status: ['status', 'rag'],
  shape: ['shape'],
  parent: ['parent', 'rollsupto', 'rollup'],
  deps: ['dependson', 'dependencies', 'deps'],
};

function rowsToItems(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const col = {};
  for (const k in HEADER_ALIASES) col[k] = HEADER_ALIASES[k].map(a => header.indexOf(a)).find(i => i >= 0) ?? -1;
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] ?? '' : '').trim();

  const items = rows.slice(1).map(r => {
    let start = get(r, 'start'), end = get(r, 'end');
    if (!start) start = end;
    if (!end) end = start;
    if (end < start) end = start;
    return {
      id: get(r, 'id'),
      ref: get(r, 'ref'),
      title: get(r, 'title'),
      description: get(r, 'description'),
      swimlane: get(r, 'swimlane') || 'General',
      subswimlane: get(r, 'subswimlane'),
      owner: get(r, 'owner'),
      start, end,
      status: normaliseStatus(get(r, 'status')),
      shape: normaliseShape(get(r, 'shape')),
      parent: get(r, 'parent'),
      deps: get(r, 'deps').split(/[;|\s]+/).filter(Boolean),
    };
  });

  // Primary key: keep valid unique integer ids; issue new ones for missing/duplicate/invalid.
  const seen = new Set();
  let last = Math.max(0, ...items.map(m => (/^\d+$/.test(m.id) ? +m.id : 0)));
  for (const m of items) {
    if (!/^\d+$/.test(m.id) || seen.has(m.id)) m.id = String(++last);
    seen.add(m.id);
  }
  state.lastId = last;
  for (const m of items) {
    m.deps = [...new Set(m.deps)].filter(d => seen.has(d) && d !== m.id);
    if (!seen.has(m.parent) || m.parent === m.id) m.parent = '';
  }
  return items;
}

function nextId() {
  state.lastId = Math.max(state.lastId, ...state.items.map(m => +m.id || 0)) + 1;
  return String(state.lastId);
}

function normaliseStatus(v) {
  const s = (v ?? '').trim().toLowerCase();
  if (s.startsWith('green') || s === 'g') return 'Green';
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('a') || s.startsWith('y')) return 'Amber';
  if (s.startsWith('b') || s.startsWith('c') || s.startsWith('done')) return 'Complete';
  return 'Not Started';
}
function normaliseShape(v) {
  const s = (v ?? '').trim().toLowerCase();
  return SHAPES.includes(s) ? s : 'diamond';
}

/* ================= data load/save ================= */

async function loadData() {
  const [items, reports] = await Promise.all(['/api/milestones', '/api/reports'].map(u => fetch(u).then(r => r.text())));
  state.items = rowsToItems(parseCSV(items));
  state.reports = rowsToReports(parseCSV(reports));
  autoRange();
}

// Every change is written back to its CSV. Saves are queued so they reach the server in order.
let saveQueue = Promise.resolve();
let saveTimer = null;
let pendingMsg = '';

function saveData(msg) {
  syncEditorToState();
  return saveCSV('/api/milestones', toCSV(state.items), msg);
}
function saveReports(msg) {
  return saveCSV('/api/reports', reportsToCSV(state.reports), msg);
}

function saveCSV(url, body, msg) { // body is snapshotted by the caller, even if the queue is busy
  saveQueue = saveQueue.then(async () => {
    flashStatus('Saving…', null);
    try {
      const res = await fetch(url, { method: 'POST', body });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || 'server error');
      flashStatus([msg, 'Saved ✓'].filter(Boolean).join(' · '), true);
      return true;
    } catch (err) {
      flashStatus(`Save failed (${err.message}) — your changes are still on screen`, false, true);
      return false;
    }
  });
  return saveQueue;
}

// Debounced save for table edits, so a burst of changes becomes one write.
function scheduleSave(msg) {
  if (msg) pendingMsg = msg;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  if (saveTimer === null) return saveQueue;
  clearTimeout(saveTimer);
  saveTimer = null;
  const msg = pendingMsg;
  pendingMsg = '';
  return saveData(msg);
}

function flashStatus(msg, ok, sticky) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  clearTimeout(el._t);
  if (ok !== null && !sticky) el._t = setTimeout(() => { el.textContent = ''; }, 5000);
}

/* ================= date helpers ================= */

function parseDate(s) {
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? null : d;
}
function fmtISO(d) {
  // local date parts — toISOString() would shift to UTC and can land on the previous day
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtNice(iso) {
  return parseDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtShort(iso) {
  return parseDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return fmtISO(d);
}
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / MS_DAY);
}

function autoRange() {
  const dates = state.items.flatMap(m => [parseDate(m.start), parseDate(m.end)]).filter(Boolean);
  if (!dates.length) {
    const now = new Date();
    state.rangeStart = new Date(now.getFullYear(), 0, 1);
    state.rangeEnd = new Date(now.getFullYear(), 11, 31);
  } else {
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    // month-aligned, padded by ~half a month each side
    state.rangeStart = new Date(min.getFullYear(), min.getMonth(), 1 - 14);
    state.rangeEnd = new Date(max.getFullYear(), max.getMonth() + 1, 14);
  }
  document.getElementById('range-start').value = fmtISO(state.rangeStart);
  document.getElementById('range-end').value = fmtISO(state.rangeEnd);
}

/* ================= scheduling ================= */
// Edges run predecessor → successor. Explicit dependencies are finish-to-start;
// a task that rolls up to a milestone must finish on or before that milestone.

function successorMap() {
  const succ = new Map(state.items.map(m => [m.id, []]));
  for (const m of state.items) {
    for (const d of m.deps) succ.get(d)?.push(m.id);
    if (m.parent) succ.get(m.id)?.push(m.parent);
  }
  return succ;
}

// Topological order of ids; shorter than the item list when there is a loop.
function topoOrder() {
  const succ = successorMap();
  const indeg = new Map(state.items.map(m => [m.id, 0]));
  for (const list of succ.values()) for (const s of list) indeg.set(s, indeg.get(s) + 1);
  const queue = state.items.filter(m => !indeg.get(m.id)).map(m => m.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (!indeg.get(s)) queue.push(s);
    }
  }
  return order;
}
const hasCycle = () => topoOrder().length < state.items.length;

function shiftItem(m, n) {
  if (!n || !m.start || !m.end) return;
  m.start = addDays(m.start, n);
  m.end = addDays(m.end, n);
}

// Move everything downstream of `id` (via explicit dependencies) by `delta` days,
// so gaps between linked items are preserved whether the change is earlier or later.
function cascadeShift(id, delta) {
  if (!delta) return;
  const byId = new Map(state.items.map(m => [m.id, m]));
  const depSucc = new Map();
  for (const m of state.items) {
    for (const d of m.deps) {
      if (!depSucc.has(d)) depSucc.set(d, []);
      depSucc.get(d).push(m.id);
    }
  }
  const queue = [...(depSucc.get(id) || [])];
  const seen = new Set([id]);
  while (queue.length) {
    const s = queue.shift();
    if (seen.has(s)) continue;
    seen.add(s);
    shiftItem(byId.get(s), delta);
    queue.push(...(depSucc.get(s) || []));
  }
}

// Push items later wherever a dependency or roll-up is violated (topological order).
// Task → task dependencies start the next day; anything involving a milestone can share the day.
function enforceConstraints() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const children = new Map();
  for (const m of state.items) {
    if (!m.parent) continue;
    if (!children.has(m.parent)) children.set(m.parent, []);
    children.get(m.parent).push(m);
  }
  for (const id of topoOrder()) {
    const m = byId.get(id);
    if (!m.start || !m.end) continue;
    let shift = 0;
    for (const d of m.deps) {
      const p = byId.get(d);
      if (!p.end) continue;
      const lag = isTask(p) && isTask(m) ? 1 : 0;
      shift = Math.max(shift, daysBetween(m.start, addDays(p.end, lag)));
    }
    for (const c of children.get(m.id) || []) {
      if (c.end) shift = Math.max(shift, daysBetween(m.end, c.end));
    }
    shiftItem(m, shift);
  }
}

// Apply field changes to an item, reject loops, and cascade date moves.
// Returns { error } or { moved: [ids whose dates changed] }.
function updateItem(m, changes) {
  const before = { ...m, deps: [...m.deps] };
  Object.assign(m, changes);
  m.deps = [...new Set(m.deps)].filter(d => d !== m.id);
  if (m.parent === m.id) m.parent = '';

  const startChanged = m.start !== before.start, endChanged = m.end !== before.end;
  // A milestone's end date moves the whole milestone; set an earlier start to make it a task.
  if (!isTask(before) && endChanged && !startChanged && m.end) m.start = m.end;
  if (!m.start) m.start = m.end;
  if (!m.end) m.end = m.start;
  if (m.end < m.start) {
    if (startChanged && !endChanged) m.end = m.start; else m.start = m.end;
  }

  if (hasCycle()) {
    Object.assign(m, before);
    return { error: 'That link would create a circular dependency.' };
  }
  const snapshot = new Map(state.items.map(x => [x.id, x.start + x.end]));
  cascadeShift(m.id, before.end && m.end ? daysBetween(before.end, m.end) : 0);
  enforceConstraints();
  return { moved: state.items.filter(x => snapshot.get(x.id) !== x.start + x.end).map(x => x.id) };
}

function movedMessage(m, moved) {
  const parts = [];
  if (moved.includes(m.id)) parts.push(`${itemLabel(m)} moved to ${fmtShort(m.start)} to respect its dependencies`);
  const others = moved.filter(id => id !== m.id).length;
  if (others) parts.push(`${others} downstream item${others > 1 ? 's' : ''} rescheduled`);
  return parts.join(' · ');
}

function removeItem(id) {
  state.items = state.items.filter(m => m.id !== id);
  for (const m of state.items) {
    m.deps = m.deps.filter(d => d !== id);
    if (m.parent === id) m.parent = '';
  }
}

/* ================= gantt rendering ================= */

const LANE_COL_W = 130;
const SUB_COL_W = 130;
const PAD_RIGHT = 30;
const QUARTER_H = 26;
const MONTH_H = 24;
const DETAIL_MIN_ROW_H = 40; // below this, the dates/owner line under each item is hidden

// Sizes derived from the row-height slider.
function rowMetrics() {
  const h = state.rowH;
  const detail = h >= DETAIL_MIN_ROW_H;
  return {
    h, detail,
    pad: Math.round(Math.min(8, h / 5)),
    barH: Math.min(18, h - 12),
    shapeS: Math.min(9, (h - 10) / 2),
    offset: detail ? 6 : 0, // lift the item when a detail line sits beneath it
  };
}

// Label column is wider when any item uses a sub-swimlane.
const hasSubLanes = () => state.items.some(m => m.subswimlane);
const labelWidth = () => (hasSubLanes() ? LANE_COL_W + SUB_COL_W : 170);

function svgEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MAX_LABEL_W = 220; // longer titles are cut with … on the chart (the hover card shows them in full)
const REF_GAP = 5;
const measureCtx = document.createElement('canvas').getContext('2d');

function textW(s, size, weight = 400) {
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(s).width;
}
function truncate(s, px, size, weight = 400) {
  if (textW(s, size, weight) <= px) return s;
  let lo = 0, hi = s.length; // longest prefix that fits with an ellipsis
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textW(s.slice(0, mid).trimEnd() + '…', size, weight) <= px) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + '…';
}

// Fit ref + title into maxW: the ref is kept, the title is truncated.
function fitLabel(m, maxW, size) {
  const refW = m.ref ? textW(m.ref, size, 700) + REF_GAP : 0;
  const title = truncate(m.title, Math.max(24, maxW - refW), size, 600);
  return { title, w: refW + textW(title, size, 600) };
}

function metaText(m) {
  const dates = isTask(m) ? `${fmtShort(m.start)} – ${fmtShort(m.end)}` : fmtShort(m.end);
  return m.owner ? `${dates} · ${m.owner}` : dates;
}

// Title with the ref in bold ahead of it.
function titleText(attrs, m, refFill) {
  const t = svgEl('text', attrs);
  if (m.ref) {
    t.appendChild(svgEl('tspan', { 'font-weight': 700, fill: refFill }, m.ref));
    t.appendChild(svgEl('tspan', { dx: REF_GAP }, m._title));
  } else t.textContent = m._title;
  return t;
}

// Outside labels get a white outline so they stay readable over gridlines and arrows.
const HALO = { 'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': 3, 'stroke-linejoin': 'round' };

function layoutLanes(items, xOf, rm, minX, maxX) {
  // Group by swimlane → sub-swimlane (first-appearance order), then pack each sub-lane into rows.
  const lanes = [], laneMap = new Map();
  for (const m of items) {
    let lane = laneMap.get(m.swimlane);
    if (!lane) {
      lane = { name: m.swimlane, subs: [], subMap: new Map() };
      laneMap.set(m.swimlane, lane);
      lanes.push(lane);
    }
    let sub = lane.subMap.get(m.subswimlane);
    if (!sub) {
      sub = { name: m.subswimlane, items: [] };
      lane.subMap.set(m.subswimlane, sub);
      lane.subs.push(sub);
    }
    sub.items.push(m);
  }
  for (const lane of lanes) {
    for (const sub of lane.subs) {
      sub.items.sort((a, b) => a._s - b._s || a._e - b._e);
      const rowEnds = [];
      for (const m of sub.items) {
        const x1 = xOf(m._s), x2 = xOf(m._e);
        m._meta = rm.detail ? truncate(metaText(m), MAX_LABEL_W, 10.5) : '';
        const metaW = m._meta ? textW(m._meta, 10.5) : 0;
        let left, right;
        const inBar = m._task && fitLabel(m, Infinity, 12);
        if (inBar && inBar.w + 16 <= x2 - x1) {
          // whole title fits inside the bar
          m._side = 'inside';
          m._title = inBar.title;
          left = x1;
          right = Math.max(x2, x1 + metaW);
        } else {
          // label beside the item: to the right, or to the left if it would run off the chart
          const out = fitLabel(m, MAX_LABEL_W, 12.5);
          const labelW = Math.max(out.w, metaW);
          const itemL = m._task ? x1 : x1 - rm.shapeS - 3;
          const itemR = m._task ? x2 : x1 + rm.shapeS + 3;
          const rightX = m._task ? x2 + 8 : x1 + rm.shapeS + 7;
          const leftX = m._task ? x1 - 8 : x1 - rm.shapeS - 7;
          m._title = out.title;
          if (rightX + labelW <= maxX - 4 || leftX - labelW < minX) {
            m._side = 'right'; m._lx = rightX; left = itemL; right = rightX + labelW;
          } else {
            m._side = 'left'; m._lx = leftX; left = leftX - labelW; right = itemR;
          }
        }
        let r = rowEnds.findIndex(end => left - 10 > end);
        if (r < 0) { r = rowEnds.length; rowEnds.push(right); } else rowEnds[r] = right;
        m._row = r;
      }
      sub.rows = Math.max(1, rowEnds.length);
      sub.h = sub.rows * rm.h + rm.pad * 2;
    }
    lane.h = lane.subs.reduce((a, s) => a + s.h, 0);
  }
  return lanes;
}

function drawShape(parent, shape, cx, cy, status, s) {
  const c = STATUS[status] || STATUS['Not Started'];
  let el;
  if (shape === 'diamond') {
    el = svgEl('path', { d: `M ${cx} ${cy - s - 2} L ${cx + s + 2} ${cy} L ${cx} ${cy + s + 2} L ${cx - s - 2} ${cy} Z` });
  } else if (shape === 'triangle') {
    el = svgEl('path', { d: `M ${cx} ${cy - s - 2} L ${cx + s + 1} ${cy + s} L ${cx - s - 1} ${cy + s} Z` });
  } else if (shape === 'circle') {
    el = svgEl('circle', { cx, cy, r: s + 0.5 });
  } else {
    el = svgEl('rect', { x: cx - s, y: cy - s, width: s * 2, height: s * 2, rx: 2.5 });
  }
  el.setAttribute('fill', `url(#grad-${statusSlug(status)})`);
  el.setAttribute('stroke', c.dark);
  el.setAttribute('stroke-width', '1.4');
  el.setAttribute('filter', 'url(#ms-shadow)');
  parent.appendChild(el);
}

// Elbow connector from the end of `a` to the start of `b`.
function drawLink(svg, a, b, rollup, rm) {
  const fx = a.x2 + (a.task ? 0 : rm.shapeS + 2), fy = a.cy;
  const tx = b.x1 - (b.task ? 0 : rm.shapeS + 3), ty = b.cy;
  let d;
  if (fy === ty && tx > fx) d = `M ${fx} ${fy} H ${tx}`;
  else if (tx - fx >= 14) d = `M ${fx} ${fy} H ${fx + 7} V ${ty} H ${tx}`;
  else {
    const midY = fy === ty ? fy + rm.h / 2 : (fy + ty) / 2;
    d = `M ${fx} ${fy} H ${fx + 7} V ${midY} H ${tx - 9} V ${ty} H ${tx}`;
  }
  svg.appendChild(svgEl('path', {
    d, fill: 'none',
    stroke: rollup ? '#7c3aed' : '#64748b', 'stroke-width': 1.3, 'stroke-opacity': 0.85,
    'stroke-dasharray': rollup ? '4 3' : 'none',
    'marker-end': `url(#arrow-${rollup ? 'roll' : 'dep'})`,
  }));
}

function renderGantt() {
  const container = document.getElementById('gantt-container');
  container.innerHTML = '';
  hideTip();
  if (!state.rangeStart) return; // data not loaded yet

  const LABEL_W = labelWidth();
  const subCol = hasSubLanes();
  const rm = rowMetrics();

  const items = state.items
    .map(m => ({ ...m, _s: parseDate(m.start), _e: parseDate(m.end), _task: isTask(m) }))
    .filter(m => m._s && m._e && m._e >= state.rangeStart && m._s <= state.rangeEnd);

  const totalDays = Math.max(1, (state.rangeEnd - state.rangeStart) / MS_DAY);
  const chartW = totalDays * state.pxPerDay;
  const rawX = (d) => LABEL_W + ((d - state.rangeStart) / MS_DAY) * state.pxPerDay;
  const xOf = (d) => Math.min(LABEL_W + chartW, Math.max(LABEL_W, rawX(d)));

  const headerH = (state.showQuarters ? QUARTER_H : 0) + (state.showMonths ? MONTH_H : 0);
  const width = LABEL_W + chartW + PAD_RIGHT;
  const lanes = layoutLanes(items, xOf, rm, LABEL_W, width);
  const bodyH = lanes.reduce((a, l) => a + l.h, 0) || 120;
  const height = headerH + bodyH + 8;

  const svg = svgEl('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`,
    xmlns: 'http://www.w3.org/2000/svg',
    style: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
  });

  // defs: status gradients, drop shadow, arrowheads
  const defs = svgEl('defs', {});
  for (const st of STATUSES) {
    const c = STATUS[st];
    const g = svgEl('linearGradient', { id: `grad-${statusSlug(st)}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': c.light }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': c.base }));
    defs.appendChild(g);
  }
  const f = svgEl('filter', { id: 'ms-shadow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  f.appendChild(svgEl('feDropShadow', { dx: 0, dy: 1.2, stdDeviation: 1.2, 'flood-color': '#0f172a', 'flood-opacity': '0.30' }));
  defs.appendChild(f);
  for (const [id, color] of [['dep', '#64748b'], ['roll', '#7c3aed']]) {
    const mk = svgEl('marker', { id: `arrow-${id}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' });
    mk.appendChild(svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 Z', fill: color }));
    defs.appendChild(mk);
  }
  svg.appendChild(defs);

  // background
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: '#ffffff' }));

  // lane backgrounds (alternating) + lane / sub-lane labels
  let y = headerH;
  lanes.forEach((lane, i) => {
    if (i % 2 === 1) svg.appendChild(svgEl('rect', { x: 0, y, width, height: lane.h, fill: '#f8fafc' }));
    const accent = LANE_ACCENTS[i % LANE_ACCENTS.length];
    svg.appendChild(svgEl('rect', { x: 0, y: y + 4, width: 4, height: lane.h - 8, rx: 2, fill: accent }));
    const laneColW = subCol ? LANE_COL_W : LABEL_W;
    svg.appendChild(svgEl('text', {
      x: 16, y: y + lane.h / 2 + 5, 'font-size': 14, 'font-weight': 700, fill: '#1e293b',
    }, truncate(lane.name, laneColW - 24, 14, 700)));

    let sy = y;
    lane.subs.forEach((sub, j) => {
      sub._y = sy;
      if (subCol) {
        if (j > 0) {
          svg.appendChild(svgEl('line', { x1: LANE_COL_W, y1: sy, x2: width, y2: sy, stroke: '#e2e8f0', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
        }
        if (sub.name) {
          svg.appendChild(svgEl('text', {
            x: LANE_COL_W + 12, y: sy + sub.h / 2 + 4, 'font-size': 12, 'font-weight': 600, fill: '#475569',
          }, truncate(sub.name, SUB_COL_W - 20, 12, 600)));
        }
      }
      sy += sub.h;
    });
    if (subCol) {
      svg.appendChild(svgEl('line', { x1: LANE_COL_W, y1: y, x2: LANE_COL_W, y2: y + lane.h, stroke: '#e2e8f0', 'stroke-width': 1 }));
    }
    svg.appendChild(svgEl('line', { x1: 0, y1: y + lane.h, x2: width, y2: y + lane.h, stroke: '#e2e8f0', 'stroke-width': 1 }));
    y += lane.h;
  });

  // vertical separator between labels and chart
  svg.appendChild(svgEl('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: height, stroke: '#cbd5e1', 'stroke-width': 1 }));

  // ---- month / quarter grid + headers ----
  const gridTop = headerH;
  const gridBottom = headerH + bodyH;

  const firstMonth = new Date(state.rangeStart.getFullYear(), state.rangeStart.getMonth(), 1);
  const months = [];
  for (let d = new Date(firstMonth); d <= state.rangeEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push(new Date(d));
  }

  if (state.showMonths) {
    const bandY = state.showQuarters ? QUARTER_H : 0;
    svg.appendChild(svgEl('rect', { x: LABEL_W, y: bandY, width: chartW, height: MONTH_H, fill: '#f1f5f9' }));
    for (const m of months) {
      const x1 = Math.max(LABEL_W, rawX(m));
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      const x2 = Math.min(width - PAD_RIGHT + 10, rawX(next));
      if (x2 - x1 < 4) continue;
      if (rawX(m) >= LABEL_W) {
        svg.appendChild(svgEl('line', { x1: rawX(m), y1: bandY, x2: rawX(m), y2: gridBottom, stroke: '#e2e8f0', 'stroke-width': 1 }));
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
    svg.appendChild(svgEl('line', { x1: LABEL_W, y1: bandY + MONTH_H, x2: width, y2: bandY + MONTH_H, stroke: '#cbd5e1', 'stroke-width': 1 }));
  }

  if (state.showQuarters) {
    svg.appendChild(svgEl('rect', { x: LABEL_W, y: 0, width: chartW, height: QUARTER_H, fill: '#e0e7ff' }));
    const qStarts = months.filter(m => m.getMonth() % 3 === 0);
    // ensure the partial quarter at range start gets a label
    const firstQ = new Date(state.rangeStart.getFullYear(), Math.floor(state.rangeStart.getMonth() / 3) * 3, 1);
    if (!qStarts.length || qStarts[0] > firstQ) qStarts.unshift(firstQ);
    for (const q of qStarts) {
      const qx = rawX(q);
      const next = new Date(q.getFullYear(), q.getMonth() + 3, 1);
      const x1 = Math.max(LABEL_W, qx);
      const x2 = Math.min(width - PAD_RIGHT + 10, rawX(next));
      if (x2 - x1 < 8) continue;
      if (qx >= LABEL_W) {
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
    svg.appendChild(svgEl('line', { x1: LABEL_W, y1: QUARTER_H, x2: width, y2: QUARTER_H, stroke: '#cbd5e1', 'stroke-width': 1 }));
  }

  // ---- today line ----
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (state.showToday && today >= state.rangeStart && today <= state.rangeEnd) {
    const tx = rawX(today);
    svg.appendChild(svgEl('line', {
      x1: tx, y1: gridTop, x2: tx, y2: gridBottom,
      stroke: '#ef4444', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
    }));
    const pill = svgEl('g', {});
    pill.appendChild(svgEl('rect', { x: tx - 24, y: gridTop + 4, width: 48, height: 17, rx: 8.5, fill: '#ef4444' }));
    pill.appendChild(svgEl('text', { x: tx, y: gridTop + 16, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#fff' }, 'TODAY'));
    svg.appendChild(pill);
  }

  // ---- positions ----
  const pos = new Map();
  for (const lane of lanes) {
    for (const sub of lane.subs) {
      for (const m of sub.items) {
        m._cy = sub._y + rm.pad + m._row * rm.h + rm.h / 2 - rm.offset;
        m._sub = sub;
        pos.set(m.id, { x1: xOf(m._s), x2: xOf(m._e), cy: m._cy, task: m._task });
      }
    }
  }

  // ---- dependency + roll-up connectors (under the items) ----
  if (state.showLinks) {
    for (const m of items) {
      const b = pos.get(m.id);
      for (const d of m.deps) if (pos.has(d)) drawLink(svg, pos.get(d), b, false, rm);
      if (m.parent && pos.has(m.parent)) drawLink(svg, b, pos.get(m.parent), true, rm);
    }
  }

  // ---- items ----
  for (const m of items) {
    const { x1, x2, cy } = pos.get(m.id);
    const c = STATUS[m.status];
    const g = svgEl('g', { 'data-id': m.id, class: 'gantt-item' });

    if (m._task) {
      const bh = rm.barH;
      g.appendChild(svgEl('rect', {
        x: x1, y: cy - bh / 2, width: Math.max(2, x2 - x1), height: bh, rx: Math.min(5, bh / 3),
        fill: `url(#grad-${statusSlug(m.status)})`, stroke: c.dark, 'stroke-width': 1.2, filter: 'url(#ms-shadow)',
      }));
      if (m._side === 'inside') {
        g.appendChild(titleText({ x: x1 + 8, y: cy + 4.5, 'font-size': 12, 'font-weight': 600, fill: c.text }, m, c.text));
        if (m._meta) g.appendChild(svgEl('text', { x: x1 + 2, y: cy + bh / 2 + 13, 'font-size': 10.5, fill: '#64748b', ...HALO }, m._meta));
      }
    } else {
      // stem down to sub-lane bottom for readability
      svg.appendChild(svgEl('line', {
        x1, y1: cy + rm.shapeS + 3, x2: x1, y2: m._sub._y + m._sub.h - 4,
        stroke: '#cbd5e1', 'stroke-width': 1, 'stroke-dasharray': '2 3',
      }));
      drawShape(g, m.shape, x1, cy, m.status, rm.shapeS);
    }
    if (m._side !== 'inside') {
      const anchor = m._side === 'left' ? 'end' : 'start';
      const ty = rm.detail ? cy + 1 : cy + 4.5;
      g.appendChild(titleText({ x: m._lx, y: ty, 'text-anchor': anchor, 'font-size': 12.5, 'font-weight': 600, fill: '#1e293b', ...HALO }, m, '#4f46e5'));
      if (m._meta) g.appendChild(svgEl('text', { x: m._lx, y: cy + 15, 'text-anchor': anchor, 'font-size': 10.5, fill: '#64748b', ...HALO }, m._meta));
    }
    svg.appendChild(g);
  }

  container.appendChild(svg);
}

/* ================= hover card ================= */

function showTip(m, e) {
  const tip = document.getElementById('tip');
  const c = STATUS[m.status];
  const task = isTask(m);
  const days = daysBetween(m.start, m.end) + 1;
  const when = task
    ? `${fmtShort(m.start)} – ${fmtNice(m.end)} <span class="tip-muted">(${days} days)</span>`
    : fmtNice(m.end);
  const where = [m.owner, [m.swimlane, m.subswimlane].filter(Boolean).join(' › ')].filter(Boolean).map(escAttr).join(' · ');
  tip.innerHTML = `
    <div class="tip-head">${m.ref ? `<span class="tip-ref">${escAttr(m.ref)}</span>` : ''}<span>${escAttr(m.title)}</span></div>
    <div class="tip-row"><span class="pill" style="background:${c.base};color:${c.text}">${m.status}</span><span>${task ? 'Task' : 'Milestone'} · ${when}</span></div>
    ${where ? `<div class="tip-row tip-muted">${where}</div>` : ''}
    ${m.description ? `<div class="tip-desc">${escAttr(m.description)}</div>` : ''}
    ${lastReportLine(m)}
    <div class="tip-hint">Click to edit · right-click to report</div>`;
  tip.classList.add('show');
  moveTip(e);
}
function moveTip(e) {
  const tip = document.getElementById('tip');
  const pad = 14;
  tip.style.left = tip.style.top = '0px'; // measure at full width, not squeezed against the edge
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - pad;
  if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() {
  document.getElementById('tip')?.classList.remove('show');
}

/* ================= edit dialog ================= */

let editing = null; // item being edited; null when adding a new one
let edDeps = [];

const EDIT_FIELDS = ['ref', 'title', 'description', 'swimlane', 'subswimlane', 'owner', 'start', 'end', 'status', 'shape', 'parent'];

function openEditDialog(m) {
  hideTip();
  editing = m;
  const f = document.getElementById('edit-form').elements;
  const last = state.items.at(-1);
  const today = fmtISO(new Date());
  const v = m || {
    ref: '', title: '', description: '', swimlane: last?.swimlane || 'General', subswimlane: '', owner: '',
    start: today, end: today, status: 'Not Started', shape: 'diamond', parent: '', deps: [],
  };
  const parents = state.items.filter(p => !isTask(p) && p !== m).sort(cmpRef);
  if (v.parent && !parents.some(p => p.id === v.parent)) parents.push(state.items.find(p => p.id === v.parent));
  f.parent.innerHTML = '<option value="">— none —</option>' +
    parents.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('');
  for (const k of EDIT_FIELDS) f[k].value = v[k];
  edDeps = [...v.deps];

  document.getElementById('ed-heading').textContent = m ? `Edit ${itemLabel(m)}` : 'New item';
  document.getElementById('ed-delete').hidden = !m;
  document.getElementById('ed-report').hidden = !m;
  document.getElementById('ed-error').textContent = '';
  refreshDatalists();
  renderEdDeps();
  updateEdType();
  document.getElementById('edit-dialog').showModal();
  f.title.focus();
}

function renderEdDeps() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const opts = state.items.filter(p => p !== editing && !edDeps.includes(p.id)).sort(cmpRef);
  document.getElementById('ed-deps').innerHTML =
    edDeps.map(d => `<span class="chip" title="${escAttr(byId.get(d)?.title)}">${escAttr(itemLabel(byId.get(d)))}<button type="button" data-edrm="${d}" title="Remove dependency">×</button></span>`).join('') +
    `<select id="ed-adddep" class="add-dep"><option value="">+ add dependency</option>${opts.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select>`;
}

function updateEdType() {
  const f = document.getElementById('edit-form').elements;
  const task = f.start.value && f.end.value && f.start.value < f.end.value;
  const badge = document.getElementById('ed-type');
  badge.textContent = task ? 'Task' : 'Milestone';
  badge.className = 'type-badge ' + (task ? 'task' : 'ms');
  f.shape.disabled = !!task;
}

async function submitEditDialog(e) {
  e.preventDefault();
  const f = document.getElementById('edit-form').elements;
  const err = document.getElementById('ed-error');
  const changes = {};
  for (const k of EDIT_FIELDS) changes[k] = f[k].value.trim();
  changes.deps = edDeps;

  if (!changes.title) return (err.textContent = 'Title is required.');
  if (!changes.start && !changes.end) return (err.textContent = 'Enter a start or end date.');
  const clash = changes.ref && state.items.find(x => x !== editing && x.ref === changes.ref);
  if (clash) return (err.textContent = `Ref ${changes.ref} is already used by “${clash.title}”.`);

  let m = editing;
  if (!m) {
    m = { id: nextId(), ...changes, parent: '', deps: [] };
    state.items.push(m);
  }
  const res = updateItem(m, changes);
  if (res.error) {
    if (!editing) removeItem(m.id);
    return (err.textContent = res.error);
  }
  document.getElementById('edit-dialog').close();
  renderGantt();
  await saveData(movedMessage(m, res.moved));
}

async function deleteFromDialog() {
  if (!editing || !confirm(deleteMessage(editing))) return;
  removeItem(editing.id);
  document.getElementById('edit-dialog').close();
  renderGantt();
  await saveData('Deleted');
}

/* ================= zoom / range controls ================= */

function setZoom(px) {
  state.pxPerDay = Math.min(30, Math.max(1, px));
  document.getElementById('zoom-slider').value = state.pxPerDay;
  renderGantt();
}

function fitZoom() {
  if (!state.rangeStart) return; // data not loaded yet
  const wrap = document.getElementById('gantt-scroll');
  const totalDays = Math.max(1, (state.rangeEnd - state.rangeStart) / MS_DAY);
  const avail = wrap.clientWidth - labelWidth() - PAD_RIGHT - 2;
  setZoom(avail / totalDays);
}

/* ================= editor table ================= */

function optionList(values, selected) {
  return values.map(v => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

function setDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = id;
    document.body.appendChild(dl);
  }
  dl.innerHTML = [...new Set(values.filter(Boolean))].map(v => `<option value="${escAttr(v)}"></option>`).join('');
}

function refreshDatalists() {
  setDatalist('lane-list', state.items.map(m => m.swimlane));
  setDatalist('sublane-list', state.items.map(m => m.subswimlane));
  setDatalist('owner-list', state.items.map(m => m.owner));
}

/* ---- grid: columns, sorting, filtering, resizable widths ---- */

const GRID_COLS = [
  { key: 'id', label: 'ID', w: 96, title: 'Primary key — assigned automatically, never changes' },
  { key: 'ref', label: 'Ref', w: 80 },
  { key: 'title', label: 'Title', w: 200 },
  { key: 'description', label: 'Description', w: 220 },
  { key: 'swimlane', label: 'Swimlane', w: 120 },
  { key: 'subswimlane', label: 'Sub-swimlane', w: 120 },
  { key: 'owner', label: 'Owner', w: 120 },
  { key: 'start', label: 'Start', w: 135 },
  { key: 'end', label: 'End', w: 135 },
  { key: 'status', label: 'Status', w: 125, options: STATUSES },
  { key: 'shape', label: 'Shape', w: 100, options: SHAPES },
  { key: 'parent', label: 'Rolls up to', w: 170 },
  { key: 'deps', label: 'Depends on', w: 190 },
  { key: 'actions', label: '', w: 40, fixed: true },
];
const GRID_STORE = 'milestone-tracker.grid';

const grid = {
  sort: { key: null, dir: 1 },
  filters: {},
  widths: {},
};

// Sort + widths are a per-browser convenience; storage may be unavailable.
function loadGridPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRID_STORE) || '{}');
    if (saved.sort) grid.sort = saved.sort;
    if (saved.widths) grid.widths = saved.widths;
  } catch { /* ignore */ }
}
function saveGridPrefs() {
  try { localStorage.setItem(GRID_STORE, JSON.stringify({ sort: grid.sort, widths: grid.widths })); } catch { /* ignore */ }
}

function gridValue(m, key, byId) {
  switch (key) {
    case 'id': return +m.id;
    case 'parent': return m.parent ? fullLabel(byId.get(m.parent)) : '';
    case 'deps': return m.deps.map(d => fullLabel(byId.get(d))).join(' ');
    default: return m[key] ?? '';
  }
}

function matchesFilter(m, key, f, byId) {
  if (!f) return true;
  if (key === 'id') return f === (isTask(m) ? 'Task' : 'Milestone');
  const col = GRID_COLS.find(c => c.key === key);
  if (col.options) return m[key] === f;
  let text = String(gridValue(m, key, byId));
  if ((key === 'start' || key === 'end') && m[key]) text += ' ' + fmtNice(m[key]);
  return text.toLowerCase().includes(f.toLowerCase());
}

// Rows to show: [{ m, i }] where i is the item's index in state.items.
function gridRows() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const rows = state.items
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => Object.entries(grid.filters).every(([k, f]) => matchesFilter(m, k, f, byId)));
  const { key, dir } = grid.sort;
  if (key) {
    rows.sort((a, b) => {
      const va = gridValue(a.m, key, byId), vb = gridValue(b.m, key, byId);
      const ea = va === '', eb = vb === '';
      if (ea || eb) return ea - eb || a.i - b.i; // blanks last either way
      const c = key === 'status' ? STATUSES.indexOf(va) - STATUSES.indexOf(vb)
        : typeof va === 'number' ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
      return c * dir || a.i - b.i;
    });
  }
  return rows;
}

function renderGridHead() {
  document.getElementById('grid-cols').innerHTML = GRID_COLS.map(c => `<col data-key="${c.key}">`).join('');
  const filterCell = (c) => {
    if (c.fixed) return '<th></th>';
    let ctl;
    if (c.key === 'id') ctl = `<select data-filter="id"><option value="">All</option><option>Task</option><option>Milestone</option></select>`;
    else if (c.options) ctl = `<select data-filter="${c.key}"><option value="">All</option>${optionList(c.options)}</select>`;
    else ctl = `<input data-filter="${c.key}" placeholder="Filter…" />`;
    return `<th class="filter-cell">${ctl}</th>`;
  };
  document.getElementById('grid-head').innerHTML = `
    <tr>${GRID_COLS.map(c => c.fixed ? '<th></th>' : `
      <th data-sort="${c.key}" class="sortable" title="${escAttr(c.title || 'Click to sort')}">
        <span>${c.label}</span><span class="sort-ind"></span>
        <span class="col-resizer" data-resize="${c.key}" title="Drag to resize · double-click to reset"></span>
      </th>`).join('')}</tr>
    <tr class="filter-row">${GRID_COLS.map(filterCell).join('')}</tr>`;
  applyColWidths();
  updateSortIndicators();
}

function applyColWidths() {
  let total = 0;
  for (const c of GRID_COLS) {
    const w = grid.widths[c.key] ?? c.w;
    document.querySelector(`#grid-cols col[data-key="${c.key}"]`).style.width = w + 'px';
    total += w;
  }
  document.getElementById('editor-table').style.width = total + 'px';
}

function updateSortIndicators() {
  document.querySelectorAll('#grid-head [data-sort]').forEach(th => {
    const on = th.dataset.sort === grid.sort.key;
    th.classList.toggle('sorted', on);
    th.querySelector('.sort-ind').textContent = on ? (grid.sort.dir > 0 ? '▲' : '▼') : '';
  });
}

function onGridHeadClick(e) {
  if (e.target.closest('.col-resizer, [data-filter]')) return;
  const th = e.target.closest('[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  // cycle: ascending → descending → off
  if (grid.sort.key !== key) grid.sort = { key, dir: 1 };
  else if (grid.sort.dir > 0) grid.sort.dir = -1;
  else grid.sort = { key: null, dir: 1 };
  saveGridPrefs();
  updateSortIndicators();
  syncEditorToState();
  renderEditor();
}

function onGridFilter(e) {
  const key = e.target.dataset.filter;
  if (!key) return;
  const v = e.target.value.trim();
  if (v) grid.filters[key] = v; else delete grid.filters[key];
  syncEditorToState();
  renderEditor();
}

function clearFilters() {
  grid.filters = {};
  document.querySelectorAll('#grid-head [data-filter]').forEach(el => { el.value = ''; });
}

function onResizeStart(e) {
  const handle = e.target.closest('[data-resize]');
  if (!handle) return;
  e.preventDefault();
  const key = handle.dataset.resize;
  const startX = e.clientX;
  const startW = grid.widths[key] ?? GRID_COLS.find(c => c.key === key).w;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add('col-resizing');
  const move = (ev) => {
    grid.widths[key] = Math.max(48, Math.round(startW + ev.clientX - startX));
    applyColWidths();
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    document.body.classList.remove('col-resizing');
    saveGridPrefs();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}

function onResizeReset(e) {
  const handle = e.target.closest('[data-resize]');
  if (!handle) return;
  delete grid.widths[handle.dataset.resize];
  applyColWidths();
  saveGridPrefs();
}

function renderEditor(highlight = []) {
  const body = document.getElementById('editor-body');
  body.innerHTML = '';
  const byId = new Map(state.items.map(m => [m.id, m]));
  const milestones = state.items.filter(m => !isTask(m)).sort(cmpRef);
  const refCount = new Map();
  for (const m of state.items) if (m.ref) refCount.set(m.ref, (refCount.get(m.ref) || 0) + 1);

  const rows = gridRows();
  for (const { m, i } of rows) {
    const task = isTask(m);
    const tr = document.createElement('tr');
    if (highlight.includes(m.id)) tr.className = 'shifted';

    const parentOpts = milestones.filter(p => p.id !== m.id);
    if (m.parent && !parentOpts.some(p => p.id === m.parent)) parentOpts.push(byId.get(m.parent));
    const depOpts = state.items.filter(p => p.id !== m.id && !m.deps.includes(p.id)).sort(cmpRef);
    const chips = m.deps.map(d => `
      <span class="chip" title="${escAttr(byId.get(d)?.title)}">${escAttr(itemLabel(byId.get(d)))}<button data-rmdep="${i}" data-dep="${d}" title="Remove dependency">×</button></span>`).join('');
    const dup = refCount.get(m.ref) > 1;

    tr.innerHTML = `
      <td class="col-id"><span class="type-badge ${task ? 'task' : 'ms'}" title="${task ? 'Task — has a duration, drawn as a bar' : 'Milestone — start equals end'}">${task ? 'Task' : 'MS'}</span><span class="id" title="Primary key">${m.id}</span></td>
      <td><input data-i="${i}" data-k="ref" value="${escAttr(m.ref)}" placeholder="e.g. 4.1" ${dup ? 'class="dup" title="Duplicate ref"' : ''} /></td>
      <td><input data-i="${i}" data-k="title" value="${escAttr(m.title)}" placeholder="Title" /></td>
      <td><input data-i="${i}" data-k="description" value="${escAttr(m.description)}" placeholder="Description" /></td>
      <td><input data-i="${i}" data-k="swimlane" value="${escAttr(m.swimlane)}" list="lane-list" placeholder="Swimlane" /></td>
      <td><input data-i="${i}" data-k="subswimlane" value="${escAttr(m.subswimlane)}" list="sublane-list" placeholder="Sub-swimlane" /></td>
      <td><input data-i="${i}" data-k="owner" value="${escAttr(m.owner)}" list="owner-list" placeholder="Owner" /></td>
      <td><input data-i="${i}" data-k="start" type="date" value="${escAttr(m.start)}" /></td>
      <td><input data-i="${i}" data-k="end" type="date" value="${escAttr(m.end)}" /></td>
      <td><select data-i="${i}" data-k="status" class="status-${statusSlug(m.status)}">${optionList(STATUSES, m.status)}</select></td>
      <td><select data-i="${i}" data-k="shape" ${task ? 'disabled title="Tasks are drawn as bars"' : ''}>${optionList(SHAPES, m.shape)}</select></td>
      <td><select data-i="${i}" data-k="parent"><option value="">—</option>${parentOpts.map(p => `<option value="${p.id}" ${p.id === m.parent ? 'selected' : ''}>${escAttr(fullLabel(p))}</option>`).join('')}</select></td>
      <td><div class="deps">${chips}<select data-adddep="${i}" class="add-dep"><option value="">+ add</option>${depOpts.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select></div></td>
      <td><button class="btn-del" data-del="${i}" title="Delete row">✕</button></td>`;
    body.appendChild(tr);
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${GRID_COLS.length}" class="grid-empty">No items match the filters.</td></tr>`;
  }

  const filtered = Object.keys(grid.filters).length > 0;
  document.getElementById('grid-count').textContent = filtered
    ? `Showing ${rows.length} of ${state.items.length}`
    : `${state.items.length} items`;
  document.getElementById('btn-clear-filters').hidden = !filtered;
  refreshDatalists();
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Copy table edits into state (optionally skipping one control whose change is handled separately).
function syncEditorToState(skip) {
  document.querySelectorAll('#editor-body [data-k]').forEach(el => {
    if (el !== skip) state.items[+el.dataset.i][el.dataset.k] = el.value;
  });
}

function applyTableChange(m, changes, msg) {
  const res = updateItem(m, changes);
  if (res.error) {
    flashStatus(res.error, false);
    return renderEditor();
  }
  renderEditor(res.moved);
  scheduleSave([msg, movedMessage(m, res.moved)].filter(Boolean).join(' · '));
}

function onEditorChange(e) {
  const t = e.target;

  if (t.dataset.adddep != null) {
    syncEditorToState();
    const m = state.items[+t.dataset.adddep];
    if (!t.value) return;
    return applyTableChange(m, { deps: [...m.deps, t.value] });
  }

  const k = t.dataset.k;
  if (!k) return;
  const m = state.items[+t.dataset.i];

  if (k === 'status') t.className = 'status-' + statusSlug(t.value);
  if (k === 'ref') { // refresh duplicate warnings and labels
    syncEditorToState();
    renderEditor();
    return scheduleSave();
  }

  if (k === 'parent') {
    syncEditorToState(t);
    return applyTableChange(m, { parent: t.value });
  }

  if (k === 'start' || k === 'end') {
    // Date inputs fire change mid-typing (e.g. year 0002) — wait for a real date.
    if (t.value && (+t.value.slice(0, 4) < 1900 || !parseDate(t.value))) return;
    syncEditorToState(t);
    return applyTableChange(m, { [k]: t.value });
  }

  syncEditorToState(); // plain field (title, owner, status, …) — sync now so a re-render can't drop it
  scheduleSave();
}

function onEditorClick(e) {
  const rm = e.target.closest('[data-rmdep]');
  if (rm) {
    syncEditorToState();
    const m = state.items[+rm.dataset.rmdep];
    m.deps = m.deps.filter(d => d !== rm.dataset.dep);
    renderEditor();
    return scheduleSave();
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    syncEditorToState();
    const m = state.items[+del.dataset.del];
    if (!confirm(deleteMessage(m))) return;
    removeItem(m.id);
    renderEditor();
    scheduleSave('Deleted');
  }
}

/* ================= reports ================= */
// A report is a status update on one item for one period. Reports are weekly, fortnightly
// or monthly; the period runs up to and including `period_end`.

const CADENCES = ['Weekly', 'Fortnightly', 'Monthly'];
const REPORT_COLUMNS = ['id', 'item_id', 'cadence', 'period_start', 'period_end', 'status',
  'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author', 'created', 'updated'];
const OFF_TRACK = ['Amber', 'Red']; // statuses that need a get-to-green plan

function rowsToReports(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const reports = rows.slice(1).map(r => {
    const o = {};
    for (const k of REPORT_COLUMNS) o[k] = (r[header.indexOf(k)] ?? '').trim();
    o.cadence = CADENCES.find(c => c.toLowerCase() === o.cadence.toLowerCase()) || 'Weekly';
    o.status = normaliseStatus(o.status);
    if (o.period_end && !o.period_start) o.period_start = periodStart(o.period_end, o.cadence);
    return o;
  });
  const seen = new Set();
  let last = Math.max(0, ...reports.map(r => (/^\d+$/.test(r.id) ? +r.id : 0)));
  for (const r of reports) {
    if (!/^\d+$/.test(r.id) || seen.has(r.id)) r.id = String(++last);
    seen.add(r.id);
  }
  state.lastReportId = last;
  return reports;
}

function reportsToCSV(reports) {
  return [REPORT_COLUMNS.join(','), ...reports.map(r => REPORT_COLUMNS.map(k => csvEscape(r[k])).join(','))].join('\n') + '\n';
}

function nextReportId() {
  state.lastReportId = Math.max(state.lastReportId, ...state.reports.map(r => +r.id || 0)) + 1;
  return String(state.lastReportId);
}

const itemById = (id) => state.items.find(m => m.id === id);
const byPeriodDesc = (a, b) => b.period_end.localeCompare(a.period_end) || b.updated.localeCompare(a.updated);
const reportsFor = (itemId) => state.reports.filter(r => r.item_id === itemId).sort(byPeriodDesc);

// First day of the period that ends on `end` (inclusive).
function periodStart(end, cadence) {
  if (cadence === 'Weekly') return addDays(end, -6);
  if (cadence === 'Fortnightly') return addDays(end, -13);
  const d = parseDate(end);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const prevLen = new Date(d.getFullYear(), d.getMonth(), 0).getDate();
  prev.setDate(Math.min(d.getDate(), prevLen) + 1); // day after the same date last month
  return fmtISO(prev);
}

// Weekly/fortnightly periods end on the coming Friday; monthly ones at month end.
function defaultPeriodEnd(cadence) {
  const d = new Date();
  if (cadence === 'Monthly') return fmtISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return fmtISO(d);
}

function fmtStamp(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const periodText = (r) => `${fmtShort(r.period_start)} – ${fmtNice(r.period_end)}`;
const statusPill = (st) => `<span class="pill" style="background:${STATUS[st].base};color:${STATUS[st].text}">${st}</span>`;

function lastReportLine(m) {
  const r = reportsFor(m.id)[0];
  return r ? `<div class="tip-row tip-muted">Last report: period ending ${fmtShort(r.period_end)} ${statusPill(r.status)}</div>`
    : '<div class="tip-row tip-muted">No reports yet</div>';
}

function deleteMessage(m) {
  const n = reportsFor(m.id).length;
  return `Delete “${fullLabel(m)}”? Any links to it will be removed.` +
    (n ? `\n\nIts ${n} report${n > 1 ? 's are' : ' is'} kept in reports.csv.` : '');
}

/* ---- right-click menu on the chart ---- */

function showCtxMenu(m, e) {
  e.preventDefault();
  hideTip();
  const menu = document.getElementById('ctx-menu');
  const n = reportsFor(m.id).length;
  menu.dataset.id = m.id;
  menu.innerHTML = `
    <div class="ctx-head">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</div>
    <button role="menuitem" data-act="report">Provide report…</button>
    <button role="menuitem" data-act="edit">Edit item…</button>
    <button role="menuitem" data-act="history" ${n ? '' : 'disabled'}>View reports (${n})</button>`;
  menu.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelector('button').focus();
}
function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.hidden = true;
}
function onCtxMenuClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const m = itemById(document.getElementById('ctx-menu').dataset.id);
  hideCtxMenu();
  if (!m) return;
  if (b.dataset.act === 'report') openReportDialog({ itemId: m.id });
  else if (b.dataset.act === 'edit') openEditDialog(m);
  else {
    clearReportFilters();
    rptFilter.item = m.id;
    switchView('reports');
  }
}

/* ---- report dialog ---- */

let rpEditing = null;  // report being edited; null for a new one
let rpItemId = '';
let rpDateTouched = false; // stop re-defaulting the period once the user picks a date
let rpPrevIdx = 0;         // which earlier report the side panel shows (0 = the one just before)

function openReportDialog({ report = null, itemId = '' } = {}) {
  hideTip();
  hideCtxMenu();
  rpEditing = report;
  rpItemId = report ? report.item_id : itemId;
  rpDateTouched = !!report;
  rpPrevIdx = 0;
  const f = document.getElementById('report-form').elements;

  document.getElementById('rp-item-pick').hidden = !!rpItemId;
  f.item_id.innerHTML = '<option value="">— choose an item —</option>' +
    [...state.items].sort(cmpRef).map(m => `<option value="${m.id}">${escAttr(fullLabel(m))}</option>`).join('');
  f.item_id.value = rpItemId;

  const v = report || newReportValues(rpItemId);
  for (const k of ['cadence', 'period_end', 'status', 'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author']) f[k].value = v[k];
  f.sync_status.checked = true;

  document.getElementById('rp-heading').textContent = report ? 'Edit report' : 'Provide report';
  document.getElementById('rp-submit').textContent = report ? 'Save changes' : 'Submit report';
  document.getElementById('rp-delete').hidden = !report;
  document.getElementById('rp-meta').textContent = report
    ? `Submitted ${fmtStamp(report.created)}` + (report.updated !== report.created ? ` · last edited ${fmtStamp(report.updated)}` : '')
    : '';
  refreshDatalists();
  refreshReportForm();
  document.getElementById('report-dialog').showModal();
  (rpItemId ? f.exec_summary : f.item_id).focus();
}

// Defaults for a new report: carry on the item's last cadence, current status and owner.
function newReportValues(itemId) {
  const m = itemById(itemId);
  const cadence = reportsFor(itemId)[0]?.cadence || 'Weekly';
  return {
    cadence, period_end: defaultPeriodEnd(cadence), status: m?.status || 'Not Started',
    exec_summary: '', achievements: '', next_steps: '', get_to_green: '', author: m?.owner || '',
  };
}

function refreshReportForm() {
  const f = document.getElementById('report-form').elements;
  const m = itemById(rpItemId);
  const end = f.period_end.value;
  const st = f.status.value;

  const strip = document.getElementById('rp-item');
  strip.hidden = !rpItemId;
  strip.innerHTML = m
    ? `${statusPill(m.status)}<span class="rp-item-title">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>
       <span class="rp-item-meta">${isTask(m) ? 'Task' : 'Milestone'} · ${isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : `due ${fmtNice(m.end)}`}${m.owner ? ` · ${escAttr(m.owner)}` : ''}</span>`
    : `<span class="rp-item-title">Deleted item #${escAttr(rpItemId)}</span>`;

  document.getElementById('rp-range').textContent = end && parseDate(end)
    ? `Covers ${fmtShort(periodStart(end, f.cadence.value))} – ${fmtNice(end)}` : '';

  const offTrack = OFF_TRACK.includes(st);
  document.getElementById('rp-gtg').hidden = !offTrack;
  f.get_to_green.required = offTrack;

  // Offer to update the item's status, but only from its most recent report.
  const others = state.reports.filter(r => r.item_id === rpItemId && r !== rpEditing);
  const latest = !others.some(r => r.period_end > end);
  const sync = document.getElementById('rp-sync');
  sync.hidden = !(m && latest && st !== m.status);
  if (m) sync.querySelector('span').innerHTML = `Also change ${escAttr(itemLabel(m))}’s status on the chart from <b>${m.status}</b> to <b>${st}</b>`;

  renderPrevReport(others.filter(r => r.period_end < end).sort(byPeriodDesc));

  const clash = end && state.reports.find(r => r !== rpEditing && r.item_id === rpItemId && r.period_end === end);
  document.getElementById('rp-error').innerHTML = clash
    ? `There’s already a report for this item for the period ending ${fmtNice(end)}. <button type="button" class="link-btn" data-open-report="${clash.id}">Open it</button>`
    : '';
}

function onReportFormInput(e) {
  const f = document.getElementById('report-form').elements;
  const t = e.target;
  if (t.name === 'item_id') {
    rpItemId = t.value;
    const v = newReportValues(rpItemId);
    for (const k of ['cadence', 'status', 'author']) f[k].value = v[k];
    if (!rpDateTouched) f.period_end.value = v.period_end;
  } else if (t.name === 'cadence') {
    if (!rpDateTouched) f.period_end.value = defaultPeriodEnd(t.value);
  } else if (t.name === 'period_end') {
    rpDateTouched = true;
  } else if (t.name !== 'status') return;
  if (t.name !== 'status') rpPrevIdx = 0;
  refreshReportForm();
}

// Side panel with an earlier report on the same item, so the new one can be written against
// what was said last time. Sections can be copied into the matching field of the new report.
const PREV_SECTIONS = [
  { key: 'exec_summary', label: 'Exec summary', to: 'exec_summary', btn: 'Copy to exec summary' },
  { key: 'achievements', label: 'Achievements' },
  { key: 'next_steps', label: 'Next steps it committed to', to: 'achievements', btn: 'Copy to achievements' },
  { key: 'get_to_green', label: 'Get to green plan', to: 'get_to_green', btn: 'Carry forward' },
];

function renderPrevReport(earlier) {
  const el = document.getElementById('rp-prev');
  rpPrevIdx = Math.min(rpPrevIdx, Math.max(0, earlier.length - 1));
  const prev = earlier[rpPrevIdx];
  el.hidden = !prev;
  document.getElementById('report-dialog').classList.toggle('has-prev', !!prev);
  if (!prev) return;
  const gtgShown = !document.getElementById('rp-gtg').hidden;
  const sections = PREV_SECTIONS.map(s => {
    const text = prev[s.key];
    const copy = s.to && text && (s.to !== 'get_to_green' || gtgShown)
      ? `<button type="button" class="link-btn" data-copy="${s.key}" data-to="${s.to}">${s.btn}</button>` : '';
    return `<section><header><span>${s.label}</span>${copy}</header>
      ${text ? `<p>${escAttr(text)}</p>` : '<p class="rp-prev-empty">—</p>'}</section>`;
  }).join('');
  el.innerHTML = `
    <div class="rp-prev-head">
      <span class="rp-prev-title">${rpPrevIdx ? 'Earlier report' : 'Previous report'}</span>
      <span class="rp-prev-nav">
        <button type="button" data-prev-step="1" ${rpPrevIdx < earlier.length - 1 ? '' : 'disabled'} title="Older report">‹</button>
        <span>${rpPrevIdx + 1} of ${earlier.length}</span>
        <button type="button" data-prev-step="-1" ${rpPrevIdx > 0 ? '' : 'disabled'} title="Newer report">›</button>
      </span>
    </div>
    <div class="rp-prev-when">${statusPill(prev.status)} Period ending <b>${fmtNice(prev.period_end)}</b></div>
    <div class="rp-prev-sub">${prev.cadence}${prev.author ? ` · ${escAttr(prev.author)}` : ''}</div>
    ${sections}`;
  el._earlier = earlier;
}

function onPrevPanelClick(e) {
  const step = e.target.closest('[data-prev-step]');
  if (step) {
    rpPrevIdx += +step.dataset.prevStep;
    return renderPrevReport(document.getElementById('rp-prev')._earlier);
  }
  const copy = e.target.closest('[data-copy]');
  if (!copy) return;
  const prev = document.getElementById('rp-prev')._earlier[rpPrevIdx];
  const field = document.getElementById('report-form').elements[copy.dataset.to];
  const text = prev[copy.dataset.copy];
  if (!field.value.includes(text)) field.value = field.value.trim() ? `${field.value.trimEnd()}\n${text}` : text;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

async function submitReport(e) {
  e.preventDefault();
  const f = document.getElementById('report-form').elements;
  const err = document.getElementById('rp-error');
  const v = {};
  for (const k of ['cadence', 'period_end', 'status', 'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author']) v[k] = f[k].value.trim();

  if (!rpItemId) return (err.textContent = 'Choose the item this report is for.');
  if (!parseDate(v.period_end)) return (err.textContent = 'Enter the date the reporting period ends.');
  if (!v.exec_summary) return (err.textContent = 'Add an exec summary.');
  const offTrack = OFF_TRACK.includes(v.status);
  if (offTrack && !v.get_to_green) return (err.textContent = `A ${v.status} report needs a get to green plan.`);
  if (!offTrack) v.get_to_green = '';
  if (state.reports.some(r => r !== rpEditing && r.item_id === rpItemId && r.period_end === v.period_end)) return refreshReportForm();
  v.period_start = periodStart(v.period_end, v.cadence);

  const now = new Date().toISOString();
  const isNew = !rpEditing;
  if (rpEditing) Object.assign(rpEditing, v, { updated: now });
  else state.reports.push({ id: nextReportId(), item_id: rpItemId, ...v, created: now, updated: now });

  const m = itemById(rpItemId);
  const syncStatus = !document.getElementById('rp-sync').hidden && f.sync_status.checked;
  document.getElementById('report-dialog').close();
  if (syncStatus) {
    m.status = v.status;
    saveData(`${itemLabel(m)} is now ${v.status}`);
  }
  rerenderCurrentView();
  await saveReports(isNew ? 'Report submitted' : 'Report updated');
}

async function deleteReport() {
  if (!rpEditing) return;
  const m = itemById(rpEditing.item_id);
  if (!confirm(`Delete the report${m ? ` on “${fullLabel(m)}”` : ''} for the period ending ${fmtNice(rpEditing.period_end)}?`)) return;
  state.reports = state.reports.filter(r => r !== rpEditing);
  document.getElementById('report-dialog').close();
  rerenderCurrentView();
  await saveReports('Report deleted');
}

function rerenderCurrentView() {
  if (isShown('gantt')) renderGantt();
  if (isShown('reports')) renderReports();
}

/* ---- reports list ---- */

const rptFilter = { item: '', status: '', cadence: '', q: '' };

function clearReportFilters() {
  Object.assign(rptFilter, { item: '', status: '', cadence: '', q: '' });
}

function renderReports() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const itemName = (id) => (byId.has(id) ? fullLabel(byId.get(id)) : `Deleted item #${id}`);

  // item filter lists everything that has reports, in ref order
  const withReports = [...new Set(state.reports.map(r => r.item_id))]
    .sort((a, b) => (byId.has(a) && byId.has(b) ? cmpRef(byId.get(a), byId.get(b)) : !byId.has(a) - !byId.has(b)));
  if (rptFilter.item && !withReports.includes(rptFilter.item)) withReports.unshift(rptFilter.item);
  const sel = document.getElementById('rpf-item');
  sel.innerHTML = '<option value="">All items</option>' + withReports.map(id => `<option value="${id}">${escAttr(itemName(id))}</option>`).join('');
  sel.value = rptFilter.item;
  document.getElementById('rpf-status').value = rptFilter.status;
  document.getElementById('rpf-cadence').value = rptFilter.cadence;
  const qEl = document.getElementById('rpf-q');
  if (document.activeElement !== qEl) qEl.value = rptFilter.q; // don't disturb the caret while typing

  const q = rptFilter.q.trim().toLowerCase();
  const rows = state.reports
    .filter(r => (!rptFilter.item || r.item_id === rptFilter.item)
      && (!rptFilter.status || r.status === rptFilter.status)
      && (!rptFilter.cadence || r.cadence === rptFilter.cadence)
      && (!q || [itemName(r.item_id), r.exec_summary, r.achievements, r.next_steps, r.get_to_green, r.author].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.period_end.localeCompare(a.period_end)
      || (byId.has(a.item_id) && byId.has(b.item_id) ? cmpRef(byId.get(a.item_id), byId.get(b.item_id)) : 0));

  const body = document.getElementById('reports-body');
  body.innerHTML = rows.map(r => {
    const m = byId.get(r.item_id);
    return `<tr data-rid="${r.id}" tabindex="0" title="Click to view or edit">
      <td class="rc-period"><b>${fmtNice(r.period_end)}</b><small>${periodText(r)}</small></td>
      <td class="rc-item">${m ? `${m.ref ? `<b class="ref">${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}` : `<i>Deleted item #${escAttr(r.item_id)}</i>`}</td>
      <td class="rc-cad">${r.cadence}</td>
      <td class="rc-status">${statusPill(r.status)}</td>
      <td class="rc-sum"><div>${escAttr(r.exec_summary)}</div>${r.get_to_green ? '<small class="gtg-flag">Has get to green plan</small>' : ''}</td>
      <td class="rc-author">${escAttr(r.author)}</td>
      <td class="rc-upd">${fmtStamp(r.updated)}</td>
    </tr>`;
  }).join('');
  const filtered = Object.values(rptFilter).some(v => v.trim());
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="grid-empty">${state.reports.length
      ? 'No reports match the filters.'
      : 'No reports yet. Right-click an item on the Gantt chart and choose <b>Provide report</b>, or use <b>+ New report</b>.'}</td></tr>`;
  }
  document.getElementById('rp-count').textContent = filtered
    ? `Showing ${rows.length} of ${state.reports.length}`
    : `${state.reports.length} report${state.reports.length === 1 ? '' : 's'}`;
  document.getElementById('rpf-clear').hidden = !filtered;
}

function initReports() {
  document.getElementById('rp-status').innerHTML = STATUSES.map(st => `
    <label style="--c:${STATUS[st].base};--t:${STATUS[st].text}"><input type="radio" name="status" value="${st}" /><span>${st}</span></label>`).join('');
  document.getElementById('rpf-status').innerHTML = '<option value="">All statuses</option>' + optionList(STATUSES);
  document.getElementById('rpf-cadence').innerHTML = '<option value="">All cadences</option>' + optionList(CADENCES);
}

function wireReports() {
  const menu = document.getElementById('ctx-menu');
  menu.addEventListener('click', onCtxMenuClick);
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideCtxMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  document.addEventListener('scroll', hideCtxMenu, true);
  window.addEventListener('resize', hideCtxMenu);

  const dlg = document.getElementById('report-dialog');
  const form = document.getElementById('report-form');
  form.addEventListener('submit', submitReport);
  form.addEventListener('change', onReportFormInput);
  document.getElementById('rp-cancel').onclick = () => dlg.close();
  document.getElementById('rp-close').onclick = () => dlg.close();
  document.getElementById('rp-delete').onclick = deleteReport;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  document.getElementById('rp-prev').addEventListener('click', onPrevPanelClick);
  document.getElementById('rp-error').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open-report]');
    if (b) openReportDialog({ report: state.reports.find(r => r.id === b.dataset.openReport) });
  });

  document.getElementById('btn-new-report').onclick = () => openReportDialog({ itemId: rptFilter.item });
  const openRow = (e) => {
    const tr = e.target.closest('[data-rid]');
    if (tr) openReportDialog({ report: state.reports.find(r => r.id === tr.dataset.rid) });
  };
  const body = document.getElementById('reports-body');
  body.addEventListener('click', openRow);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
  for (const [id, key] of [['rpf-item', 'item'], ['rpf-status', 'status'], ['rpf-cadence', 'cadence'], ['rpf-q', 'q']]) {
    document.getElementById(id).addEventListener('input', (e) => { rptFilter[key] = e.target.value; renderReports(); });
  }
  document.getElementById('rpf-clear').onclick = () => { clearReportFilters(); renderReports(); };
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

const VIEWS = ['gantt', 'editor', 'reports'];
const isShown = (view) => !document.getElementById(`view-${view}`).classList.contains('hidden');

function switchView(view) {
  hideCtxMenu();
  if (view !== 'editor') {
    syncEditorToState();
    // Clear the hidden table so a later sync can't overwrite edits made elsewhere.
    document.getElementById('editor-body').innerHTML = '';
  }
  if (view === 'gantt') renderGantt();
  else if (view === 'editor') renderEditor();
  else renderReports();
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
    document.getElementById(`tab-${v}`).classList.toggle('active', v === view);
  }
}

function wireEvents() {
  document.getElementById('tab-gantt').onclick = () => switchView('gantt');
  document.getElementById('tab-editor').onclick = () => switchView('editor');
  document.getElementById('tab-reports').onclick = () => switchView('reports');

  document.getElementById('zoom-in').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay * 1.3); };
  document.getElementById('zoom-out').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay / 1.3); };
  document.getElementById('zoom-fit').onclick = () => { state.userZoomed = false; fitZoom(); };
  document.getElementById('zoom-slider').oninput = (e) => { state.userZoomed = true; setZoom(+e.target.value); };
  document.getElementById('row-slider').oninput = (e) => { state.rowH = +e.target.value; renderGantt(); };

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
  document.getElementById('toggle-links').onchange = (e) => { state.showLinks = e.target.checked; renderGantt(); };

  document.getElementById('btn-png').onclick = downloadPNG;
  document.getElementById('btn-gantt-add').onclick = () => openEditDialog(null);

  // gantt: hover card + click to edit
  const gc = document.getElementById('gantt-container');
  const itemAt = (e) => {
    const g = e.target.closest('[data-id]');
    return g && state.items.find(m => m.id === g.dataset.id);
  };
  gc.addEventListener('mouseover', (e) => {
    const m = !document.getElementById('edit-dialog').open && itemAt(e);
    if (m) showTip(m, e); else hideTip();
  });
  gc.addEventListener('mousemove', (e) => { if (document.getElementById('tip').classList.contains('show')) moveTip(e); });
  gc.addEventListener('mouseleave', hideTip);
  gc.addEventListener('click', (e) => { const m = itemAt(e); if (m) openEditDialog(m); });
  gc.addEventListener('contextmenu', (e) => { const m = itemAt(e); if (m) showCtxMenu(m, e); });

  // edit dialog
  const dlg = document.getElementById('edit-dialog');
  const form = document.getElementById('edit-form');
  form.addEventListener('submit', submitEditDialog);
  form.elements.start.addEventListener('input', updateEdType);
  form.elements.end.addEventListener('input', updateEdType);
  document.getElementById('ed-cancel').onclick = () => dlg.close();
  document.getElementById('ed-close').onclick = () => dlg.close();
  document.getElementById('ed-delete').onclick = deleteFromDialog;
  document.getElementById('ed-report').onclick = () => { const m = editing; dlg.close(); openReportDialog({ itemId: m.id }); };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  document.getElementById('ed-deps').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-edrm]');
    if (rm) { edDeps = edDeps.filter(d => d !== rm.dataset.edrm); renderEdDeps(); }
  });
  document.getElementById('ed-deps').addEventListener('change', (e) => {
    if (e.target.id === 'ed-adddep' && e.target.value) { edDeps.push(e.target.value); renderEdDeps(); }
  });

  // editor table
  document.getElementById('btn-add').onclick = () => {
    syncEditorToState();
    const last = state.items.at(-1);
    const today = fmtISO(new Date());
    state.items.push({
      id: nextId(), ref: '', title: 'New item', description: '',
      swimlane: last?.swimlane || 'General', subswimlane: last?.subswimlane || '', owner: last?.owner || '',
      start: today, end: today, status: 'Not Started', shape: 'diamond', parent: '', deps: [],
    });
    clearFilters(); // so the new row is visible
    renderEditor();
    const input = document.querySelector(`#editor-body [data-i="${state.items.length - 1}"][data-k="title"]`);
    input?.scrollIntoView({ block: 'center' });
    input?.select();
    scheduleSave('Item added');
  };

  // grid header: sort, filter, resize
  const head = document.getElementById('grid-head');
  head.addEventListener('click', onGridHeadClick);
  head.addEventListener('input', onGridFilter);
  head.addEventListener('pointerdown', onResizeStart);
  head.addEventListener('dblclick', onResizeReset);
  document.getElementById('btn-clear-filters').onclick = () => {
    clearFilters();
    syncEditorToState();
    renderEditor();
  };
  document.getElementById('btn-reload').onclick = async () => {
    await flushSave(); // don't lose a pending edit
    await loadData();
    renderEditor();
    flashStatus('Reloaded', true);
  };

  document.getElementById('editor-body').addEventListener('change', onEditorChange);
  document.getElementById('editor-body').addEventListener('click', onEditorClick);

  wireReports();

  // Leaving the page with a save still pending: send it anyway.
  window.addEventListener('pagehide', () => {
    if (saveTimer === null) return;
    syncEditorToState();
    navigator.sendBeacon('/api/milestones', toCSV(state.items));
  });

  // Auto-fit while the user hasn't chosen a zoom; re-render otherwise.
  new ResizeObserver(() => {
    if (document.getElementById('view-gantt').classList.contains('hidden')) return;
    if (state.userZoomed) renderGantt();
    else fitZoom();
  }).observe(document.getElementById('gantt-scroll'));
}

(async function init() {
  const f = document.getElementById('edit-form').elements;
  f.status.innerHTML = optionList(STATUSES);
  f.shape.innerHTML = optionList(SHAPES);
  initReports();
  document.getElementById('row-slider').value = state.rowH;
  loadGridPrefs();
  renderGridHead();
  wireEvents();
  await loadData();
  fitZoom(); // also renders; the ResizeObserver keeps it fitted as layout settles
})();
