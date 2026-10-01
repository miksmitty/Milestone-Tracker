/* Tracker frontend — CSV-backed editor + SVG gantt.
 * Every item has a type: a milestone has a single date (start = end, drawn as a shape);
 * a task runs from start to end inclusive (drawn as a bar). Moving either date of a
 * milestone moves the milestone; changing the type is how an item gets a date range. Tasks can roll up to a milestone, and any
 * item can depend on others (finish-to-start) — date changes cascade downstream.
 *
 * `id` is the primary key: an integer, unique, immutable and never reused. All links
 * (parent, depends_on) reference ids. `ref` (e.g. 4.1) is the human-facing label.
 *
 * Periodic status reports live in a second record set (reports.csv); each report
 * points at the item it covers through `item_id`.
 *
 * Items and reports belong to a workspace (workspaces.csv) through `workspace_id`. Only the
 * current workspace's records are held in state.items / state.reports; the rest wait in
 * state.otherItems / state.otherReports and are written back alongside them. Ids stay
 * unique across every workspace. Each workspace can rename its items, milestones and tasks. */

/* ---- RAG options ---- */
// Each workspace has its own list of RAG statuses (statuses.csv): a name, a colour, what it
// means, whether a report at that status needs a get to green plan, and which one new items
// start at. Workspaces without their own list use DEFAULT_STATUSES. Items and reports store
// the status name. STATUS / STATUSES / OFF_TRACK describe the workspace being viewed.
const DEFAULT_STATUSES = [
  { name: 'Green', color: '#16a34a', description: 'on track', get_to_green: false, is_default: false },
  { name: 'Amber', color: '#f59e0b', description: 'at risk', get_to_green: true, is_default: false },
  { name: 'Red', color: '#e60000', description: 'off track', get_to_green: true, is_default: false },
  { name: 'Complete', color: '#1f6fb2', description: 'complete', get_to_green: false, is_default: false },
  { name: 'Not Started', color: '#a8a69c', description: 'not started', get_to_green: false, is_default: true },
];
// Hand-tuned gradients for the standard colours; any other colour gets a derived one.
const PRESET_PALETTES = {
  '#16a34a': { light: '#4ade80', dark: '#166534', text: '#ffffff' },
  '#f59e0b': { light: '#fcd34d', dark: '#92400e', text: '#422006' },
  '#e60000': { light: '#ff6b6b', dark: '#8a0000', text: '#ffffff' },
  '#1f6fb2': { light: '#5b9bd5', dark: '#134a7a', text: '#ffffff' },
  '#a8a69c': { light: '#cccabc', dark: '#5a5d5c', text: '#262626' },
};
const STATUS_COLUMNS = ['workspace_id', 'position', 'name', 'color', 'description', 'get_to_green', 'is_default'];

function mixHex(hex, target, t) {
  const a = hex.match(/\w\w/g).map(x => parseInt(x, 16)), b = target.match(/\w\w/g).map(x => parseInt(x, 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function paletteOf(color) {
  const base = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#a8a69c';
  const preset = PRESET_PALETTES[base];
  if (preset) return { base, ...preset };
  const [r, g, b] = base.match(/\w\w/g).map(x => parseInt(x, 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { base, light: mixHex(base, '#ffffff', 0.4), dark: mixHex(base, '#000000', 0.45), text: lum > 0.6 ? '#262626' : '#ffffff' };
}
const UNKNOWN_PALETTE = paletteOf('#a8a69c');

// A workspace's status list, in order.
function statusesFor(workspaceId) {
  const own = state.statuses.filter(s => s.workspace_id === workspaceId).sort((a, b) => a.position - b.position);
  return own.length ? own : DEFAULT_STATUSES;
}
// { list, names, map: name → palette, offTrack, def } for a workspace.
function ragOf(workspaceId) {
  const list = statusesFor(workspaceId);
  return {
    list,
    names: list.map(s => s.name),
    map: Object.fromEntries(list.map(s => [s.name, paletteOf(s.color)])),
    offTrack: list.filter(s => s.get_to_green).map(s => s.name),
    def: (list.find(s => s.is_default) || list.at(-1)).name,
  };
}

let STATUS = {}, STATUSES = [], OFF_TRACK = [], DEFAULT_STATUS = 'Not Started';
function useStatuses(workspaceId) {
  const r = ragOf(workspaceId);
  STATUS = r.map; STATUSES = r.names; OFF_TRACK = r.offTrack; DEFAULT_STATUS = r.def;
}
const pal = (st, map = STATUS) => map[st] || UNKNOWN_PALETTE;
const gradId = (st) => `grad-${STATUSES.includes(st) ? STATUSES.indexOf(st) : 'x'}`;
// Options for a status select, keeping a value that isn't in the list so it can't be lost.
const statusOptions = (selected, names = STATUSES) =>
  optionList(selected && !names.includes(selected) ? [...names, selected] : names, selected);
const SHAPES = ['diamond', 'circle', 'square', 'triangle'];
// The chart's own colours, light and dark; G is the set in use (see applyTheme).
const GANTT_THEMES = {
  light: {
    bg: '#ffffff', alt: '#f9f8f5', line: '#e0ded6', strong: '#cccabc', tick: '#a8a69c', tierTop: '#ecebe4', tierBottom: '#f4f3ee',
    text: '#262626', textTop: '#1c1c1c', sub: '#5a5d5c', muted: '#7a7870', accent: '#e60000', today: '#1c1c1c',
    weekend: '#1c1c1c', weekendOpacity: 0.035, shadow: '#1c1c1c', shadowOpacity: 0.3, baseline: '#a8a69c',
    links: { dep: '#0f8b8d', roll: '#7c3aed' }, // connector colours stay clear of the RAG palette
    laneAccents: ['#e60000', '#1c1c1c', '#8e8d83', '#a43725', '#1f6fb2', '#cfbd9b', '#5a5d5c'],
  },
  dark: {
    bg: '#1f1f1d', alt: '#252523', line: '#34342f', strong: '#45443e', tick: '#5d5c55', tierTop: '#2c2c29', tierBottom: '#262624',
    text: '#ecebe4', textTop: '#f4f3ee', sub: '#b3b1a6', muted: '#9a988d', accent: '#ff5a5a', today: '#f4f3ee',
    weekend: '#ffffff', weekendOpacity: 0.03, shadow: '#000000', shadowOpacity: 0.5, baseline: '#8e8d83',
    links: { dep: '#2bb5b0', roll: '#a78bfa' },
    laneAccents: ['#ff5a5a', '#cccabc', '#8e8d83', '#d0705c', '#5b9bd5', '#cfbd9b', '#7a7870'],
  },
};
let G = GANTT_THEMES.light;
const COLUMNS = ['id', 'workspace_id', 'ref', 'title', 'type', 'description', 'swimlane', 'subswimlane', 'owner', 'start', 'end', 'rag', 'shape', 'parent', 'depends_on', 'baseline_start', 'baseline_end'];
const MS_DAY = 86400000;

const state = {
  statuses: [],         // RAG options: {workspace_id, position, name, color, description, get_to_green, is_default}
  workspaces: [],       // {id, number, name, code, description, owner, lead, start, end, status, trend, item_term, milestone_term, task_term, created, updated}
  updates: [],          // weekly updates, every workspace: {id, workspace_id, swimlane ('' for the whole program), week_ending, status, summary, author, created, updated}
  lanes: [],            // swimlane details, every workspace: {workspace_id, name, lead, trend}
  lastWorkspaceId: 0,
  workspaceId: '',        // the workspace being viewed
  otherItems: [],       // items of every other workspace, kept so saves write the whole file
  otherReports: [],
  items: [],            // {id, workspace_id, ref, title, type, description, swimlane, subswimlane, owner, start, end, status, shape, parent, deps[]}
  lastId: 0,            // highest id ever issued this session, so ids are never reused
  reports: [],          // {id, workspace_id, item_id, cadence, period_start, period_end, status, exec_summary, achievements, next_steps, get_to_green, author, created, updated}
  lastReportId: 0,
  pxPerDay: 6,
  rowH: 40,
  rangeStart: null,     // Date
  rangeEnd: null,       // Date
  showMonths: true,
  showQuarters: true,
  timescale: 'quarters', // key of TIMESCALES
  showToday: true,
  linkMode: 'all',      // dependency lines: 'all', 'hover' (only the item under the pointer) or 'none'
  showBaseline: true,
  userZoomed: false, // once the user touches zoom, stop auto-fitting on resize
};

const TYPES = ['milestone', 'task'];
const isTask = (m) => m.type === 'task';

/* ---- workspace terminology ---- */
// Each workspace names its things: the generic word (Item), the point-in-time kind (Milestone)
// and the kind with a duration (Task). T.item etc. are lower case for use mid-sentence.
const DEFAULT_TERMS = { item_term: 'Item', milestone_term: 'Milestone', task_term: 'Task' };
function plural(w) {
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + 'es';
  return w + 's';
}
function makeTerms(p) {
  const t = {};
  for (const [key, word] of [['Item', 'item_term'], ['Milestone', 'milestone_term'], ['Task', 'task_term']]) {
    const v = (p?.[word] || '').trim() || DEFAULT_TERMS[word];
    t[key] = v;
    t[key + 's'] = plural(v);
    t[key.toLowerCase()] = v.toLowerCase();
    t[key.toLowerCase() + 's'] = plural(v).toLowerCase();
  }
  return t;
}
let T = makeTerms();
const typeName = (m) => (isTask(m) ? T.Task : T.Milestone);
const typeOptions = (selected) => TYPES.map(t => `<option value="${t}" ${t === selected ? 'selected' : ''}>${escAttr(t === 'task' ? T.Task : T.Milestone)}</option>`).join('');
const withArticle = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const itemLabel = (m) => m.ref || `#${m.id}`;
const fullLabel = (m) => (m.ref ? `${m.ref} ${m.title}` : m.title);
const cmpRef = (a, b) => (!a.ref) - (!b.ref) || a.ref.localeCompare(b.ref, undefined, { numeric: true });

/* ================= CSV ================= */

// Reads CSV (or another delimiter — see detectDelimiter). A leading byte order mark is dropped.
function parseCSV(text, delim = ',') {
  text = text.replace(/^\ufeff/, '');
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
    } else if (c === delim) {
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

// Tab (pasted from a spreadsheet), semicolon (Excel in many European locales) or comma:
// whichever appears most often in the first line, outside quotes.
function detectDelimiter(text) {
  const line = text.replace(/^\ufeff/, '').split(/\r?\n/).find(l => l.trim()) || '';
  const bare = line.replace(/"[^"]*"/g, '');
  const n = (c) => bare.split(c).length - 1;
  return ['\t', ';', ','].reduce((best, c) => (n(c) > n(best) ? c : best), ',');
}
const parseAny = (text) => parseCSV(text, detectDelimiter(text));

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function toCSV(items) {
  const lines = [COLUMNS.join(',')];
  for (const m of items) {
    lines.push([m.id, m.workspace_id, m.ref, m.title, m.type, m.description, m.swimlane, m.subswimlane, m.owner, m.start, m.end,
      m.status, m.shape, m.parent, m.deps.join(';'), m.baseline_start, m.baseline_end].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

// Header names are matched loosely; legacy columns (name, date, rag) still load.
const HEADER_ALIASES = {
  id: ['id'],
  workspace_id: ['workspaceid', 'workspace', 'programid', 'programmeid', 'program', 'programme'], // earlier files said programme
  ref: ['ref', 'reference'],
  title: ['title', 'name'],
  type: ['type', 'kind', 'itemtype'],
  description: ['description', 'desc'],
  swimlane: ['swimlane', 'lane'],
  subswimlane: ['subswimlane', 'sublane'],
  owner: ['owner'],
  start: ['start', 'startdate'],
  end: ['end', 'enddate', 'date'],
  status: ['rag', 'status'],
  shape: ['shape'],
  parent: ['parent', 'rollsupto', 'rollup'],
  deps: ['dependson', 'dependencies', 'deps'],
  baseline_start: ['baselinestart'],
  baseline_end: ['baselineend'],
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
    // Files without a type column: a date range is a task, a single date a milestone.
    const t = get(r, 'type').toLowerCase();
    const type = t.startsWith('t') ? 'task' : t.startsWith('m') ? 'milestone' : start < end ? 'task' : 'milestone';
    if (type === 'milestone') start = end;
    return {
      type,
      id: get(r, 'id'),
      workspace_id: get(r, 'workspace_id'),
      ref: get(r, 'ref'),
      title: get(r, 'title'),
      description: get(r, 'description'),
      swimlane: get(r, 'swimlane') || 'General',
      subswimlane: get(r, 'subswimlane'),
      owner: get(r, 'owner'),
      start, end,
      status: get(r, 'status'), // normalised once the workspace is known
      shape: normaliseShape(get(r, 'shape')),
      parent: get(r, 'parent'),
      deps: get(r, 'deps').split(/[;|\s]+/).filter(Boolean),
      baseline_start: get(r, 'baseline_start'),
      baseline_end: get(r, 'baseline_end'),
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
  // Items from before workspaces existed (or pointing at a missing one) join the first workspace.
  const workspaceIds = new Set(state.workspaces.map(p => p.id));
  for (const m of items) {
    if (!workspaceIds.has(m.workspace_id)) m.workspace_id = state.workspaces[0].id;
    m.status = normaliseStatus(m.status, m.workspace_id);
  }
  // Links only work within a workspace.
  const progOf = new Map(items.map(m => [m.id, m.workspace_id]));
  for (const m of items) {
    m.deps = [...new Set(m.deps)].filter(d => progOf.get(d) === m.workspace_id && d !== m.id);
    if (progOf.get(m.parent) !== m.workspace_id || m.parent === m.id) m.parent = '';
  }
  return items;
}

function nextId() {
  state.lastId = Math.max(state.lastId, ...allItems().map(m => +m.id || 0)) + 1;
  return String(state.lastId);
}

// Match a stored status to the workspace's list (ignoring case). Blank gets the default
// status; the old shorthand (G, A, Y, R, B, done…) still maps onto the standard names.
// Anything else is kept as written and shown in grey.
function normaliseStatus(v, workspaceId) {
  const r = ragOf(workspaceId);
  const raw = (v ?? '').trim(), s = raw.toLowerCase();
  if (!s) return r.def;
  const exact = r.names.find(n => n.toLowerCase() === s);
  if (exact) return exact;
  const legacy = s.startsWith('green') || s === 'g' ? 'Green' : s.startsWith('r') ? 'Red'
    : s.startsWith('a') || s.startsWith('y') ? 'Amber' : s.startsWith('b') || s.startsWith('c') || s.startsWith('done') ? 'Complete'
    : s.startsWith('not') ? 'Not Started' : '';
  return r.names.includes(legacy) ? legacy : raw;
}

function rowsToStatuses(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const yes = (v) => /^(y|yes|true|1)$/i.test(v);
  return rows.slice(1).map(r => {
    const o = {};
    for (const k of STATUS_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    return { ...o, position: +o.position || 0, color: paletteOf(o.color).base, get_to_green: yes(o.get_to_green), is_default: yes(o.is_default) };
  }).filter(s => s.workspace_id && s.name);
}
function statusesToCSV(statuses) {
  return [STATUS_COLUMNS.join(','), ...statuses.map(s => STATUS_COLUMNS.map(k =>
    csvEscape(typeof s[k] === 'boolean' ? (s[k] ? 'yes' : '') : s[k])).join(','))].join('\n') + '\n';
}
function normaliseShape(v) {
  const s = (v ?? '').trim().toLowerCase();
  return SHAPES.includes(s) ? s : 'diamond';
}

/* ================= data load/save ================= */

async function loadData() {
  if (location.protocol === 'file:') throw new Error('the page was opened as a file — run node server.js and open the address it prints');
  const [workspaces, statuses, items, reports, updates, lanes] = await Promise.all(['api/workspaces', 'api/statuses', 'api/milestones', 'api/reports', 'api/updates', 'api/swimlanes'].map(async (u) => {
    const r = await fetch(u);
    // e.g. a server started before workspaces existed: stop rather than save items under the wrong workspace
    if (!r.ok) throw new Error(`${u} returned ${r.status} ${r.statusText} — the app must be opened through its own server (node server.js), not a separate web server or file://`);
    const text = await r.text();
    if (/^\s*</.test(text)) throw new Error(`${u} returned a web page instead of CSV — something between the browser and node server.js (a proxy or another web server) is answering instead`);
    return text;
  }));
  state.workspaces = rowsToWorkspaces(parseAny(workspaces));
  state.statuses = rowsToStatuses(parseAny(statuses));
  for (const p of state.workspaces) p.status = normaliseStatus(p.status, p.id);
  const created = !state.workspaces.length;
  if (created) state.workspaces.push(newWorkspace({ name: 'My workspace' }));
  const allItems = rowsToItems(parseAny(items));
  const allReports = rowsToReports(parseAny(reports), allItems);
  state.updates = rowsToUpdates(parseAny(updates));
  state.lanes = rowsToLanes(parseAny(lanes));
  dataLoaded = true;
  if (created) await saveCSV('api/workspaces', workspacesToCSV(state.workspaces));
  state.items = allItems;
  state.reports = allReports;
  state.otherItems = [];
  state.otherReports = [];
  const prefs = loadAppPrefs();
  const want = state.workspaceId || prefs.workspaceId || prefs.programId; // programId: saved by earlier versions
  selectWorkspace(state.workspaces.some(p => p.id === want) ? want : state.workspaces[0].id);
}

// Hold the chosen workspace's items and reports in state.items / state.reports.
function selectWorkspace(id) {
  const items = [...state.otherItems, ...state.items];
  const reports = [...state.otherReports, ...state.reports];
  state.workspaceId = id;
  state.items = items.filter(m => m.workspace_id === id);
  state.otherItems = items.filter(m => m.workspace_id !== id);
  state.reports = reports.filter(r => r.workspace_id === id);
  state.otherReports = reports.filter(r => r.workspace_id !== id);
  T = makeTerms(currentWorkspace());
  useStatuses(id);
  saveAppPrefs({ workspaceId: id });
  autoRange();
}

const currentWorkspace = () => state.workspaces.find(p => p.id === state.workspaceId);
const workspaceById = (id) => state.workspaces.find(p => p.id === id);

// Every workspace's records, grouped by workspace (in workspace order) for a stable file.
function allRecords(current, others) {
  const order = new Map(state.workspaces.map((p, i) => [p.id, i]));
  return [...others, ...current].sort((a, b) => order.get(a.workspace_id) - order.get(b.workspace_id));
}
const allItems = () => allRecords(state.items, state.otherItems);
const allReports = () => allRecords(state.reports, state.otherReports);

// Every change is written back to its CSV. Saves are queued so they reach the server in order.
let saveQueue = Promise.resolve();
let saveTimer = null;
// Until every file has loaded nothing is written: saving the half-empty state would overwrite them.
let dataLoaded = false;
let pendingMsg = '';

// The server logs every change to an item's dates (date-changes.csv), with who made it. Each save
// of the items says how (`via`, e.g. "Quick update panel") and what the change was (the message), and
// which items only moved because something they depend on moved.
const knockOn = new Set();     // since the last save: items moved by a dependency…
const directEdits = new Set(); // …and items changed directly, which aren't knock-on even if both
function saveData(msg, via = 'Items table') {
  syncEditorToState();
  const headers = auditHeaders(msg, via);
  knockOn.clear();
  directEdits.clear();
  return saveCSV('api/milestones', toCSV(allItems()), msg, headers);
}
function auditHeaders(note, via) {
  const enc = encodeURIComponent;
  return {
    'X-Change-Via': enc(via), 'X-Change-Note': enc(note || ''),
    'X-Knock-On': [...knockOn].filter(id => !directEdits.has(id)).join(','),
  };
}
function saveReports(msg) {
  return saveCSV('api/reports', reportsToCSV(allReports()), msg);
}
function saveStatuses(msg) {
  return saveCSV('api/statuses', statusesToCSV(state.statuses), msg);
}
function saveWorkspaces(msg) {
  return saveCSV('api/workspaces', workspacesToCSV(state.workspaces), msg);
}
function saveUpdates(msg) {
  return saveCSV('api/updates', updatesToCSV(state.updates), msg);
}
function saveLanes(msg) {
  return saveCSV('api/swimlanes', lanesToCSV(state.lanes), msg);
}

function saveCSV(url, body, msg, headers = {}) { // body is snapshotted by the caller, even if the queue is busy
  if (!dataLoaded) {
    flashStatus('Not saved — the data hasn’t loaded, so saving would overwrite it', false, true);
    return Promise.resolve(false);
  }
  saveQueue = saveQueue.then(async () => {
    flashStatus('Saving…', null);
    try {
      const res = await fetch(url, { method: 'POST', body, headers });
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
  return saveData(msg, 'Items table');
}

function flashStatus(msg, ok, sticky) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  clearTimeout(el._t);
  if (ok !== null && !sticky) el._t = setTimeout(() => { el.textContent = ''; }, 5000);
}

/* ---- undo ---- */
// Changes made in one go (deletes, imports, bulk edits, dragging on the chart, quick updates)
// snapshot every record set first. The toast that reports the change offers Undo — so does
// ⌘/Ctrl+Z when you're not typing — which puts the snapshot back and saves what it changes.

const undoStack = []; // [{ label, snap }], newest last
const UNDO_KEYS = ['items', 'reports', 'updates', 'workspaces', 'statuses', 'lanes'];

function snapshotData() {
  syncEditorToState();
  return {
    items: JSON.stringify(allItems()), reports: JSON.stringify(allReports()), updates: JSON.stringify(state.updates),
    workspaces: JSON.stringify(state.workspaces), statuses: JSON.stringify(state.statuses), lanes: JSON.stringify(state.lanes),
    workspaceId: state.workspaceId,
  };
}

// Call with a snapshot taken before the change, once the change is made.
function offerUndo(snap, label) {
  undoStack.push({ label, snap });
  if (undoStack.length > 30) undoStack.shift();
  showToast(label, true);
}

async function undoLast() {
  const u = undoStack.pop();
  if (!u) return showToast('Nothing to undo');
  if (!leavePaneEdit()) { undoStack.push(u); return; }
  hideQuick();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  clearTimeout(saveTimer);
  saveTimer = null;
  const now = snapshotData();
  const changed = UNDO_KEYS.filter(k => now[k] !== u.snap[k]);
  const s = u.snap;
  state.workspaces = JSON.parse(s.workspaces);
  state.statuses = JSON.parse(s.statuses);
  state.updates = JSON.parse(s.updates);
  state.lanes = JSON.parse(s.lanes);
  state.items = []; state.reports = [];
  state.otherItems = JSON.parse(s.items);
  state.otherReports = JSON.parse(s.reports);
  document.getElementById('editor-body').innerHTML = ''; // so a sync can't write the undone values back
  const range = [state.rangeStart, state.rangeEnd];
  selectWorkspace(state.workspaces.some(p => p.id === state.workspaceId) ? state.workspaceId : s.workspaceId);
  [state.rangeStart, state.rangeEnd] = range;
  applyWorkspaceChrome();
  rerenderCurrentView();
  if (isShown('editor')) renderEditor();
  showToast(`Undone: ${u.label}`);
  knockOn.clear();
  directEdits.clear();
  const save = { items: () => saveData(`Undone: ${u.label}`, 'Undo'), reports: saveReports, updates: saveUpdates, workspaces: saveWorkspaces, statuses: saveStatuses, lanes: saveLanes };
  await Promise.all(changed.map(k => save[k]('Undone')));
}

// A short message at the foot of the window, with Undo when the change can be taken back.
function showToast(msg, undo = false) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span class="toast-msg">${escAttr(msg)}</span>${undo ? '<button type="button" class="toast-undo" data-undo>Undo</button>' : ''}<button type="button" class="toast-close" title="Dismiss" aria-label="Dismiss">✕</button>`;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart the entrance animation
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, undo ? 9000 : 4000);
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

// A task's length in calendar days, counting both its start and end day.
const taskDays = (m) => (m.start && m.end ? Math.max(1, daysBetween(m.start, m.end) + 1) : 0);

// Whether a RAG status means the work is done (named or described as complete / done).
function isDoneStatus(name, workspaceId = state.workspaceId) {
  const st = statusesFor(workspaceId).find(s => s.name === name);
  return [name, st?.description].some(v => /^\s*(complete|completed|done)\s*$/i.test(v || ''));
}

// Overdue: its end date has passed and it isn't at a done status. A late start is a task whose
// start has passed while it's still at the workspace's default (not started) status.
const todayISO = () => fmtISO(new Date());
const isLate = (m) => !!m.end && m.end < todayISO() && !isDoneStatus(m.status, m.workspace_id);
const isLateStart = (m) => isTask(m) && !isLate(m) && !!m.start && m.start < todayISO() && m.status === ragOf(m.workspace_id).def;
const daysText = (n) => `${n} day${n === 1 ? '' : 's'}`;
const lateText = (m) => `Overdue by ${daysText(daysBetween(m.end, todayISO()))}`;
const lateStartText = (m) => `Should have started ${daysText(daysBetween(m.start, todayISO()))} ago`;

// A milestone's progress: the share of its tasks' total duration that is complete. Counts the
// tasks that roll up to it, directly or through other milestones. null when it has no tasks.
function milestoneProgress(m) {
  const kids = new Map();
  for (const x of state.items) if (x.parent) (kids.get(x.parent) || kids.set(x.parent, []).get(x.parent)).push(x);
  const seen = new Set([m.id]), tasks = [];
  const walk = (id) => {
    for (const c of kids.get(id) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (isTask(c)) tasks.push(c); else walk(c.id);
    }
  };
  walk(m.id);
  const total = tasks.reduce((a, t) => a + taskDays(t), 0);
  if (!total) return null;
  const done = tasks.filter(t => isDoneStatus(t.status));
  const doneDays = done.reduce((a, t) => a + taskDays(t), 0);
  return { pct: Math.floor((doneDays / total) * 100), doneDays, total, doneCount: done.length, count: tasks.length };
}

function autoRange() {
  const shown = state.items.filter(ganttMatches);
  const dates = (shown.length ? shown : state.items).flatMap(m => [parseDate(m.start), parseDate(m.end)]).filter(Boolean);
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

/* ---- baseline ---- */
// A snapshot of the planned dates (View → Set baseline), kept in baseline_start / baseline_end.
// The chart shows where an item was planned when it has moved, and the hover card how far.
const hasBaseline = (m) => !!(m.baseline_end && (m.baseline_start || !isTask(m)));
const baselineMoved = (m) => hasBaseline(m) && (m.baseline_end !== m.end || (isTask(m) && m.baseline_start !== m.start));
function baselineRow(m) {
  if (!hasBaseline(m)) return '';
  const when = isTask(m) && m.baseline_start !== m.baseline_end ? `${fmtShort(m.baseline_start)} – ${fmtShort(m.baseline_end)}` : fmtShort(m.baseline_end);
  const d = daysBetween(m.baseline_end, m.end);
  const drift = !d ? (baselineMoved(m) ? 'same end date' : 'on baseline') : d > 0 ? `slipped ${daysText(d)}` : `${daysText(-d)} early`;
  return `<div class="tip-row tip-muted"><span>Baseline ${when} · <b class="${d > 0 ? 'tip-slip' : ''}">${drift}</b></span></div>`;
}

// Record (or clear) every item's dates as the baseline, for the whole workspace.
async function setBaseline(on) {
  const snap = snapshotData();
  for (const m of state.items) {
    m.baseline_start = on ? m.start : '';
    m.baseline_end = on ? m.end : '';
  }
  renderGantt();
  const msg = on ? `Baseline set from today’s dates for ${count(state.items.length, T.item, T.items)}` : 'Baseline cleared';
  offerUndo(snap, msg);
  await saveData(msg, 'Baseline');
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

// Move everything downstream of `ids` (via explicit dependencies) by `delta` days,
// so gaps between linked items are preserved whether the change is earlier or later.
function cascadeShift(ids, delta) {
  if (!delta) return;
  const byId = new Map(state.items.map(m => [m.id, m]));
  const depSucc = new Map();
  for (const m of state.items) {
    for (const d of m.deps) {
      if (!depSucc.has(d)) depSucc.set(d, []);
      depSucc.get(d).push(m.id);
    }
  }
  const queue = ids.flatMap(id => depSucc.get(id) || []);
  const seen = new Set(ids);
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
  if (!m.start) m.start = m.end;
  if (!m.end) m.end = m.start;
  if (!isTask(m)) {
    // A milestone has one date: changing either moves it (a task turning into one keeps its end).
    m.start = m.end = startChanged && !endChanged ? m.start : m.end;
  } else if (m.end < m.start) {
    if (startChanged && !endChanged) m.end = m.start; else m.start = m.end;
  }

  if (hasCycle()) {
    Object.assign(m, before);
    return { error: 'That link would create a circular dependency.' };
  }
  const snapshot = new Map(state.items.map(x => [x.id, x.start + x.end]));
  cascadeShift([m.id], before.end && m.end ? daysBetween(before.end, m.end) : 0);
  enforceConstraints();
  const moved = state.items.filter(x => snapshot.get(x.id) !== x.start + x.end).map(x => x.id);
  directEdits.add(m.id);
  for (const id of moved) if (id !== m.id) knockOn.add(id);
  return { moved };
}

function movedMessage(m, moved) {
  const parts = [];
  if (moved.includes(m.id)) parts.push(`${itemLabel(m)} moved to ${fmtShort(m.start)} to respect its dependencies`);
  const others = moved.filter(id => id !== m.id).length;
  if (others) parts.push(`${others} downstream ${others > 1 ? T.items : T.item} rescheduled`);
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

// Header units. labels() lists candidates longest first; the first that fits its cell is drawn.
const gb = (d, o) => d.toLocaleDateString('en-GB', o);
const TIME_UNITS = {
  quarter: {
    start: d => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1),
    next: d => new Date(d.getFullYear(), d.getMonth() + 3, 1),
    labels: d => { const q = `Q${Math.floor(d.getMonth() / 3) + 1}`; return [`${q} ${d.getFullYear()}`, `${q} ’${String(d.getFullYear()).slice(2)}`, q]; },
  },
  month: {
    start: d => new Date(d.getFullYear(), d.getMonth(), 1),
    next: d => new Date(d.getFullYear(), d.getMonth() + 1, 1),
    labels: d => [gb(d, { month: 'long', year: 'numeric' }), `${gb(d, { month: 'short' })} ’${String(d.getFullYear()).slice(2)}`, gb(d, { month: 'short' }), gb(d, { month: 'narrow' })],
  },
  week: { // weeks start on Monday
    start: d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)),
    next: d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7),
    labels: d => [`w/c ${gb(d, { day: 'numeric', month: 'short', year: 'numeric' })}`, gb(d, { day: 'numeric', month: 'short' }), String(d.getDate())],
  },
  day: {
    start: d => new Date(d.getFullYear(), d.getMonth(), d.getDate()),
    next: d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
    labels: d => [`${gb(d, { weekday: 'short' })} ${d.getDate()}`, String(d.getDate()), gb(d, { weekday: 'narrow' })],
  },
};
// Timescale presets: top and bottom header tiers, and the zoom (px per day) each opens at.
const TIMESCALES = {
  quarters: { top: 'quarter', bottom: 'month', px: null }, // fits the range to the window
  months: { top: 'month', bottom: 'week', px: 14 },
  weeks: { top: 'week', bottom: 'day', px: 50 },
};
const MAX_ZOOM = 80;

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
  const tagW = m._tag ? textW(m._tag, size, 700) + REF_GAP : 0;
  const title = truncate(m.title, Math.max(24, maxW - refW - tagW), size, 600);
  return { title, w: refW + textW(title, size, 600) + tagW };
}

function metaText(m) {
  const dates = isTask(m) ? `${fmtShort(m.start)} – ${fmtShort(m.end)}` : fmtShort(m.end);
  return m.owner ? `${dates} · ${m.owner}` : dates;
}

// Title with the ref in bold ahead of it, and the tag (milestone % complete) after.
function titleText(attrs, m, refFill, tagFill) {
  const t = svgEl('text', attrs);
  if (m.ref) {
    t.appendChild(svgEl('tspan', { 'font-weight': 700, fill: refFill }, m.ref));
    t.appendChild(svgEl('tspan', { dx: REF_GAP }, m._title));
  } else t.textContent = m._title;
  if (m._tag) t.appendChild(svgEl('tspan', { dx: REF_GAP, 'font-weight': 700, fill: tagFill }, m._tag));
  return t;
}

// Outside labels get an outline in the background colour so they stay readable over gridlines and arrows.
const halo = () => ({ 'paint-order': 'stroke', stroke: G.bg, 'stroke-width': 3, 'stroke-linejoin': 'round' });

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
  sortLanes(lanes);
  const oneEach = ganttSort.rows !== 'packed';
  const folded = collapsedLanes();
  for (const lane of lanes) {
    if (folded.has(lane.name)) {
      // folded: one summary row for the whole swimlane
      const all = lane.subs.flatMap(sub => sub.items);
      for (const m of all) m._row = 0;
      lane.collapsed = true;
      lane.count = all.length;
      lane.subs = [{ name: '', items: all, rows: 1, collapsed: true, h: Math.max(44, rm.h + rm.pad * 2) }];
      lane.h = lane.subs[0].h;
      continue;
    }
    for (const sub of lane.subs) {
      sub.items.sort(oneEach ? ganttItemOrder : (a, b) => a._s - b._s || a._e - b._e);
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
        let r = oneEach ? -1 : rowEnds.findIndex(end => left - 10 > end);
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
  const c = pal(status);
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
  el.setAttribute('fill', `url(#${gradId(status)})`);
  el.setAttribute('stroke', c.dark);
  el.setAttribute('stroke-width', '1.4');
  el.setAttribute('filter', 'url(#ms-shadow)');
  parent.appendChild(el);
}


// A path through right-angled points, with the corners rounded.
function roundedPath(pts, r = 5) {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const k = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * k, ay = y - Math.sign(y - py) * k;
    const bx = x + Math.sign(nx - x) * k, by = y + Math.sign(ny - y) * k;
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const [lx, ly] = pts.at(-1);
  return d + ` L ${lx} ${ly}`;
}

// Elbow connector from the end of `a` to the start of `b`. The vertical run sits just before `b`,
// so lines drop into what they lead to rather than hanging off early items across the chart.
function drawLink(svg, a, b, rollup, rm) {
  const fx = a.x2 + (a.task ? 0 : rm.shapeS + 2), fy = a.cy;
  const tx = b.x1 - (b.task ? 0 : rm.shapeS + 3), ty = b.cy;
  let d;
  if (fy === ty && tx > fx) d = `M ${fx} ${fy} H ${tx}`;
  else if (tx - fx >= 14) d = roundedPath([[fx, fy], [tx - 8, fy], [tx - 8, ty], [tx, ty]]);
  else {
    const midY = fy === ty ? fy + rm.h / 2 : (fy + ty) / 2;
    d = roundedPath([[fx, fy], [fx + 7, fy], [fx + 7, midY], [tx - 9, midY], [tx - 9, ty], [tx, ty]]);
  }
  svg.appendChild(svgEl('path', {
    d, fill: 'none', class: 'gantt-link', 'data-from': a.id, 'data-to': b.id,
    stroke: G.links[rollup ? 'roll' : 'dep'], 'stroke-width': 1.4, 'stroke-opacity': 0.75,
    'stroke-dasharray': rollup ? '4 3' : 'none',
    'marker-end': `url(#arrow-${rollup ? 'roll' : 'dep'})`,
  }));
}

function renderGantt() {
  const container = document.getElementById('gantt-container');
  container.innerHTML = '';
  hideTip();
  chainLinks = null;
  if (!state.rangeStart) return; // data not loaded yet

  const LABEL_W = labelWidth();
  const subCol = hasSubLanes();
  const rm = rowMetrics();

  const items = state.items
    // a task's end date is inclusive, so its bar runs to the end of that day
    .map(m => ({ ...m, _s: parseDate(m.start), _e: parseDate(isTask(m) && m.end ? addDays(m.end, 1) : m.end), _task: isTask(m) }))
    .map(m => {
      // tag after a milestone's title: its % complete (a task's duration is in the hover card)
      const prog = !m._task && milestoneProgress(m);
      return { ...m, _tag: prog ? `${prog.pct}%` : '' };
    })
    .filter(m => m._s && m._e && m._e >= state.rangeStart && m._s <= state.rangeEnd && ganttMatches(m));
  renderGanttFilters();

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
    width, height, viewBox: `0 0 ${width} ${height}`, class: state.linkMode === 'hover' ? 'links-hover' : '',
    xmlns: 'http://www.w3.org/2000/svg',
    style: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
  });

  // defs: status gradients, drop shadow, arrowheads
  const defs = svgEl('defs', {});
  for (const st of [...STATUSES, null]) { // null: a status that isn't in the workspace's list
    const c = pal(st);
    const g = svgEl('linearGradient', { id: gradId(st), x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': c.light }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': c.base }));
    defs.appendChild(g);
  }
  const f = svgEl('filter', { id: 'ms-shadow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  f.appendChild(svgEl('feDropShadow', { dx: 0, dy: 1.2, stdDeviation: 1.2, 'flood-color': G.shadow, 'flood-opacity': G.shadowOpacity }));
  defs.appendChild(f);
  for (const [id, color] of Object.entries(G.links)) {
    const mk = svgEl('marker', { id: `arrow-${id}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' });
    mk.appendChild(svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 Z', fill: color }));
    defs.appendChild(mk);
  }
  svg.appendChild(defs);

  // background
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: G.bg }));

  // Label column and timescale header are separate layers, pinned while the chart scrolls
  // (see syncGanttSticky) so swimlane names and dates stay in view, as in MS Project.
  const col = svgEl('g', { class: 'gantt-col' });
  const head = svgEl('g', { class: 'gantt-head' });
  const corner = svgEl('g', { class: 'gantt-corner' });
  head.appendChild(svgEl('rect', { x: 0, y: 0, width, height: headerH, fill: G.bg }));
  corner.appendChild(svgEl('rect', { x: 0, y: 0, width: LABEL_W, height: headerH, fill: G.bg }));
  corner.appendChild(svgEl('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: headerH, stroke: G.strong, 'stroke-width': 1 }));
  if (headerH) corner.appendChild(svgEl('line', { x1: 0, y1: headerH, x2: LABEL_W, y2: headerH, stroke: G.strong, 'stroke-width': 1 }));

  // lane backgrounds (alternating) + lane / sub-lane labels
  let y = headerH;
  lanes.forEach((lane, i) => {
    if (i % 2 === 1) svg.appendChild(svgEl('rect', { x: 0, y, width, height: lane.h, fill: G.alt }));
    col.appendChild(svgEl('rect', { x: 0, y, width: LABEL_W, height: lane.h, fill: i % 2 ? G.alt : G.bg }));
    const accent = G.laneAccents[i % G.laneAccents.length];
    col.appendChild(svgEl('rect', { x: 0, y: y + 4, width: 4, height: lane.h - 8, rx: 2, fill: accent }));
    const laneColW = subCol ? LANE_COL_W : LABEL_W;
    // click the swimlane's name to fold it into one summary row (and back)
    const toggle = svgEl('g', { class: 'lane-toggle', 'data-lane': lane.name, role: 'button', tabindex: 0,
      'aria-expanded': String(!lane.collapsed), 'aria-label': `${lane.collapsed ? 'Expand' : 'Collapse'} ${lane.name}` });
    toggle.appendChild(svgEl('rect', { x: 4, y, width: laneColW - 4, height: lane.h, fill: 'transparent' }));
    toggle.appendChild(svgEl('path', {
      d: lane.collapsed ? `M 14 ${y + lane.h / 2 - 4} l 4.5 4 l -4.5 4` : `M 12 ${y + lane.h / 2 - 2} l 4 4.5 l 4 -4.5`,
      fill: 'none', stroke: G.muted, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    const nameY = lane.collapsed ? y + lane.h / 2 + 1 : y + lane.h / 2 + 5;
    toggle.appendChild(svgEl('text', { x: 26, y: nameY, 'font-size': 14, 'font-weight': 700, fill: G.text }, truncate(lane.name, laneColW - 34, 14, 700)));
    if (lane.collapsed) toggle.appendChild(svgEl('text', { x: 26, y: nameY + 13, 'font-size': 10.5, fill: G.muted }, `${lane.count} ${lane.count === 1 ? T.item : T.items} folded`));
    col.appendChild(toggle);

    let sy = y;
    lane.subs.forEach((sub, j) => {
      sub._y = sy;
      if (subCol) {
        if (j > 0) {
          svg.appendChild(svgEl('line', { x1: LANE_COL_W, y1: sy, x2: width, y2: sy, stroke: G.line, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
          col.appendChild(svgEl('line', { x1: LANE_COL_W, y1: sy, x2: LABEL_W, y2: sy, stroke: G.line, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
        }
        if (sub.name) {
          col.appendChild(svgEl('text', {
            x: LANE_COL_W + 12, y: sy + sub.h / 2 + 4, 'font-size': 12, 'font-weight': 600, fill: G.sub,
          }, truncate(sub.name, SUB_COL_W - 20, 12, 600)));
        }
      }
      sy += sub.h;
    });
    if (subCol) {
      col.appendChild(svgEl('line', { x1: LANE_COL_W, y1: y, x2: LANE_COL_W, y2: y + lane.h, stroke: G.line, 'stroke-width': 1 }));
    }
    svg.appendChild(svgEl('line', { x1: 0, y1: y + lane.h, x2: width, y2: y + lane.h, stroke: G.line, 'stroke-width': 1 }));
    col.appendChild(svgEl('line', { x1: 0, y1: y + lane.h, x2: LABEL_W, y2: y + lane.h, stroke: G.line, 'stroke-width': 1 }));
    y += lane.h;
  });

  // vertical separator between labels and chart
  col.appendChild(svgEl('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: height, stroke: G.strong, 'stroke-width': 1 }));

  // ---- timescale: two tiers of headers + grid, like MS Project ----
  const gridBottom = headerH + bodyH;
  const scale = TIMESCALES[state.timescale];
  const topH = state.showQuarters ? QUARTER_H : 0;

  // weekends shaded once days are wide enough to pick out
  if (state.pxPerDay >= 8) {
    const d = new Date(state.rangeStart);
    d.setDate(d.getDate() - 1); // catch a Sunday at the very start
    for (; d < state.rangeEnd; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 6) continue; // Saturday: shade Sat + Sun together
      const x1 = xOf(d), x2 = xOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2));
      if (x2 > x1) svg.appendChild(svgEl('rect', { x: x1, y: headerH, width: x2 - x1, height: bodyH, fill: G.weekend, 'fill-opacity': G.weekendOpacity }));
    }
  }

  // One tier: header band with a label per unit, and a gridline at each unit's start.
  const drawTier = (unit, bandY, bandH, top) => {
    const u = TIME_UNITS[unit];
    head.appendChild(svgEl('rect', { x: LABEL_W, y: bandY, width: chartW, height: bandH, fill: top ? G.tierTop : G.tierBottom }));
    const size = top ? 12.5 : 11.5, weight = top ? 700 : 600;
    const cells = [];
    for (let d = u.start(state.rangeStart); d < state.rangeEnd; d = u.next(d)) {
      const x1 = Math.max(LABEL_W, rawX(d));
      const x2 = Math.min(width - PAD_RIGHT + 10, rawX(u.next(d)));
      if (x2 - x1 < 4) continue;
      if (rawX(d) >= LABEL_W) {
        const line = top ? { stroke: G.tick, 'stroke-width': 1.2 } : { stroke: G.line, 'stroke-width': 1 };
        head.appendChild(svgEl('line', { x1: rawX(d), y1: bandY, x2: rawX(d), y2: headerH, ...line }));
        svg.appendChild(svgEl('line', { x1: rawX(d), y1: headerH, x2: rawX(d), y2: gridBottom, ...line }));
      }
      cells.push({ x1, x2, labels: u.labels(d), full: rawX(u.next(d)) - rawX(d) });
    }
    // one label style for the whole tier: the longest that fits every full-width cell
    const fits = (c, i) => textW(c.labels[i], size, weight) <= c.full - 8;
    const n = cells[0] ? cells[0].labels.length : 0;
    let style = 0;
    while (style < n && !cells.every(c => fits(c, style))) style++;
    for (const c of cells) {
      // part-cells at the range edges fall back to shorter labels, or none
      let i = style;
      while (i < n && textW(c.labels[i], size, weight) > c.x2 - c.x1 - 8) i++;
      if (i < n) {
        head.appendChild(svgEl('text', {
          x: (c.x1 + c.x2) / 2, y: bandY + bandH / 2 + 4.5, 'text-anchor': 'middle',
          'font-size': size, 'font-weight': weight, fill: top ? G.textTop : G.sub,
        }, c.labels[i]));
      }
    }
    head.appendChild(svgEl('line', { x1: LABEL_W, y1: bandY + bandH, x2: width, y2: bandY + bandH, stroke: G.strong, 'stroke-width': 1 }));
  };
  if (state.showMonths) drawTier(scale.bottom, topH, MONTH_H, false);
  if (state.showQuarters) drawTier(scale.top, 0, QUARTER_H, true);
  const gridTop = headerH;

  // ---- positions ----
  const pos = new Map();
  for (const lane of lanes) {
    for (const sub of lane.subs) {
      for (const m of sub.items) {
        m._cy = sub.collapsed ? sub._y + sub.h / 2 : sub._y + rm.pad + m._row * rm.h + rm.h / 2 - rm.offset;
        m._sub = sub;
        m._collapsed = !!sub.collapsed;
        pos.set(m.id, { id: m.id, x1: xOf(m._s), x2: xOf(m._e), cy: m._cy, task: m._task });
      }
    }
  }

  // ---- dependency + roll-up connectors (under the items) ----
  if (state.linkMode !== 'none') {
    const shown = (id) => pos.has(id) && !items.find(x => x.id === id)._collapsed; // folded swimlanes draw no links
    for (const m of items) {
      if (m._collapsed) continue;
      const b = pos.get(m.id);
      for (const d of m.deps) if (shown(d)) drawLink(svg, pos.get(d), b, false, rm);
      if (m.parent && shown(m.parent)) drawLink(svg, b, pos.get(m.parent), true, rm);
    }
  }

  // ---- items ----
  for (const m of items) {
    const { x1, x2, cy } = pos.get(m.id);
    const c = pal(m.status);
    const g = svgEl('g', { 'data-id': m.id, class: 'gantt-item' });

    if (m._collapsed) {
      // a folded swimlane: every item on one row, small and unlabelled (the hover card still works)
      if (m._task) {
        g.appendChild(svgEl('rect', { x: x1, y: cy - 3.5, width: Math.max(2, x2 - x1), height: 7, rx: 3.5, fill: `url(#${gradId(m.status)})`, stroke: c.dark, 'stroke-width': 0.8, 'fill-opacity': 0.9 }));
      } else drawShape(g, m.shape, x1, cy, m.status, 4.5);
      svg.appendChild(g);
      continue;
    }

    // where it was planned, when the baseline is shown and it has moved: a thin bar just under a
    // task's bar, or a dashed outline of a milestone's shape
    if (state.showBaseline && baselineMoved(m)) {
      const bs = parseDate(isTask(m) ? m.baseline_start : m.baseline_end), be = parseDate(isTask(m) ? addDays(m.baseline_end, 1) : m.baseline_end);
      const bx1 = xOf(bs), bx2 = xOf(be);
      const ghost = { fill: 'none', stroke: G.baseline, 'stroke-width': 1.2, 'stroke-dasharray': '3 2', 'pointer-events': 'none', class: 'gantt-baseline' };
      if (m._task) g.appendChild(svgEl('rect', { x: bx1, y: cy + rm.barH / 2 + 1.5, width: Math.max(2, bx2 - bx1), height: 3, rx: 1.5, fill: G.baseline, 'pointer-events': 'none', class: 'gantt-baseline' }));
      else {
        const sz = rm.shapeS + 2;
        g.appendChild(svgEl('path', { d: `M ${bx1} ${cy - sz} L ${bx1 + sz} ${cy} L ${bx1} ${cy + sz} L ${bx1 - sz} ${cy} Z`, ...ghost }));
      }
    }

    if (m._task) {
      const bh = rm.barH;
      g.appendChild(svgEl('rect', {
        x: x1, y: cy - bh / 2, width: Math.max(2, x2 - x1), height: bh, rx: Math.min(5, bh / 3),
        fill: `url(#${gradId(m.status)})`, stroke: c.dark, 'stroke-width': 1.2, filter: 'url(#ms-shadow)',
      }));
      if (m._side === 'inside') {
        g.appendChild(titleText({ x: x1 + 8, y: cy + 4.5, 'font-size': 12, 'font-weight': 600, fill: c.text }, m, c.text, c.text));
        if (m._meta) g.appendChild(svgEl('text', { x: x1 + 2, y: cy + bh / 2 + 13, 'font-size': 10.5, fill: G.muted, ...halo() }, m._meta));
      }
    } else {
      // stem down to sub-lane bottom for readability
      g.appendChild(svgEl('line', {
        x1, y1: cy + rm.shapeS + 3, x2: x1, y2: m._sub._y + m._sub.h - 4, 'pointer-events': 'none',
        stroke: G.strong, 'stroke-width': 1, 'stroke-dasharray': '2 3',
      }));
      drawShape(g, m.shape, x1, cy, m.status, rm.shapeS);
    }
    if (m._side !== 'inside') {
      const anchor = m._side === 'left' ? 'end' : 'start';
      const ty = rm.detail ? cy + 1 : cy + 4.5;
      g.appendChild(titleText({ x: m._lx, y: ty, 'text-anchor': anchor, 'font-size': 12.5, 'font-weight': 600, fill: G.text, ...halo() }, m, G.accent, G.muted));
      if (m._meta) g.appendChild(svgEl('text', { x: m._lx, y: cy + 15, 'text-anchor': anchor, 'font-size': 10.5, fill: G.muted, ...halo() }, m._meta));
    }
    // overdue: a red "!" on its top-right corner; a late start gets an amber one
    const late = isLate(m), lateStart = !late && isLateStart(m);
    if (late || lateStart) {
      const bx = m._task ? x2 - 1 : x1 + rm.shapeS + 1, by = m._task ? cy - rm.barH / 2 : cy - rm.shapeS - 1;
      const badge = svgEl('g', { class: 'gantt-late', 'pointer-events': 'none' });
      badge.appendChild(svgEl('circle', { cx: bx, cy: by, r: 6, fill: late ? G.accent : '#f59e0b', stroke: G.bg, 'stroke-width': 1.5 }));
      badge.appendChild(svgEl('text', { x: bx, y: by + 3.4, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 800, fill: late ? '#fff' : '#422006' }, '!'));
      g.appendChild(badge);
    }
    svg.appendChild(g);
  }

  // ---- today line (on top of the items, but see-through so labels stay readable) ----
  // Its label sits in the timescale header, so it never covers an item and stays in view when scrolling.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (state.showToday && today >= state.rangeStart && today <= state.rangeEnd) {
    const tx = rawX(today);
    svg.appendChild(svgEl('line', {
      x1: tx, y1: gridTop, x2: tx, y2: gridBottom, 'pointer-events': 'none',
      stroke: G.today, 'stroke-width': 1.5, 'stroke-dasharray': '5 4', 'stroke-opacity': 0.45,
    }));
    const pill = svgEl('g', { 'pointer-events': 'none', class: 'gantt-today' });
    const py = headerH ? headerH - 18 : gridTop + 4;
    pill.appendChild(svgEl('rect', { x: tx - 21, y: py, width: 42, height: 15, rx: 7.5, fill: G.accent }));
    pill.appendChild(svgEl('text', { x: tx, y: py + 11, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700, 'letter-spacing': '.04em', fill: '#fff' }, 'TODAY'));
    (headerH ? head : svg).appendChild(pill);
  }

  if (!items.length && ganttFiltered()) {
    svg.appendChild(svgEl('text', { x: LABEL_W + 20, y: headerH + 64, 'font-size': 13, fill: G.muted },
      `No ${T.items} match the filters in this date range.`));
  }
  svg.append(head, col, corner);
  container.appendChild(svg);
  syncGanttSticky();
  if (kbId) svg.querySelector(`.gantt-item[data-id="${kbId}"]`)?.classList.add('kb');
  focusLinks(null); // keep a pinned item's chain picked out
}

/* ---- dragging on the chart ---- */
// Drag an item to move it, or the left or right end of a task's bar to change its start or end.
// Days snap as you go; the card beside the pointer says where it lands and how many items
// downstream move with it. Nothing changes until you let go (Esc cancels), and Undo takes it back.

let drag = null;          // { m, g, mode: 'move' | 'start' | 'end', x0, days, active }
let dragSuppressClick = false;

function dragChanges(m, mode, days) {
  if (mode === 'move') return isTask(m) ? { start: addDays(m.start, days), end: addDays(m.end, days) } : { end: addDays(m.end, days) };
  if (mode === 'end') return { end: addDays(m.end, Math.max(days, daysBetween(m.end, m.start))) };
  return { start: addDays(m.start, Math.min(days, daysBetween(m.start, m.end))) };
}

// What a change would do, without keeping it: the item's new dates and what else would move.
function previewUpdate(m, changes) {
  const saved = state.items.map(x => [x, x.start, x.end, x.type]);
  const res = updateItem(m, changes);
  const out = { error: res.error, start: m.start, end: m.end, moved: (res.moved || []).filter(id => id !== m.id).length };
  for (const [x, a, b, t] of saved) Object.assign(x, { start: a, end: b, type: t });
  return out;
}

// Which part of an item the pointer is on: a task's ends are for resizing.
function dragModeAt(g, m, clientX) {
  if (!isTask(m)) return 'move';
  const bar = g.querySelector('rect:not(.gantt-baseline)');
  if (!bar) return 'move';
  const r = bar.getBoundingClientRect();
  if (r.width >= 18 && Math.abs(clientX - r.right) <= 6) return 'end';
  if (r.width >= 18 && Math.abs(clientX - r.left) <= 6) return 'start';
  return 'move';
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.active) {
    if (Math.abs(dx) < 5) return;
    drag.active = true;
    hideQuick();
    document.getElementById('gantt-container').classList.add('dragging');
  }
  const days = Math.round(dx / state.pxPerDay);
  if (days === drag.days) return moveTip(e);
  drag.days = days;
  const { m, g, mode } = drag;
  const px = days * state.pxPerDay;
  if (mode === 'move') g.setAttribute('transform', `translate(${px} 0)`);
  else {
    const bar = g.querySelector('rect:not(.gantt-baseline)');
    bar._x ??= +bar.getAttribute('x');
    bar._w ??= +bar.getAttribute('width');
    const w = mode === 'end' ? Math.max(2, bar._w + px) : Math.max(2, bar._w - px);
    bar.setAttribute('x', mode === 'end' ? bar._x : bar._x + bar._w - w);
    bar.setAttribute('width', w);
  }
  const p = previewUpdate(m, dragChanges(m, mode, days));
  const what = mode === 'move' ? (days ? `${days > 0 ? '+' : '−'}${daysText(Math.abs(days))}` : 'No change')
    : `${mode === 'end' ? 'End' : 'Start'} ${days > 0 ? '+' : days < 0 ? '−' : ''}${days ? daysText(Math.abs(days)) : 'unchanged'}`;
  const tip = document.getElementById('tip');
  tip.innerHTML = `
    <div class="tip-head">${m.ref ? `<span class="tip-ref">${escAttr(m.ref)}</span>` : ''}<span>${what}</span></div>
    <div class="tip-row">${p.error ? escAttr(p.error) : isTask(m) ? `${fmtShort(p.start)} – ${fmtNice(p.end)} <span class="tip-muted">(${daysText(daysBetween(p.start, p.end) + 1)})</span>` : fmtNice(p.end)}</div>
    ${p.moved ? `<div class="tip-row tip-late amber">Moves ${count(p.moved, `${T.item} downstream`, `${T.items} downstream`)}</div>` : ''}
    <div class="tip-hint">Let go to save · Esc to cancel</div>`;
  tipAvoid = [];
  tip.classList.add('show');
  moveTip(e);
}

async function onDragEnd() {
  if (!drag) return;
  const { m, mode, days, active } = drag;
  drag = null;
  document.getElementById('gantt-container').classList.remove('dragging');
  if (!active) return;
  dragSuppressClick = true; // the click that ends a drag doesn't open the quick update panel
  setTimeout(() => { dragSuppressClick = false; }, 0);
  hideTip();
  if (!days) return renderGantt();
  const snap = snapshotData();
  const res = updateItem(m, dragChanges(m, mode, days));
  renderGantt();
  if (res.error) return showToast(res.error);
  const msg = [`${itemLabel(m)}: ${isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end)}`, movedMessage(m, res.moved)].filter(Boolean).join(' · ');
  offerUndo(snap, msg);
  await saveData(msg, 'Dragged on the Gantt chart');
}

/* ---- keyboard on the chart ---- */
// Tab into the chart, then the arrow keys move between items (← → along a swimlane, ↑ ↓ to the
// row above or below), Enter opens the quick update panel and Esc lets go.

function ganttKeyNav(e) {
  if (e.target.closest('.lane-toggle') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    return toggleLane(e.target.closest('.lane-toggle').dataset.lane);
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' '].includes(e.key)) return;
  const gs = [...document.querySelectorAll('#gantt-container .gantt-item')];
  if (!gs.length) return;
  const at = (g) => { const r = g.getBoundingClientRect(); return { g, x: r.left, y: r.top + r.height / 2, lane: itemById(g.dataset.id)?.swimlane }; };
  const all = gs.map(at);
  const cur = all.find(a => a.g.dataset.id === kbId);
  if (e.key === 'Escape') { if (kbId) { setKbItem(null); e.preventDefault(); } return; }
  if (e.key === 'Enter' || e.key === ' ') {
    if (!cur) return;
    e.preventDefault();
    const r = cur.g.getBoundingClientRect();
    return showQuick(itemById(kbId), { preventDefault() {}, clientX: r.left + r.width / 2, clientY: r.bottom });
  }
  e.preventDefault();
  if (!cur) return setKbItem(all.sort((a, b) => a.y - b.y || a.x - b.x)[0].g.dataset.id);
  let next;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const lane = all.filter(a => a.lane === cur.lane && a !== cur && Math.sign(a.x - cur.x || a.y - cur.y) === dir);
    next = lane.sort((a, b) => dir * (a.x - b.x) || Math.abs(a.y - cur.y) - Math.abs(b.y - cur.y))[0];
  } else {
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const rows = all.filter(a => (a.y - cur.y) * dir > 4);
    next = rows.sort((a, b) => Math.abs(a.y - cur.y) - Math.abs(b.y - cur.y) || Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x))[0];
  }
  if (next) setKbItem(next.g.dataset.id);
}

function setKbItem(id) {
  if (quickId && quickId !== id) hideQuick();
  kbId = id;
  document.querySelectorAll('#gantt-container .gantt-item.kb').forEach(g => g.classList.remove('kb'));
  const g = id && document.querySelector(`#gantt-container .gantt-item[data-id="${id}"]`);
  if (!g) { hideTip(); return focusLinks(null); }
  g.classList.add('kb');
  g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  focusLinks(itemById(id));
  setTimeout(() => { // once scrolling has settled (scrolling hides the card)
    if (kbId !== id) return;
    const r = g.getBoundingClientRect();
    showTip(itemById(id), { clientX: r.right, clientY: r.top + r.height / 2 });
  }, 60);
}

// Everything linked to an item, however distantly: upstream is what it waits on and what rolls up
// into it; downstream is what waits on it and what it rolls up to. Worked out once per render.
let chainLinks = null; // { succ, pred }
function chainParts(id) {
  if (!chainLinks) {
    const succ = successorMap();
    const pred = new Map(state.items.map(m => [m.id, []]));
    for (const [a, list] of succ) for (const b of list) pred.get(b)?.push(a);
    chainLinks = { succ, pred };
  }
  const walk = (next) => {
    const seen = new Set(), queue = [id];
    while (queue.length) for (const y of next.get(queue.shift()) || []) if (y !== id && !seen.has(y)) { seen.add(y); queue.push(y); }
    return seen;
  };
  return { up: walk(chainLinks.pred), down: walk(chainLinks.succ) };
}
const chainOf = (id) => { const { up, down } = chainParts(id); return new Set([id, ...up, ...down]); };

// Pick out an item's whole chain — its own links strongest, the rest of the chain lit, everything
// else faded. Follows the pointer; while an item's quick update panel is open (or it has the
// keyboard focus) its chain stays picked out.
const pinnedItem = () => itemById(quickId) || itemById(kbId);
function focusLinks(m) {
  const svg = document.querySelector('#gantt-container svg');
  if (!svg) return;
  m ||= pinnedItem();
  const ids = m ? chainOf(m.id) : new Set();
  const on = ids.size > 1;
  for (const l of svg.querySelectorAll('.gantt-link')) {
    l.classList.toggle('hl', on && ids.has(l.dataset.from) && ids.has(l.dataset.to));
    l.classList.toggle('direct', on && (l.dataset.from === m.id || l.dataset.to === m.id));
  }
  for (const g of svg.querySelectorAll('.gantt-item')) g.classList.toggle('dim', on && !ids.has(g.dataset.id));
  svg.classList.toggle('link-focus', on);
}

// Keep the label column and timescale header in view while the chart panel scrolls.
function syncGanttSticky() {
  const wrap = document.getElementById('gantt-scroll');
  const svg = document.querySelector('#gantt-container svg');
  if (!svg) return;
  const x = wrap.scrollLeft, y = wrap.scrollTop;
  svg.querySelector('.gantt-col').setAttribute('transform', `translate(${x} 0)`);
  svg.querySelector('.gantt-head').setAttribute('transform', `translate(0 ${y})`);
  svg.querySelector('.gantt-corner').setAttribute('transform', `translate(${x} ${y})`);
}

/* ================= gantt filters + sort ================= */
// Filters narrow what the chart draws (and what Auto fits the range to); they reset when the
// workspace changes. Sort sets the order of swimlanes and, optionally, of items within them:
// "packed" fits several items to a row by date, the other orders give each item its own row.
// The sort is a per-browser preference.

const ganttFilter = { q: '', lane: '', owner: '', type: '', rag: [], late: false };
const GANTT_SORT_DEFAULT = { lanes: 'name', rows: 'packed', dir: 1 }; // swimlanes A–Z, items packed by date
const ganttSort = { ...GANTT_SORT_DEFAULT };

const ganttFiltered = () => !!(ganttFilter.q.trim() || ganttFilter.lane || ganttFilter.owner || ganttFilter.type || ganttFilter.rag.length || ganttFilter.late);

function ganttMatches(m) {
  const f = ganttFilter, q = f.q.trim().toLowerCase();
  return (!f.lane || m.swimlane === f.lane)
    && (!f.owner || m.owner === f.owner)
    && (!f.type || (f.type === 'task') === isTask(m))
    && (!f.rag.length || f.rag.includes(m.status))
    && (!f.late || isLate(m) || isLateStart(m))
    && (!q || [m.ref, m.title, m.description, m.owner, m.swimlane, m.subswimlane].join(' ').toLowerCase().includes(q));
}

function clearGanttFilters() {
  Object.assign(ganttFilter, { q: '', lane: '', owner: '', type: '', rag: [], late: false });
}

// Folded swimlanes, per workspace (a per-browser preference).
function collapsedLanes() {
  return new Set(loadAppPrefs().folded?.[state.workspaceId] || []);
}
function toggleLane(name, fold) {
  const all = loadAppPrefs().folded || {};
  const set = new Set(all[state.workspaceId] || []);
  if (fold ?? !set.has(name)) set.add(name); else set.delete(name);
  saveAppPrefs({ folded: { ...all, [state.workspaceId]: [...set] } });
  renderGantt();
}
function foldAllLanes(fold) {
  const all = loadAppPrefs().folded || {};
  saveAppPrefs({ folded: { ...all, [state.workspaceId]: fold ? [...new Set(state.items.map(m => m.swimlane))] : [] } });
  renderGantt();
}

// Swimlanes and their sub-swimlanes share one order.
function sortLanes(lanes) {
  const by = ganttSort.lanes;
  if (by === 'list') return;
  const key = (group) => {
    const ms = group.items || group.subs.flatMap(s => s.items);
    if (by === 'start') return Math.min(...ms.map(m => m._s));
    if (by === 'end') return -Math.max(...ms.map(m => m._e));
    if (by === 'risk') return -ms.filter(m => OFF_TRACK.includes(m.status)).length;
    return 0;
  };
  const cmp = (a, b) => (by === 'name'
    ? (!a.name) - (!b.name) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : key(a) - key(b));
  lanes.sort(cmp);
  for (const lane of lanes) lane.subs.sort(cmp);
}

// Items one per row: by the chosen field (blanks last), then by date.
function ganttItemOrder(a, b) {
  const by = ganttSort.rows;
  const byDate = a._s - b._s || a._e - b._e;
  let c = 0;
  if (by === 'start') c = byDate;
  else if (by === 'end') c = a._e - b._e || a._s - b._s;
  else if (by === 'ref') c = cmpRef(a, b);
  else if (by === 'status') c = ((STATUSES.indexOf(a.status) + 1) || 999) - ((STATUSES.indexOf(b.status) + 1) || 999);
  else {
    const va = a[by] || '', vb = b[by] || '';
    c = (!va) - (!vb) || va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
  }
  return c * ganttSort.dir || byDate;
}

// Option lists follow the data, so they're rebuilt with the chart. Active filters also show as
// chips under the toolbar, each removable on its own.
function renderGanttFilters() {
  const f = ganttFilter;
  const distinct = (k) => [...new Set(state.items.map(m => m[k]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const fill = (id, all, values, value) => {
    if (value && !values.includes(value)) values.push(value); // keep a filter whose last item went
    document.getElementById(id).innerHTML = `<option value="">${all}</option>` + values.map(v =>
      `<option value="${escAttr(v)}" ${v === value ? 'selected' : ''}>${escAttr(v)}</option>`).join('');
  };
  fill('gf-lane', 'All swimlanes', distinct('swimlane'), f.lane);
  fill('gf-owner', 'All owners', distinct('owner'), f.owner);
  const types = [['', 'All'], ['milestone', T.Milestones], ['task', T.Tasks]];
  document.getElementById('gf-type').innerHTML = types.map(([v, label]) =>
    `<button type="button" data-type="${v}" aria-pressed="${f.type === v}">${escAttr(label)}</button>`).join('');
  f.rag = f.rag.filter(st => STATUSES.includes(st));
  document.getElementById('gf-rag').innerHTML = STATUSES.map(st => `
    <button type="button" data-rag="${escAttr(st)}" aria-pressed="${f.rag.includes(st)}" style="--c:${STATUS[st].base};--t:${STATUS[st].text}">${escAttr(st)}</button>`).join('');

  document.getElementById('gf-late').setAttribute('aria-pressed', f.late);
  const q = document.getElementById('gf-q');
  if (document.activeElement !== q) q.value = f.q; // don't disturb the caret while typing

  const chips = [
    f.lane && ['lane', 'Swimlane', f.lane],
    f.owner && ['owner', 'Owner', f.owner],
    f.type && ['type', 'Type', f.type === 'task' ? T.Tasks : T.Milestones],
    f.rag.length && ['rag', 'RAG', f.rag.join(', ')],
    f.late && ['late', 'Show', 'Overdue or late starting'],
  ].filter(Boolean);
  const badge = document.getElementById('gf-badge');
  badge.hidden = !chips.length;
  badge.textContent = chips.length;
  const row = document.getElementById('gf-chips');
  row.hidden = !ganttFiltered();
  if (!row.hidden) {
    const shown = state.items.filter(ganttMatches).length;
    row.innerHTML = chips.map(([k, label, v]) => `
      <span class="fchip"><span class="fchip-k">${label}</span> ${escAttr(v)}<button type="button" data-unfilter="${k}" title="Remove this filter">✕</button></span>`).join('')
      + `<span class="grid-count">Showing ${shown} of ${count(state.items.length, T.item, T.items)}</span>
         <button type="button" class="link-btn" data-unfilter="all">Clear all</button>`;
  }

  document.getElementById('gs-lanes').value = ganttSort.lanes;
  document.getElementById('gs-rows').value = ganttSort.rows;
  const packed = ganttSort.rows === 'packed';
  document.querySelectorAll('#gs-dir [data-dir]').forEach(b => {
    b.disabled = packed;
    b.setAttribute('aria-pressed', !packed && +b.dataset.dir === ganttSort.dir);
  });
  document.getElementById('gs-badge').hidden = ganttSort.lanes === GANTT_SORT_DEFAULT.lanes && packed;

  const based = state.items.filter(hasBaseline);
  const moved = based.filter(baselineMoved).length;
  document.getElementById('baseline-note').textContent = based.length
    ? `${count(moved, T.item, T.items)} of ${based.length} moved since the baseline`
    : 'No baseline yet: set one to see what slips.';
  document.getElementById('baseline-clear').disabled = !based.length;
  document.getElementById('legend-baseline').hidden = !(state.showBaseline && moved);
  document.getElementById('link-mode').value = state.linkMode;
  document.getElementById('toggle-baseline').checked = state.showBaseline;

  writeHash();
  const fmtR = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', ' ’');
  if (state.rangeStart) document.getElementById('range-label').textContent = `${fmtR(state.rangeStart)} – ${fmtR(state.rangeEnd)}`;
}

// Toolbar menus: one open at a time; closed by clicking outside or Esc.
function closeMenus(except) {
  document.querySelectorAll('[data-menu]').forEach(btn => {
    if (btn.dataset.menu === except) return;
    btn.setAttribute('aria-expanded', 'false');
    document.getElementById(btn.dataset.menu).hidden = true;
  });
}
function wireMenus() {
  document.querySelectorAll('[data-menu]').forEach(btn => btn.addEventListener('click', () => {
    const pop = document.getElementById(btn.dataset.menu);
    closeMenus(btn.dataset.menu);
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', !pop.hidden);
    if (!pop.hidden) pop.querySelector('select, input, button')?.focus();
  }));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.tb-menu')) closeMenus(); });
  document.addEventListener('keydown', (e) => {
    const open = document.querySelector('[data-menu][aria-expanded="true"]');
    if (e.key === 'Escape' && open) { closeMenus(); open.focus(); }
  });
}

function wireGanttFilters() {
  Object.assign(ganttSort, loadAppPrefs().ganttSort || {});
  wireMenus();
  const saveSort = () => { saveAppPrefs({ ganttSort: { ...ganttSort } }); renderGantt(); };
  document.getElementById('gf-q').addEventListener('input', (e) => { ganttFilter.q = e.target.value; renderGantt(); });
  for (const [id, k] of [['gf-lane', 'lane'], ['gf-owner', 'owner']]) {
    document.getElementById(id).addEventListener('change', (e) => { ganttFilter[k] = e.target.value; renderGantt(); });
  }
  document.getElementById('gf-type').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (b) { ganttFilter.type = b.dataset.type; renderGantt(); }
  });
  document.getElementById('gf-rag').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rag]');
    if (!b) return;
    const st = b.dataset.rag;
    ganttFilter.rag = ganttFilter.rag.includes(st) ? ganttFilter.rag.filter(x => x !== st) : [...ganttFilter.rag, st];
    renderGantt();
  });
  document.getElementById('gf-late').addEventListener('click', () => { ganttFilter.late = !ganttFilter.late; renderGantt(); });
  document.getElementById('gf-chips').addEventListener('click', (e) => {
    const k = e.target.closest('[data-unfilter]')?.dataset.unfilter;
    if (!k) return;
    if (k === 'all') clearGanttFilters();
    else ganttFilter[k] = k === 'rag' ? [] : k === 'late' ? false : '';
    renderGantt();
  });
  document.getElementById('gs-lanes').addEventListener('change', (e) => { ganttSort.lanes = e.target.value; saveSort(); });
  document.getElementById('gs-rows').addEventListener('change', (e) => { ganttSort.rows = e.target.value; ganttSort.dir = 1; saveSort(); });
  document.getElementById('gs-dir').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dir]');
    if (b && !b.disabled) { ganttSort.dir = +b.dataset.dir; saveSort(); }
  });
  document.getElementById('gs-reset').onclick = () => { Object.assign(ganttSort, GANTT_SORT_DEFAULT); saveSort(); };
}

/* ================= hover card ================= */

function showTip(m, e) {
  const tip = document.getElementById('tip');
  const c = pal(m.status);
  const task = isTask(m);
  const days = daysBetween(m.start, m.end) + 1;
  const when = task
    ? `${fmtShort(m.start)} – ${fmtNice(m.end)} <span class="tip-muted">(${days} days)</span>`
    : fmtNice(m.end);
  const where = [m.owner, [m.swimlane, m.subswimlane].filter(Boolean).join(' › ')].filter(Boolean).map(escAttr).join(' · ');
  const prog = !task && milestoneProgress(m);
  const progress = prog ? `<div class="tip-row"><b>${prog.pct}% complete</b><span class="tip-muted">${prog.doneDays} of ${prog.total} days · ${prog.doneCount} of ${prog.count} ${prog.count === 1 ? T.task : T.tasks} done</span></div>` : '';
  tip.innerHTML = `
    <div class="tip-head">${m.ref ? `<span class="tip-ref">${escAttr(m.ref)}</span>` : ''}<span>${escAttr(m.title)}</span></div>
    <div class="tip-row"><span class="pill" style="background:${c.base};color:${c.text}">${m.status}</span><span>${escAttr(typeName(m))} · ${when}</span></div>
    ${progress}
    ${isLate(m) ? `<div class="tip-row tip-late">${lateText(m)}</div>` : isLateStart(m) ? `<div class="tip-row tip-late amber">${lateStartText(m)}</div>` : ''}
    ${baselineRow(m)}
    ${where ? `<div class="tip-row tip-muted">${where}</div>` : ''}
    ${tipLinks(m)}
    ${m.description ? `<div class="tip-desc">${escAttr(m.description)}</div>` : ''}
    ${lastReportLine(m)}
    <div class="tip-hint">Click to update RAG or dates, or to report</div>`;
  const ids = chainOf(m.id);
  tipAvoid = [...document.querySelectorAll('#gantt-container .gantt-item')].filter(g => ids.has(g.dataset.id)).map(g => g.getBoundingClientRect());
  tip.classList.add('show');
  moveTip(e);
}
// Roll-up links both ways: what this item rolls up to, and what rolls up to it.
function tipLinks(m) {
  const parent = m.parent && state.items.find(p => p.id === m.parent);
  const kids = state.items.filter(k => k.parent === m.id).sort(cmpRef);
  const ref = (x) => `<span class="tip-ref">${escAttr(itemLabel(x))}</span>`;
  const { up, down } = chainParts(m.id);
  return [
    parent && `<div class="tip-links"><b>Rolls up to</b> ${ref(parent)} ${escAttr(parent.title)}</div>`,
    kids.length && `<div class="tip-links"><b>Rolled up from</b> ${kids.map(ref).join(', ')}</div>`,
    (up.size || down.size) && `<div class="tip-links tip-chain"><b>Chain</b> ${[up.size && `waits on ${up.size}`, down.size && `holds up ${down.size}`].filter(Boolean).join(' · ')}</div>`,
  ].filter(Boolean).join('');
}
// The card goes beside the pointer, on whichever side covers least of the items linked to the
// one under it (they're picked out on the chart, so the card shouldn't hide them).
let tipAvoid = [];
function moveTip(e) {
  const tip = document.getElementById('tip');
  const pad = 14;
  tip.style.left = tip.style.top = '0px'; // measure at full width, not squeezed against the edge
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const fit = (x, y) => [Math.max(8, Math.min(x, window.innerWidth - w - 8)), Math.max(8, Math.min(y, window.innerHeight - h - 8))];
  const spots = [[e.clientX + pad, e.clientY + pad], [e.clientX + pad, e.clientY - h - pad], [e.clientX - w - pad, e.clientY + pad], [e.clientX - w - pad, e.clientY - h - pad]].map(([x, y]) => fit(x, y));
  const covers = ([x, y]) => tipAvoid.reduce((a, r) => a + Math.max(0, Math.min(x + w, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top)), 0)
    + (e.clientX >= x && e.clientX <= x + w && e.clientY >= y && e.clientY <= y + h ? 1e9 : 0); // never under the pointer
  const best = spots.reduce((b, p) => (covers(p) < covers(b) ? p : b));
  tip.style.left = best[0] + 'px';
  tip.style.top = best[1] + 'px';
}
function hideTip() {
  document.getElementById('tip')?.classList.remove('show');
}

/* ================= edit dialog ================= */

let editing = null; // item being edited; null when adding a new one
let edDeps = [];

const EDIT_FIELDS = ['ref', 'title', 'type', 'description', 'swimlane', 'subswimlane', 'owner', 'start', 'end', 'status', 'shape', 'parent'];

function openEditDialog(m) {
  hideTip();
  editing = m;
  const f = document.getElementById('edit-form').elements;
  const last = state.items.at(-1);
  const today = fmtISO(new Date());
  const v = m || {
    ref: '', title: '', description: '', swimlane: last?.swimlane || 'General', subswimlane: '', owner: '',
    type: 'milestone', start: today, end: today, status: DEFAULT_STATUS, shape: 'diamond', parent: '', deps: [],
  };
  f.type.innerHTML = typeOptions(v.type);
  f.status.innerHTML = statusOptions(v.status);
  const parents = state.items.filter(p => !isTask(p) && p !== m).sort(cmpRef);
  if (v.parent && !parents.some(p => p.id === v.parent)) parents.push(state.items.find(p => p.id === v.parent));
  f.parent.innerHTML = '<option value="">— none —</option>' +
    parents.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('');
  f.swimlane.innerHTML = laneOptions(v.swimlane);
  for (const k of EDIT_FIELDS) f[k].value = v[k];
  f.swimlane.dataset.prev = f.swimlane.value;
  edDeps = [...v.deps];

  document.getElementById('ed-heading').textContent = m ? `Edit ${itemLabel(m)}` : `New ${T.item}`;
  document.getElementById('ed-delete').hidden = !m;
  document.getElementById('ed-report').hidden = !m;
  const n = m ? reportsFor(m.id).length : 0;
  const hist = document.getElementById('ed-history');
  hist.hidden = !m;
  hist.disabled = !n;
  hist.textContent = `View reports (${n})`;
  document.getElementById('ed-dates').hidden = !m;
  document.getElementById('ed-error').textContent = '';
  refreshDatalists();
  renderEdDeps();
  updateEdType();
  document.getElementById('edit-dialog').showModal();
  f.title.focus();
}

// The workspace's existing swimlanes (A–Z), plus a way to start a new one.
const NEW_LANE = '\u0000new';
function laneOptions(current) {
  const names = [...new Set([...lanesInOrder(), ...state.lanes.filter(l => l.workspace_id === state.workspaceId).map(l => l.name), current])]
    .filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map(n => `<option value="${escAttr(n)}">${escAttr(n)}</option>`).join('') +
    `<option value="${NEW_LANE}">+ New swimlane…</option>`;
}
function pickEdLane(sel) {
  if (sel.value !== NEW_LANE) return (sel.dataset.prev = sel.value);
  const name = (prompt('New swimlane name') || '').trim();
  if (name && ![...sel.options].some(o => o.value === name)) sel.add(new Option(name, name), sel.options.length - 1);
  sel.value = name || sel.dataset.prev || '';
  sel.dataset.prev = sel.value;
}

function renderEdDeps() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const opts = state.items.filter(p => p !== editing && !edDeps.includes(p.id)).sort(cmpRef);
  document.getElementById('ed-deps').innerHTML =
    edDeps.map(d => `<span class="chip" title="${escAttr(byId.get(d)?.title)}">${escAttr(itemLabel(byId.get(d)))}<button type="button" data-edrm="${d}" title="Remove dependency">×</button></span>`).join('') +
    `<select id="ed-adddep" class="add-dep"><option value="">+ add dependency</option>${opts.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select>`;
}

// A milestone shows one date; a task shows start and end.
function updateEdType() {
  const f = document.getElementById('edit-form').elements;
  const task = f.type.value === 'task';
  const badge = document.getElementById('ed-type');
  badge.textContent = task ? T.Task : T.Milestone;
  badge.className = 'type-badge ' + (task ? 'task' : 'ms');
  f.shape.disabled = task;
  document.getElementById('ed-start').classList.toggle('invisible', !task);
  document.getElementById('ed-end-label').textContent = task ? 'End' : 'Date';
  if (!task) f.start.value = f.end.value;
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

  const snap = snapshotData();
  let m = editing;
  if (!m) {
    m = { id: nextId(), workspace_id: state.workspaceId, ...changes, parent: '', deps: [] };
    state.items.push(m);
  }
  const res = updateItem(m, changes);
  if (res.error) {
    if (!editing) removeItem(m.id);
    return (err.textContent = res.error);
  }
  document.getElementById('edit-dialog').close();
  rerenderCurrentView();
  const note = [editing ? `${itemLabel(m)} saved` : `Added ${fullLabel(m)}`, movedMessage(m, res.moved)].filter(Boolean).join(' · ');
  offerUndo(snap, note);
  await saveData(movedMessage(m, res.moved), editing ? 'Edit dialog' : 'New item dialog');
}

async function deleteFromDialog() {
  if (!editing) return;
  const snap = snapshotData();
  const label = `Deleted ${fullLabel(editing)}`;
  removeItem(editing.id);
  document.getElementById('edit-dialog').close();
  rerenderCurrentView();
  offerUndo(snap, label);
  await saveData(label, 'Edit dialog');
}

/* ================= zoom / range controls ================= */

function setZoom(px) {
  state.pxPerDay = Math.min(MAX_ZOOM, Math.max(1, px));
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

// Switch the header tiers and jump to that preset's zoom; Months and Weeks open around today.
function setTimescale(key) {
  if (!TIMESCALES[key]) key = 'quarters';
  state.timescale = key;
  saveAppPrefs({ timescale: key });
  for (const b of document.querySelectorAll('#timescale button')) b.setAttribute('aria-pressed', b.dataset.scale === key);
  const px = TIMESCALES[key].px;
  state.userZoomed = !!px;
  if (!px) return fitZoom();
  setZoom(px);
  if (!state.rangeStart) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const wrap = document.getElementById('gantt-scroll');
  if (today >= state.rangeStart && today <= state.rangeEnd) {
    wrap.scrollLeft = ((today - state.rangeStart) / MS_DAY - 7) * state.pxPerDay;
  } else wrap.scrollLeft = 0;
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
  setDatalist('people-list', [...allItems().map(m => m.owner), ...state.workspaces.flatMap(p => [p.owner, p.lead])].sort());
}

/* ---- sortable, filterable tables with draggable column widths ---- */
// Shared by the Items grid and the Reports list. A column's `filter` is 'text' (contains) or a
// function returning [[value, label]] options (exact match). Sort order, widths and the view mode
// are a per-browser convenience (storage may be unavailable) and never change the CSV order.

function makeTable({ table, store, cols, onChange, mode, fill }) {
  const t = { table, store, cols, onChange, mode, fill, sort: { key: null, dir: 1 }, filters: {}, widths: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(store) || '{}');
    for (const k of ['sort', 'widths', 'mode']) if (saved[k]) t[k] = saved[k];
  } catch { /* ignore */ }
  return t;
}
function saveTablePrefs(t) {
  try { localStorage.setItem(t.store, JSON.stringify({ sort: t.sort, widths: t.widths, mode: t.mode })); } catch { /* ignore */ }
}
const tableEl = (t) => document.getElementById(t.table);
const colWidth = (t, c) => t.widths[c.wkey || c.key] ?? c.w;

function filterOptions(c, value) {
  return '<option value="">All</option>' + c.filter().map(([v, label]) =>
    `<option value="${escAttr(v)}" ${v === value ? 'selected' : ''}>${escAttr(label)}</option>`).join('');
}

function renderTableHead(t) {
  const cols = t.cols();
  tableEl(t).querySelector('colgroup').innerHTML = cols.map(c => `<col data-key="${c.key}">`).join('');
  const filterCell = (c) => {
    if (!c.filter) return '<th></th>';
    const v = t.filters[c.key] || '';
    const ctl = c.filter === 'text'
      ? `<input data-filter="${c.key}" placeholder="Filter…" value="${escAttr(v)}" />`
      : `<select data-filter="${c.key}">${filterOptions(c, v)}</select>`;
    return `<th class="filter-cell">${ctl}</th>`;
  };
  tableEl(t).querySelector('thead').innerHTML = `
    <tr>${cols.map(c => c.fixed ? `<th${c.head ? ` class="col-${c.key}"` : ''}>${c.head ? c.head() : ''}</th>` : `
      <th data-sort="${c.key}" class="sortable" title="${escAttr(c.title || 'Click to sort')}">
        <span>${escAttr(typeof c.label === 'function' ? c.label() : c.label)}</span><span class="sort-ind"></span>
        <span class="col-resizer" data-resize="${c.key}" title="Drag to resize · double-click to reset"></span>
      </th>`).join('')}</tr>
    <tr class="filter-row">${cols.map(filterCell).join('')}</tr>`;
  applyTableWidths(t);
  updateSortIndicators(t);
}

// Option lists that depend on the data (e.g. items with reports) are refreshed on every render.
function refreshSelectFilters(t) {
  for (const c of t.cols()) {
    const el = typeof c.filter === 'function' && tableEl(t).querySelector(`select[data-filter="${c.key}"]`);
    if (el) el.innerHTML = filterOptions(c, t.filters[c.key] || '');
  }
}

// A table with a `fill` column stretches to its container: that column takes the spare width,
// and the set widths become the minimum before the table scrolls sideways.
function applyTableWidths(t) {
  let total = 0;
  for (const c of t.cols()) {
    const w = colWidth(t, c);
    tableEl(t).querySelector(`col[data-key="${c.key}"]`).style.width = c.key === t.fill ? '' : w + 'px';
    total += w;
  }
  tableEl(t).style.width = t.fill ? '100%' : total + 'px';
  tableEl(t).style.minWidth = t.fill ? total + 'px' : '';
}

function updateSortIndicators(t) {
  tableEl(t).querySelectorAll('thead [data-sort]').forEach(th => {
    const on = th.dataset.sort === t.sort.key;
    th.classList.toggle('sorted', on);
    th.querySelector('.sort-ind').textContent = on ? (t.sort.dir > 0 ? '▲' : '▼') : '';
  });
}

function clearTableFilters(t) {
  t.filters = {};
  tableEl(t).querySelectorAll('thead [data-filter]').forEach(el => { el.value = ''; });
}

// Rows: sort by the chosen column (blanks last either way); `tie` keeps the default order.
function sortRows(t, rows, valueOf, tie) {
  const { key, dir } = t.sort;
  if (!key) return rows.sort(tie);
  return rows.sort((a, b) => {
    const va = valueOf(a, key), vb = valueOf(b, key);
    const ea = va === '', eb = vb === '';
    if (ea || eb) return ea - eb || tie(a, b);
    const c = key === 'status' ? STATUSES.indexOf(va) - STATUSES.indexOf(vb)
      : typeof va === 'number' ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return c * dir || tie(a, b);
  });
}

function wireTable(t) {
  const head = tableEl(t).querySelector('thead');
  head.addEventListener('click', (e) => {
    if (e.target.closest('.col-resizer, [data-filter]')) return;
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    // cycle: ascending → descending → off
    if (t.sort.key !== key) t.sort = { key, dir: 1 };
    else if (t.sort.dir > 0) t.sort.dir = -1;
    else t.sort = { key: null, dir: 1 };
    saveTablePrefs(t);
    updateSortIndicators(t);
    t.onChange();
  });
  head.addEventListener('input', (e) => {
    const key = e.target.dataset.filter;
    if (!key) return;
    const v = e.target.value.trim();
    if (v) t.filters[key] = v; else delete t.filters[key];
    t.onChange();
  });
  head.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-resize]');
    if (!handle) return;
    e.preventDefault();
    const cols = t.cols();
    let c = cols.find(x => x.key === handle.dataset.resize);
    let dir = 1;
    // The fill column takes the spare width, so while there is some, dragging its edge moves
    // the border instead: the next column gives or takes the difference.
    const wrap = tableEl(t).parentElement;
    if (c.key === t.fill && wrap.clientWidth > parseFloat(tableEl(t).style.minWidth)) {
      const next = cols[cols.indexOf(c) + 1];
      if (next) { c = next; dir = -1; }
    }
    const startX = e.clientX, startW = colWidth(t, c);
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    const move = (ev) => {
      t.widths[c.wkey || c.key] = Math.max(48, Math.round(startW + dir * (ev.clientX - startX)));
      applyTableWidths(t);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
      saveTablePrefs(t);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  head.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('[data-resize]');
    if (!handle) return;
    const c = t.cols().find(x => x.key === handle.dataset.resize);
    delete t.widths[c.wkey || c.key];
    applyTableWidths(t);
    saveTablePrefs(t);
  });
}

/* ---- items grid ---- */

const opts = (values) => () => values.map(v => [v, v]);
const GRID_COLS = [
  { key: 'sel', label: '', w: 36, fixed: true, head: () => `<input type="checkbox" id="grid-sel-all" title="Select all shown" />` },
  { key: 'id', label: 'ID', w: 64, title: 'Primary key — assigned automatically, never changes', filter: 'text' },
  { key: 'ref', label: 'Ref', w: 80, filter: 'text' },
  { key: 'title', label: 'Title', w: 200, filter: 'text' },
  { key: 'type', label: 'Type', w: 130, title: 'A single date (shape) or a date range (bar)', filter: () => [['milestone', T.Milestone], ['task', T.Task]] },
  { key: 'description', label: 'Description', w: 220, filter: 'text' },
  { key: 'swimlane', label: 'Swimlane', w: 120, filter: 'text' },
  { key: 'subswimlane', label: 'Sub-swimlane', w: 120, filter: 'text' },
  { key: 'owner', label: 'Owner', w: 120, filter: 'text' },
  { key: 'start', label: 'Start', w: 135, filter: 'text' },
  { key: 'end', label: 'End', w: 135, filter: 'text' },
  { key: 'status', label: 'RAG', w: 125, filter: () => STATUSES.map(v => [v, v]) },
  { key: 'shape', label: 'Shape', w: 100, filter: opts(SHAPES) },
  { key: 'parent', label: 'Rolls up to', w: 170, filter: 'text' },
  { key: 'deps', label: 'Depends on', w: 190, filter: 'text' },
  { key: 'actions', label: '', w: 40, fixed: true },
];
// Quick update mode: just what changes week to week — RAG (one click) and dates, in this order.
const QUICK_COLS = {
  sel: {}, id: { w: 56 }, ref: { w: 70 }, title: { w: 180 }, type: { w: 120 }, owner: { w: 130 }, status: { w: 205, wkey: 'status.compact' }, start: { w: 130 }, end: { w: 130 },
  actions: { w: 90, wkey: 'actions.quick' },
};

const grid = makeTable({
  table: 'editor-table',
  store: 'milestone-tracker.grid',
  mode: 'quick',
  fill: 'title', // the title takes any spare width
  cols: () => (grid.mode === 'quick'
    ? Object.entries(QUICK_COLS).map(([k, o]) => ({ ...GRID_COLS.find(c => c.key === k), ...o }))
    : GRID_COLS),
  onChange: () => { syncEditorToState(); renderEditor(); },
});

function setGridMode(mode) {
  syncEditorToState();
  grid.mode = mode;
  for (const k of Object.keys(grid.filters)) if (!grid.cols().some(c => c.key === k)) delete grid.filters[k];
  saveTablePrefs(grid);
  renderTableHead(grid);
  renderEditor();
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
  const col = GRID_COLS.find(c => c.key === key);
  if (col.filter !== 'text') return m[key] === f;
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
  return sortRows(grid, rows, (r, key) => gridValue(r.m, key, byId), (a, b) => a.i - b.i);
}

function renderEditor(highlight = []) {
  const body = document.getElementById('editor-body');
  body.innerHTML = '';
  const byId = new Map(state.items.map(m => [m.id, m]));
  const milestones = state.items.filter(m => !isTask(m)).sort(cmpRef);
  const refCount = new Map();
  for (const m of state.items) if (m.ref) refCount.set(m.ref, (refCount.get(m.ref) || 0) + 1);

  const rows = gridRows();
  const cols = grid.cols();
  for (const { m, i } of rows) {
    const task = isTask(m);
    const tr = document.createElement('tr');
    tr.dataset.id = m.id;
    tr.classList.toggle('shifted', highlight.includes(m.id));
    tr.classList.toggle('selected', gridSel.has(m.id));

    const parentOpts = milestones.filter(p => p.id !== m.id);
    if (m.parent && !parentOpts.some(p => p.id === m.parent)) parentOpts.push(byId.get(m.parent));
    const depOpts = state.items.filter(p => p.id !== m.id && !m.deps.includes(p.id)).sort(cmpRef);
    const chips = m.deps.map(d => `
      <span class="chip" title="${escAttr(byId.get(d)?.title)}">${escAttr(itemLabel(byId.get(d)))}<button data-rmdep="${i}" data-dep="${d}" title="Remove dependency">×</button></span>`).join('');
    const dup = refCount.get(m.ref) > 1;
    const late = isLate(m);

    const quick = grid.mode === 'quick';
    // A milestone's two date cells are one date: editing either moves the milestone.
    const dateTitle = task ? '' : ` title="${escAttr(`${T.Milestone} — changing this date moves it. Change the type to ${T.Task} to give it a date range.`)}"`;
    const cells = {
      sel: `<input type="checkbox" data-sel="${m.id}" ${gridSel.has(m.id) ? 'checked' : ''} title="Select" />`,
      id: `<span class="id" title="Primary key">${m.id}</span>`,
      ref: `<input data-i="${i}" data-k="ref" value="${escAttr(m.ref)}" placeholder="e.g. 4.1" class="ref-in${dup ? ' dup' : ''}" ${dup ? 'title="Duplicate ref"' : ''} />`,
      title: `<input data-i="${i}" data-k="title" value="${escAttr(m.title)}" placeholder="Title" ${m.description ? `title="${escAttr(m.description)}"` : ''} />`,
      type: `<select data-i="${i}" data-k="type" class="type-sel type-${m.type}">${typeOptions(m.type)}</select>`,
      description: `<input data-i="${i}" data-k="description" value="${escAttr(m.description)}" placeholder="Description" />`,
      swimlane: `<input data-i="${i}" data-k="swimlane" value="${escAttr(m.swimlane)}" list="lane-list" placeholder="Swimlane" />`,
      subswimlane: `<input data-i="${i}" data-k="subswimlane" value="${escAttr(m.subswimlane)}" list="sublane-list" placeholder="Sub-swimlane" />`,
      owner: `<input data-i="${i}" data-k="owner" value="${escAttr(m.owner)}" list="owner-list" placeholder="Owner" />`,
      start: `<input data-i="${i}" data-k="start" type="date" value="${escAttr(m.start)}"${dateTitle} />`,
      end: `<input data-i="${i}" data-k="end" type="date" value="${escAttr(m.end)}"${late ? ` class="late" title="${escAttr(lateText(m))}"` : dateTitle} />`,
      status: quick ? `<div class="rag-pick sm compact">${ragButtons(m.status, `data-i="${i}"`)}</div>`
        : `<select data-i="${i}" data-k="status" class="status-sel" style="color:${pal(m.status).dark}">${statusOptions(m.status)}</select>`,
      shape: `<select data-i="${i}" data-k="shape" ${task ? `disabled title="${escAttr(T.Tasks)} are drawn as bars"` : ''}>${optionList(SHAPES, m.shape)}</select>`,
      parent: `<select data-i="${i}" data-k="parent"><option value="">—</option>${parentOpts.map(p => `<option value="${p.id}" ${p.id === m.parent ? 'selected' : ''}>${escAttr(fullLabel(p))}</option>`).join('')}</select>`,
      deps: `<div class="deps">${chips}<select data-adddep="${i}" class="add-dep"><option value="">+ add</option>${depOpts.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select></div>`,
      actions: quick ? `<button class="btn btn-sm" data-report="${m.id}" title="Provide a report on this ${escAttr(T.item)}">Report…</button>`
        : `<button class="btn-del" data-del="${i}" title="Delete row">✕</button>`,
    };
    tr.innerHTML = cols.map(c => `<td${c.key === 'id' ? ' class="col-id"' : c.key === 'sel' ? ' class="col-sel"' : ''}>${cells[c.key]}</td>`).join('');
    body.appendChild(tr);
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="grid-empty">${state.items.length ? `No ${escAttr(T.items)} match the filters.` : `No ${escAttr(T.items)} in this workspace yet. Use <b>+ Add ${escAttr(T.item)}</b> to create one.`}</td></tr>`;
  }

  const filtered = Object.keys(grid.filters).length > 0;
  document.getElementById('grid-count').textContent = filtered
    ? `Showing ${rows.length} of ${state.items.length}`
    : count(state.items.length, T.item, T.items);
  document.getElementById('btn-clear-filters').hidden = !filtered;
  document.querySelectorAll('[name="grid-mode"]').forEach(r => { r.checked = r.value === grid.mode; });
  refreshDatalists();
  // Only rows on screen stay selected, so a bulk action never reaches something filtered out of view.
  const shown = new Set(rows.map(r => r.m.id));
  for (const id of gridSel) if (!shown.has(id)) gridSel.delete(id);
  renderBulkBar();
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

  if (k === 'status') t.style.color = pal(t.value).dark;
  if (k === 'ref') { // refresh duplicate warnings and labels
    syncEditorToState();
    renderEditor();
    return scheduleSave();
  }

  if (k === 'type') {
    syncEditorToState(t);
    return applyTableChange(m, { type: t.value }, `${itemLabel(m)} is now ${withArticle(t.value === 'task' ? T.task : T.milestone)}`);
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
  const sel = e.target.closest('[data-sel]');
  if (sel) return toggleSelected(sel, e.shiftKey);
  const rag = e.target.closest('[data-rag]');
  if (rag) {
    syncEditorToState();
    if (setRag(state.items[+rag.dataset.i], rag.dataset.rag)) {
      rag.parentElement.querySelectorAll('[data-rag]').forEach(b => b.setAttribute('aria-pressed', b === rag));
    }
    return;
  }
  const rpt = e.target.closest('[data-report]');
  if (rpt) {
    syncEditorToState();
    return openReportDialog({ itemId: rpt.dataset.report });
  }
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
    const snap = snapshotData();
    removeItem(m.id);
    renderEditor();
    offerUndo(snap, `Deleted ${fullLabel(m)}`);
    scheduleSave('Deleted');
  }
}

/* ---- row selection + bulk actions ---- */
// Tick rows (shift-click for a range) to set one field on all of them, move their dates or delete them.

const gridSel = new Set(); // ids of the selected rows; always a subset of the rows shown
let gridSelAnchor = null;  // last row ticked, where a shift-click range starts
let bulkField = 'status';

const BULK_FIELDS = () => [
  ['status', 'RAG'], ['owner', 'Owner'], ['swimlane', 'Swimlane'], ['subswimlane', 'Sub-swimlane'],
  ['type', 'Type'], ['shape', 'Shape'], ['parent', 'Rolls up to'], ['shift', 'Dates — move by'],
];
const selectedItems = () => state.items.filter(m => gridSel.has(m.id));

function toggleSelected(box, range) {
  const boxes = [...document.querySelectorAll('#editor-body [data-sel]')];
  const from = boxes.findIndex(b => b.dataset.sel === gridSelAnchor);
  const to = boxes.indexOf(box);
  const targets = range && from >= 0 ? boxes.slice(Math.min(from, to), Math.max(from, to) + 1) : [box];
  for (const b of targets) setSelected(b, box.checked);
  gridSelAnchor = box.dataset.sel;
  renderBulkBar();
}

function setSelected(box, on) {
  box.checked = on;
  if (on) gridSel.add(box.dataset.sel); else gridSel.delete(box.dataset.sel);
  box.closest('tr').classList.toggle('selected', on);
}

function selectAllShown(on) {
  document.querySelectorAll('#editor-body [data-sel]').forEach(b => setSelected(b, on));
  gridSelAnchor = null;
  renderBulkBar();
}

function bulkValueControl() {
  const lanes = (list) => `<input id="bulk-input" list="${list}" placeholder="Leave blank to clear" />`;
  switch (bulkField) {
    case 'status': return `<span>to</span><select id="bulk-input">${statusOptions(DEFAULT_STATUS)}</select>`;
    case 'owner': return `<span>to</span>${lanes('owner-list')}`;
    case 'swimlane': return '<span>to</span><input id="bulk-input" list="lane-list" placeholder="Swimlane" />';
    case 'subswimlane': return `<span>to</span>${lanes('sublane-list')}`;
    case 'type': return `<span>to</span><select id="bulk-input">${typeOptions('milestone')}</select>`;
    case 'shape': return `<span>to</span><select id="bulk-input">${optionList(SHAPES)}</select>`;
    case 'parent': return `<span>to</span><select id="bulk-input"><option value="">— none —</option>${state.items.filter(m => !isTask(m)).sort(cmpRef)
      .map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select>`;
    case 'shift': return '<input id="bulk-input" type="number" step="1" value="7" /><span>days (negative for earlier)</span>';
  }
}

function renderBulkBar() {
  const n = gridSel.size;
  const shown = document.querySelectorAll('#editor-body [data-sel]').length;
  const all = document.getElementById('grid-sel-all');
  if (all) {
    all.checked = n > 0 && n === shown;
    all.indeterminate = n > 0 && n < shown;
  }
  const bar = document.getElementById('bulk-bar');
  const wasHidden = bar.hidden;
  bar.hidden = !n;
  if (!n) return;
  document.getElementById('bulk-count').textContent = `${count(n, T.item, T.items)} selected`;
  const field = document.getElementById('bulk-field');
  field.innerHTML = BULK_FIELDS().map(([k, label]) => `<option value="${k}" ${k === bulkField ? 'selected' : ''}>${label}</option>`).join('');
  if (wasHidden) document.getElementById('bulk-value').innerHTML = bulkValueControl();
}

function applyBulk() {
  syncEditorToState();
  const items = selectedItems();
  if (!items.length) return;
  const v = document.getElementById('bulk-input').value.trim();
  const snap = snapshotData();
  const snapshot = new Map(state.items.map(x => [x.id, x.start + x.end]));
  const others = () => state.items.filter(x => !gridSel.has(x.id) && snapshot.get(x.id) !== x.start + x.end).map(x => x.id);
  const also = (ids) => (ids.length ? ` · ${ids.length} downstream ${ids.length > 1 ? T.items : T.item} rescheduled` : '');

  if (bulkField === 'shift') {
    const n = Math.round(+v);
    if (!n) return flashStatus('Enter a number of days to move by, e.g. 7 or -3', false);
    for (const m of items) shiftItem(m, n);
    cascadeShift(items.map(m => m.id), n);
    enforceConstraints();
    const moved = others();
    for (const m of items) directEdits.add(m.id);
    for (const id of moved) knockOn.add(id);
    renderEditor([...items.map(m => m.id), ...moved]);
    offerUndo(snap, `Moved ${count(items.length, T.item, T.items)} ${Math.abs(n)} day${Math.abs(n) > 1 ? 's' : ''} ${n > 0 ? 'later' : 'earlier'}`);
    return scheduleSave(`Moved ${count(items.length, T.item, T.items)} ${Math.abs(n)} day${Math.abs(n) > 1 ? 's' : ''} ${n > 0 ? 'later' : 'earlier'}${also(moved)}`);
  }
  if (bulkField === 'swimlane' && !v) return flashStatus('Enter a swimlane', false);

  let done = 0, skipped = 0;
  for (const m of items) {
    if (bulkField === 'parent' && v === m.id) { skipped++; continue; } // can't roll up to itself
    if (updateItem(m, { [bulkField]: v }).error) skipped++; else done++;
  }
  const moved = others();
  const label = BULK_FIELDS().find(([k]) => k === bulkField)[1];
  renderEditor(moved);
  if (done) offerUndo(snap, `${label} updated on ${count(done, T.item, T.items)}`);
  scheduleSave(`${label} updated on ${count(done, T.item, T.items)}` +
    (skipped ? ` · ${skipped} skipped (would roll up to itself or create a loop)` : '') + also(moved));
}

function bulkDelete() {
  syncEditorToState();
  const items = selectedItems();
  if (!items.length) return;
  const what = count(items.length, T.item, T.items);
  const snap = snapshotData();
  for (const m of items) removeItem(m.id);
  gridSel.clear();
  renderEditor();
  offerUndo(snap, `Deleted ${what}`);
  scheduleSave(`Deleted ${what}`);
}

function wireBulk() {
  document.getElementById('editor-table').querySelector('thead').addEventListener('change', (e) => {
    if (e.target.id === 'grid-sel-all') selectAllShown(e.target.checked);
  });
  document.getElementById('bulk-field').onchange = (e) => {
    bulkField = e.target.value;
    document.getElementById('bulk-value').innerHTML = bulkValueControl();
  };
  document.getElementById('bulk-value').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBulk(); });
  document.getElementById('bulk-apply').onclick = applyBulk;
  document.getElementById('bulk-delete').onclick = bulkDelete;
  document.getElementById('bulk-clear').onclick = () => selectAllShown(false);
}

/* ================= reports ================= */
// A report is a status update on one item for one period. Reports are weekly, fortnightly
// or monthly; the period runs up to and including `period_end`.

const CADENCES = ['Weekly', 'Fortnightly', 'Monthly'];
const REPORT_COLUMNS = ['id', 'workspace_id', 'item_id', 'cadence', 'period_start', 'period_end', 'status',
  'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author', 'created', 'updated'];

// Reports saved before workspaces existed take their item's workspace.
function rowsToReports(rows, items) {
  if (!rows.length) return [];
  const progOf = new Map(items.map(m => [m.id, m.workspace_id]));
  const workspaceIds = new Set(state.workspaces.map(p => p.id));
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const reports = rows.slice(1).map(r => {
    const o = {};
    for (const k of REPORT_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    o.cadence = CADENCES.find(c => c.toLowerCase() === o.cadence.toLowerCase()) || 'Weekly';
    if (o.period_end && !o.period_start) o.period_start = periodStart(o.period_end, o.cadence);
    if (!workspaceIds.has(o.workspace_id)) o.workspace_id = progOf.get(o.item_id) || state.workspaces[0].id;
    o.status = normaliseStatus(o.status, o.workspace_id);
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

// Items and reports keep a `status` field in memory; the CSV column is called `rag` (`status` still loads).
const csvName = (k) => (k === 'status' ? 'rag' : k);

// Column position in a (lower-cased, underscored) header, also accepting names used by earlier files.
const OLD_COLUMN_NAMES = { workspace_id: ['program_id', 'programme_id'], owner: ['manager'], lead: ['sponsor'] };
function colIndex(header, k) {
  for (const name of [csvName(k), k, ...(OLD_COLUMN_NAMES[k] || [])]) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

function reportsToCSV(reports) {
  return [REPORT_COLUMNS.map(csvName).join(','), ...reports.map(r => REPORT_COLUMNS.map(k => csvEscape(r[k])).join(','))].join('\n') + '\n';
}

function nextReportId() {
  state.lastReportId = Math.max(state.lastReportId, ...allReports().map(r => +r.id || 0)) + 1;
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
const statusPill = (st, map) => { const c = pal(st, map); return `<span class="pill" style="background:${c.base};color:${c.text}">${escAttr(st)}</span>`; };

function lastReportLine(m) {
  const r = reportsFor(m.id)[0];
  return r ? `<div class="tip-row tip-muted">Last report: period ending ${fmtShort(r.period_end)} ${statusPill(r.status)}</div>`
    : '<div class="tip-row tip-muted">No reports yet</div>';
}

/* ---- quick update panel (click or right-click an item on the chart) ---- */
// RAG, type and dates change far more often than an item's details, so they sit here; everything
// else lives behind "Edit details". Changes are a draft until Save, and the draft keeps both
// dates while the type is switched, so trying Milestone and going back to Task loses nothing.

let quickId = null;    // item the panel is showing
let quickDraft = null; // {status, type, start, end} as edited, not yet saved
let quickMsg = '';     // why the last Save didn't go through
let kbId = null;       // item with the keyboard focus on the chart

function showQuick(m, e) {
  e.preventDefault();
  hideTip();
  if (quickDirty() && quickId !== m.id && !confirm(`Discard your changes to ${itemLabel(itemById(quickId))}?`)) return;
  quickId = m.id;
  quickDraft = { status: m.status, type: m.type, start: m.start || m.end, end: m.end || m.start };
  quickMsg = '';
  renderQuick();
  const el = document.getElementById('quick');
  el.hidden = false;
  // Beside the item rather than on top of it: right of it, else left, else below or above.
  const g = document.querySelector(`#gantt-container .gantt-item[data-id="${m.id}"]`);
  const r = g ? g.getBoundingClientRect() : { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
  const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight, gap = 12;
  const clampY = (y) => Math.max(8, Math.min(y, H - h - 8));
  const clampX = (x) => Math.max(8, Math.min(x, W - w - 8));
  let x, y;
  if (r.right + gap + w <= W - 8) [x, y] = [r.right + gap, clampY(r.top - 12)];
  else if (r.left - gap - w >= 8) [x, y] = [r.left - gap - w, clampY(r.top - 12)];
  else if (r.bottom + gap + h <= H - 8) [x, y] = [clampX(e.clientX - w / 2), r.bottom + gap];
  else [x, y] = [clampX(e.clientX - w / 2), Math.max(8, r.top - gap - h)];
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  focusLinks(m);
  el.querySelector('.rag-pick [aria-pressed="true"]')?.focus();
}

function hideQuick() {
  const el = document.getElementById('quick');
  if (el) el.hidden = true;
  const was = quickId;
  quickId = null;
  quickDraft = null;
  if (was) focusLinks(null);
}

// Has anything in the panel changed from the saved item?
function quickDirty() {
  const m = itemById(quickId), d = quickDraft;
  if (!m || !d) return false;
  const task = d.type === 'task';
  return d.status !== m.status || d.type !== m.type || d.end !== m.end || (task && d.start !== m.start);
}

// Items that would move with this one (explicit dependencies, followed transitively).
function dependentCount(id) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const m of state.items) if (m.deps.includes(cur) && !seen.has(m.id)) { seen.add(m.id); queue.push(m.id); }
  }
  return seen.size - 1;
}

const ragButtons = (current, attrs = '') => STATUSES.map(st => `
  <button type="button" data-rag="${escAttr(st)}" ${attrs} aria-pressed="${st === current}" title="${escAttr(st)}" style="--c:${STATUS[st].base};--t:${STATUS[st].text}">${escAttr(st)}</button>`).join('');

function renderQuick() {
  const m = itemById(quickId), d = quickDraft;
  if (!m || !d) return hideQuick();
  const task = d.type === 'task';
  const n = reportsFor(m.id).length;
  const deps = dependentCount(m.id);
  document.getElementById('quick').innerHTML = `
    <form class="q-form" novalidate>
    <div class="q-head">
      <span class="type-badge ${task ? 'task' : 'ms'}">${escAttr(task ? T.Task : T.Milestone)}</span>
      <span class="q-title">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>
      <button type="button" class="dlg-close" data-act="cancel" title="Close without saving (Esc)">✕</button>
    </div>
    <div class="q-label">RAG</div>
    <div class="rag-pick">${ragButtons(d.status)}</div>
    <div class="q-row">
      <div>
        <div class="q-label">Type</div>
        <div class="q-type" role="group" aria-label="Type">${TYPES.map(t => `
          <button type="button" data-type="${t}" aria-pressed="${t === d.type}" title="${t === 'task' ? 'A date range, drawn as a bar' : 'A single date, drawn as a shape'}">${escAttr(t === 'task' ? T.Task : T.Milestone)}</button>`).join('')}</div>
      </div>
      <div class="q-dates">
        ${task
          ? `<label>Start<input type="date" name="start" value="${d.start}" /></label><label>End<input type="date" name="end" value="${d.end}" /></label>`
          : `<label>Date<input type="date" name="end" value="${d.end}" /></label>`}
      </div>
    </div>
    ${deps ? `<p class="q-note">Moving the ${task ? 'end ' : ''}date moves ${deps} dependent ${escAttr(deps > 1 ? T.items : T.item)} by the same amount.</p>` : ''}
    <p class="q-msg">${escAttr(quickMsg)}</p>
    <div class="q-save">
      <span class="q-unsaved"></span>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
    <div class="q-foot">
      <button type="button" class="btn" data-act="report">Provide report…</button>
      <button type="button" class="btn" data-act="history" ${n ? '' : 'disabled'}>Reports (${n})</button>
      <button type="button" class="btn" data-act="dates">Date history</button>
      <button type="button" class="btn" data-act="edit">Edit details…</button>
    </div>
    </form>`;
  refreshQuickSave();
}

// Save is only offered for a real, valid change.
function refreshQuickSave() {
  const el = document.getElementById('quick'), d = quickDraft;
  if (!d || el.hidden && !quickId) return;
  const okDate = (v) => parseDate(v) && +v.slice(0, 4) >= 1900;
  const valid = okDate(d.end) && (d.type !== 'task' || okDate(d.start));
  const dirty = quickDirty();
  el.querySelector('[type=submit]').disabled = !(dirty && valid);
  el.querySelector('.q-unsaved').textContent = dirty ? (valid ? 'Unsaved changes' : 'Enter a valid date') : '';
  el.classList.toggle('dirty', dirty);
}

function setRag(m, st) {
  if (m.status === st) return false;
  const snap = snapshotData();
  m.status = st;
  offerUndo(snap, `${itemLabel(m)} RAG is now ${st}`);
  saveData(`${itemLabel(m)} RAG is now ${st}`);
  return true;
}

function onQuickClick(e) {
  const m = itemById(quickId), d = quickDraft;
  if (!m || !d) return;
  const rag = e.target.closest('[data-rag]');
  if (rag) {
    d.status = rag.dataset.rag;
    quickMsg = '';
    renderQuick();
    document.querySelector(`#quick .rag-pick [aria-pressed="true"]`)?.focus();
    return;
  }
  const type = e.target.closest('[data-type]');
  if (type) {
    if (type.dataset.type === d.type) return;
    d.type = type.dataset.type;
    if (d.type === 'task' && d.start > d.end) d.start = d.end; // the milestone date moved before the old start
    quickMsg = '';
    renderQuick();
    document.querySelector(`#quick [data-type="${d.type}"]`)?.focus();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'cancel') return hideQuick();
  if (quickDirty() && !confirm('Discard the changes you haven’t saved?')) return;
  hideQuick();
  if (act === 'report') openReportDialog({ itemId: m.id });
  else if (act === 'edit') openEditDialog(m);
  else if (act === 'history') showReportsFor(m.id);
  else if (act === 'dates') showDatesFor(m.id);
}

function onQuickDateInput(e) {
  const d = quickDraft, t = e.target;
  if (!d || !['start', 'end'].includes(t.name)) return;
  d[t.name] = t.value;
  // A milestone's single date moves the whole item, so a task keeps its length if it comes back.
  if (d.type !== 'task' && t.name === 'end') {
    const m = itemById(quickId);
    if (m && parseDate(t.value) && parseDate(m.end) && parseDate(m.start)) d.start = addDays(m.start, daysBetween(m.end, t.value));
  }
  quickMsg = '';
  document.querySelector('#quick .q-msg').textContent = '';
  refreshQuickSave();
}

async function onQuickDateSubmit(e) {
  e.preventDefault();
  const m = itemById(quickId), d = quickDraft;
  if (!m || !d || document.querySelector('#quick [type=submit]').disabled) return;
  const task = d.type === 'task';
  if (task && d.end < d.start) {
    quickMsg = 'The end date is before the start date.';
    return renderQuick();
  }
  const snap = snapshotData();
  const msgs = [];
  if (d.status !== m.status) { m.status = d.status; msgs.push(`RAG ${d.status}`); }
  const changes = { type: d.type, end: d.end, start: task ? d.start : d.end };
  let res = { moved: [] };
  if (changes.type !== m.type || changes.end !== m.end || changes.start !== m.start) {
    const typeChanged = changes.type !== m.type;
    res = updateItem(m, changes);
    if (res.error) {
      quickMsg = res.error;
      return renderQuick();
    }
    if (typeChanged) msgs.push(`now ${withArticle(task ? T.task : T.milestone)}`);
    msgs.push(task ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end));
  }
  hideQuick();
  renderGantt();
  const msg = [`${itemLabel(m)}: ${msgs.join(', ')}`, movedMessage(m, res.moved)].filter(Boolean).join(' · ');
  offerUndo(snap, msg);
  await saveData(msg, 'Quick update panel');
}

/* ---- markdown ---- */
// Report text is written in Markdown. This small renderer covers what status reports need:
// paragraphs, headings, bullet and numbered lists (nested by indenting), quotes, **bold**,
// *italic*, ~~strikethrough~~, `code` and links (a backslash keeps a character literal, e.g. \*). Every line is escaped before any markup is
// added, so no HTML in the text gets through, and links only go to http(s) or mailto. A single
// line break stays a line break, so text written before Markdown reads as it always did.

const MD_URL = /^(https?:\/\/|mailto:)/i;

function mdInline(line) { // `line` is already escaped
  const held = []; // code spans and links are set aside so their contents aren't restyled
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = line.replace(/\\([\\`*_~[\]#>+\-.)•])/g, (_, c) => hold(c));
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
    (MD_URL.test(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`) : m));
  s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)])/g, (_, pre, url) =>
    pre + hold(`<a href="${/^www\./i.test(url) ? 'https://' + url : url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])(.+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=[^\s_])(.+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
}

function mdList(items) {
  let html = '';
  const open = []; // tags of the lists currently open, outermost first
  for (const it of items) {
    const level = Math.min(it.level, open.length); // at most one level deeper than the last item
    while (open.length > level + 1) html += `</li></${open.pop()}>`;
    if (open.length === level + 1 && open[level] !== it.tag) html += `</li></${open.pop()}>`;
    if (open.length === level + 1) html += '</li>';
    else { html += `<${it.tag}>`; open.push(it.tag); }
    html += `<li>${mdInline(it.text)}`;
  }
  while (open.length) html += `</li></${open.pop()}>`;
  return html;
}

function mdToHtml(src) {
  const out = [];
  let para = [], list = [], quote = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    if (list.length) out.push(mdList(list));
    if (quote.length) out.push(`<blockquote>${quote.map(mdInline).join('<br>')}</blockquote>`);
    para = []; list = []; quote = [];
  };
  for (const raw of String(src ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = escAttr(raw.replace(/\t/g, '  '));
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^ {0,3}(#{1,3})\s+(.*?)\s*#*$/))) { flush(); out.push(`<h${m[1].length + 3}>${mdInline(m[2])}</h${m[1].length + 3}>`); }
    else if ((m = line.match(/^( *)([-*+•]|\d+[.)])\s+(.*)$/))) {
      if (para.length || quote.length) { const l = list; list = []; flush(); list = l; }
      list.push({ level: Math.floor(m[1].length / 2), tag: /\d/.test(m[2]) ? 'ol' : 'ul', text: m[3] });
    }
    else if ((m = line.match(/^ *&gt;\s?(.*)$/) || line.match(/^ *>\s?(.*)$/))) { if (!quote.length) flush(); quote.push(m[1]); }
    else if (list.length && /^ {2,}\S/.test(line)) list[list.length - 1].text += ' ' + line.trim(); // wrapped list item
    else { if (list.length || quote.length) flush(); para.push(line); }
  }
  flush();
  return out.join('');
}

// One line of plain text, for list cells where the full formatting won't fit.
function mdToText(src) {
  const held = [];
  return String(src ?? '')
    .replace(/\\([\\`*_~[\]#>+\-.)•])/g, (_, c) => `\u0000${held.push(c) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^ *(#{1,3}|[-*+•]|\d+[.)]|>)\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S.*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s*\n+\s*/g, ' · ')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
}

// Shortcuts in report text boxes: ⌘/Ctrl+B bold, ⌘/Ctrl+I italic, ⌘/Ctrl+K link, and Enter
// on a list line starts the next item (Enter on an empty item ends the list).
function onMdKeydown(e) {
  const t = e.target;
  if (!(t instanceof HTMLTextAreaElement) || !t.classList.contains('md-input')) return;
  const { selectionStart: a, selectionEnd: b, value } = t;
  const insert = (text, selA, selB) => {
    t.focus();
    if (!document.execCommand('insertText', false, text)) t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end'); // execCommand keeps undo working
    if (selA != null) t.setSelectionRange(selA, selB);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
  const wrap = { b: '**', i: '*' }[mod && e.key.toLowerCase()];
  if (wrap) {
    e.preventDefault();
    const sel = value.slice(a, b);
    insert(wrap + sel + wrap, a + wrap.length, a + wrap.length + sel.length);
  } else if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const sel = value.slice(a, b) || 'link';
    insert(`[${sel}](https://)`, a + sel.length + 3, a + sel.length + 11);
  } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && a === b) {
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const m = value.slice(lineStart, a).match(/^( *)([-*+•]|(\d+)([.)]))( +)(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (!m[6].trim() && value.slice(a, value.indexOf('\n', a) < 0 ? undefined : value.indexOf('\n', a)).trim() === '') {
      // empty item: end the list, leaving a plain line to carry on typing
      if (!lineStart) { t.setRangeText('', 0, a, 'end'); return t.dispatchEvent(new Event('input', { bubbles: true })); }
      t.setSelectionRange(lineStart - 1, a);
      return insert('\n');
    }
    insert(`\n${m[1]}${m[3] ? `${+m[3] + 1}${m[4]}` : m[2]}${m[5]}`);
  }
}

/* ---- rich-text editor for report text ---- */
// Report boxes are edited as formatted text, but what's stored is still Markdown: each editor
// sits on a (hidden) textarea that holds the Markdown, so forms, saving and dirty checks read
// `.value` as before. Typing converts the editor's HTML back to Markdown; the textarea is only
// rewritten on a real edit, so opening a report never changes its text. The Markdown button
// shows the textarea itself for anyone who'd rather type the syntax.

const ED_TOOLS = [
  { cmd: 'bold', label: '<b>B</b>', title: 'Bold (⌘B)' },
  { cmd: 'italic', label: '<i>I</i>', title: 'Italic (⌘I)' },
  { cmd: 'strikeThrough', label: '<s>S</s>', title: 'Strikethrough' },
  { sep: true },
  { cmd: 'insertUnorderedList', label: '<svg viewBox="0 0 20 20"><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="14" r="1.3"/><path d="M8.5 6h8M8.5 14h8"/></svg>', title: 'Bulleted list (type “- ”)' },
  { cmd: 'insertOrderedList', label: '<svg viewBox="0 0 20 20"><path d="M8.5 6h8M8.5 14h8"/><text x="2.2" y="8.3" font-size="6.5" stroke="none" fill="currentColor">1</text><text x="2.2" y="16.3" font-size="6.5" stroke="none" fill="currentColor">2</text></svg>', title: 'Numbered list (type “1. ”)' },
  { cmd: 'link', label: '<svg viewBox="0 0 20 20"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>', title: 'Link (⌘K)' },
];

function mdEditor(t) {
  if (t._ed) return t._ed;
  const wrap = document.createElement('div');
  wrap.className = 'wys';
  wrap.innerHTML = `
    <div class="wys-bar" role="toolbar" aria-label="Formatting">
      ${ED_TOOLS.map(b => (b.sep ? '<span class="wys-sep"></span>'
        : `<button type="button" data-cmd="${b.cmd}" title="${b.title}" aria-pressed="false" tabindex="-1">${b.label}</button>`)).join('')}
      <span class="spacer"></span>
      <button type="button" data-cmd="source" class="wys-src" title="Edit as Markdown text" aria-pressed="false" tabindex="-1">Markdown</button>
    </div>
    <div class="wys-body md" contenteditable="true" role="textbox" aria-multiline="true"></div>`;
  t.after(wrap);
  wrap.prepend(t); // the textarea lives in the wrapper, shown only in Markdown mode
  t.classList.add('md-input');
  const body = wrap.querySelector('.wys-body');
  body.dataset.placeholder = t.placeholder;
  body.setAttribute('aria-label', t.closest('.field, label')?.querySelector('.field-label')?.textContent || t.name);
  const ed = { t, wrap, body };
  t._ed = ed;

  body.addEventListener('input', () => edCommit(ed));
  body.addEventListener('keydown', (e) => edKeydown(ed, e));
  body.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (!text) return;
    document.execCommand('insertHTML', false, /\n/.test(text.trim()) ? mdToHtml(text) : mdInline(escAttr(text)));
  });
  body.addEventListener('drop', (e) => e.preventDefault()); // only typed or pasted text, never dropped HTML
  wrap.querySelector('.wys-bar').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  wrap.querySelector('.wys-bar').addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
    if (!cmd) return;
    if (cmd === 'source') return edSource(ed, !wrap.classList.contains('source'));
    body.focus();
    if (cmd === 'link') edLink(ed);
    else document.execCommand(cmd);
    edCommit(ed);
  });
  t.addEventListener('input', () => { if (wrap.classList.contains('source')) autoGrow(t); });
  edLoad(t);
  return ed;
}

// Show the textarea's Markdown in the editor (after the value was set in code).
function edLoad(t) {
  const ed = t._ed;
  if (!ed) return;
  ed.body.innerHTML = mdToHtml(t.value);
  edEmpty(ed);
  if (ed.wrap.classList.contains('source')) autoGrow(t);
}
const edEmpty = (ed) => ed.body.classList.toggle('is-empty', !ed.body.textContent.trim() && !ed.body.querySelector('li'));

// Chrome makes a list inside the paragraph it started in; lift it out so spacing matches the
// saved report. The caret sits in a text node that's only moved, so it's put back afterwards.
function edTidy(ed) {
  const wrapped = [...ed.body.querySelectorAll('p, div')].filter(p => p.querySelector(':scope > ul, :scope > ol'));
  if (!wrapped.length) return;
  const sel = window.getSelection();
  const at = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset] : null;
  for (const p of wrapped) {
    const parts = [];
    let loose = null;
    for (const n of [...p.childNodes]) {
      if (/^(UL|OL|P|DIV|BLOCKQUOTE|H[1-6])$/.test(n.nodeName)) { parts.push(n); loose = null; }
      else if (n.nodeName === 'BR' && !loose) continue;
      else { if (!loose) parts.push(loose = document.createElement('p')); loose.append(n); }
    }
    p.replaceWith(...parts);
  }
  if (at && ed.body.contains(at[0])) sel.collapse(at[0], Math.min(at[1], at[0].length ?? at[0].childNodes.length));
}

function edCommit(ed) {
  edTidy(ed);
  ed.t.value = htmlToMd(ed.body);
  edEmpty(ed);
  ed.t.dispatchEvent(new Event('input', { bubbles: true }));
  edToolState();
}

function edSource(ed, on) {
  ed.wrap.classList.toggle('source', on);
  ed.wrap.querySelector('.wys-src').setAttribute('aria-pressed', on);
  if (on) { autoGrow(ed.t); ed.t.focus(); } else { edLoad(ed.t); focusText(ed.t); }
}

// Focus a report text box, caret at the end, whichever way it's being edited.
function focusText(t) {
  const ed = t._ed;
  if (!ed || ed.wrap.classList.contains('source')) {
    t.focus();
    return t.setSelectionRange(t.value.length, t.value.length);
  }
  ed.body.focus();
  const r = document.createRange();
  r.selectNodeContents(ed.body);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function edLink(ed) {
  const sel = window.getSelection();
  let url = prompt('Link address', 'https://');
  if (!url || url === 'https://') return;
  url = url.trim();
  if (!MD_URL.test(url)) url = /^[\w.-]+@[\w.-]+\.\w+$/.test(url) ? `mailto:${url}` : `https://${url.replace(/^\/+/, '')}`;
  if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${escAttr(url)}">${escAttr(url)}</a>`);
  else document.execCommand('createLink', false, url);
}

function edKeydown(ed, e) {
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); edLink(ed); return edCommit(ed); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); document.execCommand('strikeThrough'); return edCommit(ed); }
  const sel = window.getSelection();
  const li = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('li');
  if (e.key === 'Tab' && li && ed.body.contains(li)) {
    e.preventDefault();
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    return edCommit(ed);
  }
  // Markdown as you type: "- ", "* ", "1. " or "> " at the start of a line.
  if (e.key === ' ' && sel.isCollapsed && !li) {
    const block = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('p, div, h4, h5, h6');
    const start = block && ed.body.contains(block) ? block : ed.body;
    const before = document.createRange();
    before.setStart(start, 0);
    before.setEnd(sel.anchorNode, sel.anchorOffset);
    const typed = before.toString();
    const cmd = /^[-*+•]$/.test(typed) ? ['insertUnorderedList'] : /^\d+[.)]$/.test(typed) ? ['insertOrderedList']
      : typed === '>' ? ['formatBlock', 'blockquote'] : null;
    if (!cmd) return;
    e.preventDefault();
    sel.removeAllRanges();
    sel.addRange(before);
    document.execCommand('delete');
    document.execCommand(...cmd);
    edCommit(ed);
  }
}

// Light up the toolbar buttons for the formatting at the caret.
function edToolState() {
  const wrap = document.activeElement?.closest?.('.wys');
  if (!wrap) return;
  wrap.querySelectorAll('.wys-bar [data-cmd]').forEach(b => {
    if (b.dataset.cmd === 'link' || b.dataset.cmd === 'source') return;
    let on = false;
    try { on = document.queryCommandState(b.dataset.cmd); } catch { /* ignore */ }
    b.setAttribute('aria-pressed', on);
  });
}

// The editor's HTML as Markdown: paragraphs are separated by a blank line, line breaks (Shift+
// Enter) stay single, and characters that would otherwise read as formatting are escaped.
function htmlToMd(root) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/([*`[\]])/g, '\\$1').replace(/~~/g, '\\~\\~')
    .replace(/(^|\W)_/g, '$1\\_').replace(/_(?=\W|$)/g, '\\_');
  const escLead = (line) => line.replace(/^(\s*)([-+•>]|#{1,3})(?=\s)/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2');
  const wrapWith = (s, m) => s.split('\n').map(l => {
    const x = l.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return x[2] ? `${x[1]}${m}${x[2]}${m}${x[3]}` : l;
  }).join('\n');
  const isList = (n) => n.nodeName === 'UL' || n.nodeName === 'OL';
  const isBlock = (n) => /^(P|DIV|H[1-6]|BLOCKQUOTE|UL|OL|LI)$/.test(n.nodeName);

  const inline = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.nodeValue.replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' ')); continue; }
      if (n.nodeType !== 1 || isList(n)) continue;
      const tag = n.nodeName, st = n.style || {};
      if (tag === 'BR') out += '\n';
      else if (tag === 'CODE') out += '`' + n.textContent.replace(/`/g, '') + '`';
      else if (tag === 'A') {
        const href = n.getAttribute('href') || '', text = inline(n);
        out += MD_URL.test(href) ? (text === esc(href) ? href : `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`) : text;
      } else {
        let t = inline(n);
        if (isBlock(n) && out && !out.endsWith('\n')) t = '\n' + t;
        if (tag === 'B' || tag === 'STRONG' || +st.fontWeight >= 600 || st.fontWeight === 'bold') t = wrapWith(t, '**');
        if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') t = wrapWith(t, '*');
        if (/^(S|STRIKE|DEL)$/.test(tag) || /line-through/.test(st.textDecoration || st.textDecorationLine || '')) t = wrapWith(t, '~~');
        out += t;
      }
    }
    return out;
  };
  const paragraph = (text) => text.replace(/\n$/, '').split('\n').map(l => escLead(l.trim())).join('\n');
  const list = (node, depth, lines) => {
    let i = 0;
    for (const c of node.children) {
      if (c.nodeName === 'LI') {
        const marker = node.nodeName === 'OL' ? `${++i}.` : '-';
        lines.push(`${'  '.repeat(depth)}${marker} ${inline(c).replace(/\s*\n\s*/g, ' ').trim()}`);
        for (const sub of c.children) if (isList(sub)) list(sub, depth + 1, lines);
      } else if (isList(c)) list(c, depth + 1, lines);
    }
    return lines;
  };
  const blocks = [];
  let loose = '';
  const flushLoose = () => { if (loose.trim()) blocks.push(paragraph(loose)); loose = ''; };
  const walk = (parent, out) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === 1 && isList(n)) { flushLoose(); out.push(list(n, 0, []).join('\n')); }
      else if (n.nodeType === 1 && /^H[1-6]$/.test(n.nodeName)) {
        flushLoose();
        const text = inline(n).replace(/\s*\n\s*/g, ' ').trim();
        if (text) out.push(`${'#'.repeat(Math.min(3, Math.max(1, +n.nodeName[1] - 3)))} ${text}`);
      } else if (n.nodeName === 'BLOCKQUOTE') {
        flushLoose();
        const inner = [];
        walk(n, inner);
        if (!inner.length) { const t = paragraph(inline(n)); if (t.trim()) inner.push(t); }
        if (inner.length) out.push(inner.join('\n').split('\n').map(l => `> ${l}`).join('\n'));
      } else if (n.nodeType === 1 && (n.nodeName === 'P' || n.nodeName === 'DIV')) {
        flushLoose();
        if (n.querySelector('ul, ol, p, div, blockquote')) walk(n, out); // a wrapper, not a paragraph
        else { const t = paragraph(inline(n)); if (t.trim()) out.push(t); }
      } else if (parent === root) loose += n.nodeType === 3 ? esc(n.nodeValue.replace(/\u00a0/g, ' ')) : n.nodeName === 'BR' ? '\n' : inline({ childNodes: [n] });
    }
    if (parent === root) flushLoose();
  };
  walk(root, blocks);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---- report dialog ---- */

let rpEditing = null;  // report being edited; null for a new one
let rpItemId = '';
let rpDateTouched = false; // stop re-defaulting the period once the user picks a date
let rpPrevIdx = 0;         // which earlier report the side panel shows (0 = the one just before)

function openReportDialog({ report = null, itemId = '' } = {}) {
  hideTip();
  hideQuick();
  rpEditing = report;
  rpItemId = report ? report.item_id : itemId;
  rpDateTouched = !!report;
  rpPrevIdx = 0;
  const f = document.getElementById('report-form').elements;

  document.getElementById('rp-item-pick').hidden = !!rpItemId;
  f.item_id.innerHTML = `<option value="">— choose ${escAttr(withArticle(T.item))} —</option>` +
    [...state.items].sort(cmpRef).map(m => `<option value="${m.id}">${escAttr(fullLabel(m))}</option>`).join('');
  f.item_id.value = rpItemId;

  const v = report || newReportValues(rpItemId);
  for (const k of ['cadence', 'period_end', 'status', 'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author']) f[k].value = v[k];
  for (const k of REPORT_TEXTS) edLoad(f[k]);
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
  if (rpItemId) focusText(f.exec_summary); else f.item_id.focus();
}

// Defaults for a new report: carry on the item's last cadence, current status and owner.
function newReportValues(itemId) {
  const m = itemById(itemId);
  const cadence = reportsFor(itemId)[0]?.cadence || 'Weekly';
  return {
    cadence, period_end: defaultPeriodEnd(cadence), status: m?.status || DEFAULT_STATUS,
    exec_summary: '', achievements: '', next_steps: '', get_to_green: '', author: m?.owner || '',
  };
}

function refreshReportForm() {
  const f = document.getElementById('report-form').elements;
  const m = itemById(rpItemId);
  const end = f.period_end.value;
  const st = f.status.value;

  const n = rpItemId ? reportsFor(rpItemId).length : 0;
  const hist = document.getElementById('rp-history');
  hist.hidden = !n;
  hist.textContent = `View all reports (${n})`;

  const strip = document.getElementById('rp-item');
  strip.hidden = !rpItemId;
  strip.innerHTML = m
    ? `${statusPill(m.status)}<span class="rp-item-title">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>
       <span class="rp-item-meta">${escAttr(typeName(m))} · ${isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : `due ${fmtNice(m.end)}`}${m.owner ? ` · ${escAttr(m.owner)}` : ''}</span>`
    : `<span class="rp-item-title">Deleted ${escAttr(T.item)} #${escAttr(rpItemId)}</span>`;

  document.getElementById('rp-range').textContent = end && parseDate(end)
    ? `Covers ${fmtShort(periodStart(end, f.cadence.value))} – ${fmtNice(end)}` : '';

  const offTrack = OFF_TRACK.includes(st);
  document.getElementById('rp-gtg').hidden = !offTrack;
  f.get_to_green.required = offTrack;

  // Offer to update the item's RAG, but only from its most recent report.
  const others = state.reports.filter(r => r.item_id === rpItemId && r !== rpEditing);
  const latest = isLatestReport(rpItemId, end, rpEditing);
  const sync = document.getElementById('rp-sync');
  sync.hidden = !(m && latest && st !== m.status);
  if (m) sync.querySelector('span').innerHTML = `Also change ${escAttr(itemLabel(m))}’s RAG on the chart from <b>${m.status}</b> to <b>${st}</b>`;

  renderPrevReport(others.filter(r => r.period_end < end).sort(byPeriodDesc));

  const clash = end && reportClash({ period_end: end }, rpItemId, rpEditing);
  document.getElementById('rp-error').innerHTML = clash
    ? `There’s already a report for this ${escAttr(T.item)} for the period ending ${fmtNice(end)}. <button type="button" class="link-btn" data-open-report="${clash.id}">Open it</button>`
    : '';
}

// Has the user typed anything that isn't saved yet?
function reportDirty() {
  const f = document.getElementById('report-form').elements;
  return ['exec_summary', 'achievements', 'next_steps', 'get_to_green']
    .some(k => f[k].value.trim() !== (rpEditing ? rpEditing[k] : '').trim());
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
      ${text ? `<div class="md">${mdToHtml(text)}</div>` : '<p class="rp-prev-empty">—</p>'}</section>`;
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
  if (!field.value.includes(text)) field.value = field.value.trim() ? `${field.value.trimEnd()}\n\n${text}` : text;
  edLoad(field);
  focusText(field);
}

// Why a report's values can't be saved yet, or '' if they can.
function reportProblem(v) {
  if (!parseDate(v.period_end)) return 'Enter the date the reporting period ends.';
  if (!v.status) return 'Choose the RAG for this period.';
  if (!v.exec_summary) return 'Add an exec summary.';
  if (OFF_TRACK.includes(v.status) && !v.get_to_green) return `A ${v.status} report needs a get to green plan.`;
  return '';
}
// Another report on the same item for the same period.
const reportClash = (v, itemId, editing) =>
  state.reports.find(r => r !== editing && r.item_id === itemId && r.period_end === v.period_end);
// Changing a report's RAG only offers to update the item from its most recent report.
const isLatestReport = (itemId, end, editing) =>
  !state.reports.some(r => r.item_id === itemId && r !== editing && r.period_end > end);

async function submitReport(e) {
  e.preventDefault();
  const f = document.getElementById('report-form').elements;
  const err = document.getElementById('rp-error');
  const v = {};
  for (const k of ['cadence', 'period_end', 'status', 'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author']) v[k] = f[k].value.trim();

  if (!rpItemId) return (err.textContent = `Choose the ${T.item} this report is for.`);
  const problem = reportProblem(v);
  if (problem) return (err.textContent = problem);
  if (reportClash(v, rpItemId, rpEditing)) return refreshReportForm();
  if (!OFF_TRACK.includes(v.status)) v.get_to_green = '';
  v.period_start = periodStart(v.period_end, v.cadence);

  const now = new Date().toISOString();
  const isNew = !rpEditing;
  if (rpEditing) Object.assign(rpEditing, v, { updated: now });
  else {
    const r = { id: nextReportId(), workspace_id: state.workspaceId, item_id: rpItemId, ...v, created: now, updated: now };
    state.reports.push(r);
    rptSelId = r.id;
  }

  const m = itemById(rpItemId);
  const syncStatus = !document.getElementById('rp-sync').hidden && f.sync_status.checked;
  document.getElementById('report-dialog').close();
  if (syncStatus) {
    m.status = v.status;
    saveData(`${itemLabel(m)} RAG is now ${v.status}`);
  }
  rerenderCurrentView();
  await saveReports(isNew ? 'Report submitted' : 'Report updated');
}

async function deleteReport() {
  if (!rpEditing) return;
  const m = itemById(rpEditing.item_id);
  const snap = snapshotData();
  const label = `Deleted the report${m ? ` on ${itemLabel(m)}` : ''} for ${fmtShort(rpEditing.period_end)}`;
  state.reports = state.reports.filter(r => r !== rpEditing);
  document.getElementById('report-dialog').close();
  rerenderCurrentView();
  offerUndo(snap, label);
  await saveReports('Report deleted');
}

// Reports whose item no longer exists, e.g. after the items file was replaced.
const orphanReports = () => state.reports.filter(r => !itemById(r.item_id));

async function deleteOrphanReports() {
  const gone = new Set(orphanReports());
  if (!gone.size || !leavePaneEdit()) return;
  const snap = snapshotData();
  state.reports = state.reports.filter(r => !gone.has(r));
  paneEditing = false;
  rerenderCurrentView();
  offerUndo(snap, `Deleted ${count(gone.size, 'report', 'reports')} on deleted ${T.items}`);
  await saveReports(`${count(gone.size, 'report', 'reports')} deleted`);
}

function rerenderCurrentView() {
  updateDueBadge();
  if (isShown('gantt')) renderGantt();
  if (isShown('reports')) renderReports();
  if (isShown('workspaces')) renderWorkspaces();
  if (isShown('overview')) renderOverview();
  if (isShown('lanes')) renderLaneOverview();
  if (isShown('changes')) renderChanges();
}

/* ---- reports list ---- */

const itemName = (id) => { const m = itemById(id); return m ? fullLabel(m) : `Deleted ${T.item} #${id}`; };

// The item filter lists everything that has reports (plus a filtered-on item without any), in ref order.
function reportItemOptions() {
  const ids = new Set(state.reports.map(r => r.item_id));
  if (rptTable.filters.item_id) ids.add(rptTable.filters.item_id);
  return [...ids]
    .sort((a, b) => { const ma = itemById(a), mb = itemById(b); return ma && mb ? cmpRef(ma, mb) : !ma - !mb; })
    .map(id => [id, itemName(id)]);
}

// `text` is what a text filter searches; `sort` is the value the column sorts by.
const RPT_COLS = [
  { key: 'period_end', label: 'Period ending', w: 150, filter: 'text', text: r => `${r.period_end} ${fmtNice(r.period_end)} ${periodText(r)}` },
  { key: 'item_id', label: () => T.Item, w: 230, filter: reportItemOptions, sort: r => itemById(r.item_id) || null },
  { key: 'cadence', label: 'Cadence', w: 115, filter: opts(CADENCES), sort: r => CADENCES.indexOf(r.cadence) },
  { key: 'status', label: 'RAG', w: 120, filter: () => STATUSES.map(v => [v, v]) },
  { key: 'exec_summary', label: 'Exec summary', w: 420, filter: 'text', text: r => `${r.exec_summary} ${r.get_to_green ? 'get to green' : ''}` },
  { key: 'author', label: 'Author', w: 130, filter: 'text' },
  { key: 'created', label: 'Created', w: 120, filter: 'text', text: r => fmtStamp(r.created) },
  { key: 'updated', label: 'Last updated', w: 120, filter: 'text', text: r => fmtStamp(r.updated) },
];

// With the preview open the list keeps to what identifies a report; the pane shows the rest.
const PREVIEW_HIDDEN = ['cadence', 'exec_summary'];
const rptTable = makeTable({
  table: 'reports-table', store: 'milestone-tracker.reports-grid', onChange: () => renderReports(), fill: 'item_id',
  cols: () => (rptPreview ? RPT_COLS.filter(c => !PREVIEW_HIDDEN.includes(c.key)) : RPT_COLS),
});
let rptSearch = ''; // free-text search across every report field, from the toolbar

function clearReportFilters() {
  clearTableFilters(rptTable);
  rptSearch = '';
}

function showReportsFor(itemId) {
  clearReportFilters();
  rptTable.filters.item_id = itemId;
  switchView('reports');
}

// Newest period first, then by item ref.
const reportDefaultOrder = (a, b) => b.period_end.localeCompare(a.period_end)
  || ((ma, mb) => (ma && mb ? cmpRef(ma, mb) : 0))(itemById(a.item_id), itemById(b.item_id));

// Reports matching the filters on the Reports tab, in the table's sort order.
function filteredReports() {
  const q = rptSearch.trim().toLowerCase();
  const rows = state.reports.filter(r =>
    Object.entries(rptTable.filters).every(([k, f]) => {
      const c = RPT_COLS.find(x => x.key === k);
      if (c.filter !== 'text') return r[k] === f;
      return (c.text ? c.text(r) : r[k]).toLowerCase().includes(f.toLowerCase());
    })
    && (!q || [itemName(r.item_id), r.exec_summary, r.achievements, r.next_steps, r.get_to_green, r.author].join(' ').toLowerCase().includes(q)));
  const valueOf = (r, key) => {
    const c = RPT_COLS.find(x => x.key === key);
    return c.sort ? c.sort(r) : r[key];
  };
  if (rptTable.sort.key === 'item_id') { // items sort by ref, not by id
    const dir = rptTable.sort.dir;
    return rows.sort((a, b) => {
      const ma = itemById(a.item_id), mb = itemById(b.item_id);
      return ((ma && mb ? cmpRef(ma, mb) : !ma - !mb) * dir) || reportDefaultOrder(a, b);
    });
  }
  return sortRows(rptTable, rows, valueOf, reportDefaultOrder);
}

// A created / updated time as date over time, so the column stays narrow.
function stampCell(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '<td class="rc-stamp"></td>';
  return `<td class="rc-stamp" title="${escAttr(fmtStamp(iso))}">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}<small>${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></td>`;
}

/* ---- reports due ---- */
// What still needs a report this period. An item is being reported on once it has started or has
// a report, until it reaches a done status. Its cadence is that of its latest report (weekly if it
// has none); it's covered once a report's period reaches into the current one.

let rptMode = 'all'; // 'all' reports, or what's 'due'

function reportsDue(items = state.items) {
  const today = todayISO();
  const out = [];
  for (const m of items) {
    if (isDoneStatus(m.status, m.workspace_id)) continue;
    const reps = reportsFor(m.id);
    const last = reps[0];
    if (!last && !(m.start && m.start <= today)) continue; // not started and never reported on
    const cadence = last?.cadence || 'Weekly';
    const end = defaultPeriodEnd(cadence);
    const start = periodStart(end, cadence);
    if (last && last.period_end >= start) continue; // this period is covered
    const missed = last ? Math.max(0, Math.floor(daysBetween(last.period_end, start) / (cadence === 'Monthly' ? 30 : cadence === 'Fortnightly' ? 14 : 7))) : 0;
    out.push({ m, cadence, end, last, missed });
  }
  return out;
}

function updateDueBadge() {
  const n = reportsDue().length;
  for (const id of ['nav-due', 'rp-due-count']) {
    const el = document.getElementById(id);
    el.textContent = n || '';
    el.hidden = !n;
  }
  document.getElementById('nav-due').title = `${count(n, 'report', 'reports')} due this period`;
}

function renderDue() {
  const due = reportsDue();
  const byOwner = new Map();
  for (const d of due) {
    const k = d.m.owner || '';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(d);
  }
  const owners = [...byOwner.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
  const when = (d) => {
    if (!d.last) return '<span class="due-late">No reports yet</span>';
    const ago = `${statusPill(d.last.status)} <span class="muted">period ending ${fmtShort(d.last.period_end)}</span>`;
    return d.missed ? `${ago} <span class="due-late">· ${count(d.missed, 'period', 'periods')} missed</span>` : ago;
  };
  document.getElementById('rp-due').innerHTML = due.length ? `
    <table class="due-table">
      <thead><tr><th>${escAttr(T.Item)}</th><th>RAG</th><th>Cadence</th><th>Due for the period ending</th><th>Last report</th><th></th></tr></thead>
      ${owners.map(o => `
        <tbody>
          <tr class="due-owner"><th colspan="6">${o ? escAttr(o) : '<span class="muted">No owner</span>'} <span class="muted">· ${count(byOwner.get(o).length, 'report', 'reports')} due</span></th></tr>
          ${byOwner.get(o).sort((a, b) => b.missed - a.missed || cmpRef(a.m, b.m)).map(d => `
            <tr>
              <td>${d.m.ref ? `<b class="ref">${escAttr(d.m.ref)}</b> ` : ''}${escAttr(d.m.title)}</td>
              <td>${statusPill(d.m.status)}</td>
              <td>${d.cadence}</td>
              <td>${fmtNice(d.end)}</td>
              <td>${when(d)}</td>
              <td class="due-act"><button type="button" class="btn btn-sm" data-due-report="${d.m.id}">Provide report…</button></td>
            </tr>`).join('')}
        </tbody>`).join('')}
    </table>`
    : `<p class="due-empty">Every ${escAttr(T.item)} that’s under way has a report for this period. Nothing is due.</p>`;
}

function setReportsMode(mode) {
  if (mode === rptMode) return;
  if (mode === 'due' && !leavePaneEdit()) return (document.querySelector('[name="rp-mode"][value="all"]').checked = true);
  rptMode = mode;
  saveAppPrefs({ reportsMode: mode });
  renderReports();
}

function renderReports() {
  updateDueBadge();
  document.querySelectorAll('[name="rp-mode"]').forEach(r => { r.checked = r.value === rptMode; });
  const due = rptMode === 'due';
  document.getElementById('rp-due').hidden = !due;
  document.getElementById('rp-split').hidden = due;
  document.querySelector('#view-reports .rp-filters').hidden = due;
  document.getElementById('rp-hint').hidden = due;
  document.getElementById('rp-due-hint').hidden = !due;
  for (const id of ['btn-reports-csv', 'rp-count']) document.getElementById(id).hidden = due;
  if (due) {
    document.getElementById('btn-rp-orphans').hidden = true;
    return renderDue();
  }
  refreshSelectFilters(rptTable);
  const qEl = document.getElementById('rpf-q');
  if (document.activeElement !== qEl) qEl.value = rptSearch; // don't disturb the caret while typing

  const rows = rptRows = filteredReports();
  // Keep the selection while it's listed (or being edited); otherwise show the first report.
  if (!paneEditing && !rows.some(r => r.id === rptSelId)) rptSelId = rows[0]?.id ?? null;
  const cells = {
    period_end: r => `<td class="rc-period"><b>${fmtNice(r.period_end)}</b><small>${periodText(r)}</small></td>`,
    item_id: (r, m) => `<td class="rc-item">${m ? `${m.ref ? `<b class="ref">${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}` : `<i>Deleted ${escAttr(T.item)} #${escAttr(r.item_id)}</i>`}</td>`,
    cadence: r => `<td class="rc-cad">${r.cadence}</td>`,
    status: r => `<td class="rc-status">${statusPill(r.status)}${rptPreview && r.get_to_green ? '<small class="gtg-flag">Get to green plan</small>' : ''}</td>`,
    exec_summary: r => `<td class="rc-sum"><div>${escAttr(mdToText(r.exec_summary))}</div>${r.get_to_green ? '<small class="gtg-flag">Has get to green plan</small>' : ''}</td>`,
    author: r => `<td class="rc-author">${escAttr(r.author)}</td>`,
    created: r => stampCell(r.created),
    updated: r => stampCell(r.updated),
  };
  const cols = rptTable.cols();
  const body = document.getElementById('reports-body');
  body.innerHTML = rows.map(r => {
    const m = itemById(r.item_id);
    const sel = rptPreview && r.id === rptSelId;
    return `<tr data-rid="${r.id}" tabindex="${sel || (!rptPreview) ? 0 : -1}" class="${sel ? 'selected' : ''}" aria-selected="${sel}"
      title="${rptPreview ? 'Click to preview · double-click to edit' : 'Click to view or edit'}">${cols.map(c => cells[c.key](r, m)).join('')}</tr>`;
  }).join('');
  const filtered = Object.keys(rptTable.filters).length > 0 || !!rptSearch.trim();
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="grid-empty">${state.reports.length
      ? 'No reports match the filters.'
      : `No reports in this workspace yet. Click ${escAttr(withArticle(T.item))} on the Gantt chart and choose <b>Provide report</b>, or use <b>+ New report</b>.`}</td></tr>`;
  }
  document.getElementById('rp-count').textContent = filtered
    ? `Showing ${rows.length} of ${state.reports.length}`
    : `${state.reports.length} report${state.reports.length === 1 ? '' : 's'}`;
  document.getElementById('rpf-clear').hidden = !filtered;
  const orphans = orphanReports().length;
  const ob = document.getElementById('btn-rp-orphans');
  ob.hidden = !orphans;
  ob.textContent = `Delete ${count(orphans, 'report', 'reports')} on deleted ${T.items}`;
  document.getElementById('rp-split').classList.toggle('no-preview', !rptPreview);
  if (!rptPreview) return;
  if (paneEditing) updatePanePos(); // leave the form (and what's been typed) alone
  else renderPane();
}

// The report form's RAG choices follow the current workspace's options.
function renderReportRagChoices() {
  document.getElementById('rp-status').innerHTML = STATUSES.map(st => `
    <label style="--c:${STATUS[st].base};--t:${STATUS[st].text}"><input type="radio" name="status" value="${escAttr(st)}" /><span>${escAttr(st)}</span></label>`).join('');
}

/* ---- report preview ---- */
// Beside the list, the selected report reads like a document. ↑ / ↓ step through the list, like
// previewing files in a folder, and clicking into the preview turns it into a form to edit in place.

let rptPreview = true;    // show the preview (a per-browser preference, read in wirePane)
let rptRows = [];         // reports as listed, filters and sort applied
let rptSelId = null;      // the report in the preview
let paneEditing = false;  // the preview is a form
const PANE_TEXTS = [
  { key: 'exec_summary', label: 'Exec summary' },
  { key: 'achievements', label: 'Achievements last period' },
  { key: 'next_steps', label: 'Next steps' },
  { key: 'get_to_green', label: 'Get to green plan', gtg: true },
];
const REPORT_TEXTS = ['exec_summary', 'achievements', 'next_steps', 'get_to_green'];
const PANE_FIELDS = ['cadence', 'period_end', 'status', 'exec_summary', 'achievements', 'next_steps', 'get_to_green', 'author'];
const selectedReport = () => state.reports.find(r => r.id === rptSelId);
const paneForm = () => document.getElementById('pane-form');
const placeholderOf = (k) => document.querySelector(`#report-form [name="${k}"]`)?.placeholder || '';

function setPreview(on) {
  if (!on && !leavePaneEdit()) return (document.getElementById('rp-preview-toggle').checked = true);
  rptPreview = on;
  saveAppPrefs({ rptPreview: on });
  if (on) for (const k of PREVIEW_HIDDEN) delete rptTable.filters[k]; // their filters are no longer shown
  renderTableHead(rptTable);
  renderReports();
}

function panePosText(r) {
  const i = rptRows.indexOf(r);
  return i < 0 ? 'Not in the filtered list' : `${i + 1} of ${rptRows.length}`;
}
function updatePanePos() {
  const r = selectedReport(), el = document.querySelector('#rp-pane .pane-pos');
  if (r && el) el.textContent = panePosText(r);
}

function renderPane(focusKey) {
  const el = document.getElementById('rp-pane');
  const r = selectedReport();
  if (!r) {
    paneEditing = false;
    el.innerHTML = `<div class="pane-empty">${state.reports.length ? 'No report selected.' : 'Reports appear here once they’re submitted.'}</div>`;
    return;
  }
  const m = itemById(r.item_id);
  const i = rptRows.indexOf(r);
  const bar = `
    <div class="pane-bar">
      <span class="pane-nav">
        <button type="button" data-step="-1" title="Previous report (↑)" ${i > 0 ? '' : 'disabled'}>↑</button>
        <button type="button" data-step="1" title="Next report (↓)" ${i >= 0 && i < rptRows.length - 1 ? '' : 'disabled'}>↓</button>
      </span>
      <span class="pane-pos">${panePosText(r)}</span>
      <span class="spacer"></span>
      ${paneEditing
        ? `<button type="button" class="btn btn-sm btn-danger" data-pane="delete">Delete</button>
           <button type="button" class="btn btn-sm" data-pane="cancel" title="Esc">Cancel</button>
           <button type="submit" class="btn btn-sm btn-primary" title="${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter">Save</button>`
        : '<button type="button" class="btn btn-sm" data-pane="edit" title="Enter">Edit</button>'}
    </div>`;
  const n = reportsFor(r.item_id).length;
  const item = `
    <div class="pane-item">
      <div class="pane-item-title">${m ? `${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}` : `<i>Deleted ${escAttr(T.item)} #${escAttr(r.item_id)}</i>`}</div>
      ${rptTable.filters.item_id === r.item_id || n < 2 ? ''
        : `<button type="button" class="link-btn" data-pane="item">All ${n} reports on this ${escAttr(T.item)}</button>`}
    </div>`;
  const edited = r.updated !== r.created ? `<small>Last edited ${fmtStamp(r.updated)}</small>` : '';

  // The text runs down a main column; the report's details sit in a side column (above the
  // text when the pane is narrow). Reading and editing share the layout, so nothing jumps.
  if (!paneEditing) {
    const sections = PANE_TEXTS.filter(s => !s.gtg || r.get_to_green).map(s => `
      <section class="pane-sec${s.gtg ? ' gtg' : ''}" data-field="${s.key}"><h3>${s.label}</h3>
        ${r[s.key] ? `<div class="md">${mdToHtml(r[s.key])}</div>` : '<p class="pane-blank">—</p>'}</section>`).join('');
    el.innerHTML = `${bar}
      <div class="pane-doc" title="Click to edit">
        ${item}
        <div class="pane-cols">
          <div class="pane-main">${sections}</div>
          <aside class="pane-side">
            <div class="ps-row" data-field="status"><span class="ps-k">RAG this period</span>${statusPill(r.status)}</div>
            <div class="ps-row" data-field="period_end"><span class="ps-k">Period ending</span><b>${fmtNice(r.period_end)}</b><small>Covers ${periodText(r)}</small></div>
            <div class="ps-row" data-field="cadence"><span class="ps-k">Cadence</span>${r.cadence}</div>
            <div class="ps-row" data-field="author"><span class="ps-k">Reported by</span>${r.author ? escAttr(r.author) : '<span class="pane-blank">—</span>'}</div>
            <div class="ps-row ps-stamp"><span class="ps-k">Submitted</span>${fmtStamp(r.created)}${edited}</div>
          </aside>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `<form id="pane-form" novalidate>${bar}
    <div class="pane-doc editing">
      ${item}
      <div class="pane-cols">
        <div class="pane-main form-grid">
          ${PANE_TEXTS.map(s => `<div class="field${s.gtg ? ' rp-gtg' : ''}" data-sec="${s.key}"><span class="field-label">${s.label}</span><textarea name="${s.key}" rows="4" placeholder="${escAttr(placeholderOf(s.key))}"></textarea></div>`).join('')}
          <p class="dlg-error pane-error"></p>
        </div>
        <aside class="pane-side form-grid">
          <div class="field"><span class="field-label">RAG this period</span><div class="rag">${STATUSES.map(st => `
            <label style="--c:${STATUS[st].base};--t:${STATUS[st].text}"><input type="radio" name="status" value="${escAttr(st)}" /><span>${escAttr(st)}</span></label>`).join('')}</div></div>
          <label id="pane-sync" class="rp-sync"><input type="checkbox" name="sync_status" checked /> <span></span></label>
          <label>Period ending<input name="period_end" type="date" /><small class="pane-range"></small></label>
          <div class="field"><span class="field-label">Cadence</span><div class="seg">${CADENCES.map(c => `
            <label><input type="radio" name="cadence" value="${c}" /><span>${c}</span></label>`).join('')}</div></div>
          <label>Reported by<input name="author" list="owner-list" /></label>
          <div class="ps-row ps-stamp"><span class="ps-k">Submitted</span>${fmtStamp(r.created)}${edited}</div>
        </aside>
      </div>
    </div></form>`;
  const f = paneForm().elements;
  for (const k of PANE_FIELDS) f[k].value = r[k];
  for (const k of REPORT_TEXTS) mdEditor(f[k]);
  refreshDatalists();
  refreshPaneForm();
  if (f[focusKey] instanceof HTMLInputElement && f[focusKey].type !== 'radio') f[focusKey].focus();
  else focusText(REPORT_TEXTS.includes(focusKey) ? f[focusKey] : f.exec_summary);
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}

// Show or hide what depends on the RAG and dates while editing, as the report form does.
function refreshPaneForm() {
  const r = selectedReport(), form = paneForm();
  if (!r || !form) return;
  const f = form.elements, m = itemById(r.item_id);
  const end = f.period_end.value, st = f.status.value;
  form.querySelector('.pane-range').textContent = end && parseDate(end)
    ? `Covers ${fmtShort(periodStart(end, f.cadence.value))} – ${fmtNice(end)}` : '';
  const gtg = form.querySelector('[data-sec="get_to_green"]');
  gtg.hidden = !OFF_TRACK.includes(st);
  const sync = document.getElementById('pane-sync');
  sync.hidden = !(m && isLatestReport(r.item_id, end, r) && st !== m.status);
  if (m) sync.querySelector('span').innerHTML = `Also change ${escAttr(itemLabel(m))}’s RAG on the chart from <b>${m.status}</b> to <b>${st}</b>`;
}

function paneValues() {
  const f = paneForm().elements, v = {};
  for (const k of PANE_FIELDS) v[k] = f[k].value.trim();
  if (!OFF_TRACK.includes(v.status)) v.get_to_green = '';
  return v;
}
const paneDirty = (r, v) => PANE_FIELDS.some(k => v[k] !== (r[k] || '').trim());
function paneProblem(r, v) {
  const clash = reportClash(v, r.item_id, r);
  return reportProblem(v) || (clash ? `There’s already a report on this ${T.item} for the period ending ${fmtNice(v.period_end)}.` : '');
}

function editPane(focusKey) {
  if (!selectedReport()) return;
  paneEditing = true;
  renderPane(focusKey);
}

// Saves the edits; false (with the reason shown) if they can't be saved yet.
function savePane() {
  const r = selectedReport();
  if (!r || !paneEditing) return true;
  const v = paneValues();
  const problem = paneProblem(r, v);
  if (problem) {
    // The message sits at the foot of a long form, so also flash it and take the user to the field.
    const err = paneForm().querySelector('.pane-error');
    err.textContent = problem;
    flashStatus(problem, false);
    const f = paneForm().elements;
    const key = !parseDate(v.period_end) ? 'period_end' : !v.exec_summary ? 'exec_summary'
      : OFF_TRACK.includes(v.status) && !v.get_to_green ? 'get_to_green' : null;
    const field = key && (f[key]._ed?.wrap || f[key]);
    (field || err).scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (key && REPORT_TEXTS.includes(key)) focusText(f[key]);
    else if (key) f[key].focus({ preventScroll: true });
    return false;
  }
  const sync = !document.getElementById('pane-sync').hidden && paneForm().elements.sync_status.checked;
  const changed = paneDirty(r, v);
  paneEditing = false;
  if (changed) {
    Object.assign(r, v, { period_start: periodStart(v.period_end, v.cadence), updated: new Date().toISOString() });
    const m = itemById(r.item_id);
    if (sync) {
      m.status = v.status;
      saveData(`${itemLabel(m)} RAG is now ${v.status}`);
    }
    saveReports('Report updated');
  }
  rerenderCurrentView();
  focusSelectedRow();
  return true;
}

function cancelPane() {
  const r = selectedReport();
  if (r && paneDirty(r, paneValues()) && !confirm('Discard your changes to this report?')) return;
  paneEditing = false;
  renderReports();
  focusSelectedRow();
}

async function deletePane() {
  const r = selectedReport();
  if (!r) return;
  const m = itemById(r.item_id);
  const snap = snapshotData();
  const i = rptRows.indexOf(r);
  const next = rptRows[i + 1] || rptRows[i - 1];
  state.reports = state.reports.filter(x => x !== r);
  rptSelId = next?.id ?? null;
  paneEditing = false;
  rerenderCurrentView();
  focusSelectedRow();
  offerUndo(snap, `Deleted the report${m ? ` on ${itemLabel(m)}` : ''} for ${fmtShort(r.period_end)}`);
  await saveReports('Report deleted');
}

// Before the preview shows something else: keep edits that can be saved, otherwise ask.
function leavePaneEdit() {
  const r = selectedReport();
  if (!paneEditing || !r || !paneForm()) return !(paneEditing = false);
  const v = paneValues();
  if (!paneDirty(r, v)) return !(paneEditing = false);
  if (savePane()) return true;
  if (!confirm(`This report can’t be saved yet: ${paneProblem(r, v)}\n\nDiscard your changes?`)) return false;
  paneEditing = false;
  return true;
}

function selectReport(id, focus) {
  if (id !== rptSelId && !leavePaneEdit()) return;
  rptSelId = id;
  paneEditing = false;
  document.querySelectorAll('#reports-body tr[data-rid]').forEach(tr => {
    const on = tr.dataset.rid === id;
    tr.classList.toggle('selected', on);
    tr.setAttribute('aria-selected', on);
    tr.tabIndex = on ? 0 : -1;
  });
  if (focus) focusSelectedRow();
  else document.querySelector('#reports-body tr.selected')?.scrollIntoView({ block: 'nearest' });
  renderPane();
}

function stepReport(n) {
  if (!rptRows.length) return;
  const i = rptRows.findIndex(r => r.id === rptSelId);
  const next = rptRows[i < 0 ? 0 : Math.min(rptRows.length - 1, Math.max(0, i + n))];
  if (next.id !== rptSelId) selectReport(next.id, true);
}

function focusSelectedRow() {
  const tr = document.querySelector('#reports-body tr.selected');
  if (!tr) return;
  tr.focus({ preventScroll: true });
  tr.scrollIntoView({ block: 'nearest' });
}

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function onPaneClick(e) {
  const step = e.target.closest('[data-step]');
  if (step) return stepReport(+step.dataset.step);
  const act = e.target.closest('[data-pane]')?.dataset.pane;
  if (act === 'edit') return editPane('exec_summary');
  if (act === 'cancel') return cancelPane();
  if (act === 'delete') return deletePane();
  if (act === 'item') {
    const r = selectedReport();
    if (!leavePaneEdit()) return;
    clearReportFilters();
    rptTable.filters.item_id = r.item_id;
    renderTableHead(rptTable);
    return renderReports();
  }
  // Clicking into the document edits it — unless the click finished selecting text to copy.
  if (!paneEditing && e.target.closest('.pane-doc') && !e.target.closest('button, a')
    && (window.getSelection()?.isCollapsed ?? true)) {
    editPane(e.target.closest('[data-field]')?.dataset.field);
  }
}

function wirePane() {
  const pane = document.getElementById('rp-pane');
  pane.addEventListener('click', onPaneClick);
  pane.addEventListener('submit', (e) => { e.preventDefault(); savePane(); });
  pane.addEventListener('change', (e) => {
    if (['status', 'cadence', 'period_end'].includes(e.target.name)) refreshPaneForm();
    const err = paneForm()?.querySelector('.pane-error');
    if (err) err.textContent = '';
  });
  pane.addEventListener('keydown', (e) => {
    if (!paneEditing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelPane(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); savePane(); }
  });
  // ↑ / ↓ move through the list wherever focus is, except while typing.
  document.addEventListener('keydown', (e) => {
    if (!rptPreview || !isShown('reports') || document.querySelector('dialog[open]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepReport(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !paneEditing && !e.target.closest('button, a, [data-pane]') && selectedReport()) {
      e.preventDefault();
      editPane('exec_summary');
    }
  });

  const split = document.getElementById('rp-split');
  const divider = document.getElementById('rp-divider');
  const w = loadAppPrefs().rptListW;
  if (w) split.style.setProperty('--rp-list-w', w + 'px');
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const list = split.querySelector('.rp-list');
    const startX = e.clientX, startW = list.getBoundingClientRect().width;
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    const max = () => split.getBoundingClientRect().width - 340;
    const move = (ev) => split.style.setProperty('--rp-list-w', Math.round(Math.min(max(), Math.max(280, startW + ev.clientX - startX))) + 'px');
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
      saveAppPrefs({ rptListW: parseInt(split.style.getPropertyValue('--rp-list-w'), 10) || null });
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('dblclick', () => { split.style.removeProperty('--rp-list-w'); saveAppPrefs({ rptListW: null }); });

  rptPreview = loadAppPrefs().rptPreview ?? true;
  rptMode = loadAppPrefs().reportsMode === 'due' ? 'due' : 'all';
  document.querySelectorAll('[name="rp-mode"]').forEach(r => r.addEventListener('change', () => setReportsMode(r.value)));
  document.getElementById('rp-due').addEventListener('click', (e) => {
    const b = e.target.closest('[data-due-report]');
    if (b) openReportDialog({ itemId: b.dataset.dueReport });
  });
  const toggle = document.getElementById('rp-preview-toggle');
  toggle.checked = rptPreview;
  toggle.addEventListener('change', () => setPreview(toggle.checked));
}

function wireReports() {
  const quick = document.getElementById('quick');
  quick.addEventListener('click', onQuickClick);
  quick.addEventListener('input', onQuickDateInput);
  quick.addEventListener('submit', onQuickDateSubmit);
  // Clicking away closes the panel unless it has unsaved changes; then it asks for Save or Cancel.
  document.addEventListener('mousedown', (e) => {
    if (quick.hidden || quick.contains(e.target) || e.target.closest('.gantt-item')) return;
    if (!quickDirty()) return hideQuick();
    quick.classList.remove('nudge');
    void quick.offsetWidth; // restart the animation
    quick.classList.add('nudge');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !quick.hidden) hideQuick(); });
  const hideIfClean = () => { if (!quickDirty()) hideQuick(); };
  document.getElementById('gantt-scroll').addEventListener('scroll', hideIfClean);
  document.getElementById('gantt-scroll').addEventListener('scroll', syncGanttSticky, { passive: true });
  window.addEventListener('resize', hideIfClean);

  const dlg = document.getElementById('report-dialog');
  const form = document.getElementById('report-form');
  for (const k of REPORT_TEXTS) mdEditor(form.elements[k]);
  document.addEventListener('keydown', onMdKeydown); // shortcuts while editing as Markdown text
  document.addEventListener('selectionchange', edToolState);
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
  form.addEventListener('submit', submitReport);
  form.addEventListener('change', onReportFormInput);
  document.getElementById('rp-cancel').onclick = () => dlg.close();
  document.getElementById('rp-close').onclick = () => dlg.close();
  document.getElementById('rp-delete').onclick = deleteReport;
  document.getElementById('rp-history').onclick = () => {
    if (reportDirty() && !confirm('Discard what you’ve written in this report?')) return;
    dlg.close();
    showReportsFor(rpItemId);
  };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  document.getElementById('rp-prev').addEventListener('click', onPrevPanelClick);
  document.getElementById('rp-error').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open-report]');
    if (b) openReportDialog({ report: state.reports.find(r => r.id === b.dataset.openReport) });
  });

  document.getElementById('btn-reports-csv').onclick = downloadReportsCSV;
  document.getElementById('btn-new-report').onclick = () => {
    if (leavePaneEdit()) openReportDialog({ itemId: rptTable.filters.item_id || '' });
  };
  // With the preview open a click selects the report and a double-click edits it there;
  // without it, a click opens the report form.
  const body = document.getElementById('reports-body');
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-rid]');
    if (!tr) return;
    if (rptPreview) selectReport(tr.dataset.rid);
    else openReportDialog({ report: state.reports.find(r => r.id === tr.dataset.rid) });
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('[data-rid]');
    if (tr && rptPreview && tr.dataset.rid === rptSelId && !paneEditing) editPane('exec_summary');
  });
  body.addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-rid]');
    if (tr && e.key === 'Enter' && !rptPreview) openReportDialog({ report: state.reports.find(r => r.id === tr.dataset.rid) });
  });
  wirePane();
  wireTable(rptTable);
  document.getElementById('rpf-q').addEventListener('input', (e) => { rptSearch = e.target.value; renderReports(); });
  document.getElementById('rpf-clear').onclick = () => { clearReportFilters(); renderReports(); };
  document.getElementById('btn-rp-orphans').onclick = deleteOrphanReports;
}

// Downloads the items currently listed on the Items tab (filters and sort applied), in the
// milestones.csv columns except that links name items by ref, as Import expects, so the file
// loads straight back in (into this workspace or another). An item without a ref is named #id.
const EXPORT_COLUMNS = COLUMNS.map(c => (c === 'parent' ? 'rolls_up_to' : c));
function itemsExportCSV(items) {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const name = (id) => { const x = byId.get(id); return x?.ref || `#${id}`; };
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const m of items) {
    lines.push([m.id, m.workspace_id, m.ref, m.title, m.type, m.description, m.swimlane, m.subswimlane, m.owner, m.start, m.end,
      m.status, m.shape, m.parent ? name(m.parent) : '', m.deps.map(name).join(';')].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}
function downloadItemsCSV() {
  syncEditorToState();
  const p = currentWorkspace();
  const name = (p.code || p.name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'workspace';
  const csv = itemsExportCSV(gridRows().map(r => r.m));
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.download = `${name}-items-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

// Downloads the reports currently listed (filters applied). item_ref / item_title are added for
// readability; the file still loads as reports.csv because unknown columns are ignored.
function downloadReportsCSV() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const cols = [...REPORT_COLUMNS.slice(0, 2), 'item_ref', 'item_title', ...REPORT_COLUMNS.slice(2)];
  const header = cols.map(csvName).join(',');
  const lines = filteredReports().map(r => {
    const m = byId.get(r.item_id);
    return cols.map(k => csvEscape(k === 'item_ref' ? m?.ref : k === 'item_title' ? m?.title : r[k])).join(',');
  });
  const blob = new Blob(['\ufeff' + [header, ...lines].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.download = `reports-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ================= import ================= */
// Brings a list of milestones and tasks into the current workspace, from a CSV file or cells
// pasted from a spreadsheet. Each column is matched to a field by its heading (and can be
// changed), dates are read in whatever format they're written, and a preview shows what will be
// added, updated, deleted or skipped before anything is saved. Blank cells leave an existing
// item's value alone. Links (rolls up to, depends on) name an item by its ref.

const IMPORT_FIELDS = ['ref', 'title', 'type', 'description', 'swimlane', 'subswimlane', 'owner', 'start', 'end', 'status', 'shape', 'parent', 'deps', 'id'];
const importFieldLabel = (k) => ({
  ref: 'Ref', title: 'Title', type: `Type (${T.milestone} or ${T.task})`, description: 'Description', swimlane: 'Swimlane',
  subswimlane: 'Sub-swimlane', owner: 'Owner', start: 'Start date', end: `End date / ${T.milestone} date`, status: 'RAG',
  shape: 'Shape', parent: 'Rolls up to (ref)', deps: 'Depends on (refs)', id: 'ID (used to match links)',
}[k]);
// Headings are compared with everything but letters and digits removed.
const IMPORT_ALIASES = {
  id: ['id', 'itemid', 'uniqueid', 'uid'],
  ref: ['ref', 'reference', 'refno', 'wbs', 'no', 'number', 'key', 'outlinenumber'],
  title: ['title', 'name', 'milestone', 'milestonename', 'task', 'taskname', 'item', 'itemname', 'summary', 'deliverable', 'activity', 'activityname'],
  type: ['type', 'kind', 'itemtype', 'milestoneortask'],
  description: ['description', 'desc', 'details', 'notes', 'comments', 'comment'],
  swimlane: ['swimlane', 'lane', 'workstream', 'stream', 'category', 'group', 'area', 'team', 'theme', 'project'],
  subswimlane: ['subswimlane', 'sublane', 'subworkstream', 'substream', 'subcategory', 'subgroup'],
  owner: ['owner', 'assignee', 'assignedto', 'responsible', 'accountable', 'resource', 'resourcenames', 'lead'],
  start: ['start', 'startdate', 'begin', 'begindate', 'from', 'plannedstart', 'baselinestart', 'forecaststart', 'actualstart'],
  end: ['end', 'enddate', 'date', 'due', 'duedate', 'finish', 'finishdate', 'deadline', 'target', 'targetdate', 'to', 'plannedend',
    'plannedfinish', 'baselinefinish', 'forecastend', 'forecastfinish', 'completiondate', 'milestonedate', 'deliverydate'],
  status: ['rag', 'status', 'ragstatus', 'health', 'rating'],
  shape: ['shape'],
  parent: ['parent', 'parentref', 'parentid', 'rollsupto', 'rollup'],
  deps: ['dependson', 'dependencies', 'dependency', 'deps', 'predecessors', 'predecessor'],
};

const imp = { name: '', rows: [], hasHeader: true, map: [], order: 'auto', mode: 'merge', plan: null };

function guessImportMap(header) {
  const norm = header.map(h => (h.trim() === '#' ? 'no' : h.toLowerCase().replace(/[^a-z0-9]+/g, '')));
  const map = norm.map(() => '');
  const take = (i, k) => { if (!map.includes(k)) map[i] = k; };
  for (const k of IMPORT_FIELDS) {
    const i = norm.findIndex((h, j) => !map[j] && IMPORT_ALIASES[k].includes(h));
    if (i >= 0) take(i, k);
  }
  // Looser second pass, e.g. "Planned start (baseline)" or "Forecast due".
  norm.forEach((h, i) => {
    if (map[i]) return;
    if (/start|begin/.test(h)) take(i, 'start');
    else if (/finish|due|deadline|enddate/.test(h)) take(i, 'end');
    else if (/rag|status/.test(h)) take(i, 'status');
    else if (/owner|assign/.test(h)) take(i, 'owner');
    else if (/predecessor|depend/.test(h)) take(i, 'deps');
    else if (/milestone|type/.test(h)) take(i, 'type'); // e.g. a yes/no "Milestone?" column
  });
  return map;
}

/* ---- dates ---- */
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NUMERIC_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;

function ymd(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? fmtISO(dt) : null;
}
const fullYear = (y) => (y.length <= 2 ? 2000 + +y : +y);
const stripTime = (s) => String(s ?? '').trim()
  .replace(/(?:T|\s+)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]\.?m\.?)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i, '').trim();

// Reads a date written almost any way into YYYY-MM-DD. `order` says how to read 03/04/2026:
// 'dmy' (3 April) or 'mdy' (4 March). Returns '' for a blank cell and null if it can't be read.
function readDate(raw, order) {
  const s = stripTime(raw);
  if (!s) return '';
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(NUMERIC_DATE))) {
    const y = fullYear(m[3]);
    return order === 'mdy' ? ymd(y, +m[1], +m[2]) : ymd(y, +m[2], +m[1]);
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if (/^\d{5}(\.\d+)?$/.test(s)) { // an Excel date number: days since 30 Dec 1899
    const n = Math.floor(+s);
    return n > 20000 && n < 80000 ? fmtISO(new Date(1899, 11, 30 + n)) : null;
  }
  // Words: 31 Mar 2026, 31-Mar-26, March 31, 2026, Tue 31st March 2026…
  let month = 0;
  const nums = [];
  for (const w of s.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').split(/[\s,./'-]+/).filter(Boolean)) {
    if (/^\d+$/.test(w)) { nums.push(w); continue; }
    const mi = w.length >= 3 ? MONTH_NAMES.findIndex(n => n.startsWith(w) || (w === 'sept' && n === 'september')) : -1;
    if (mi >= 0 && !month) month = mi + 1;
    else if (!(w.length >= 3 && DAY_NAMES.some(n => n.startsWith(w)))) return null;
  }
  if (!month || nums.length !== 2) return null;
  const [a, b] = nums;
  return a.length === 4 ? ymd(+a, month, +b) : ymd(fullYear(b), month, +a);
}

// Which way round the file writes numeric dates, if any of them give it away (a day over 12).
function detectDateOrder(values) {
  let dmy = false, mdy = false, ambiguous = false;
  for (const v of values) {
    const m = stripTime(v).match(NUMERIC_DATE);
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    else if (+m[2] > 12) mdy = true;
    else if (m[1] !== m[2]) ambiguous = true;
  }
  return { found: dmy !== mdy ? (dmy ? 'dmy' : 'mdy') : null, ambiguous, conflict: dmy && mdy };
}
const localDateOrder = () => (/^en-(us|ph)|^(fil|es-us)/i.test(navigator.language || '') ? 'mdy' : 'dmy');

/* ---- values ---- */
// The workspace's own words count, as do yes/no from a "Milestone?" column.
function readType(v) {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if ([T.task, T.tasks].some(w => w.toLowerCase() === s) || /^(no|n|false)$/.test(s)) return 'task';
  if ([T.milestone, T.milestones].some(w => w.toLowerCase() === s) || /^(yes|y|true)$/.test(s)) return 'milestone';
  if (/^(t|tasks?|bars?|activit(y|ies)|phases?|work ?packages?|ranges?|summary( task)?)$/.test(s)) return 'task';
  if (/^(m|milestones?|gates?|checkpoints?|deliverables?|points?|key dates?)$/.test(s)) return 'milestone';
  return null;
}
// Link cells: refs or ids separated by ; , | or spaces. MS Project style suffixes (3FS+2d) are dropped.
const readLinks = (v) => v.split(/[;,|\s]+/).map(t => t.replace(/(fs|ss|ff|sf)([+-].*)?$/i, '').trim()).filter(Boolean);

/* ---- plan ---- */
// Works out, row by row, what the import will do. Nothing changes until applyImport.
function planImport() {
  const order = imp.order === 'auto' ? imp.detected.found || localDateOrder() : imp.order;
  const data = imp.hasHeader ? imp.rows.slice(1) : imp.rows;
  const col = Object.fromEntries(IMPORT_FIELDS.map(k => [k, imp.map.indexOf(k)]));
  const has = (k) => col[k] >= 0;
  const statuses = STATUSES.map(s => s.toLowerCase());
  const rows = [], usedTargets = new Set(), refRow = new Map();
  // Rows are matched to items by ref. Ids are only trusted from this workspace's own download:
  // another tool's ID column (1, 2, 3…) would otherwise land on unrelated items.
  const wsCol = imp.hasHeader ? imp.rows[0].findIndex(h => h.toLowerCase().replace(/[^a-z]/g, '') === 'workspaceid') : -1;
  const ownExport = wsCol >= 0 && data.every(r => (r[wsCol] ?? '').trim() === state.workspaceId);

  data.forEach((r, i) => {
    const line = i + (imp.hasHeader ? 2 : 1);
    const cell = (k) => (has(k) ? String(r[col[k]] ?? '').trim() : '');
    const row = { line, action: 'add', notes: [], fields: {}, target: null, links: null };
    if (r.every(v => !String(v).trim())) return;

    const ref = cell('ref');
    if (ref && refRow.has(ref)) {
      row.action = 'skip';
      row.notes.push(`Ref ${ref} is already used on row ${refRow.get(ref).line}`);
    } else if (ref) refRow.set(ref, row);
    const existing = (ref && state.items.find(m => m.ref === ref))
      || (!ref && ownExport && state.items.find(m => m.id === cell('id'))) || null;
    if (existing && imp.mode === 'add') row.notes.push(`Ref ${ref} is also used by an existing ${T.item}`);
    else if (existing && row.action !== 'skip' && !usedTargets.has(existing)) {
      row.target = existing;
      row.action = 'update';
      usedTargets.add(existing);
    }
    const t = row.target;
    const f = row.fields;

    for (const k of ['ref', 'title', 'description', 'swimlane', 'subswimlane', 'owner']) if (cell(k)) f[k] = cell(k);
    if (row.action === 'add' && !f.title) { row.action = 'skip'; row.notes.push('No title'); }

    // Dates
    const dates = {};
    for (const k of ['start', 'end']) {
      const v = cell(k);
      const d = readDate(v, order);
      if (d === null) row.notes.push(`Couldn't read the date “${v}”`);
      dates[k] = d || '';
    }
    let type = has('type') ? readType(cell('type')) : '';
    if (type === null) { row.notes.push(`Type “${cell('type')}” isn't ${withArticle(T.milestone)} or ${withArticle(T.task)}; worked out from the dates`); type = ''; }
    // Only one date: a new item is a milestone on it, an existing one keeps its type.
    let { start, end } = dates;
    if (start && end && end < start) { [start, end] = [end, start]; row.notes.push('The end date was before the start date, so they were swapped'); }
    if (!type) type = start && end ? (start < end ? 'task' : 'milestone') : t ? t.type : 'milestone';
    if (type === 'milestone') start = end = end || start || t?.end || '';
    else {
      start ||= t?.start || end;
      end ||= t?.end || start;
      if (end < start) { if (dates.end) start = end; else end = start; }
    }
    if (row.action === 'add' && !end) { row.action = 'skip'; row.notes.push('No date'); }
    if (!t || type !== t.type) f.type = type;
    if (!t || start !== t.start) f.start = start;
    if (!t || end !== t.end) f.end = end;

    const rag = cell('status');
    if (rag) {
      f.status = normaliseStatus(rag, state.workspaceId);
      if (!statuses.includes(f.status.toLowerCase())) {
        f.status = t ? t.status : DEFAULT_STATUS;
        row.notes.push(`RAG “${rag}” isn't one of this workspace's options, so ${t ? 'it stays' : 'it starts at'} ${f.status}`);
      }
    } else if (!t) f.status = DEFAULT_STATUS;
    if (!t && !f.swimlane) f.swimlane = 'General';
    const shape = cell('shape');
    if (shape) {
      f.shape = normaliseShape(shape);
      if (f.shape !== shape.toLowerCase()) row.notes.push(`Shape “${shape}” isn't known; using ${f.shape}`);
    }
    if (has('parent') && cell('parent')) row.links = { ...row.links, parent: cell('parent') };
    if (has('deps') && cell('deps')) row.links = { ...row.links, deps: readLinks(cell('deps')) };
    row.fileId = cell('id');
    if (t) for (const k of Object.keys(f)) if (f[k] === t[k]) delete f[k];
    rows.push(row);
  });

  // Link cells name a ref: this file's refs first, then the workspace's. "#12" names an item by id
  // (the download does this for items without a ref). Downloads from before links were written as
  // refs (a "parent" column) hold bare ids, trusted only from this workspace's own download.
  const live = rows.filter(r => r.action !== 'skip');
  const byFileId = new Map(live.filter(r => r.fileId).map(r => [r.fileId, r]));
  const byId = (id) => byFileId.get(id) || (ownExport && state.items.find(m => m.id === id));
  const byRef = (tok) => (refRow.get(tok)?.action !== 'skip' && refRow.get(tok)) || state.items.find(m => m.ref === tok);
  const legacyIds = ownExport && has('parent') && imp.rows[0][col.parent].toLowerCase().replace(/[^a-z]/g, '') === 'parent';
  const resolve = (tok) => (tok.startsWith('#') ? byId(tok.slice(1))
    : legacyIds ? byId(tok) || byRef(tok) : byRef(tok)) || null;
  for (const r of live) {
    if (!r.links) continue;
    if (r.links.parent) {
      r.parent = resolve(r.links.parent);
      if (!r.parent) r.notes.push(`Rolls up to “${r.links.parent}”, which isn't in the file or this workspace`);
    }
    if (r.links.deps) {
      r.deps = r.links.deps.map(tok => [tok, resolve(tok)]);
      const missing = r.deps.filter(([, x]) => !x).map(([tok]) => tok);
      if (missing.length) r.notes.push(`Depends on ${missing.join(', ')}, not found`);
      r.deps = r.deps.map(([, x]) => x).filter(Boolean);
    }
  }
  // An update that changes nothing, links included, is left alone.
  const idOf = (x) => (x.line ? x.target?.id : x.id);
  for (const r of live) {
    if (r.action !== 'update' || Object.keys(r.fields).length) continue;
    const t = r.target;
    const parentSame = !r.links?.parent || (r.parent && idOf(r.parent) === t.parent);
    const ids = (r.deps || []).map(idOf);
    const depsSame = !r.links?.deps || (ids.every(Boolean) && new Set(ids).size === t.deps.length && ids.every(id => t.deps.includes(id)));
    if (parentSame && depsSame) r.action = 'same';
  }

  const matched = new Set(rows.map(r => r.target).filter(Boolean));
  const deletes = imp.mode === 'replace' ? state.items.filter(m => !matched.has(m)) : [];
  return { rows, deletes, order };
}

// Applies the plan to the workspace. Links that would make a loop are left out (and reported).
async function applyImport() {
  const plan = planImport();
  const snap = snapshotData();
  const itemOf = new Map();
  let added = 0, updated = 0;
  for (const m of plan.deletes) removeItem(m.id);
  for (const r of plan.rows) {
    if (r.action === 'skip') continue;
    let m = r.target;
    if (!m) {
      m = {
        id: nextId(), workspace_id: state.workspaceId, type: 'milestone', ref: '', title: '', description: '', swimlane: 'General',
        subswimlane: '', owner: '', start: '', end: '', status: DEFAULT_STATUS, shape: 'diamond', parent: '', deps: [],
      };
      state.items.push(m);
      added++;
    } else if (r.action === 'update') updated++;
    Object.assign(m, r.fields);
    itemOf.set(r, m);
  }
  const target = (x) => (x && (itemOf.get(x) || (state.items.includes(x) ? x : null)));
  let dropped = 0;
  for (const r of plan.rows) {
    const m = itemOf.get(r);
    if (!m) continue;
    const parent = target(r.parent);
    if (parent && parent !== m) {
      const before = m.parent;
      m.parent = parent.id;
      if (hasCycle()) { m.parent = before; dropped++; }
    }
    if (r.links?.deps) m.deps = []; // the file's list replaces the item's
    for (const d of (r.deps || []).map(target)) {
      if (!d || d === m || m.deps.includes(d.id)) continue;
      m.deps.push(d.id);
      if (hasCycle()) { m.deps.pop(); dropped++; }
    }
  }
  document.getElementById('import-dialog').close();
  clearTableFilters(grid);
  autoRange();
  renderEditor();
  renderGantt();
  const parts = [added && `${added} added`, updated && `${updated} updated`, plan.deletes.length && `${plan.deletes.length} deleted`,
    dropped && `${count(dropped, 'link', 'links')} left out to avoid a circular dependency`].filter(Boolean);
  if (added || updated || plan.deletes.length) offerUndo(snap, `Imported: ${parts.slice(0, 3).join(', ')}`);
  await saveData(`Imported: ${parts.join(', ') || 'nothing changed'}`, 'Import');
}

/* ---- dialog ---- */
function openImportDialog() {
  syncEditorToState();
  document.getElementById('im-workspace').textContent = currentWorkspace().name;
  document.getElementById('im-paste').value = '';
  document.getElementById('im-file').value = '';
  showImportStep('source');
  document.getElementById('import-dialog').showModal();
}

function showImportStep(step) {
  document.getElementById('im-step-source').hidden = step !== 'source';
  document.getElementById('im-step-map').hidden = step !== 'map';
  document.getElementById('im-error').textContent = '';
  document.getElementById('im-submit').disabled = step !== 'map';
}

function loadImportText(text, name) {
  const rows = parseAny(text.replace(/\u0000/g, '')).map(r => r.map(v => v.trim()));
  const err = document.getElementById('im-error');
  if (rows.length < 2) return (err.textContent = rows.length ? 'Only one row found: include the column headings and at least one row.' : 'Nothing to import.');
  Object.assign(imp, { name, rows, hasHeader: true, order: 'auto', mode: 'merge' });
  imp.map = guessImportMap(rows[0]);
  document.getElementById('im-has-header').checked = true;
  document.querySelector('[name="im-mode"][value="merge"]').checked = true;
  showImportStep('map');
  renderImport();
}

async function readImportFile(file) {
  const err = document.getElementById('im-error');
  if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(file.name)) {
    return (err.textContent = `${file.name} is a workbook, which can't be read directly. Save it as CSV (in Excel: File › Save As › CSV), or copy the cells and paste them.`);
  }
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch {
    // UTF-16 (Excel "Unicode text") or Windows-1252 (Excel's plain CSV on Windows)
    const b = new Uint8Array(buf);
    text = new TextDecoder(b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'windows-1252').decode(buf);
  }
  loadImportText(text, file.name);
}

function renderImport() {
  const data = imp.hasHeader ? imp.rows.slice(1) : imp.rows;
  const width = Math.max(...imp.rows.map(r => r.length));
  const header = Array.from({ length: width }, (_, i) =>
    (imp.hasHeader && imp.rows[0][i]) || `Column ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`);
  while (imp.map.length < width) imp.map.push('');

  const dateCols = imp.map.map((k, i) => (k === 'start' || k === 'end' ? i : -1)).filter(i => i >= 0);
  imp.detected = detectDateOrder(dateCols.flatMap(i => data.map(r => r[i] ?? '')));
  const d = imp.detected, local = localDateOrder();
  const label = { dmy: 'day first (3 April 2026)', mdy: 'month first (4 March 2026)' };
  document.getElementById('im-order').innerHTML = [
    ['auto', d.found ? `Detected: ${label[d.found]}` : `Automatic: ${label[local]}`], ['dmy', `Day first: 03/04 is 3 April`], ['mdy', `Month first: 03/04 is 4 March`],
  ].map(([v, t]) => `<option value="${v}" ${v === imp.order ? 'selected' : ''}>${t}</option>`).join('');
  document.getElementById('im-source-name').textContent = `${imp.name} · ${count(data.length, 'row', 'rows')}`;

  const plan = imp.plan = planImport();
  const opts = (sel) => `<option value="">— don't import —</option>` +
    IMPORT_FIELDS.map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${escAttr(importFieldLabel(k))}</option>`).join('');
  document.getElementById('im-cols').innerHTML = header.map((h, i) => {
    const samples = [...new Set(data.map(r => (r[i] ?? '').trim()).filter(Boolean))].slice(0, 3);
    const k = imp.map[i];
    const ex = samples.map(v => {
      if (k !== 'start' && k !== 'end') return escAttr(v);
      const iso = readDate(v, plan.order);
      return iso ? `${escAttr(v)} <span class="im-date">→ ${fmtNice(iso)}</span>` : `${escAttr(v)} <span class="im-bad">→ can't read</span>`;
    }).join(' · ');
    return `<tr><td>${escAttr(h)}</td><td title="${escAttr(samples.join(' · '))}">${ex || '<span class="im-bad">empty</span>'}</td>
      <td><select data-col="${i}" class="${k ? '' : 'unmapped'}">${opts(k)}</select></td></tr>`;
  }).join('');

  // Preview
  const shown = ['ref', 'title', 'type', 'start', 'end', 'status', 'owner', 'swimlane'];
  document.getElementById('im-preview-head').innerHTML = `<tr><th>Row</th><th></th>${shown.map(k =>
    `<th>${escAttr({ ref: 'Ref', title: 'Title', type: 'Type', start: 'Start', end: 'End', status: 'RAG', owner: 'Owner', swimlane: 'Swimlane' }[k])}</th>`).join('')}<th>Links</th><th>Notes</th></tr>`;
  const actLabel = { add: 'Add', update: 'Update', same: 'No change', skip: 'Skip', delete: 'Delete' };
  const cellFor = (r, k) => {
    const v = k in r.fields ? r.fields[k] : r.target ? r.target[k] : '';
    const text = k === 'type' ? (v === 'task' ? T.Task : v ? T.Milestone : '') : k === 'start' || k === 'end' ? (v ? fmtNice(v) : '') : v;
    return `<td class="${k === 'title' ? 'im-title' : ''} ${r.target && k in r.fields ? 'changed' : ''}">${escAttr(text)}</td>`;
  };
  // A link points at a row of the file or at an item already in the workspace.
  const linkName = (x) => (x.line ? x.fields.ref || x.target?.ref || `row ${x.line}` : itemLabel(x));
  const links = (r) => [r.parent && `rolls up to ${linkName(r.parent)}`,
    r.deps?.length && `after ${r.deps.map(linkName).join(', ')}`].filter(Boolean).join(' · ');
  document.getElementById('im-preview').innerHTML = plan.rows.map(r => `<tr class="${r.action}"><td>${r.line}</td>
      <td><span class="im-act ${r.action === 'same' ? 'skip' : r.action}">${actLabel[r.action]}</span></td>
      ${shown.map(k => cellFor(r, k)).join('')}<td>${escAttr(links(r))}</td><td class="im-notes">${escAttr(r.notes.join('. '))}</td></tr>`).join('')
    + plan.deletes.map(m => `<tr class="delete"><td></td><td><span class="im-act delete">Delete</span></td>${shown.map(k =>
      `<td>${escAttr(k === 'type' ? typeName(m) : k === 'start' || k === 'end' ? fmtNice(m[k]) : m[k])}</td>`).join('')}<td></td>
      <td class="im-notes">Not in the file${reportsFor(m.id).length ? `; its ${count(reportsFor(m.id).length, 'report is', 'reports are')} kept` : ''}</td></tr>`).join('');

  const n = (a) => plan.rows.filter(r => r.action === a).length;
  const warned = plan.rows.filter(r => r.action !== 'skip' && r.notes.length).length;
  const summary = [n('add') && `${n('add')} to add`, n('update') && `${n('update')} to update`, n('same') && `${n('same')} unchanged`,
    plan.deletes.length && `${plan.deletes.length} to delete`, n('skip') && `${n('skip')} skipped`, warned && `${count(warned, 'row has', 'rows have')} notes`].filter(Boolean);
  document.getElementById('im-summary').textContent = summary.join(' · ');
  const btn = document.getElementById('im-submit');
  const does = [n('add') && `add ${n('add')}`, n('update') && `update ${n('update')}`, plan.deletes.length && `delete ${plan.deletes.length}`].filter(Boolean);
  btn.disabled = !does.length;
  btn.textContent = does.length ? `Import: ${does.join(', ')}` : 'Import';
  document.getElementById('im-error').textContent = d.conflict
    ? 'Some dates are written day first and others month first: check the dates in the preview.'
    : !imp.map.includes('title') ? `No column is imported as the title, so only existing ${T.items} (matched by ref) can be updated.` : '';
}

function wireImport() {
  const dlg = document.getElementById('import-dialog');
  const close = () => dlg.close();
  document.getElementById('btn-items-import').onclick = openImportDialog;
  document.getElementById('im-close').onclick = close;
  document.getElementById('im-cancel').onclick = close;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.getElementById('im-change').onclick = () => { document.getElementById('im-file').value = ''; showImportStep('source'); };
  document.getElementById('im-file').addEventListener('change', (e) => { if (e.target.files[0]) readImportFile(e.target.files[0]); });
  const drop = document.getElementById('im-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readImportFile(e.dataTransfer.files[0]);
  });
  document.getElementById('im-paste').addEventListener('paste', () => {
    setTimeout(() => { const t = document.getElementById('im-paste').value; if (t.trim()) loadImportText(t, 'Pasted rows'); }, 0);
  });
  document.getElementById('im-has-header').onchange = (e) => {
    imp.hasHeader = e.target.checked;
    imp.map = imp.hasHeader ? guessImportMap(imp.rows[0]) : imp.map.map(() => '');
    renderImport();
  };
  document.getElementById('im-order').onchange = (e) => { imp.order = e.target.value; renderImport(); };
  document.getElementById('im-mode').addEventListener('change', (e) => { imp.mode = e.target.value; renderImport(); });
  document.getElementById('im-cols').addEventListener('change', (e) => {
    const i = +e.target.dataset.col, k = e.target.value;
    if (k) imp.map = imp.map.map(x => (x === k ? '' : x)); // one column per field
    imp.map[i] = k;
    renderImport();
  });
  document.getElementById('import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyImport();
  });
}

/* ================= workspaces ================= */
// A workspace groups a set of items and their reports. The Workspaces screen lists them all
// with a summary of each; the one being viewed drives the Gantt chart, Items and Reports.

const WORKSPACE_COLUMNS = ['id', 'number', 'name', 'code', 'description', 'owner', 'lead', 'start', 'end', 'status', 'trend',
  'item_term', 'milestone_term', 'task_term', 'created', 'updated'];
const WORKSPACE_FIELDS = WORKSPACE_COLUMNS.slice(1, -2);

function rowsToWorkspaces(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const workspaces = rows.slice(1).map(r => {
    const o = {};
    for (const k of WORKSPACE_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    if (!o.name) o.name = 'Untitled workspace';
    return o;
  });
  const seen = new Set();
  let last = Math.max(0, ...workspaces.map(p => (/^\d+$/.test(p.id) ? +p.id : 0)));
  for (const p of workspaces) {
    if (!/^\d+$/.test(p.id) || seen.has(p.id)) p.id = String(++last);
    seen.add(p.id);
  }
  state.lastWorkspaceId = last;
  return workspaces;
}

function workspacesToCSV(workspaces) {
  return [WORKSPACE_COLUMNS.map(csvName).join(','), ...workspaces.map(p => WORKSPACE_COLUMNS.map(k => csvEscape(p[k])).join(','))].join('\n') + '\n';
}

function newWorkspace(values = {}) {
  state.lastWorkspaceId = Math.max(state.lastWorkspaceId, ...state.workspaces.map(p => +p.id || 0)) + 1;
  const now = new Date().toISOString();
  const p = { id: String(state.lastWorkspaceId), created: now, updated: now, status: 'Not Started', ...DEFAULT_TERMS };
  for (const k of WORKSPACE_FIELDS) p[k] ??= '';
  return Object.assign(p, values);
}

// Which workspace and view were open, and whether the sidebar is collapsed — per browser.
const APP_PREFS = 'milestone-tracker.app';
function loadAppPrefs() {
  try { return JSON.parse(localStorage.getItem(APP_PREFS) || '{}'); } catch { return {}; }
}
function saveAppPrefs(changes) {
  try { localStorage.setItem(APP_PREFS, JSON.stringify({ ...loadAppPrefs(), ...changes })); } catch { /* ignore */ }
}

async function switchWorkspace(id, view) {
  if (id !== state.workspaceId) {
    if (!leavePaneEdit()) return (document.getElementById('workspace-select').value = state.workspaceId);
    hideQuick();
    syncEditorToState(); // table edits belong to the workspace being left
    document.getElementById('editor-body').innerHTML = '';
    await flushSave();
    selectWorkspace(id);
    clearTableFilters(grid);
    clearReportFilters();
    clearGanttFilters();
    state.userZoomed = false;
    applyWorkspaceChrome();
  }
  switchView(view || (APP_VIEWS.includes(currentView()) ? 'gantt' : currentView()));
}

// Sidebar, headings and every label that uses the workspace's own terms.
function applyWorkspaceChrome() {
  const p = currentWorkspace();
  document.querySelectorAll('[data-term]').forEach(el => { el.textContent = T[el.dataset.term]; });
  document.getElementById('nav-editor').title = T.Items;
  document.getElementById('workspace-select').innerHTML = state.workspaces
    .map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${escAttr(x.name)}</option>`).join('');
  document.getElementById('workspace-dot').style.background = pal(p.status).base;
  document.getElementById('workspace-dot').title = `Workspace RAG: ${p.status}`;
  renderTableHead(grid);
  renderTableHead(rptTable);
  renderReportRagChoices();
  renderRagLegend();
  updatePageHead();
  updateDueBadge();
}

// The Gantt key lists the workspace's own RAG options.
function renderRagLegend() {
  const list = statusesFor(state.workspaceId);
  document.getElementById('legend-rag').innerHTML = list.map(s => `
    <span class="legend-item"><i class="dot" style="background:${paletteOf(s.color).base}"></i> ${escAttr(s.name)}${s.description ? ` — ${escAttr(s.description)}` : ''}</span>`).join('');
}

const VIEW_TITLES = { overview: () => 'Program overview', lanes: () => 'Swimlane overview', workspaces: () => 'Workspaces', gantt: () => 'Gantt chart', editor: () => T.Items, reports: () => 'Reports', changes: () => 'What changed', dates: () => 'Date history' };
function updatePageHead() {
  const view = currentView();
  const p = currentWorkspace();
  const inWorkspace = !APP_VIEWS.includes(view);
  document.getElementById('page-title').textContent = VIEW_TITLES[view]();
  const crumb = document.getElementById('page-workspace');
  crumb.hidden = !inWorkspace;
  crumb.innerHTML = inWorkspace ? `${p.code ? `<b>${escAttr(p.code)}</b> ` : ''}${escAttr(p.name)}` : '';
  const suffix = APP_CONFIG.title ? ` — ${APP_CONFIG.title}` : '';
  document.title = inWorkspace ? `${VIEW_TITLES[view]()} · ${p.name}${suffix}` : `${VIEW_TITLES[view]()}${suffix}`;
}

function workspaceStats(p) {
  const items = allItems().filter(m => m.workspace_id === p.id);
  const reports = allReports().filter(r => r.workspace_id === p.id);
  const rag = {};
  for (const m of items) rag[m.status] = (rag[m.status] || 0) + 1;
  const dates = items.flatMap(m => [m.start, m.end]).filter(Boolean).sort();
  return {
    items, reports, rag,
    tasks: items.filter(isTask).length,
    first: dates[0], last: dates.at(-1),
    lastReport: reports.map(r => r.period_end).sort().at(-1),
  };
}

// A workspace's milestones by where they stand. Done statuses are Closed, those needing a get to
// green plan (Amber and Red as standard) are Red/Amber, the default status is Not started, and
// the rest (Green, or any other on-track status) count as Green, so the five add up to the total.
const MS_BUCKETS = [['notStarted', 'Not started'], ['green', 'Green'], ['redAmber', 'Red/Amber'], ['closed', 'Closed'], ['total', 'Total']];
function msBucket(status, workspaceId, rg = ragOf(workspaceId)) {
  if (isDoneStatus(status, workspaceId)) return 'closed';
  if (rg.offTrack.includes(status)) return 'redAmber';
  if (status === rg.def || /^not\s*started$/i.test(status)) return 'notStarted';
  return 'green';
}
function milestoneOverview(workspaceId, lane = null) { // lane: only that swimlane's milestones
  const rg = ragOf(workspaceId);
  const out = { notStarted: 0, green: 0, redAmber: 0, closed: 0, total: 0 };
  for (const m of allItems()) {
    if (m.workspace_id !== workspaceId || isTask(m) || (lane != null && m.swimlane !== lane)) continue;
    out.total++;
    out[msBucket(m.status, workspaceId, rg)]++;
  }
  return out;
}

// A count is a way in: it opens the Gantt chart showing just those milestones.
async function openBucket(workspaceId, bucket, lane = '') {
  await switchWorkspace(workspaceId, 'gantt');
  clearGanttFilters();
  ganttFilter.type = 'milestone';
  ganttFilter.lane = lane;
  if (bucket !== 'total') ganttFilter.rag = STATUSES.filter(st => msBucket(st, workspaceId) === bucket);
  renderGantt();
}

function milestoneStrip(workspaceId) {
  const ov = milestoneOverview(workspaceId);
  return `<div class="ms-strip">${MS_BUCKETS.map(([k, label]) => ov[k]
    ? `<button type="button" class="ms-${k}" data-bucket="${k}" title="Show these on the Gantt chart"><b>${ov[k]}</b><span>${label}</span></button>`
    : `<div class="ms-${k}"><b>${ov[k]}</b><span>${label}</span></div>`).join('')}</div>`;
}

// Trend is set by hand (or from the weekly update) and shown as just an arrow; its name is the tooltip.
const TRENDS = [
  { name: 'Improving', icon: '↑', cls: 'up' },
  { name: 'Stable', icon: '→', cls: 'flat' },
  { name: 'Declining', icon: '↓', cls: 'down' },
];
const trendArrow = (t) => `<span class="trend trend-${t.cls}" title="${t.name}" aria-label="${t.name}">${t.icon}</span>`;
function trendBadge(v) {
  const t = TRENDS.find(x => x.name.toLowerCase() === (v || '').toLowerCase());
  if (!t) return v ? escAttr(v) : '<span class="muted">—</span>';
  return trendArrow(t);
}
const programLabel = (p) => (p.number ? `${p.number} · ${p.name}` : p.name);

function renderWorkspaces() {
  const cards = state.workspaces.map(p => {
    const st = workspaceStats(p);
    const t = makeTerms(p);
    const rg = ragOf(p.id);
    const shown = [...rg.names, ...Object.keys(st.rag).filter(k => !rg.names.includes(k))]; // unlisted statuses last
    const n = st.items.length;
    const current = p.id === state.workspaceId;
    const start = p.start || st.first, end = p.end || st.last;
    const span = start && end ? `${fmtShort(start)} – ${fmtNice(end)}` : start ? `From ${fmtNice(start)}` : '—';
    const spanNote = !(p.start || p.end) && st.first ? ` <span class="muted">(from ${escAttr(t.items)})</span>` : '';
    const bar = n
      ? shown.filter(s => st.rag[s]).map(s => `<i style="flex:${st.rag[s]};background:${pal(s, rg.map).base}" title="${escAttr(s)}: ${st.rag[s]}"></i>`).join('')
      : '<i class="empty"></i>';
    const ragList = shown.filter(s => st.rag[s]).map(s => `<span><i class="dot" style="background:${pal(s, rg.map).base}"></i>${st.rag[s]} ${escAttr(s)}</span>`).join('');
    const meta = [['Owner', p.owner], ['Area lead', p.lead]].filter(([, v]) => v)
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escAttr(v)}</dd></div>`).join('')
      + (p.trend ? `<div><dt>Trend</dt><dd>${trendBadge(p.trend)}</dd></div>` : '');
    return `
      <article class="prog-card${current ? ' current' : ''}" data-pid="${p.id}" style="--rag:${pal(p.status, rg.map).base}">
        <div class="prog-top">
          ${statusPill(p.status, rg.map)}
          ${p.code ? `<span class="prog-code">${escAttr(p.code)}</span>` : ''}
          ${p.number ? `<span class="prog-num" title="Program number">Program ${escAttr(p.number)}</span>` : ''}
          ${current ? '<span class="prog-current">Open</span>' : ''}
          <button type="button" class="btn btn-sm prog-edit" data-edit-workspace="${p.id}" title="Edit workspace settings">Edit</button>
        </div>
        <h3>${escAttr(p.name)}</h3>
        ${p.description ? `<p class="prog-desc">${escAttr(p.description)}</p>` : ''}
        <dl class="prog-meta">
          ${meta}
          <div><dt>Timeline</dt><dd>${span}${spanNote}</dd></div>
          <div><dt>Last report</dt><dd>${st.lastReport ? `period ending ${fmtNice(st.lastReport)}` : 'none yet'}</dd></div>
        </dl>
        <div class="prog-rag">
          <div class="prog-ragbar">${bar}</div>
          <div class="prog-raglist">${ragList || `<span class="muted">No ${escAttr(t.items)} yet</span>`}</div>
        </div>
        <div class="prog-ms"><span class="prog-ms-label">${escAttr(t.Milestone)} overview</span>${milestoneStrip(p.id)}</div>
        <footer class="prog-foot">
          <span class="prog-counts">${count(n, t.item, t.items)} · ${count(n - st.tasks, t.milestone, t.milestones)} · ${count(st.tasks, t.task, t.tasks)} · ${count(st.reports.length, 'report', 'reports')}</span>
          <button type="button" class="btn ${current ? '' : 'btn-primary'}" data-open-workspace="${p.id}">${current ? 'Continue' : 'Open'} →</button>
        </footer>
      </article>`;
  }).join('');
  document.getElementById('workspace-cards').innerHTML = cards + `
    <button type="button" class="prog-card prog-new" data-new-workspace>
      <span class="prog-new-plus">+</span><span>New workspace</span>
    </button>`;
  const total = state.workspaces.length;
  const offTrack = state.workspaces.filter(p => ragOf(p.id).offTrack.includes(p.status)).length;
  document.getElementById('workspace-count').textContent =
    `${count(total, 'workspace', 'workspaces')}${offTrack ? ` · ${offTrack} at risk or off track` : ''}`;
}

/* ---- workspace dialog ---- */

let pgEditing = null; // workspace being edited; null for a new one

function openWorkspaceDialog(p) {
  hideQuick();
  pgEditing = p;
  const f = document.getElementById('workspace-form').elements;
  const v = p || { ...newWorkspaceDefaults() };
  // Default terms show as placeholders, so a new word can be typed straight in.
  for (const k of WORKSPACE_FIELDS) if (k !== 'status') f[k].value = (v[k] === DEFAULT_TERMS[k] ? '' : v[k]) ?? '';
  loadPgStatuses(p);
  showPgTab('details');
  document.getElementById('pg-heading').textContent = p ? `Edit ${p.name}` : 'New workspace';
  document.getElementById('pg-submit').textContent = p ? 'Save' : 'Create workspace';
  const del = document.getElementById('pg-delete');
  del.hidden = !p;
  del.disabled = state.workspaces.length < 2;
  del.title = del.disabled ? 'You need at least one workspace' : '';
  document.getElementById('pg-error').textContent = '';
  refreshDatalists();
  updateTermPreview();
  document.getElementById('workspace-dialog').showModal();
  f.name.focus();
}

/* ---- RAG options tab ---- */
// pgStatuses is the list being edited: { orig (name when the dialog opened, null if new), name,
// color, description, get_to_green, is_default, used (items + reports at it), deleted, replace }.
// A status that's in use can only be deleted by choosing another to move its items and reports to.

let pgStatuses = [];

function statusUsage(workspaceId) {
  const used = {};
  for (const x of [...allItems(), ...allReports()]) if (x.workspace_id === workspaceId) used[x.status] = (used[x.status] || 0) + 1;
  return used;
}

function loadPgStatuses(p) {
  const used = p ? statusUsage(p.id) : {};
  pgStatuses = statusesFor(p?.id).map(st => ({
    orig: p ? st.name : null, name: st.name, color: st.color, description: st.description,
    get_to_green: st.get_to_green, is_default: st.is_default, used: used[st.name] || 0, deleted: false, replace: null,
  }));
  // A status the workspace is using but isn't in its list: offer to keep it by adding it.
  pgStatusesSelected = pgStatuses.find(r => r.name === (p?.status ?? DEFAULT_STATUSES.find(d => d.is_default).name)) || null;
  pgStrayStatus = p && !pgStatusesSelected ? p.status : '';
  renderPgStatuses();
}
let pgStatusesSelected = null; // the row chosen as the workspace's own RAG
let pgStrayStatus = '';        // workspace RAG that isn't in the list

const activePgStatuses = () => pgStatuses.filter(r => !r.deleted);

function renderPgStatuses() {
  const active = activePgStatuses();
  const usedText = (n) => (n ? `<small class="pg-used">used ${n} time${n > 1 ? 's' : ''}</small>` : '');
  document.getElementById('pg-statuses').innerHTML = pgStatuses.map((r, i) => r.deleted ? `
    <tr class="pg-deleted" data-idx="${i}">
      <td></td>
      <td><i class="pg-swatch" style="background:${r.color}"></i></td>
      <td colspan="4"><s>${escAttr(r.orig)}</s> is used ${r.used} time${r.used > 1 ? 's' : ''} — move those items and reports to
        <select data-replace="${i}">${active.map(a => `<option value="${pgStatuses.indexOf(a)}" ${a === r.replace ? 'selected' : ''}>${escAttr(a.name || '(unnamed)')}</option>`).join('')}</select></td>
      <td><button type="button" class="link-btn" data-undo="${i}">Undo</button></td>
    </tr>` : `
    <tr data-idx="${i}">
      <td class="pg-move">
        <button type="button" data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-move="1" title="Move down" ${i === pgStatuses.length - 1 ? 'disabled' : ''}>↓</button>
      </td>
      <td><input type="color" data-f="color" value="${r.color}" title="Colour" /></td>
      <td><input data-f="name" value="${escAttr(r.name)}" placeholder="e.g. Green" />${usedText(r.used)}</td>
      <td><input data-f="description" value="${escAttr(r.description)}" placeholder="e.g. on track" /></td>
      <td class="c"><input type="checkbox" data-f="get_to_green" ${r.get_to_green ? 'checked' : ''} /></td>
      <td class="c"><input type="radio" name="pg-default" data-f="is_default" ${r.is_default ? 'checked' : ''} /></td>
      <td><button type="button" class="btn-del" data-remove="${i}" title="Remove this status" ${active.length < 2 ? 'disabled' : ''}>✕</button></td>
    </tr>`).join('');
  updatePgStatusPreview();
}

// Key preview, plus the workspace's own RAG choice, which uses the list being edited.
function updatePgStatusPreview() {
  const active = activePgStatuses();
  document.getElementById('pg-rag-preview').innerHTML = active.map(r => `
    <span class="legend-item"><i class="dot" style="background:${r.color}"></i> ${escAttr(r.name || '(unnamed)')}${r.description ? ` — ${escAttr(r.description)}` : ''}</span>`).join('');
  const sel = document.getElementById('workspace-form').elements.status;
  if (pgStatusesSelected?.deleted) pgStatusesSelected = pgStatusesSelected.replace;
  if (pgStatusesSelected && !active.includes(pgStatusesSelected)) pgStatusesSelected = active.at(-1);
  if (!pgStatusesSelected && !pgStrayStatus) pgStatusesSelected = active[0];
  sel.innerHTML = active.map(r => `<option value="${pgStatuses.indexOf(r)}" ${r === pgStatusesSelected ? 'selected' : ''}>${escAttr(r.name || '(unnamed)')}</option>`).join('')
    + (pgStrayStatus ? `<option value="stray" ${pgStatusesSelected ? '' : 'selected'}>${escAttr(pgStrayStatus)} (not in the list)</option>` : '');
  document.querySelectorAll('#pg-statuses [data-replace]').forEach(el => {
    const r = pgStatuses[+el.dataset.replace];
    el.innerHTML = active.map(a => `<option value="${pgStatuses.indexOf(a)}" ${a === r.replace ? 'selected' : ''}>${escAttr(a.name || '(unnamed)')}</option>`).join('');
  });
}

function onPgStatusesInput(e) {
  const t = e.target;
  if (t.dataset.replace != null) { pgStatuses[+t.dataset.replace].replace = pgStatuses[+t.value]; return; }
  const row = t.closest('[data-idx]');
  const f = t.dataset.f;
  if (!row || !f) return;
  const r = pgStatuses[+row.dataset.idx];
  if (f === 'is_default') pgStatuses.forEach(x => { x.is_default = x === r; });
  else r[f] = t.type === 'checkbox' ? t.checked : t.value;
  updatePgStatusPreview();
}

function onPgStatusesClick(e) {
  const move = e.target.closest('[data-move]');
  if (move) {
    const i = +move.closest('[data-idx]').dataset.idx, j = i + +move.dataset.move;
    [pgStatuses[i], pgStatuses[j]] = [pgStatuses[j], pgStatuses[i]];
    return renderPgStatuses();
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const r = pgStatuses[+rm.dataset.remove];
    if (r.used) {
      r.deleted = true;
      r.replace = activePgStatuses()[0];
    } else pgStatuses = pgStatuses.filter(x => x !== r);
    if (r.is_default && activePgStatuses().length) activePgStatuses().at(-1).is_default = true;
    r.is_default = false;
    return renderPgStatuses();
  }
  const undo = e.target.closest('[data-undo]');
  if (undo) {
    const r = pgStatuses[+undo.dataset.undo];
    r.deleted = false;
    for (const x of pgStatuses) if (x.replace === r && x.deleted) x.replace = activePgStatuses().find(a => a !== x) || r;
    return renderPgStatuses();
  }
}

function addPgStatus() {
  const used = new Set(pgStatuses.map(r => r.color));
  const color = ['#7c3aed', '#0d9488', '#db2777', '#65a30d', '#0891b2', '#ea580c'].find(c => !used.has(c)) || '#7a7870';
  pgStatuses.push({ orig: null, name: '', color, description: '', get_to_green: false, is_default: false, used: 0, deleted: false, replace: null });
  renderPgStatuses();
  document.querySelector(`#pg-statuses [data-idx="${pgStatuses.length - 1}"] [data-f="name"]`)?.focus();
}

// Back to the standard five, keeping any that match by name; others in use need somewhere to go.
function resetPgStatuses() {
  const byName = new Map(pgStatuses.filter(r => r.orig != null).map(r => [r.orig.toLowerCase(), r]));
  const fresh = DEFAULT_STATUSES.map(d => {
    const old = byName.get(d.name.toLowerCase());
    byName.delete(d.name.toLowerCase());
    return { ...d, orig: old?.orig ?? null, used: old?.used || 0, deleted: false, replace: null };
  });
  const gone = [...byName.values()].filter(r => r.used).map(r => ({ ...r, deleted: true, is_default: false, replace: fresh.at(-1) }));
  if (pgStatusesSelected) pgStatusesSelected = fresh.find(f => f.orig === pgStatusesSelected.orig) || fresh.at(-1);
  pgStatuses = [...fresh, ...gone];
  renderPgStatuses();
}

function showPgTab(tab) {
  document.querySelectorAll('[data-pg-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.pgTab === tab));
  document.getElementById('pg-panel-details').hidden = tab !== 'details';
  document.getElementById('pg-panel-rag').hidden = tab !== 'rag';
  document.getElementById('workspace-dialog').classList.toggle('wide', tab === 'rag');
}

// Check the edited list; returns an error message or null.
function checkPgStatuses() {
  const active = activePgStatuses();
  for (const r of active) r.name = r.name.trim();
  if (!active.length) return 'Keep at least one RAG status.';
  if (active.some(r => !r.name)) return 'Every RAG status needs a name.';
  const seen = new Set();
  for (const r of active) {
    if (seen.has(r.name.toLowerCase())) return `There are two RAG statuses called “${r.name}”.`;
    seen.add(r.name.toLowerCase());
  }
  if (!active.some(r => r.is_default)) active.at(-1).is_default = true;
  return null;
}

// Save the edited list for a workspace and rename/move its items and reports to match.
// Returns which files changed.
function applyPgStatuses(workspaceId) {
  const active = activePgStatuses();
  const rename = new Map();
  for (const r of pgStatuses) if (r.orig != null) rename.set(r.orig, r.deleted ? r.replace.name : r.name);
  let records = false;
  if (isShown('editor')) syncEditorToState(); // don't let the grid write back old names
  for (const list of [state.items, state.otherItems, state.reports, state.otherReports]) {
    for (const x of list) {
      if (x.workspace_id === workspaceId && rename.has(x.status) && rename.get(x.status) !== x.status) {
        x.status = rename.get(x.status);
        records = true;
      }
    }
  }
  const next = active.map((r, i) => ({
    workspace_id: workspaceId, position: i + 1, name: r.name, color: r.color, description: r.description.trim(),
    get_to_green: !!r.get_to_green, is_default: !!r.is_default,
  }));
  const key = (l) => JSON.stringify(l.map(s => [s.name, s.color, s.description, !!s.get_to_green, !!s.is_default]));
  const listChanged = key(next) !== key(statusesFor(workspaceId));
  if (listChanged) {
    state.statuses = state.statuses.filter(s => s.workspace_id !== workspaceId);
    if (key(next) !== key(DEFAULT_STATUSES)) state.statuses.push(...next); // the standard list needs no rows
  }
  return { records, listChanged };
}

function newWorkspaceDefaults() {
  return { number: '', name: '', code: '', description: '', owner: '', lead: '', start: '', end: '', status: 'Not Started', trend: '', ...DEFAULT_TERMS };
}

function updateTermPreview() {
  const f = document.getElementById('workspace-form').elements;
  const t = makeTerms({ item_term: f.item_term.value, milestone_term: f.milestone_term.value, task_term: f.task_term.value });
  document.getElementById('pg-term-preview').innerHTML =
    `The app will say <b>+ Add ${escAttr(t.item)}</b>, <b>${escAttr(t.Items)}</b> in the menu, and “12 ${escAttr(t.items)} · 4 ${escAttr(t.milestones)} · 8 ${escAttr(t.tasks)}”.`;
}

async function submitWorkspaceDialog(e) {
  e.preventDefault();
  const f = document.getElementById('workspace-form').elements;
  const err = document.getElementById('pg-error');
  const v = {};
  for (const k of WORKSPACE_FIELDS) v[k] = f[k].value.trim();
  if (!v.name) return (err.textContent = 'Give the workspace a name.');
  const clash = state.workspaces.find(p => p !== pgEditing && p.name.toLowerCase() === v.name.toLowerCase());
  if (clash) return (err.textContent = `There’s already a workspace called “${clash.name}”.`);
  const numClash = v.number && state.workspaces.find(p => p !== pgEditing && p.number.toLowerCase() === v.number.toLowerCase());
  if (numClash) return (err.textContent = `Program number ${v.number} is already used by “${numClash.name}”.`);
  if (v.start && v.end && v.end < v.start) return (err.textContent = 'The end date is before the start date.');
  for (const k of Object.keys(DEFAULT_TERMS)) v[k] ||= DEFAULT_TERMS[k];
  const ragErr = checkPgStatuses();
  if (ragErr) { showPgTab('rag'); return (err.textContent = ragErr); }
  v.status = f.status.value === 'stray' ? pgStrayStatus : pgStatusesSelected?.name ?? activePgStatuses()[0].name;

  document.getElementById('workspace-dialog').close();
  const p = pgEditing || newWorkspace();
  if (!pgEditing) state.workspaces.push(p);
  const res = applyPgStatuses(p.id);
  Object.assign(p, v, { updated: new Date().toISOString() });
  const saves = [saveWorkspaces(pgEditing ? 'Workspace saved' : 'Workspace created')];
  if (res.listChanged) saves.push(saveStatuses());
  if (res.records) saves.push(saveData('', 'Workspace settings'), saveReports());
  if (!pgEditing) {
    await Promise.all(saves);
    return switchWorkspace(p.id, 'editor'); // an empty workspace starts on its items
  }
  if (p.id === state.workspaceId) {
    T = makeTerms(p);
    useStatuses(p.id);
  }
  applyWorkspaceChrome();
  rerenderCurrentView();
  if (isShown('editor')) renderEditor(); // new terms / RAG options in the grid
  await Promise.all(saves);
}

async function deleteWorkspace() {
  const p = pgEditing;
  if (!p || state.workspaces.length < 2) return;
  const st = workspaceStats(p);
  const t = makeTerms(p);
  const lost = [st.items.length && count(st.items.length, t.item, t.items), st.reports.length && count(st.reports.length, 'report', 'reports')].filter(Boolean);
  const snap = snapshotData();
  document.getElementById('workspace-dialog').close();
  const leaving = p.id === state.workspaceId;
  if (leaving) await switchWorkspace(state.workspaces.find(x => x !== p).id, APP_VIEWS.includes(currentView()) ? currentView() : 'workspaces');
  state.workspaces = state.workspaces.filter(x => x !== p);
  state.otherItems = state.otherItems.filter(m => m.workspace_id !== p.id);
  state.otherReports = state.otherReports.filter(r => r.workspace_id !== p.id);
  const hadStatuses = state.statuses.some(s => s.workspace_id === p.id);
  state.statuses = state.statuses.filter(s => s.workspace_id !== p.id);
  const hadUpdates = state.updates.some(u => u.workspace_id === p.id);
  state.updates = state.updates.filter(u => u.workspace_id !== p.id);
  const hadLanes = state.lanes.some(l => l.workspace_id === p.id);
  state.lanes = state.lanes.filter(l => l.workspace_id !== p.id);
  applyWorkspaceChrome();
  rerenderCurrentView();
  offerUndo(snap, `Deleted the workspace ${p.name}${lost.length ? ` and its ${lost.join(' and ')}` : ''}`);
  await Promise.all([saveData(`Workspace deleted: ${p.name}`, 'Workspace deleted'), saveReports(), saveWorkspaces('Workspace deleted'), hadStatuses && saveStatuses(), hadUpdates && saveUpdates(), hadLanes && saveLanes()]);
}

function wireWorkspaces() {
  document.getElementById('workspace-select').onchange = (e) => switchWorkspace(e.target.value);
  document.getElementById('btn-new-workspace').onclick = () => openWorkspaceDialog(null);
  document.getElementById('nav-settings').onclick = () => openWorkspaceDialog(currentWorkspace());
  document.getElementById('workspace-cards').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-workspace]');
    if (edit) return openWorkspaceDialog(workspaceById(edit.dataset.editWorkspace));
    if (e.target.closest('[data-new-workspace]')) return openWorkspaceDialog(null);
    const card = e.target.closest('[data-pid]');
    const bucket = e.target.closest('[data-bucket]');
    if (card && bucket) return openBucket(card.dataset.pid, bucket.dataset.bucket);
    if (card) switchWorkspace(card.dataset.pid, 'gantt');
  });

  const dlg = document.getElementById('workspace-dialog');
  const form = document.getElementById('workspace-form');
  form.addEventListener('submit', submitWorkspaceDialog);
  form.addEventListener('input', (e) => { if (/_term$/.test(e.target.name)) updateTermPreview(); });
  form.elements.status.addEventListener('change', (e) => { pgStatusesSelected = e.target.value === 'stray' ? null : pgStatuses[+e.target.value]; });
  document.querySelector('.pg-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-pg-tab]'); if (b) showPgTab(b.dataset.pgTab); });
  const rag = document.getElementById('pg-statuses');
  rag.addEventListener('input', onPgStatusesInput);
  rag.addEventListener('change', onPgStatusesInput);
  rag.addEventListener('click', onPgStatusesClick);
  document.getElementById('pg-add-status').onclick = addPgStatus;
  document.getElementById('pg-reset-statuses').onclick = resetPgStatuses;
  document.getElementById('pg-cancel').onclick = () => dlg.close();
  document.getElementById('pg-close').onclick = () => dlg.close();
  document.getElementById('pg-delete').onclick = deleteWorkspace;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
}

/* ================= program and swimlane overviews ================= */
// Management tables: one row per workspace (program) across the app, or per swimlane within a
// workspace. Each row has an area lead, the RAG of its last two weekly updates, trend, the latest
// update's summary and a count of its milestones by status. Weekly updates live in updates.csv,
// one per program or swimlane per week (swimlane blank for the program); the newest is "current".
// A program's area lead and trend are workspace fields; a swimlane's are kept in swimlanes.csv.

const UPDATE_COLUMNS = ['id', 'workspace_id', 'swimlane', 'week_ending', 'status', 'summary', 'author', 'created', 'updated'];
const LANE_COLUMNS = ['workspace_id', 'name', 'lead', 'trend'];

function rowsToUpdates(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  const out = rows.slice(1).map(r => {
    const o = {};
    for (const k of UPDATE_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    return o;
  }).filter(u => ids.has(u.workspace_id) && parseDate(u.week_ending));
  let last = Math.max(0, ...out.map(u => (/^\d+$/.test(u.id) ? +u.id : 0)));
  const seen = new Set();
  for (const u of out) {
    if (!/^\d+$/.test(u.id) || seen.has(u.id)) u.id = String(++last);
    seen.add(u.id);
    u.status = normaliseStatus(u.status, u.workspace_id);
  }
  return out;
}
function updatesToCSV(updates) {
  return [UPDATE_COLUMNS.map(csvName).join(','), ...updates.map(u => UPDATE_COLUMNS.map(k => csvEscape(u[k])).join(','))].join('\n') + '\n';
}
const nextUpdateId = () => String(Math.max(0, ...state.updates.map(u => +u.id || 0)) + 1);

function rowsToLanes(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  return rows.slice(1).map(r => {
    const o = {};
    for (const k of LANE_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    return o;
  }).filter(l => ids.has(l.workspace_id) && l.name);
}
function lanesToCSV(lanes) {
  return [LANE_COLUMNS.join(','), ...lanes.map(l => LANE_COLUMNS.map(k => csvEscape(l[k])).join(','))].join('\n') + '\n';
}
// A swimlane's details; a blank one (not yet stored) when it has none.
const laneRecord = (workspaceId, name) => state.lanes.find(l => l.workspace_id === workspaceId && l.name === name)
  || { workspace_id: workspaceId, name, lead: '', trend: '' };

// What a row is about: a program, or one swimlane of it. `rec` holds its area lead and trend.
const programSubject = (p) => ({ p, lane: '', rec: p, label: programLabel(p) });
const laneSubject = (p, name) => ({ p, lane: name, rec: laneRecord(p.id, name), label: `${p.code || p.name} · ${name}` });

// Weekly updates for a program (lane '') or one of its swimlanes, newest first.
const updatesFor = (workspaceId, lane = '') => state.updates.filter(u => u.workspace_id === workspaceId && (u.swimlane || '') === lane)
  .sort((a, b) => b.week_ending.localeCompare(a.week_ending) || b.updated.localeCompare(a.updated));

// Programs in number order (numbers compared naturally), unnumbered ones last by name.
function programsInOrder() {
  return [...state.workspaces].sort((a, b) => (!a.number) - (!b.number)
    || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}
// The current workspace's swimlanes in the order the Gantt chart lists them (its Sort setting).
function lanesInOrder() {
  const lanes = [], byName = new Map();
  for (const m of state.items) {
    let lane = byName.get(m.swimlane);
    if (!lane) byName.set(m.swimlane, lane = { name: m.swimlane, items: [], subs: [] }), lanes.push(lane);
    lane.items.push({ ...m, _s: parseDate(m.start), _e: parseDate(isTask(m) && m.end ? addDays(m.end, 1) : m.end) });
  }
  sortLanes(lanes);
  return lanes.map(l => l.name);
}

const isStale = (u) => !u || u.week_ending < addDays(defaultPeriodEnd('Weekly'), -6);

function overviewRow(sub) {
  const { p, lane, rec } = sub;
  const [cur, prev] = sub.forLane && !lane ? [] : updatesFor(p.id, lane); // a lane without a name has no updates
  const rg = ragOf(p.id);
  const ov = milestoneOverview(p.id, sub.forLane ? lane : null);
  const stale = cur && isStale(cur);
  const ragCell = (u, isCur) => (u
    ? `${statusPill(u.status, rg.map)}<small class="ov-week${isCur && stale ? ' stale' : ''}" ${isCur && stale ? 'title="No update since this week"' : ''}>w/e ${fmtShort(u.week_ending)}</small>`
    : '<span class="muted">—</span>');
  const nameCell = sub.forLane
    ? `<td class="ov-prog">${lane
      ? `<button type="button" class="ov-name" data-open-lane="${escAttr(lane)}" title="Show this swimlane on the Gantt chart">${escAttr(lane)}</button>`
      : '<span class="muted">(No swimlane)</span>'}</td>`
    : `<td class="ov-num">${p.number ? escAttr(p.number) : '<span class="muted">—</span>'}</td>
      <td class="ov-prog">
        <button type="button" class="ov-name" data-open-workspace="${p.id}" title="Open the Gantt chart">${escAttr(p.name)}</button>
        ${p.code ? `<span class="prog-code">${escAttr(p.code)}</span>` : ''}
        <small class="ov-overall">Overall ${statusPill(p.status, rg.map)}</small>
      </td>`;
  const key = sub.forLane ? `data-lane="${escAttr(lane)}"` : `data-pid="${p.id}"`;
  const canUpdate = !sub.forLane || lane; // a lane needs a name to hold updates
  return { sub, cur, prev, ov, html: `
    <tr ${key} style="--rag:${sub.forLane ? 'var(--border)' : pal(p.status, rg.map).base}">
      ${nameCell}
      <td class="ov-lead">${rec.lead ? escAttr(rec.lead) : '<span class="muted">—</span>'}</td>
      <td class="ov-rag">${ragCell(prev, false)}</td>
      <td class="ov-rag">${ragCell(cur, true)}</td>
      <td class="ov-trend">${trendBadge(rec.trend)}</td>
      <td class="ov-summary">${cur?.summary ? `<div class="md">${mdToHtml(cur.summary)}</div>` : '<span class="muted">No update yet</span>'}</td>
      ${MS_BUCKETS.map(([k]) => `<td class="ov-ms ms-${k}${ov[k] ? '' : ' zero'}">${ov[k] ? `<button type="button" class="ov-count" data-bucket="${k}" title="Show these on the Gantt chart">${ov[k]}</button>` : 0}</td>`).join('')}
      <td class="ov-act">${canUpdate ? `<button type="button" class="btn btn-sm" data-update>Update</button>` : ''}</td>
    </tr>` };
}

// Fill one of the overview tables (programs or swimlanes) and its totals row.
function renderOverviewTable(id, subjects, one, many) {
  const rows = subjects.map(overviewRow);
  const cols = document.querySelectorAll(`#${id}-table thead tr:first-child th:not(.ov-ms-group)`).length - 1;
  document.getElementById(`${id}-body`).innerHTML = rows.map(r => r.html).join('')
    || `<tr><td colspan="${cols + MS_BUCKETS.length + 1}" class="grid-empty">No ${many} yet.</td></tr>`;
  const sum = Object.fromEntries(MS_BUCKETS.map(([k]) => [k, rows.reduce((a, r) => a + r.ov[k], 0)]));
  document.getElementById(`${id}-foot`).innerHTML = `
    <tr><td colspan="${cols}">All ${many}</td>${MS_BUCKETS.map(([k]) => `<td class="ov-ms ms-${k}">${sum[k]}</td>`).join('')}<td></td></tr>`;
  const missing = rows.filter(r => (!r.sub.forLane || r.sub.lane) && isStale(r.cur)).length;
  document.getElementById(`${id}-count`).textContent = count(rows.length, one, many)
    + (!rows.length ? '' : missing ? ` · ${missing} without an update this week` : ' · all updated this week');
  return rows;
}

let overviewRows = [], laneRows = []; // as last rendered, for clicks and the CSV
function renderOverview() {
  overviewRows = renderOverviewTable('overview', programsInOrder().map(programSubject), 'program', 'programs');
}
function renderLaneOverview() {
  const p = currentWorkspace();
  laneRows = renderOverviewTable('lanes', lanesInOrder().map(name => ({ ...laneSubject(p, name), forLane: true })), 'swimlane', 'swimlanes');
}

function downloadOverviewCSV(forLane) {
  const rows = forLane ? (renderLaneOverview(), laneRows) : (renderOverview(), overviewRows);
  const head = [...(forLane ? ['Swimlane'] : ['Program number', 'Program']), 'Area lead', ...(forLane ? [] : ['Overall RAG']),
    'Previous weekly RAG', 'Previous week ending', 'Current weekly RAG', 'Current week ending', 'Trend', 'Summary',
    ...MS_BUCKETS.map(([, l]) => `Milestones ${l.toLowerCase()}`)];
  const lines = rows.map(({ sub: { p, lane, rec }, cur, prev, ov }) => [
    ...(forLane ? [lane] : [p.number, p.name]), rec.lead, ...(forLane ? [] : [p.status]),
    prev?.status, prev?.week_ending, cur?.status, cur?.week_ending, rec.trend,
    mdToText(cur?.summary || ''), ...MS_BUCKETS.map(([k]) => ov[k]),
  ].map(csvEscape).join(','));
  const blob = new Blob(['﻿' + [head.map(csvEscape).join(','), ...lines].join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const p = currentWorkspace();
  const slug = (p.code || p.name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'workspace';
  a.download = `${forLane ? `${slug}-swimlane` : 'program'}-overview-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ---- weekly update dialog ---- */
// For a program or a swimlane. Opens on this week's update if there is one, otherwise a new one
// starting from last week's RAG. Picking a week that already has an update loads it. The area
// lead and trend are saved to the program or swimlane; the trend is suggested from the change in
// RAG until it's chosen by hand.

let upSubject = null;   // {p, lane, rec, label} being updated
let upEditing = null;   // update being edited; null for a new one
let upTrendTouched = false;
const RAG_RANK = { red: 0, amber: 1, green: 2, complete: 3 };

function openUpdateDialog(sub) {
  hideQuick();
  upSubject = sub;
  const f = document.getElementById('update-form').elements;
  const rg = ragOf(sub.p.id);
  document.getElementById('up-heading').textContent = `Weekly update · ${sub.label}`;
  document.getElementById('up-badge').textContent = sub.lane ? 'Swimlane update' : 'Weekly update';
  document.getElementById('up-status').innerHTML = rg.names.map(st => `
    <label style="--c:${rg.map[st].base};--t:${rg.map[st].text}"><input type="radio" name="status" value="${escAttr(st)}" /><span>${escAttr(st)}</span></label>`).join('');
  document.getElementById('up-trend').innerHTML = TRENDS.map(t => `
    <label><input type="radio" name="trend" value="${t.name}" />${trendArrow(t)}</label>`).join('');
  f.week_ending.value = defaultPeriodEnd('Weekly');
  f.lead.value = sub.rec.lead;
  upEditing = null;
  loadUpdateWeek(true);
  document.getElementById('up-error').textContent = '';
  refreshDatalists();
  document.getElementById('update-dialog').showModal();
}

const subjectUpdates = () => updatesFor(upSubject.p.id, upSubject.lane);

// Fill the form for the chosen week: its update if there is one, otherwise a fresh one
// (keeping what's been typed, unless the dialog has just opened).
function loadUpdateWeek(opening) {
  const f = document.getElementById('update-form').elements;
  const { p, rec } = upSubject;
  const week = f.week_ending.value;
  const found = subjectUpdates().find(u => u.week_ending === week) || null;
  const before = subjectUpdates().find(u => u.week_ending < week);
  if (found || opening || upEditing) {
    const v = found || { status: before?.status || ragOf(p.id).def, summary: '', author: before?.author || '' };
    document.querySelectorAll('#up-status input').forEach(r => { r.checked = r.value === v.status; });
    f.summary.value = v.summary;
    f.author.value = v.author;
    edLoad(f.summary);
  }
  upEditing = found;
  upTrendTouched = !!rec.trend && !!found;
  for (const r of f.trend) r.checked = r.value === rec.trend;
  if (!upTrendTouched) suggestTrend();
  const rg = ragOf(p.id);
  document.getElementById('up-prev').innerHTML = before
    ? `<span class="field-label">Previous update · w/e ${fmtNice(before.week_ending)}</span> ${statusPill(before.status, rg.map)}
       ${before.summary ? `<div class="md">${mdToHtml(before.summary)}</div>` : ''}`
    : '<span class="muted">No earlier update.</span>';
  document.getElementById('up-mode').textContent = found ? `Editing the update for the week ending ${fmtNice(week)}.` : `New update for the week ending ${fmtNice(week)}.`;
  document.getElementById('up-delete').hidden = !found;
  document.getElementById('up-submit').textContent = found ? 'Save update' : 'Submit update';
}

// Trend from the RAG change since the previous week: better, same or worse.
function suggestTrend() {
  const f = document.getElementById('update-form').elements;
  const now = document.querySelector('#up-status input:checked')?.value || '';
  const before = subjectUpdates().find(u => u.week_ending < f.week_ending.value);
  const a = RAG_RANK[before?.status.toLowerCase()], b = RAG_RANK[now.toLowerCase()];
  if (a == null || b == null) return;
  const name = b > a ? 'Improving' : b < a ? 'Declining' : 'Stable';
  for (const r of f.trend) r.checked = r.value === name;
}

async function submitUpdate(e) {
  e.preventDefault();
  const f = document.getElementById('update-form').elements;
  const err = document.getElementById('up-error');
  const week = f.week_ending.value;
  if (!parseDate(week)) return (err.textContent = 'Choose the week ending date.');
  const status = document.querySelector('#up-status input:checked')?.value;
  if (!status) return (err.textContent = 'Choose this week’s RAG.');
  const { p, lane, rec } = upSubject;
  const now = new Date().toISOString();
  const v = { week_ending: week, status, summary: f.summary.value.trim(), author: f.author.value.trim(), updated: now };
  if (upEditing) Object.assign(upEditing, v);
  else state.updates.push({ id: nextUpdateId(), workspace_id: p.id, swimlane: lane, created: now, ...v });
  const saves = [saveUpdates(upEditing ? 'Update saved' : 'Update submitted')];
  const changes = { lead: f.lead.value.trim(), trend: f.trend.value };
  if (changes.lead !== rec.lead || changes.trend !== rec.trend) {
    Object.assign(rec, changes);
    if (lane) {
      if (!state.lanes.includes(rec)) state.lanes.push(rec);
      saves.push(saveLanes());
    } else {
      p.updated = now;
      saves.push(saveWorkspaces());
    }
  }
  document.getElementById('update-dialog').close();
  rerenderCurrentView();
  await Promise.all(saves);
}

async function deleteUpdate() {
  if (!upEditing) return;
  const snap = snapshotData();
  state.updates = state.updates.filter(u => u !== upEditing);
  document.getElementById('update-dialog').close();
  rerenderCurrentView();
  offerUndo(snap, `Deleted the update for the week ending ${fmtShort(upEditing.week_ending)}`);
  await saveUpdates('Update deleted');
}

// Show one swimlane on the Gantt chart.
function openLaneOnGantt(name) {
  clearGanttFilters();
  ganttFilter.lane = name;
  switchView('gantt');
}

function wireOverview() {
  document.getElementById('btn-overview-csv').onclick = () => downloadOverviewCSV(false);
  document.getElementById('btn-lanes-csv').onclick = () => downloadOverviewCSV(true);
  document.getElementById('overview-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pid]');
    if (e.target.closest('[data-update]')) return openUpdateDialog(programSubject(workspaceById(row.dataset.pid)));
    const bucket = e.target.closest('[data-bucket]');
    if (bucket) return openBucket(row.dataset.pid, bucket.dataset.bucket);
    const open = e.target.closest('[data-open-workspace]');
    if (open) switchWorkspace(open.dataset.openWorkspace, 'gantt');
  });
  document.getElementById('lanes-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-lane]');
    if (!row) return;
    if (e.target.closest('[data-update]')) return openUpdateDialog(laneSubject(currentWorkspace(), row.dataset.lane));
    const bucket = e.target.closest('[data-bucket]');
    if (bucket) return openBucket(state.workspaceId, bucket.dataset.bucket, row.dataset.lane);
    if (e.target.closest('[data-open-lane]')) openLaneOnGantt(row.dataset.lane);
  });
  const dlg = document.getElementById('update-dialog');
  const form = document.getElementById('update-form');
  mdEditor(form.elements.summary);
  form.addEventListener('submit', submitUpdate);
  form.elements.week_ending.addEventListener('change', () => loadUpdateWeek(false));
  document.getElementById('up-status').addEventListener('change', () => { if (!upTrendTouched) suggestTrend(); });
  document.getElementById('up-trend').addEventListener('change', () => { upTrendTouched = true; });
  document.getElementById('up-cancel').onclick = () => dlg.close();
  document.getElementById('up-close').onclick = () => dlg.close();
  document.getElementById('up-delete').onclick = deleteUpdate;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
}

/* ================= what changed ================= */
// This workspace now against the start of an earlier day, from the server's daily backups:
// RAG changes, dates that moved, items added and removed, and reports written since. The
// summary can be copied, or used to start the program's weekly update.

let chHistory = null;   // { milestones: [days], reports: [...], updates: [...] } once fetched
let chSince = '';       // the day compared with
const chCache = new Map(); // day → items of every workspace on that day
let chSummary = '';     // the summary as Markdown, as last shown

async function loadHistory() {
  try {
    const res = await fetch('api/history', { cache: 'no-store' });
    chHistory = res.ok ? await res.json() : { milestones: [] };
  } catch { chHistory = { milestones: [] }; }
}

async function itemsOn(day) {
  if (!chCache.has(day)) {
    const res = await fetch(`api/history/milestones/${day}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`no copy for ${day}`);
    const lastId = state.lastId; // reading old rows mustn't move the id counter
    chCache.set(day, rowsToItems(parseAny(await res.text())));
    state.lastId = lastId;
  }
  return chCache.get(day);
}

// Today's items against those of the day compared with.
function diffItems(before, now) {
  const old = new Map(before.map(m => [m.id, m]));
  const cur = new Map(now.map(m => [m.id, m]));
  const out = { rag: [], dates: [], added: [], removed: [] };
  for (const m of now) {
    const o = old.get(m.id);
    if (!o) { out.added.push(m); continue; }
    if (o.status !== m.status) out.rag.push({ m, from: o.status, to: m.status });
    if (o.end !== m.end || (isTask(m) && o.start !== m.start)) out.dates.push({ m, o, days: o.end && m.end ? daysBetween(o.end, m.end) : 0 });
  }
  for (const o of before) if (!cur.has(o.id)) out.removed.push(o);
  const rank = (st) => (OFF_TRACK.includes(st) ? 0 : isDoneStatus(st) ? 2 : 1);
  out.rag.sort((a, b) => rank(a.to) - rank(b.to) || cmpRef(a.m, b.m));
  out.dates.sort((a, b) => b.days - a.days || cmpRef(a.m, b.m));
  out.added.sort(cmpRef);
  out.removed.sort(cmpRef);
  return out;
}

const changesSince = (day) => state.reports.filter(r => (r.created || '').slice(0, 10) >= day || (r.updated || '').slice(0, 10) >= day);

function changeSummary(d, reports, day) {
  const lbl = (m) => `${m.ref ? `${m.ref} ` : ''}${m.title}`;
  const moved = (x) => (x.days > 0 ? `slipped ${daysText(x.days)}` : x.days < 0 ? `${daysText(-x.days)} earlier` : 'start moved');
  const lines = [`Changes since ${fmtNice(day)}:`, ''];
  if (d.rag.length) lines.push(...d.rag.map(x => `- **${lbl(x.m)}**: RAG ${x.from} → ${x.to}`));
  if (d.dates.length) lines.push(...d.dates.map(x => `- **${lbl(x.m)}**: ${moved(x)} (now ${isTask(x.m) ? `${fmtShort(x.m.start)} – ${fmtNice(x.m.end)}` : fmtNice(x.m.end)})`));
  if (d.added.length) lines.push(`- Added: ${d.added.map(lbl).join('; ')}`);
  if (d.removed.length) lines.push(`- Removed: ${d.removed.map(lbl).join('; ')}`);
  if (reports.length) lines.push(`- ${count(reports.length, 'report', 'reports')} written or updated`);
  if (lines.length === 2) lines.push('- Nothing changed.');
  return lines.join('\n');
}

async function renderChanges() {
  const body = document.getElementById('ch-body');
  const sel = document.getElementById('ch-since');
  if (!chHistory) {
    body.innerHTML = '<p class="due-empty">Loading…</p>';
    await loadHistory();
    if (!isShown('changes')) return;
  }
  const days = (chHistory.milestones || []).filter(d => d <= todayISO());
  const btns = ['ch-copy', 'ch-update'].map(id => document.getElementById(id));
  if (!days.length) {
    sel.innerHTML = '<option>No earlier copies yet</option>';
    sel.disabled = true;
    btns.forEach(b => { b.disabled = true; });
    document.getElementById('ch-count').textContent = '';
    body.innerHTML = `<p class="due-empty">There’s nothing to compare with yet. The server keeps a copy of the ${escAttr(T.items)} file at the start of each day it changes, so from tomorrow you’ll see what changed since today.</p>`;
    return;
  }
  // default: about a week ago (the latest copy at least 7 days old), else the oldest there is
  if (!days.includes(chSince)) chSince = [...days].reverse().find(d => d <= addDays(todayISO(), -7)) || days[0];
  sel.disabled = false;
  btns.forEach(b => { b.disabled = false; });
  sel.innerHTML = [...days].reverse().map(d => {
    const ago = daysBetween(d, todayISO());
    return `<option value="${d}" ${d === chSince ? 'selected' : ''}>the start of ${fmtNice(d)}${ago ? ` (${ago === 1 ? 'yesterday' : `${ago} days ago`})` : ' (today)'}</option>`;
  }).join('');
  let before;
  try {
    before = (await itemsOn(chSince)).filter(m => m.workspace_id === state.workspaceId);
  } catch (err) {
    body.innerHTML = `<p class="due-empty">Couldn’t read the copy from ${fmtNice(chSince)} (${escAttr(err.message)}).</p>`;
    return;
  }
  if (!isShown('changes')) return;
  const d = diffItems(before, state.items);
  const reports = changesSince(chSince);
  chSummary = changeSummary(d, reports, chSince);
  const n = d.rag.length + d.dates.length + d.added.length + d.removed.length;
  document.getElementById('ch-count').textContent = `${count(n, `${T.item} changed`, `${T.items} changed`)} · ${count(reports.length, 'report', 'reports')}`;

  const lbl = (m) => `<span class="ch-item">${m.ref ? `<b class="ref">${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>`;
  const link = (m) => `<button type="button" class="link-btn ch-open" data-ch-item="${m.id}" title="Show it on the Gantt chart">${lbl(m)}</button>`;
  const when = (m) => (isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end));
  const section = (title, rows, empty) => `
    <section class="ch-sec">
      <h3>${title} <span class="muted">${rows.length || ''}</span></h3>
      ${rows.length ? `<ul>${rows.join('')}</ul>` : `<p class="muted">${empty}</p>`}
    </section>`;
  body.innerHTML = `
    <div class="ch-grid">
      ${section('RAG changes', d.rag.map(x => `<li>${link(x.m)}<span class="ch-what">${statusPill(x.from)} <span class="ch-arrow">→</span> ${statusPill(x.to)}</span></li>`), 'No RAG changes.')}
      ${section('Dates moved', d.dates.map(x => `<li>${link(x.m)}<span class="ch-what"><b class="${x.days > 0 ? 'ch-slip' : x.days < 0 ? 'ch-gain' : ''}">${x.days > 0 ? `+${daysText(x.days)}` : x.days < 0 ? `−${daysText(-x.days)}` : 'start moved'}</b> <span class="muted">was ${when(x.o)}, now ${when(x.m)}</span></span></li>`), 'No dates moved.')}
      ${section(`${T.Items} added`, d.added.map(m => `<li>${link(m)}<span class="ch-what muted">${escAttr(typeName(m))} · ${when(m)}</span></li>`), `No ${escAttr(T.items)} added.`)}
      ${section(`${T.Items} removed`, d.removed.map(m => `<li>${lbl(m)}<span class="ch-what muted">${escAttr(m.status)} · ${when(m)}</span></li>`), `No ${escAttr(T.items)} removed.`)}
      ${section('Reports written or updated', reports.sort((a, b) => b.period_end.localeCompare(a.period_end)).map(r => {
        const m = itemById(r.item_id);
        return `<li>${m ? link(m) : `<i>Deleted ${escAttr(T.item)}</i>`}<span class="ch-what">${statusPill(r.status)} <span class="muted">period ending ${fmtShort(r.period_end)}</span></span></li>`;
      }), 'No reports since then.')}
    </div>
    <section class="ch-sec ch-summary"><h3>Summary</h3><div class="md">${mdToHtml(chSummary)}</div></section>`;
}

function wireChanges() {
  document.getElementById('ch-since').onchange = (e) => { chSince = e.target.value; renderChanges(); };
  document.getElementById('ch-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(chSummary); showToast('Summary copied'); } catch { showToast('Couldn’t copy — select the summary text instead'); }
  };
  document.getElementById('ch-update').onclick = () => {
    openUpdateDialog(programSubject(currentWorkspace()));
    const f = document.getElementById('update-form').elements;
    f.summary.value = [f.summary.value.trim(), chSummary].filter(Boolean).join('\n\n');
    edLoad(f.summary);
  };
  document.getElementById('ch-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch-item]');
    if (b) showItemOnGantt(b.dataset.chItem);
  });
}

// Open the Gantt chart on one item: clear filters that hide it, unfold its swimlane, scroll to it
// and give it the keyboard focus (its chain lit and its card showing).
function showItemOnGantt(id) {
  const m = itemById(id);
  if (!m) return;
  switchView('gantt');
  if (!ganttMatches(m)) clearGanttFilters();
  if (collapsedLanes().has(m.swimlane)) toggleLane(m.swimlane, false);
  const d = parseDate(m.start), e = parseDate(m.end);
  if (d < state.rangeStart || e > state.rangeEnd) { autoRange(); }
  renderGantt();
  document.getElementById('gantt-container').focus({ preventScroll: true });
  setKbItem(id);
}

/* ================= date history ================= */
// The audit log of every change to an item's dates, kept by the server in date-changes.csv: who,
// when, from what to what, and how. Each save logs one row per date field; here the rows of one
// save of one item are shown together, newest first.

const DL_FIELDS = { start: 'Start', end: 'End', baseline_start: 'Baseline start', baseline_end: 'Baseline end' };
const DL_PAGE = 300;
let dlRows = [];     // every row of the log, oldest first
let dlItem = '';     // show just this item's history
let dlShown = DL_PAGE;

async function loadDateLog() {
  await saveQueue; // so the latest save is in it
  const res = await fetch('api/date-changes', { cache: 'no-store' });
  if (!res.ok) throw new Error(`the server returned ${res.status}`);
  const [header = [], ...rows] = parseAny(await res.text());
  dlRows = rows.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// The rows to show (this workspace, filters applied), grouped by save and item, newest first.
function dateLogEntries() {
  const q = document.getElementById('dl-q').value.trim().toLowerCase();
  const who = document.getElementById('dl-who').value;
  const baseline = document.getElementById('dl-baseline').checked;
  const started = document.getElementById('dl-started').checked;
  const groups = new Map();
  for (const r of dlRows) {
    if (r.workspace_id !== state.workspaceId || (dlItem && r.item_id !== dlItem)) continue;
    if (!baseline && r.field.startsWith('baseline')) continue;
    if (!started && r.action === 'Logging started') continue;
    if (who && (r.by || '') !== who) continue;
    const key = `${r.at}|${r.item_id}|${r.action}`;
    if (!groups.has(key)) groups.set(key, { ...r, fields: {} });
    groups.get(key).fields[r.field] = r;
  }
  const words = q.split(/\s+/).filter(Boolean);
  return [...groups.values()]
    .filter(g => words.every(w => [g.ref, g.title, g.by, g.via, g.note, g.action].join(' ').toLowerCase().includes(w)))
    .sort((a, b) => b.at.localeCompare(a.at) || +b.id - +a.id);
}

const dlDate = (iso) => (parseDate(iso) ? fmtNice(iso) : escAttr(iso || '—'));
function dlShift(days) {
  const n = +days;
  if (days === '' || !n) return '';
  return ` <b class="${n > 0 ? 'ch-slip' : 'ch-gain'}">${n > 0 ? '+' : '−'}${daysText(Math.abs(n))}</b>`;
}

// What changed, in words: a milestone's start and end moving together read as one date.
function dlChange(g) {
  const f = g.fields, lines = [];
  const pair = (st, en, label) => {
    if (st && en && st.from === en.from && st.to === en.to) return lines.push(dlLine(label || 'Date', st));
    if (st) lines.push(dlLine(label ? `${label} start` : 'Start', st));
    if (en) lines.push(dlLine(label ? `${label} end` : 'End', en));
  };
  pair(f.start, f.end, '');
  pair(f.baseline_start, f.baseline_end, 'Baseline');
  return lines.join('<br>');
}
function dlLine(label, r) {
  const name = `<span class="dl-field">${escAttr(label)}</span>`;
  if (!r.from) return `${name} ${dlDate(r.to)}`;
  if (!r.to) return `${name} ${dlDate(r.from)} <span class="muted">(removed)</span>`;
  return `${name} ${dlDate(r.from)} <span class="ch-arrow">→</span> ${dlDate(r.to)}${dlShift(r.days)}`;
}

const DL_ACTION_CLASS = { 'Knock-on': 'knock', Deleted: 'del', 'Edited outside the app': 'outside' };

async function renderDates() {
  const body = document.getElementById('dl-body');
  if (!dlRows.length) body.innerHTML = '<tr><td colspan="5" class="due-empty">Loading…</td></tr>';
  try { await loadDateLog(); } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="due-empty">Couldn’t load the date history (${escAttr(err.message)}). Restart <code>node server.js</code> if the app was updated.</td></tr>`;
    return;
  }
  if (!isShown('dates')) return;
  const sel = document.getElementById('dl-who');
  const people = [...new Set(dlRows.filter(r => r.workspace_id === state.workspaceId).map(r => r.by || ''))].sort((a, b) => a.localeCompare(b));
  const cur = people.includes(sel.value) ? sel.value : '';
  sel.innerHTML = `<option value="">Everyone</option>${people.map(p => `<option value="${escAttr(p)}" ${p === cur ? 'selected' : ''}>${escAttr(p || 'Unknown')}</option>`).join('')}`;
  sel.value = cur;
  sel.hidden = !people.some(Boolean); // until logins are recorded there's no one to pick
  renderDateRows();
}

function renderDateRows() {
  const entries = dateLogEntries();
  const chip = document.getElementById('dl-item');
  const m = dlItem && itemById(dlItem);
  const latest = dlItem && [...dlRows].reverse().find(r => r.item_id === dlItem);
  chip.hidden = !dlItem;
  chip.innerHTML = dlItem ? `Only ${escAttr(m ? fullLabel(m) : `${latest?.ref || ''} ${latest?.title || `#${dlItem}`}`)}<button type="button" data-dl-all title="Show every ${escAttr(T.item)}">✕</button>` : '';
  document.getElementById('dl-count').textContent = count(entries.length, 'change', 'changes');
  const body = document.getElementById('dl-body');
  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="5" class="due-empty">No date changes ${dlRows.length ? 'match' : 'logged yet'}.</td></tr>`;
    return;
  }
  body.innerHTML = entries.slice(0, dlShown).map(g => {
    const live = itemById(g.item_id);
    const lbl = `<span class="ch-item">${g.ref ? `<b class="ref">${escAttr(g.ref)}</b> ` : ''}${escAttr(g.title)}</span>`;
    const act = g.action === 'Changed' ? '' : `<span class="dl-act ${DL_ACTION_CLASS[g.action] || ''}">${escAttr(g.action)}</span>`;
    return `<tr>
      <td class="dl-when">${fmtStamp(g.at)}</td>
      <td class="dl-who">${g.by ? escAttr(g.by) : '<span class="muted">—</span>'}</td>
      <td>${live ? `<button type="button" class="link-btn ch-open" data-ch-item="${g.item_id}" title="Show it on the Gantt chart">${lbl}</button>` : `<span class="dl-gone" title="No longer in this workspace">${lbl}</span>`}</td>
      <td class="dl-change">${dlChange(g)}</td>
      <td class="dl-how">${act}${escAttr(g.via)}${g.note ? `<br>${escAttr(g.note)}` : ''}</td>
    </tr>`;
  }).join('') + (entries.length > dlShown ? `<tr><td colspan="5" class="dl-more"><button type="button" class="btn" data-dl-more>Show ${Math.min(DL_PAGE, entries.length - dlShown)} more</button></td></tr>` : '');
}

function showDatesFor(itemId) {
  dlItem = itemId;
  dlShown = DL_PAGE;
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  switchView('dates');
}

function downloadDatesCSV() {
  const cols = ['at', 'by', 'ref', 'title', 'field', 'from', 'to', 'days', 'action', 'via', 'note'];
  const lines = dateLogEntries().flatMap(g => Object.values(g.fields).map(r => cols.map(k => csvEscape(r[k])).join(',')));
  const p = currentWorkspace();
  const blob = new Blob(['﻿' + [cols.join(','), ...lines].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.download = `${pngSlug(p.code || p.name) || 'workspace'}-date-history-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

function wireDates() {
  const again = () => { dlShown = DL_PAGE; renderDateRows(); };
  document.getElementById('dl-q').oninput = again;
  for (const id of ['dl-who', 'dl-baseline', 'dl-started']) document.getElementById(id).onchange = again;
  document.getElementById('dl-csv').onclick = downloadDatesCSV;
  document.getElementById('view-dates').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch-item]');
    if (b) return showItemOnGantt(b.dataset.chItem);
    if (e.target.closest('[data-dl-all]')) { dlItem = ''; again(); }
    if (e.target.closest('[data-dl-more]')) { dlShown += DL_PAGE; renderDateRows(); }
  });
}

/* ================= PNG export ================= */

function downloadPNG() {
  // Exported in the light colours whatever the theme, so it sits well on a slide.
  const themed = G !== GANTT_THEMES.light;
  if (themed) { G = GANTT_THEMES.light; renderGantt(); }
  const svg = document.querySelector('#gantt-container svg');
  if (themed) { G = GANTT_THEMES.dark; renderGantt(); }
  if (!svg) return;
  const copy = svg.cloneNode(true); // drop the scroll offsets of the pinned layers
  for (const g of copy.querySelectorAll('.gantt-col, .gantt-head, .gantt-corner')) g.removeAttribute('transform');
  const xml = new XMLSerializer().serializeToString(copy);
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
    const p = currentWorkspace();
    a.download = `${(p.code || p.name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'workspace'}-gantt.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = url;
}

/* ================= find (⌘K) ================= */
// One box to jump anywhere: any item in any workspace (by ref, title, owner or swimlane), a
// workspace, or a page. Every word typed has to match; refs and the starts of titles rank first.

let palHits = [], palSel = 0;

function palPages() {
  const ws = currentWorkspace();
  return [
    ['overview', 'Program overview'], ['workspaces', 'All workspaces'], ['gantt', `Gantt chart · ${ws.name}`],
    ['editor', `${T.Items} · ${ws.name}`], ['reports', `Reports · ${ws.name}`], ['due', `Reports due · ${ws.name}`],
    ['changes', `What changed · ${ws.name}`], ['dates', `Date history · ${ws.name}`], ['lanes', `Swimlane overview · ${ws.name}`],
  ].map(([view, label]) => ({ kind: 'page', view, label, hay: label.toLowerCase() }));
}

function palSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pages = palPages();
  if (!words.length) return pages;
  const hits = [];
  const score = (ref, title, hay) => {
    if (!words.every(w => hay.includes(w))) return -1;
    const w0 = words[0];
    return (ref && ref.toLowerCase() === w0 ? 0 : ref && ref.toLowerCase().startsWith(w0) ? 1 : title.toLowerCase().startsWith(w0) ? 2 : 3);
  };
  for (const p of pages) { const s = score('', p.label, p.hay); if (s >= 0) hits.push({ ...p, s: s + 0.5 }); }
  for (const p of state.workspaces) {
    const s = score(p.code, p.name, [p.code, p.number, p.name, p.owner, p.lead].join(' ').toLowerCase());
    if (s >= 0) hits.push({ kind: 'ws', p, s });
  }
  for (const m of allItems()) {
    const p = workspaceById(m.workspace_id);
    const s = score(m.ref, m.title, [m.ref, m.title, m.owner, m.swimlane, m.subswimlane, p?.code, p?.name].join(' ').toLowerCase());
    if (s >= 0) hits.push({ kind: 'item', m, p, s });
  }
  return hits.sort((a, b) => a.s - b.s || (a.kind === 'item' && b.kind === 'item' ? (a.p.id === state.workspaceId ? -1 : 0) - (b.p.id === state.workspaceId ? -1 : 0) || cmpRef(a.m, b.m) : 0)).slice(0, 40);
}

function renderPalette() {
  const q = document.getElementById('pal-q').value;
  palHits = palSearch(q);
  palSel = Math.min(palSel, Math.max(0, palHits.length - 1));
  const row = (h, i) => {
    let main, sub;
    if (h.kind === 'item') {
      const rg = ragOf(h.p.id);
      main = `${h.m.ref ? `<b class="ref">${escAttr(h.m.ref)}</b> ` : ''}${escAttr(h.m.title)}`;
      sub = `${statusPill(h.m.status, rg.map)} <span>${escAttr([h.p.code || h.p.name, h.m.swimlane, h.m.owner].filter(Boolean).join(' · '))}</span>`;
    } else if (h.kind === 'ws') {
      main = `${escAttr(h.p.name)}${h.p.code ? ` <span class="prog-code">${escAttr(h.p.code)}</span>` : ''}`;
      sub = '<span>Workspace</span>';
    } else {
      main = escAttr(h.label);
      sub = '<span>Page</span>';
    }
    return `<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === palSel}" class="${i === palSel ? 'sel' : ''}"><span class="pal-main">${main}</span><span class="pal-sub">${sub}</span></li>`;
  };
  document.getElementById('pal-list').innerHTML = palHits.map(row).join('') || '<li class="pal-none">Nothing matches.</li>';
  document.getElementById('pal-q').setAttribute('aria-activedescendant', palHits.length ? `pal-${palSel}` : '');
  document.getElementById(`pal-${palSel}`)?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  const dlg = document.getElementById('palette');
  if (dlg.open) return;
  hideQuick();
  const q = document.getElementById('pal-q');
  q.value = '';
  palSel = 0;
  renderPalette();
  dlg.showModal();
  q.focus();
}

async function pickPalette(i) {
  const h = palHits[i];
  if (!h) return;
  document.getElementById('palette').close();
  if (h.kind === 'page') {
    if (h.view === 'due') { rptMode = 'due'; return switchView('reports'); }
    if (h.view === 'reports') rptMode = 'all';
    return switchView(h.view);
  }
  if (h.kind === 'ws') return switchWorkspace(h.p.id, 'gantt');
  if (h.p.id !== state.workspaceId) await switchWorkspace(h.p.id, 'gantt');
  showItemOnGantt(h.m.id);
}

function wirePalette() {
  const dlg = document.getElementById('palette');
  const q = document.getElementById('pal-q');
  document.getElementById('nav-search').onclick = openPalette;
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.getElementById('nav-kbd').textContent = 'Ctrl K';
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
      if (document.querySelector('dialog[open]:not(#palette)')) return;
      e.preventDefault();
      openPalette();
    }
  });
  q.addEventListener('input', () => { palSel = 0; renderPalette(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (palHits.length) palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palHits.length) % palHits.length;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickPalette(palSel);
    }
  });
  document.getElementById('pal-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) pickPalette(+li.dataset.i);
  });
  document.getElementById('pal-list').addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && +li.dataset.i !== palSel) { palSel = +li.dataset.i; renderPalette(); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
}

/* ================= links ================= */
// The address says where you are, so it can be bookmarked or sent to someone: the view, the
// workspace and, on the Gantt chart, its search and filters — e.g.
// #/ws/3/gantt?lane=Delivery&rag=Red,Amber&late=1. #…&item=12 opens the chart on item 12.

let routeReady = false; // until the first view is shown, nothing is written over the address
let lastHash = '';

function readHash() {
  const m = location.hash.match(/^#\/(?:ws\/([^/?]+)\/)?(\w+)(?:\?(.*))?$/);
  if (!m || !VIEWS.includes(m[2])) return null;
  const q = new URLSearchParams(m[3] || '');
  const filter = {};
  for (const k of ['q', 'lane', 'owner']) if (q.has(k)) filter[k] = q.get(k);
  if (['milestone', 'task'].includes(q.get('type'))) filter.type = q.get('type');
  if (q.get('rag')) filter.rag = q.get('rag').split(',').filter(Boolean);
  if (q.get('late') === '1') filter.late = true;
  return { ws: m[1] ? decodeURIComponent(m[1]) : '', view: m[2], filter: m[2] === 'gantt' && Object.keys(filter).length ? filter : null, item: q.get('item') || '' };
}

function writeHash() {
  if (!routeReady) return;
  const view = currentView();
  let h = APP_VIEWS.includes(view) ? `#/${view}` : `#/ws/${encodeURIComponent(state.workspaceId)}/${view}`;
  if (view === 'gantt') {
    const f = ganttFilter, q = new URLSearchParams();
    if (f.q.trim()) q.set('q', f.q.trim());
    if (f.lane) q.set('lane', f.lane);
    if (f.owner) q.set('owner', f.owner);
    if (f.type) q.set('type', f.type);
    if (f.rag.length) q.set('rag', f.rag.join(','));
    if (f.late) q.set('late', '1');
    if (q.toString()) h += `?${q}`;
  }
  if (h === location.hash) return;
  lastHash = h;
  history.replaceState(null, '', h);
}

// An address typed or pasted into this tab.
async function followHash() {
  const link = readHash();
  if (!link) return;
  if (link.ws && link.ws !== state.workspaceId && workspaceById(link.ws)) await switchWorkspace(link.ws, link.view);
  if (link.view === 'gantt') { clearGanttFilters(); Object.assign(ganttFilter, link.filter || {}); }
  switchView(link.view);
  if (link.item && itemById(link.item)) showItemOnGantt(link.item);
}

async function copyLink() {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); showToast('Link copied — it opens this view with the same filters'); }
  catch { showToast('Couldn’t copy the link — copy it from the address bar'); }
}

/* ================= PNG of a page ================= */
// The overview tables and What changed download as a PNG, like the Gantt chart: the page's title
// and content, drawn at 2× in the light colours, without the buttons. The page is copied with every
// element's computed style written onto it and drawn through an SVG image onto a canvas.

const PNG_TARGETS = { overview: 'overview-table', lanes: 'lanes-table', changes: 'ch-body' };

function pngSlug(s) { return s.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase(); }

async function downloadPagePNG() {
  const view = currentView();
  const src = document.getElementById(PNG_TARGETS[view]);
  if (!src) return;
  const root = document.documentElement;
  const theme = root.dataset.theme, dark = 'dark' in root.dataset;
  root.dataset.theme = 'light'; // light colours, whatever the theme
  delete root.dataset.dark;
  let png;
  try {
    const box = view === 'changes' ? src : src.closest('.table-wrap');
    const width = Math.ceil(Math.max(box.scrollWidth, box.offsetWidth));
    const wrap = document.createElement('div');
    const p = currentWorkspace();
    const sub = APP_VIEWS.includes(view) ? '' : `${p.code ? `${p.code} · ` : ''}${p.name}`;
    const font = FONT.replace(/"/g, "'"); // it sits inside a style="…" attribute
    wrap.innerHTML = `<div style="font:600 12.5px ${font};color:#7a7870">${escAttr(sub)}${sub ? ' · ' : ''}${fmtNice(todayISO())}</div>
      <div style="font:700 21px ${font};color:#1c1c1c;letter-spacing:-0.015em;margin:2px 0 12px">${escAttr(VIEW_TITLES[view]())}${view === 'changes' ? ` <span style="font-weight:500;font-size:15px;color:#7a7870">since ${fmtNice(chSince)}</span>` : ''}</div>`;
    // leave out the Update buttons' column
    const copy = inlineStyles(box, (el) => el.matches('.ov-act')
      || (el.matches('thead tr:first-child > th:last-child, tfoot td:last-child') && !el.textContent.trim()));
    copy.style.width = width + 'px';
    copy.style.overflow = 'visible';
    wrap.appendChild(copy);
    Object.assign(wrap.style, { padding: '20px 22px', background: '#f4f3ee', width: width + 44 + 'px' });
    document.body.appendChild(wrap); // measure the height as laid out
    wrap.style.position = 'fixed'; wrap.style.left = '-100000px'; wrap.style.top = '0';
    const height = wrap.offsetHeight;
    wrap.remove();
    wrap.style.position = wrap.style.left = wrap.style.top = '';
    const xml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 44}" height="${height}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
    png = await svgToPNG(svg, width + 44, height);
  } finally {
    if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
    if (dark) root.dataset.dark = '';
  }
  const a = document.createElement('a');
  const p = currentWorkspace();
  a.download = `${APP_VIEWS.includes(view) ? '' : `${pngSlug(p.code || p.name)}-`}${pngSlug(VIEW_TITLES[view]())}-${todayISO()}.png`;
  a.href = png;
  a.click();
}

// A copy of an element with each element's computed style written inline, so it draws the same
// outside the page. Elements `leave(el)` picks out are left out.
function inlineStyles(el, leave = () => false) {
  const copy = el.cloneNode(true);
  const from = [el, ...el.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')];
  const gone = [];
  from.forEach((src, i) => {
    if (i && leave(src)) return gone.push(to[i]);
    const cs = getComputedStyle(src);
    let css = '';
    for (const k of cs) css += `${k}:${cs.getPropertyValue(k)};`;
    to[i].setAttribute('style', css);
    to[i].removeAttribute('class');
  });
  for (const x of gone) x.remove();
  return copy;
}

function svgToPNG(svg, w, h) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2; // retina-quality export
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      try { resolve(canvas.toDataURL('image/png')); } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error('the page couldn’t be drawn'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/* ================= wiring ================= */

const VIEWS = ['overview', 'workspaces', 'gantt', 'editor', 'reports', 'changes', 'dates', 'lanes'];
const APP_VIEWS = ['overview', 'workspaces']; // views across every workspace
const isShown = (view) => !document.getElementById(`view-${view}`).classList.contains('hidden');
const currentView = () => VIEWS.find(isShown) || 'gantt';

function switchView(view) {
  if (view !== 'reports' && isShown('reports') && !leavePaneEdit()) return;
  hideQuick();
  if (view !== 'editor') {
    syncEditorToState();
    // Clear the hidden table so a later sync can't overwrite edits made elsewhere.
    document.getElementById('editor-body').innerHTML = '';
  }
  if (view === 'gantt') renderGantt();
  else if (view === 'editor') renderEditor();
  else if (view === 'reports') renderReports();
  else if (view === 'overview') renderOverview();
  else if (view === 'lanes') renderLaneOverview();
  else if (view === 'changes') renderChanges();
  else if (view === 'dates') renderDates();
  else renderWorkspaces();
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
    document.getElementById(`nav-${v}`).classList.toggle('active', v === view);
    document.getElementById(`nav-${v}`).setAttribute('aria-current', v === view ? 'page' : 'false');
  }
  document.getElementById('app-main').scrollTop = 0;
  updatePageHead();
  saveAppPrefs({ view });
  writeHash();
}

// Theme: Auto (follows the system), Light or Dark; a per-browser choice. The chart has its own
// colour set (G), so it's redrawn when the theme changes.
const THEMES = ['auto', 'light', 'dark'];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme = loadAppPrefs().theme || 'auto') {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'auto' && darkQuery.matches);
  if (dark) root.dataset.dark = ''; else delete root.dataset.dark;
  G = GANTT_THEMES[dark ? 'dark' : 'light'];
  const name = { auto: 'Auto', light: 'Light', dark: 'Dark' }[theme];
  document.getElementById('nav-theme-label').textContent = `Theme: ${name}`;
  document.getElementById('nav-theme').title = theme === 'auto' ? `Theme: follows the system (${dark ? 'dark' : 'light'} now) — click for Light` : `Theme: ${name} — click for ${theme === 'light' ? 'Dark' : 'Auto'}`;
  if (state.rangeStart && isShown('gantt')) renderGantt();
}

function setNavCollapsed(collapsed) {
  document.body.classList.toggle('nav-collapsed', collapsed);
  const btn = document.getElementById('nav-collapse');
  btn.title = collapsed ? 'Expand menu' : 'Collapse menu';
  btn.setAttribute('aria-expanded', !collapsed);
  saveAppPrefs({ navCollapsed: collapsed });
}

function wireEvents() {
  for (const v of VIEWS) document.getElementById(`nav-${v}`).onclick = () => switchView(v);
  document.getElementById('nav-collapse').onclick = () => setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
  document.querySelectorAll('[data-png]').forEach(b => { b.onclick = downloadPagePNG; });
  document.getElementById('nav-theme').onclick = () => {
    const next = THEMES[(THEMES.indexOf(loadAppPrefs().theme || 'auto') + 1) % THEMES.length];
    saveAppPrefs({ theme: next });
    applyTheme(next);
  };
  darkQuery.addEventListener('change', () => applyTheme());
  document.getElementById('app-main').addEventListener('scroll', () => { if (!quickDirty()) hideQuick(); hideTip(); });
  wireWorkspaces();
  wireOverview();

  document.getElementById('zoom-in').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay * 1.3); };
  document.getElementById('zoom-out').onclick = () => { state.userZoomed = true; setZoom(state.pxPerDay / 1.3); };
  document.getElementById('zoom-fit').onclick = () => { state.userZoomed = false; fitZoom(); };
  document.getElementById('timescale').onclick = (e) => {
    const b = e.target.closest('button[data-scale]');
    if (b) setTimescale(b.dataset.scale);
  };
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
  wireGanttFilters();
  document.getElementById('range-auto').onclick = () => { autoRange(); renderGantt(); };

  document.getElementById('toggle-months').onchange = (e) => { state.showMonths = e.target.checked; renderGantt(); };
  document.getElementById('toggle-quarters').onchange = (e) => { state.showQuarters = e.target.checked; renderGantt(); };
  document.getElementById('toggle-today').onchange = (e) => { state.showToday = e.target.checked; renderGantt(); };
  document.getElementById('link-mode').onchange = (e) => { state.linkMode = e.target.value; saveAppPrefs({ linkMode: state.linkMode }); renderGantt(); };
  document.getElementById('toggle-baseline').onchange = (e) => { state.showBaseline = e.target.checked; saveAppPrefs({ showBaseline: state.showBaseline }); renderGantt(); };
  document.getElementById('fold-all').onclick = () => foldAllLanes(true);
  document.getElementById('unfold-all').onclick = () => foldAllLanes(false);
  document.getElementById('baseline-set').onclick = () => setBaseline(true);
  document.getElementById('baseline-clear').onclick = () => setBaseline(false);

  document.getElementById('btn-png').onclick = downloadPNG;
  document.getElementById('btn-gantt-add').onclick = () => openEditDialog(null);
  document.getElementById('btn-link').onclick = copyLink;

  // gantt: hover card + click for the quick update panel
  const gc = document.getElementById('gantt-container');
  const itemAt = (e) => {
    const g = e.target.closest('[data-id]');
    return g && state.items.find(m => m.id === g.dataset.id);
  };
  gc.addEventListener('mouseover', (e) => {
    if (drag?.active) return;
    const m = !document.getElementById('edit-dialog').open && document.getElementById('quick').hidden && itemAt(e);
    if (m) showTip(m, e); else hideTip();
    focusLinks(itemAt(e));
  });
  gc.addEventListener('mousemove', (e) => { if (document.getElementById('tip').classList.contains('show')) moveTip(e); });
  gc.addEventListener('mouseleave', () => { hideTip(); focusLinks(null); });
  gc.addEventListener('pointerdown', (e) => {
    const g = e.button === 0 && !e.ctrlKey && e.target.closest('.gantt-item');
    const m = g && itemById(g.dataset.id);
    if (!m || collapsedLanes().has(m.swimlane)) return;
    e.preventDefault(); // no text selection while dragging
    drag = { m, g, mode: dragModeAt(g, m, e.clientX), x0: e.clientX, days: 0, active: false };
  });
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag?.active) { drag.days = 0; onDragEnd(); }
  });
  gc.addEventListener('mousemove', (e) => { // a task's ends show the resize cursor
    if (drag) return;
    const g = e.target.closest('.gantt-item');
    const m = g && itemById(g.dataset.id);
    gc.style.cursor = m && !collapsedLanes().has(m.swimlane) && dragModeAt(g, m, e.clientX) !== 'move' ? 'ew-resize' : '';
  });
  gc.tabIndex = 0;
  gc.setAttribute('aria-label', 'Chart: use the arrow keys to move between items and Enter to update one');
  gc.addEventListener('keydown', ganttKeyNav);
  gc.addEventListener('focusout', (e) => { if (!gc.contains(e.relatedTarget) && kbId && !quickId) { kbId = null; document.querySelectorAll('#gantt-container .gantt-item.kb').forEach(g => g.classList.remove('kb')); hideTip(); focusLinks(null); } });
  for (const type of ['click', 'contextmenu']) gc.addEventListener(type, (e) => {
    if (dragSuppressClick) return;
    const lane = type === 'click' && e.target.closest('.lane-toggle');
    if (lane) return toggleLane(lane.dataset.lane);
    const m = itemAt(e);
    if (m) showQuick(m, e);
  });

  // edit dialog
  const dlg = document.getElementById('edit-dialog');
  const form = document.getElementById('edit-form');
  form.addEventListener('submit', submitEditDialog);
  form.elements.type.addEventListener('change', updateEdType);
  form.elements.swimlane.addEventListener('change', (e) => pickEdLane(e.target));
  form.elements.end.addEventListener('input', updateEdType); // keeps a milestone's hidden start in step
  document.getElementById('ed-cancel').onclick = () => dlg.close();
  document.getElementById('ed-close').onclick = () => dlg.close();
  document.getElementById('ed-delete').onclick = deleteFromDialog;
  document.getElementById('ed-report').onclick = () => { const m = editing; dlg.close(); openReportDialog({ itemId: m.id }); };
  document.getElementById('ed-history').onclick = () => { const m = editing; dlg.close(); showReportsFor(m.id); };
  document.getElementById('ed-dates').onclick = () => showDatesFor(editing.id);
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
      id: nextId(), workspace_id: state.workspaceId, type: 'milestone', ref: '', title: `New ${T.item}`, description: '',
      swimlane: last?.swimlane || 'General', subswimlane: last?.subswimlane || '', owner: last?.owner || '',
      start: today, end: today, status: DEFAULT_STATUS, shape: 'diamond', parent: '', deps: [],
    });
    clearTableFilters(grid); // so the new row is visible
    if (grid.mode === 'quick') setGridMode('full'); // a new item needs its details filled in
    renderEditor();
    const input = document.querySelector(`#editor-body [data-i="${state.items.length - 1}"][data-k="title"]`);
    input?.scrollIntoView({ block: 'center' });
    input?.select();
    scheduleSave(`${T.Item} added`);
  };

  wireTable(grid);
  document.querySelectorAll('[name="grid-mode"]').forEach(r => r.addEventListener('change', () => setGridMode(r.value)));
  document.getElementById('btn-clear-filters').onclick = () => {
    clearTableFilters(grid);
    syncEditorToState();
    renderEditor();
  };
  document.getElementById('btn-items-csv').onclick = downloadItemsCSV;
  wireImport();
  document.getElementById('btn-reload').onclick = async () => {
    await flushSave(); // don't lose a pending edit
    await loadData();
    applyWorkspaceChrome();
    renderEditor();
    flashStatus('Reloaded', true);
  };

  document.getElementById('editor-body').addEventListener('change', onEditorChange);
  document.getElementById('editor-body').addEventListener('click', onEditorClick);
  wireBulk();

  wireReports();
  wireChanges();
  wireDates();
  wirePalette();

  // undo: the toast's button, or ⌘/Ctrl+Z when not typing (typing keeps the browser's own undo)
  document.getElementById('toast').addEventListener('click', (e) => {
    if (e.target.closest('[data-undo]')) undoLast();
    else if (e.target.closest('.toast-close')) e.currentTarget.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (isTyping(document.activeElement) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    undoLast();
  });

  // Leaving the page with a save still pending: send it anyway.
  window.addEventListener('pagehide', () => {
    if (saveTimer === null || !dataLoaded) return;
    syncEditorToState();
    const body = toCSV(allItems());
    // keepalive carries the date log's headers; a beacon can't, so it's only used for big files
    if (body.length < 60000) fetch('api/milestones', { method: 'POST', body, headers: auditHeaders(pendingMsg, 'Items table'), keepalive: true });
    else navigator.sendBeacon('api/milestones', body);
  });

  // Auto-fit while the user hasn't chosen a zoom; re-render otherwise.
  new ResizeObserver(() => {
    if (document.getElementById('view-gantt').classList.contains('hidden')) return;
    if (state.userZoomed) renderGantt();
    else fitZoom();
  }).observe(document.getElementById('gantt-scroll'));
}

// config.json (via the server) sets the app's title and logo. Without it, the defaults stay.
const APP_CONFIG = { title: 'Tracker', logo: '' };
async function loadConfig() {
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (res.ok) Object.assign(APP_CONFIG, await res.json());
  } catch { /* keep the defaults */ }
  const name = document.getElementById('brand-name');
  name.textContent = APP_CONFIG.title;
  name.hidden = !APP_CONFIG.title;
  document.title = APP_CONFIG.title;
  if (APP_CONFIG.logo) {
    const img = document.getElementById('brand-logo');
    img.alt = APP_CONFIG.title;
    img.onload = () => { img.hidden = false; document.getElementById('brand-mark').style.display = 'none'; };
    img.src = APP_CONFIG.logo;
  }
}

(async function init() {
  const f = document.getElementById('edit-form').elements;
  f.shape.innerHTML = optionList(SHAPES);
  document.getElementById('row-slider').value = state.rowH;
  const prefs = loadAppPrefs();
  setNavCollapsed(!!prefs.navCollapsed);
  applyTheme();
  if (['all', 'hover', 'none'].includes(prefs.linkMode)) state.linkMode = prefs.linkMode;
  if (prefs.showBaseline === false) state.showBaseline = false;
  wireEvents();
  await loadConfig();
  const linked = readHash()?.ws;
  if (linked) state.workspaceId = linked; // a link names its workspace; loadData checks it exists
  try {
    await loadData();
  } catch (err) {
    flashStatus(`Couldn’t load data: ${err.message}`, false, true);
    // Cover the app so nothing can be edited: changes couldn't be saved without losing the files.
    document.getElementById('load-failed-msg').textContent = err.message;
    document.getElementById('load-failed').hidden = false;
    document.getElementById('load-failed-retry').onclick = () => location.reload();
    return;
  }
  applyWorkspaceChrome();
  const link = readHash();
  if (link?.filter) Object.assign(ganttFilter, link.filter);
  switchView(link?.view || (VIEWS.includes(prefs.view) ? prefs.view : 'gantt'));
  setTimescale(prefs.timescale); // Quarters fits; the ResizeObserver keeps it fitted as layout settles
  if (link?.item && itemById(link.item)) showItemOnGantt(link.item);
  routeReady = true;
  writeHash();
  window.addEventListener('hashchange', () => { if (location.hash !== lastHash) followHash(); });
})();
