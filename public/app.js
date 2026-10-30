/* Tracker frontend — CSV-backed editor + SVG gantt.
 * Every item has a type: a milestone has a single date (start = end, drawn as a diamond; a top
 * level milestone is one under change control, drawn as a diamond in a ring);
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
// The chart's own colours, light and dark; G is the set in use (see applyTheme).
const GANTT_THEMES = {
  light: {
    bg: '#ffffff', alt: '#f9f8f5', line: '#e0ded6', strong: '#cccabc', tick: '#a8a69c', tierTop: '#ecebe4', tierBottom: '#f4f3ee',
    text: '#262626', textTop: '#1c1c1c', sub: '#5a5d5c', muted: '#7a7870', accent: '#e60000', today: '#1c1c1c',
    weekend: '#1c1c1c', weekendOpacity: 0.035, shadow: '#1c1c1c', shadowOpacity: 0.3, baseline: '#a8a69c',
    links: { dep: '#0f8b8d', roll: '#7c3aed' }, // connector colours stay clear of the RAG palette
    streamAccents: ['#e60000', '#1c1c1c', '#8e8d83', '#a43725', '#1f6fb2', '#cfbd9b', '#5a5d5c'],
  },
  dark: {
    bg: '#1f1f1d', alt: '#252523', line: '#34342f', strong: '#45443e', tick: '#5d5c55', tierTop: '#2c2c29', tierBottom: '#262624',
    text: '#ecebe4', textTop: '#f4f3ee', sub: '#b3b1a6', muted: '#9a988d', accent: '#ff5a5a', today: '#f4f3ee',
    weekend: '#ffffff', weekendOpacity: 0.03, shadow: '#000000', shadowOpacity: 0.5, baseline: '#8e8d83',
    links: { dep: '#2bb5b0', roll: '#a78bfa' },
    streamAccents: ['#ff5a5a', '#cccabc', '#8e8d83', '#d0705c', '#5b9bd5', '#cfbd9b', '#7a7870'],
  },
};
let G = GANTT_THEMES.light;
const COLUMNS = ['id', 'workspace_id', 'ref', 'title', 'type', 'description', 'stream_id', 'substream', 'owner', 'start', 'end', 'rag', 'parent', 'depends_on', 'baseline_start', 'baseline_end', 'gitlab_url', 'use_case_url'];
const MS_DAY = 86400000;

const state = {
  statuses: [],         // RAG options: {workspace_id, position, name, color, description, get_to_green, is_default}
  workspaces: [],       // {id, number, name, code, description, owner, lead, start, end, status, trend, item_term, milestone_term, task_term, created, updated}
  updates: [],          // weekly updates, every workspace: {id, workspace_id, stream ('' for the whole program), week_ending, status, summary, author, created, updated}
  streams: [],            // stream details, every workspace: {workspace_id, name, lead, trend}
  raid: [],             // risks, issues and dependencies, every workspace: {id, workspace_id, kind, ref, title, …, links: ['item:12', 'stream:Design']}
  raidNotes: [],        // their notes, only ever added to: {id, workspace_id, raid_id, at, by, text}
  reportComments: [],   // comments on passages of reports, every workspace: {id, workspace_id, report_id, field, quote, start, end, parent_id, at, by, text, resolved}
  lastWorkspaceId: 0,
  workspaceId: '',        // the workspace being viewed
  otherItems: [],       // items of every other workspace, kept so saves write the whole file
  otherReports: [],
  items: [],            // {id, workspace_id, ref, title, type, description, stream, substream, owner, start, end, status, parent, deps[]}
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

// A top level milestone is a milestone under change control: one date, like any milestone.
const TYPES = ['top', 'milestone', 'task'];
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
  t.Top = `Top level ${t.milestone}`;
  t.Tops = `Top level ${t.milestones}`;
  t.top = `top level ${t.milestone}`;
  t.tops = `top level ${t.milestones}`;
  return t;
}
let T = makeTerms();
const typeLabel = (t) => (t === 'task' ? T.Task : t === 'top' ? T.Top : T.Milestone);
const typeName = (m) => typeLabel(m.type);
const typeOptions = (selected) => TYPES.map(t => `<option value="${t}" ${t === selected ? 'selected' : ''}>${escAttr(typeLabel(t))}</option>`).join('');
// Reads a type as stored in milestones.csv: top level, milestone or task (blank → undefined).
const fileType = (v) => {
  const t = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return t.startsWith('top') ? 'top' : t.startsWith('t') ? 'task' : t.startsWith('m') ? 'milestone' : undefined;
};
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
    lines.push([m.id, m.workspace_id, m.ref, m.title, m.type, m.description, m.stream_id, m.substream, m.owner, m.start, m.end,
      m.status, m.parent, m.deps.join(';'), m.baseline_start, m.baseline_end, m.gitlab_url, m.use_case_url].map(csvEscape).join(','));
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
  stream_id: ['streamid'],
  stream: ['stream'], // files from before named the stream in each row
  substream: ['substream'],
  owner: ['owner'],
  start: ['start', 'startdate'],
  end: ['end', 'enddate', 'date'],
  status: ['rag', 'status'],
  parent: ['parent', 'rollsupto', 'rollup'],
  deps: ['dependson', 'dependencies', 'deps'],
  baseline_start: ['baselinestart'],
  baseline_end: ['baselineend'],
  gitlab_url: ['gitlaburl', 'gitlab'],
  use_case_url: ['usecaseurl', 'usecase'],
  top_level: ['toplevel'], // earlier files flagged top level milestones in their own column
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
    let type = fileType(get(r, 'type')) || (start < end ? 'task' : 'milestone');
    if (type === 'milestone' && readYes(get(r, 'top_level'))) type = 'top';
    if (type !== 'task') start = end;
    return {
      type,
      id: get(r, 'id'),
      workspace_id: get(r, 'workspace_id'),
      ref: get(r, 'ref'),
      title: get(r, 'title'),
      description: get(r, 'description'),
      // a stream named rather than pointed at (an older file or backup) is matched by name
      stream_id: get(r, 'stream_id') || streamIdFor(get(r, 'workspace_id'), get(r, 'stream'), false),
      substream: get(r, 'substream'),
      owner: get(r, 'owner'),
      start, end,
      status: get(r, 'status'), // normalised once the workspace is known
      parent: get(r, 'parent'),
      deps: get(r, 'deps').split(/[;|\s]+/).filter(Boolean),
      baseline_start: get(r, 'baseline_start'),
      baseline_end: get(r, 'baseline_end'),
      gitlab_url: get(r, 'gitlab_url'),
      use_case_url: get(r, 'use_case_url'),
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
  const id = takeId('milestones', () => String(Math.max(state.lastId, ...allItems().map(m => +m.id || 0)) + 1));
  state.lastId = Math.max(state.lastId, +id);
  return id;
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

/* ================= data load/save ================= */

async function loadData() {
  if (location.protocol === 'file:') throw new Error('the page was opened as a file — run node server.js and open the address it prints');
  const texts = await Promise.all(FILE_NAMES.map(async (file) => {
    const u = `api/${file}`;
    const r = await fetch(u, { cache: 'no-store' });
    // e.g. a server started before workspaces existed: stop rather than save items under the wrong workspace
    if (!r.ok) throw new Error(`${u} returned ${r.status} ${r.statusText} — the app must be opened through its own server (node server.js), not a separate web server or file://`);
    const text = await r.text();
    if (/^\s*</.test(text)) throw new Error(`${u} returned a web page instead of CSV — something between the browser and node server.js (a proxy or another web server) is answering instead`);
    synced[file] = { version: r.headers.get('X-Version'), text };
    return text;
  }));
  const [workspaces, statuses, streams, items, reports, updates, raid, raidNotes, reportComments] = texts;
  state.workspaces = rowsToWorkspaces(parseAny(workspaces));
  state.statuses = rowsToStatuses(parseAny(statuses));
  for (const p of state.workspaces) p.status = normaliseStatus(p.status, p.id);
  const created = !state.workspaces.length;
  if (created) state.workspaces.push(newWorkspace({ name: 'My workspace' }));
  state.streams = rowsToStreams(parseAny(streams));
  const allItems = rowsToItems(parseAny(items));
  const allReports = rowsToReports(parseAny(reports), allItems);
  state.updates = rowsToUpdates(parseAny(updates));
  state.raid = rowsToRaid(parseAny(raid));
  state.raidNotes = rowsToRaidNotes(parseAny(raidNotes));
  state.reportComments = rowsToComments(parseAny(reportComments));
  dataLoaded = true;
  if (created) await saveWorkspaces();
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
  if (id !== state.workspaceId && raidFilter.link) Object.assign(raidFilter, { link: '', status: 'open' }); // it links into the last workspace
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
  return saveCSV('milestones', msg, headers);
}
function auditHeaders(note, via) {
  const enc = encodeURIComponent;
  return {
    'X-Change-Via': enc(via), 'X-Change-Note': enc(note || ''),
    'X-Knock-On': [...knockOn].filter(id => !directEdits.has(id)).join(','),
  };
}
const saveReports = (msg) => saveCSV('reports', msg);
const saveStatuses = (msg) => saveCSV('statuses', msg);
const saveWorkspaces = (msg) => saveCSV('workspaces', msg);
const saveUpdates = (msg) => saveCSV('updates', msg);
const saveStreams = (msg) => saveCSV('streams', msg);
const saveRaid = (msg) => saveCSV('raid', msg);
const saveRaidNotes = (msg) => saveCSV('raid-notes', msg);
const saveComments = (msg) => saveCSV('report-comments', msg);

/* ---- working together ---- */
// Several people can have the app open at once. Each file is held with the version it was read
// at (synced[file]: { version, text }). A save says which version it was made from; if someone
// else has saved since, the server sends back the file as it is now, their changes are merged in
// (mergeFile) and the save is tried again. The server also says whenever a file changes
// (listenForChanges), and the change is merged in the same way, so everyone sees it within moments.
//
// The merge is per record and per field: a field someone else changed is taken from them, unless
// it was changed here too, to something different — then theirs, saved first, is kept and the
// conflict is listed for this person, who can put theirs back (showConflicts).
const synced = {};
const fieldsOf = (cols) => cols.filter(k => k !== 'id');
// Each file: how to read it, where its records are held, how to write it, and what a record is called.
const FILES = {
  workspaces: {
    parse: (t) => rowsToWorkspaces(parseAny(t)), all: () => state.workspaces, set: (l) => { state.workspaces = l; },
    csv: () => workspacesToCSV(state.workspaces), key: (p) => p.id, name: (p) => `Workspace ${p.name}`, quiet: ['updated'],
  },
  statuses: { // a workspace's RAG options are one list, merged as a whole
    parse: (t) => rowsToStatuses(parseAny(t)), all: () => state.statuses, set: (l) => { state.statuses = l; },
    csv: () => statusesToCSV(state.statuses), key: (g) => g.workspace_id, group: true,
    name: (g) => `RAG options of ${workspaceById(g.workspace_id)?.name || 'a workspace'}`,
  },
  streams: {
    parse: (t) => rowsToStreams(parseAny(t)), all: () => state.streams, set: (l) => { state.streams = l; },
    csv: () => streamsToCSV(state.streams), key: (l) => l.id, name: (l) => `Stream ${l.name}`,
  },
  milestones: {
    parse: (t) => keepCounters(() => rowsToItems(parseAny(t))), all: () => allItems(), set: (l) => setItems(l),
    csv: () => toCSV(allItems()), key: (m) => m.id, name: (m) => fullLabel(m) || `${T.Item} #${m.id}`,
  },
  reports: {
    parse: (t) => keepCounters(() => rowsToReports(parseAny(t), allItems())), all: () => allReports(), set: (l) => setReports(l),
    csv: () => reportsToCSV(allReports()), key: (r) => r.id, quiet: ['updated'],
    name: (r) => `Report on ${allItems().find(m => m.id === r.item_id)?.ref || 'an item'} for ${fmtShort(r.period_end)}`,
  },
  updates: {
    parse: (t) => rowsToUpdates(parseAny(t)), all: () => state.updates, set: (l) => { state.updates = l; },
    csv: () => updatesToCSV(state.updates), key: (u) => u.id, quiet: ['updated'],
    name: (u) => `Weekly update for ${[workspaceById(u.workspace_id)?.name, streamName(u.stream_id)].filter(Boolean).join(' · ')}, w/e ${fmtShort(u.week_ending)}`,
  },
  raid: {
    parse: (t) => rowsToRaid(parseAny(t)), all: () => state.raid, set: (l) => { state.raid = l; },
    csv: () => raidToCSV(state.raid), key: (r) => r.id, quiet: ['updated'],
    name: (r) => `${RAID_KINDS[r.kind]?.one || 'Entry'} ${r.ref || `#${r.id}`} ${r.title}`.trim(),
  },
  'raid-notes': {
    parse: (t) => rowsToRaidNotes(parseAny(t)), all: () => state.raidNotes, set: (l) => { state.raidNotes = l; },
    csv: () => raidNotesToCSV(state.raidNotes), key: (n) => n.id,
    name: (n) => `Note on ${state.raid.find(r => r.id === n.raid_id)?.ref || 'an entry'}, ${fmtStamp(n.at)}`,
  },
  'report-comments': {
    parse: (t) => rowsToComments(parseAny(t)), all: () => state.reportComments, set: (l) => { state.reportComments = l; },
    csv: () => commentsToCSV(state.reportComments), key: (c) => c.id,
    name: (c) => `${c.parent_id ? 'Reply' : 'Comment'} on ${FILES.reports.name(allReports().find(r => r.id === c.report_id) || { period_end: '' })}, ${fmtStamp(c.at)}`,
  },
};
const FILE_NAMES = Object.keys(FILES); // in the order they depend on each other

// Reading another copy of a file mustn't move the id counters.
function keepCounters(fn) {
  const { lastId, lastReportId } = state;
  const out = fn();
  state.lastId = Math.max(lastId, state.lastId);
  state.lastReportId = Math.max(lastReportId, state.lastReportId);
  return out;
}
function setItems(list) {
  state.items = list.filter(m => m.workspace_id === state.workspaceId);
  state.otherItems = list.filter(m => m.workspace_id !== state.workspaceId);
}
function setReports(list) {
  state.reports = list.filter(r => r.workspace_id === state.workspaceId);
  state.otherReports = list.filter(r => r.workspace_id !== state.workspaceId);
}

// Equal values; a field that's missing counts as blank.
function same(a, b) {
  if (a === b) return true;
  const obj = (x) => x && typeof x === 'object';
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (obj(a) && obj(b) && !Array.isArray(a) && !Array.isArray(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => same(a[k] ?? '', b[k] ?? ''));
  return JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
}
// A grouped file's records are its lists (one per workspace), and back.
function grouped(f, list) {
  if (!f.group) return list;
  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.workspace_id)) groups.set(r.workspace_id, { workspace_id: r.workspace_id, rows: [] });
    groups.get(r.workspace_id).rows.push(r);
  }
  return [...groups.values()];
}
const ungrouped = (f, recs) => (!f.group ? recs : recs.flatMap(g => g.rows));

// Merge two sets of changes to the same starting point: `mine` (made here) and `theirs` (saved by
// someone else). Records are matched by key. The result keeps theirs' order, with records added
// here placed after the one they followed. Records made here are updated in place, so anything
// holding one (an open form) still has it.
function merge3(f, baseList, mineList, theirsList) {
  const [base, mine, theirs] = [baseList, mineList, theirsList].map(l => new Map(grouped(f, l).map(r => [f.key(r), r])));
  const conflicts = [];
  const out = new Map();
  const note = (kind, rec, extra = {}) => conflicts.push({ kind, key: f.key(rec), name: f.name(rec), ...extra });
  for (const [k, t] of theirs) {
    const b = base.get(k), m = mine.get(k);
    if (!m) {
      if (!b) out.set(k, t); // added by them
      else if (!same(b, t)) { out.set(k, t); note('kept', t, { mine: b }); } // deleted here, changed by them: kept
      continue; // deleted here
    }
    const fields = [...new Set([...Object.keys(b || {}), ...Object.keys(m), ...Object.keys(t)])];
    const merged = {};
    for (const x of fields) {
      const bv = b ? b[x] : '', mv = m[x], tv = t[x];
      if (same(mv, bv) || same(mv, tv)) merged[x] = tv;
      else if (same(tv, bv)) merged[x] = mv;
      else if (f.quiet?.includes(x)) merged[x] = String(mv) > String(tv) ? mv : tv;
      else { merged[x] = tv; note('field', t, { field: x, mine: mv, theirs: tv }); }
    }
    out.set(k, Object.assign(m, structuredClone(merged)));
  }
  // Records only here: added here, or deleted by them.
  let prev = null;
  const after = new Map(); // key → records added here that follow it
  for (const [k, m] of mine) {
    if (!theirs.has(k)) {
      const b = base.get(k);
      if (!b) { if (!after.has(prev)) after.set(prev, []); after.get(prev).push([k, m]); }
      else if (!same(b, m)) note('deleted', m, { mine: m }); // changed here, deleted by them: stays deleted
    }
    if (out.has(k)) prev = k;
  }
  const result = [...(after.get(null) || []).map(([, r]) => r)];
  for (const [k, r] of out) result.push(r, ...(after.get(k) || []).map(([, x]) => x));
  for (const [k, list] of after) if (k !== null && !out.has(k)) result.push(...list.map(([, x]) => x));
  return { list: ungrouped(f, result), conflicts };
}

// A form saves only what was changed in it, so a field someone else changed while it was open keeps
// their value: the form's values, less those still as they were when it opened (`was`).
const changedFrom = (v, was) => (!was ? v : Object.fromEntries(Object.entries(v).filter(([k, x]) => !same(x, was[k] ?? ''))));

// Bring someone else's version of a file into what's on screen, keeping the changes made here.
// Items that only moved here because something they depend on moved (`knockOn`) aren't listed as
// conflicts: putting back the change that moved them moves them again.
function mergeFile(file, text, version, knockOn = new Set()) {
  const f = FILES[file];
  if (file === 'milestones') syncEditorToState();
  const { list, conflicts } = merge3(f, f.parse(synced[file].text), f.all(), f.parse(text));
  f.set(list);
  synced[file] = { version, text };
  return conflicts.filter(c => !(c.kind === 'field' && knockOn.has(c.key))).map(c => ({ ...c, file }));
}

// Every change is written back to its CSV. Saves are queued so they reach the server in order, and
// each writes the file as it is when its turn comes, so a merge in between is never undone.
function saveCSV(file, msg, headers = {}) {
  if (!dataLoaded) {
    flashStatus('Not saved — the data hasn’t loaded, so saving would overwrite it', false, true);
    return Promise.resolve(false);
  }
  saveQueue = saveQueue.then(async () => {
    flashStatus('Saving…', null);
    const conflicts = [];
    try {
      for (let tries = 0; ; tries++) {
        const body = FILES[file].csv();
        if (body === synced[file].text) break; // nothing new (an earlier save already wrote it)
        const res = await fetch(`api/${file}`, { method: 'POST', body, headers: { ...headers, 'X-Base-Version': synced[file].version } });
        const out = await res.json();
        if (res.status === 409 && out.conflict && tries < 5) {
          conflicts.push(...mergeFile(file, out.text, out.version, new Set((headers['X-Knock-On'] || '').split(','))));
          afterMerge();
          continue;
        }
        if (!out.ok) throw new Error(out.conflict ? 'others kept changing it at the same time' : out.error || 'server error');
        synced[file] = { version: out.version, text: body };
        if (out.text) { mergeFile(file, out.text, out.version); afterMerge(); } // the server added to it (signed notes)
        break;
      }
      flashStatus([msg, conflicts.length ? 'Saved, with others’ changes' : 'Saved ✓'].filter(Boolean).join(' · '), true);
      if (conflicts.length) showConflicts(conflicts);
      return true;
    } catch (err) {
      flashStatus(`Save failed (${err.message}) — your changes are still on screen`, false, true);
      return false;
    }
  });
  return saveQueue;
}

// Fetch the files that have changed on the server and merge them in. Runs in the save queue, so it
// never overlaps a save.
function pullChanges(versions) {
  saveQueue = saveQueue.then(async () => {
    const conflicts = [];
    let changed = false;
    try {
      for (const file of FILE_NAMES) {
        if (!synced[file] || (versions && versions[file] === synced[file].version)) continue;
        const res = await fetch(`api/${file}`, { cache: 'no-store' });
        if (!res.ok) continue;
        const version = res.headers.get('X-Version'), text = await res.text();
        if (version === synced[file].version) continue;
        conflicts.push(...mergeFile(file, text, version, new Set([...knockOn].filter(id => !directEdits.has(id)))));
        changed = true;
      }
    } catch { return; } // offline for now: the next check tries again
    if (!changed) return;
    afterMerge();
    flashStatus('Updated with changes from others', true);
    if (conflicts.length) showConflicts(conflicts);
  });
  return saveQueue;
}

// Redraw after a merge, keeping the place: the workspace (unless it's gone), the chart's range,
// the Items grid's order and the focus.
function afterMerge() {
  const range = [state.rangeStart, state.rangeEnd];
  const id = workspaceById(state.workspaceId) ? state.workspaceId : state.workspaces[0]?.id;
  if (!id) return;
  if (id !== state.workspaceId) selectWorkspace(id);
  else { T = makeTerms(currentWorkspace()); useStatuses(id); }
  if (id === state.workspaceId) [state.rangeStart, state.rangeEnd] = range;
  applyWorkspaceChrome();
  rerenderCurrentView();
  if (isShown('editor')) refreshEditor();
  else document.getElementById('editor-body').innerHTML = ''; // a hidden grid's old values mustn't be synced back
}

// Hear about others' saves as they happen. If the event stream can't get through (a proxy that
// holds it back), checking the versions every 20 seconds, and on coming back to the tab, still
// catches them.
function listenForChanges() {
  const onVersions = (e) => { try { pullChanges(JSON.parse(e.data)); } catch { /* malformed: ignore */ } };
  if (window.EventSource) {
    const es = new EventSource('api/events');
    es.addEventListener('versions', onVersions);
    es.addEventListener('change', (e) => {
      try { const { file, version } = JSON.parse(e.data); if (synced[file] && version !== synced[file].version) pullChanges({ ...versionsNow(), [file]: version }); } catch { /* ignore */ }
    });
  }
  const check = async () => {
    try { const res = await fetch('api/versions', { cache: 'no-store' }); if (res.ok) pullChanges(await res.json()); } catch { /* offline */ }
  };
  setInterval(() => { if (!document.hidden) check(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
const versionsNow = () => Object.fromEntries(FILE_NAMES.map(f => [f, synced[f]?.version]));

// What was changed both here and by someone else. Theirs is showing; "Use mine" puts this person's
// change back (and saves it), which is then just another change for everyone else to receive.
const FIELD_NAMES = {
  status: 'RAG', start: 'Start', end: 'End', ref: 'Ref', deps: 'Depends on', parent: 'Rolls up to', substream: 'Sub-stream',
  baseline_start: 'Baseline start', baseline_end: 'Baseline end', gitlab_url: 'GitLab URL', use_case_url: 'Use case URL',
  exec_summary: 'Executive summary', next_steps: 'Next steps', get_to_green: 'Get to green plan', period_end: 'Period ending',
  week_ending: 'Week ending', lead: 'Area lead', author: 'Author', number: 'Program number', rows: 'RAG options',
  likelihood: 'Likelihood', impact: 'Impact', priority: 'Priority', dep_type: 'Dependency type', dep_priorities: 'Dependency priorities', dep_types: 'Dependency types', text: 'Status update', due: 'Due', party: 'Other party', response: 'Response', links: 'Linked to', kind: 'Type',
  impact_if: 'Impact if delayed or blocked', accountable: 'Accountable people',
  item_term: 'Word for an item', milestone_term: 'Word for a milestone', task_term: 'Word for a task', hidden: 'Hidden fields and features',
};
const fieldName = (k) => FIELD_NAMES[k] || k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ');
function shownValue(v, field) {
  if (field === 'rows') return v.map(x => x.name).join(', ');
  if (Array.isArray(v)) v = v.join(', ');
  const t = String(v ?? '').trim();
  return t ? (t.length > 240 ? t.slice(0, 240) + '…' : t) : '(blank)';
}
let conflictList = [];
// One row per record, with each field that clashed; a milestone's start and end show as its date.
function conflictGroups() {
  const groups = new Map();
  for (const c of conflictList) {
    const k = `${c.file}\u0000${c.key}`;
    if (!groups.has(k)) groups.set(k, { file: c.file, key: c.key, name: c.name, kind: c.kind, list: [] });
    groups.get(k).list.push(c);
  }
  return [...groups.values()];
}
function showConflicts(list) {
  const dlg = document.getElementById('conflict-dialog');
  conflictList = dlg.open ? [...conflictList, ...list] : list;
  const groups = conflictGroups();
  const row = (g, i) => {
    const done = g.list.every(c => c.done);
    let vals;
    if (g.kind === 'field') {
      const fields = g.list.filter(c => !(c.field === 'start' && g.list.some(e => e.field === 'end' && same(e.mine, c.mine) && same(e.theirs, c.theirs))));
      vals = fields.map(c => {
        const label = c.field === 'end' && fields.length < g.list.length ? 'Date' : fieldName(c.field);
        return `<span>${escAttr(label)}</span><span>Theirs: ${escAttr(shownValue(c.theirs, c.field))}<br>Yours: ${escAttr(shownValue(c.mine, c.field))}</span>`;
      }).join('');
    } else vals = `<span></span><span>${g.kind === 'deleted' ? 'They deleted it while you were changing it.' : 'They changed it while you were deleting it, so it’s been kept.'}</span>`;
    const label = g.kind === 'deleted' ? 'Put it back' : g.kind === 'kept' ? 'Delete it' : 'Use mine';
    return `<li class="${done ? 'done' : ''}"><div class="cf-what">${escAttr(g.name)}</div><div class="cf-vals">${vals}</div>
      <button type="button" class="btn btn-sm" data-cf="${i}">${label}</button></li>`;
  };
  document.getElementById('cf-list').innerHTML = groups.map(row).join('');
  document.getElementById('cf-all').hidden = groups.filter(g => !g.list.every(c => c.done)).length < 2;
  if (!dlg.open && groups.length) dlg.showModal();
}
function useMine(groups) {
  const files = new Set();
  for (const g of groups) {
    const todo = g.list.filter(c => !c.done);
    if (!todo.length) continue;
    const f = FILES[g.file];
    const recs = grouped(f, f.all());
    const rec = recs.find(r => f.key(r) === g.key);
    if (g.kind === 'field' && rec) {
      const changes = Object.fromEntries(todo.map(c => [c.field, structuredClone(c.mine)]));
      if (g.file === 'milestones' && state.items.includes(rec)) updateItem(rec, changes); // moves what depends on it too
      else Object.assign(rec, changes);
    } else if (g.kind === 'deleted' && !rec) recs.push(structuredClone(todo[0].mine));
    else if (g.kind === 'kept' && rec) recs.splice(recs.indexOf(rec), 1);
    else continue;
    f.set(ungrouped(f, recs));
    if (g.kind === 'kept' && g.file === 'milestones') removeItem(g.key); // and its links
    for (const c of todo) c.done = true;
    files.add(g.file);
  }
  afterMerge();
  for (const file of files) file === 'milestones' ? saveData('Your change put back', 'Conflict') : saveCSV(file, 'Your change put back');
  showConflicts([]);
  if (conflictList.every(c => c.done)) document.getElementById('conflict-dialog').close();
}
function wireConflicts() {
  document.getElementById('cf-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cf]');
    if (b) useMine([conflictGroups()[+b.dataset.cf]]);
  });
  document.getElementById('cf-all').onclick = () => useMine(conflictGroups());
}

/* ---- ids ---- */
// New records take their ids from the server, so ids stay unique however many people are adding at
// once. One is fetched when it's needed (the caller waits, briefly); during a burst, such as an
// import, a block is fetched so the rest come straight from hand. Ids still in hand when the page
// closes are never used, so a burst can leave a gap in the numbers. If the server can't be reached,
// the next number after the highest seen is used.
const idPool = { workspaces: [], milestones: [], reports: [], updates: [], streams: [], raid: [], 'raid-notes': [], 'report-comments': [] };
const idLastTaken = {};
function takeId(file, fallback) {
  const burst = Date.now() - (idLastTaken[file] || 0) < 2000;
  idLastTaken[file] = Date.now();
  if (!idPool[file].length) {
    try {
      const x = new XMLHttpRequest();
      x.open('POST', `api/ids?file=${file}&n=${burst ? 25 : 1}`, false); // waits: the caller needs the id now
      x.send();
      const o = JSON.parse(x.responseText);
      if (o.ok) idPool[file].push(...o.ids);
    } catch { /* server unreachable */ }
  }
  return idPool[file].shift() ?? fallback();
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
// snapshot every record set first. The toast that reports the change offers Undo, as do
// ⌘/Ctrl+Z when you're not typing and the chart's Undo button (shown while there's something
// to take back). Undo puts the snapshot back and saves what it changes.

const undoStack = []; // [{ label, snap }], newest last
const UNDO_KEYS = ['items', 'reports', 'updates', 'workspaces', 'statuses', 'streams', 'raid', 'raidNotes', 'reportComments'];
const UNDO_FILES = { items: 'milestones', reports: 'reports', updates: 'updates', workspaces: 'workspaces', statuses: 'statuses', streams: 'streams', raid: 'raid', raidNotes: 'raid-notes', reportComments: 'report-comments' };

function snapshotData() {
  syncEditorToState();
  return {
    items: JSON.stringify(allItems()), reports: JSON.stringify(allReports()), updates: JSON.stringify(state.updates),
    workspaces: JSON.stringify(state.workspaces), statuses: JSON.stringify(state.statuses), streams: JSON.stringify(state.streams),
    raid: JSON.stringify(state.raid), raidNotes: JSON.stringify(state.raidNotes), reportComments: JSON.stringify(state.reportComments), workspaceId: state.workspaceId,
  };
}

// Call with a snapshot taken before the change, once the change is made.
function offerUndo(snap, label) {
  undoStack.push({ label, snap, after: snapshotData() });
  if (undoStack.length > 30) undoStack.shift();
  showToast(label, true);
  updateUndoButton();
}

function updateUndoButton() {
  const btn = document.getElementById('btn-undo');
  const u = undoStack.at(-1);
  btn.hidden = !u;
  btn.title = u ? `Undo: ${u.label} (⌘/Ctrl+Z)` : '';
}

async function undoLast() {
  const u = undoStack.pop();
  if (!u) return showToast('Nothing to undo');
  if (!leavePaneEdit()) { undoStack.push(u); return; }
  updateUndoButton();
  hideQuick();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  clearTimeout(saveTimer);
  saveTimer = null;
  // Only this change is taken back: anything changed since (by others, or here in another way) is
  // kept, by merging "from after the change back to before it" into how things are now.
  const now = snapshotData();
  const s = u.snap, back = {};
  let kept = 0;
  for (const k of UNDO_KEYS) {
    if (now[k] === u.after[k]) back[k] = JSON.parse(s[k]);
    else {
      const r = merge3(FILES[UNDO_FILES[k]], JSON.parse(u.after[k]), JSON.parse(s[k]), JSON.parse(now[k]));
      back[k] = r.list;
      kept += r.conflicts.length;
    }
  }
  const changed = UNDO_KEYS.filter(k => now[k] !== JSON.stringify(back[k]));
  state.workspaces = back.workspaces;
  state.statuses = back.statuses;
  state.updates = back.updates;
  state.streams = back.streams;
  state.raid = back.raid;
  state.raidNotes = back.raidNotes;
  state.reportComments = back.reportComments;
  state.items = []; state.reports = [];
  state.otherItems = back.items;
  state.otherReports = back.reports;
  document.getElementById('editor-body').innerHTML = ''; // so a sync can't write the undone values back
  const range = [state.rangeStart, state.rangeEnd];
  selectWorkspace(state.workspaces.some(p => p.id === state.workspaceId) ? state.workspaceId : s.workspaceId);
  [state.rangeStart, state.rangeEnd] = range;
  applyWorkspaceChrome();
  rerenderCurrentView();
  if (isShown('editor')) renderEditor();
  showToast(`Undone: ${u.label}${kept ? ' · anything changed again since was left as it is' : ''}`);
  knockOn.clear();
  directEdits.clear();
  const save = { items: () => saveData(`Undone: ${u.label}`, 'Undo'), reports: saveReports, updates: saveUpdates, workspaces: saveWorkspaces, statuses: saveStatuses, streams: saveStreams, raid: saveRaid, raidNotes: saveRaidNotes, reportComments: saveComments };
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

// Widen the range (never narrow it) so these items are on the chart: an item added or moved
// beyond the range would otherwise just vanish from it. The chart refits unless the user has
// set a zoom, and scrolls the first item into view.
function growRangeTo(ids) {
  if (!state.rangeStart) return false;
  let grown = false;
  for (const id of ids) {
    const m = itemById(id);
    const s = m && parseDate(m.start), e = m && parseDate(m.end);
    if (!s || !e) continue;
    if (s < state.rangeStart) { state.rangeStart = new Date(s.getFullYear(), s.getMonth(), 1 - 14); grown = true; }
    if (e > state.rangeEnd) { state.rangeEnd = new Date(e.getFullYear(), e.getMonth() + 1, 14); grown = true; }
  }
  if (!grown) return false;
  document.getElementById('range-start').value = fmtISO(state.rangeStart);
  document.getElementById('range-end').value = fmtISO(state.rangeEnd);
  if (isShown('gantt')) {
    if (!state.userZoomed) fitZoom();
    requestAnimationFrame(() => document.querySelector(`#gantt-container .gantt-item[data-id="${ids[0]}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  return true;
}

// Fit the range to the items shown, and the zoom to the window unless the user has set one.
function fitRange() {
  autoRange();
  if (state.userZoomed) renderGantt(); else fitZoom();
}

// Items the filters would show but the date range hides, named under the toolbar with a
// one-click fit, so an item dated beyond the range is never silently missing.
function renderOutsideNote(outside) {
  const note = document.getElementById('g-outside');
  note.hidden = !outside.length;
  if (note.hidden) return;
  const sorted = [...outside].sort((a, b) => a._s - b._s);
  const when = (m) => m._task ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end);
  const names = sorted.slice(0, 3).map(m => `<b>${escAttr(fullLabel(m))}</b> (${when(m)})`).join(', ');
  const more = sorted.length > 3 ? ` and ${sorted.length - 3} more` : '';
  note.innerHTML = `<span>${count(sorted.length, T.item, T.items)} outside this date range: ${names}${more}.</span>
    <button type="button" class="link-btn" data-act="fit">Fit the range to everything</button>`;
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

// Push items later wherever a dependency is violated (topological order), and move a milestone
// later to fit what rolls up to it when that was chosen for this change (see guardChange).
// Task → task dependencies start the next day; anything involving a milestone can share the day.
let rollupMove = new Set(); // ids of milestones that may move to fit their roll-ups, during one change
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
    if (rollupMove.has(m.id)) for (const c of children.get(m.id) || []) {
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

/* ---- change control ---- */
// Top level milestones are under change control: anything that would move one (directly or as a
// knock-on), delete it or take it out of change control first lists what changes and asks.

const readYes = (v) => (/^(y|yes|true|1|x|✓)$/i.test(String(v ?? '').trim()) ? 'yes' : '');
const isTopLevel = (m) => m?.type === 'top';

// How each top level milestone in `before` ([{ m, start, end }]) has been changed since.
function topLevelHits(before) {
  return before.map(({ m, end }) => {
    if (!state.items.includes(m)) return { m, kind: 'deleted' };
    if (!isTopLevel(m)) return { m, kind: 'unflagged', task: isTask(m) };
    if (m.end !== end) return { m, kind: 'moved', from: end, to: m.end };
    return null;
  }).filter(Boolean);
}

// Make a change, but if it touches a top level milestone, take it back and ask first; if confirmed
// the change is made again. Resolves to the change's result, or null if it was cancelled.
async function guardTopLevel(apply) {
  const restore = checkpoint();
  const before = state.items.filter(isTopLevel).map(m => ({ m, end: m.end }));
  const res = apply();
  if (res?.error) return res;
  const hits = topLevelHits(before);
  if (!hits.length) return res;
  restore();
  if (!await confirmTopLevel(hits)) return null;
  return apply();
}

// Returns a function that puts the items (and the change log's notes) back exactly as they are now.
function checkpoint() {
  const list = state.items, kept = [...list];
  const saved = list.map(x => [x, structuredClone(x)]);
  const audit = [new Set(knockOn), new Set(directEdits)];
  return () => {
    state.items = list;
    list.splice(0, list.length, ...kept);
    for (const [x, v] of saved) { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, v); }
    for (const [set, was] of [[knockOn, audit[0]], [directEdits, audit[1]]]) { set.clear(); was.forEach(id => set.add(id)); }
  };
}

/* ---- roll-up clashes ---- */
// Something that ends after the milestone it rolls up to is a clash. When a change makes one (or
// makes one worse), the person chooses for each milestone: move it later to fit, or keep its date
// and flag the clash, which then shows on the chart and in the Items grid until it's resolved.

// Each clash: { c, p, gap } — c ends `gap` days after p, the milestone it rolls up to.
function rollupClashes() {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const out = [];
  for (const c of state.items) {
    const p = c.parent && byId.get(c.parent);
    if (p?.end && c.end && c.end > p.end) out.push({ c, p, gap: daysBetween(p.end, c.end) });
  }
  return out;
}
const clashGaps = () => new Map(rollupClashes().map(x => [x.c.id, x.gap]));
// Clashes that are new, or wider than they were, since `gaps` (from clashGaps()).
const freshClashes = (gaps) => rollupClashes().filter(x => x.gap > (gaps.get(x.c.id) || 0));
const clashOf = (m) => rollupClashes().find(x => x.c === m);
const clashesInto = (m) => rollupClashes().filter(x => x.p === m);

// Every change on the items goes through here: roll-up clashes it causes are asked about (move the
// milestone or flag it), then top level milestones it touches are confirmed (guardTopLevel).
// Resolves to the change's result, or null if it was cancelled at either step.
async function guardChange(apply) {
  const gaps = clashGaps();
  const first = rollupPlan(apply, gaps, new Map());
  if (first.error) return first.error;
  let moves = new Set();
  if (first.rows.length) {
    const decided = await askRollup((choices) => rollupPlan(apply, gaps, choices));
    if (!decided) return null;
    moves = new Set([...decided].filter(([, v]) => v === 'move').map(([id]) => id));
  }
  rollupMove = moves;
  try { return await guardTopLevel(apply); } finally { rollupMove = new Set(); }
}

// What the change would ask about, given the choices made so far (Map id → 'move' | 'flag'): one
// row per milestone it leaves finishing before what rolls up to it. Moving a milestone can push
// others (and what rolls up to them) along, so this repeats until nothing new comes up. Nothing
// is kept. Returns { rows: [{ p, end, latest, kids, choice }], decided }, or { error }.
function rollupPlan(apply, gaps, choices) {
  const decided = new Map(), rows = [];
  for (;;) {
    const restore = checkpoint();
    rollupMove = new Set([...decided].filter(([, v]) => v === 'move').map(([id]) => id));
    const res = apply();
    rollupMove = new Set();
    const groups = new Map();
    if (!res?.error) for (const x of freshClashes(gaps)) {
      if (decided.has(x.p.id)) continue;
      if (!groups.has(x.p.id)) groups.set(x.p.id, { p: x.p, end: x.p.end, kids: [] });
      groups.get(x.p.id).kids.push({ c: x.c, end: x.c.end, gap: x.gap });
    }
    restore();
    if (res?.error) return { error: res };
    if (!groups.size) return { rows, decided };
    for (const g of groups.values()) {
      g.latest = g.kids.reduce((a, k) => (k.end > a ? k.end : a), g.end);
      // under change control, keeping the date is the safer default
      g.choice = choices.get(g.p.id) || (isTopLevel(g.p) ? 'flag' : 'move');
      decided.set(g.p.id, g.choice);
      rows.push(g);
    }
  }
}

// The roll-up question: a row per milestone, each to move or flag. Changing one re-works the list
// (moving a milestone can reach others). Resolves to Map(id → 'move' | 'flag'), or null.
function askRollup(plan) {
  const dlg = document.getElementById('ru-dialog');
  if (dlg.open) return Promise.resolve(null);
  const choices = new Map();
  let current;
  const render = () => {
    current = plan(choices);
    const rows = current.rows, n = rows.length;
    document.getElementById('ru-heading').textContent = n > 1
      ? `${n} ${T.milestones} now finish before what rolls up to them` : `${fullLabel(rows[0].p)} now finishes before what rolls up to it`;
    document.getElementById('ru-list').innerHTML = rows.map(g => {
      const kids = g.kids.map(k => `<span>${escAttr(isTask(k.c) ? T.Task : T.Milestone)}</span><span>${escAttr(fullLabel(k.c))} ends ${fmtNice(k.end)}, ${daysText(k.gap)} after it</span>`).join('');
      return `<li><div class="cf-what">${escAttr(fullLabel(g.p))} <small>· ${fmtNice(g.end)}${isTopLevel(g.p) ? ' · top level' : ''}</small></div>
        <div class="cf-vals">${kids}</div>
        <div class="ru-pick" role="radiogroup">
          <label><input type="radio" name="ru-${g.p.id}" data-ru="${g.p.id}" value="move" ${g.choice === 'move' ? 'checked' : ''} /> Move it to <b>${fmtNice(g.latest)}</b></label>
          <label><input type="radio" name="ru-${g.p.id}" data-ru="${g.p.id}" value="flag" ${g.choice === 'flag' ? 'checked' : ''} /> Keep ${fmtNice(g.end)} and flag the clash</label>
        </div></li>`;
    }).join('');
  };
  render();
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('.btn[value="ok"]').focus();
  // Answered by the button pressed (or Esc), not the close event, which a hidden page can hold back.
  return new Promise(resolve => {
    const form = dlg.querySelector('form');
    const done = (ok) => {
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('change', onChange);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(ok ? current.decided : null);
    };
    const onChange = (e) => {
      if (!e.target.dataset.ru) return;
      choices.set(e.target.dataset.ru, e.target.value);
      render();
      dlg.querySelector(`[data-ru="${e.target.dataset.ru}"][value="${e.target.value}"]`)?.focus();
    };
    const onSubmit = (e) => done(e.submitter?.value === 'ok');
    const onCancel = () => done(false);
    const onClose = () => done(dlg.returnValue === 'ok');
    form.addEventListener('submit', onSubmit);
    form.addEventListener('change', onChange);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
  });
}

function confirmTopLevel(hits) {
  const dlg = document.getElementById('tl-dialog');
  if (dlg.open) return Promise.resolve(false); // one at a time
  const n = hits.length;
  document.getElementById('tl-heading').textContent = n > 1
    ? `This changes ${n} top level ${T.milestones}` : `This changes a top level ${T.milestone}`;
  document.getElementById('tl-list').innerHTML = hits.map(h => {
    const what = h.kind === 'deleted' ? '<span>Deleted</span><span>It will be removed from the plan.</span>'
      : h.kind === 'unflagged' ? `<span>Control</span><span>${h.task ? `Becomes ${withArticle(T.task)}, so it` : 'It'} will no longer be under change control.</span>`
      : `<span>Date</span><span>${fmtNice(h.from)} → <b>${fmtNice(h.to)}</b> (${daysBetween(h.from, h.to) > 0 ? '+' : '−'}${daysText(Math.abs(daysBetween(h.from, h.to)))})</span>`;
    return `<li><div class="cf-what">${escAttr(fullLabel(h.m))}</div><div class="cf-vals">${what}</div></li>`;
  }).join('');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('[value="cancel"].btn').focus();
  // Answered by the button pressed (or Esc), not the close event, which a hidden page can hold back.
  return new Promise(resolve => {
    const form = dlg.querySelector('form');
    const done = (ok) => {
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(ok);
    };
    const onSubmit = (e) => done(e.submitter?.value === 'ok');
    const onCancel = () => done(false);
    const onClose = () => done(dlg.returnValue === 'ok');
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
  });
}

function removeItem(id) {
  state.items = state.items.filter(m => m.id !== id);
  for (const m of state.items) {
    m.deps = m.deps.filter(d => d !== id);
    if (m.parent === id) m.parent = '';
  }
}

/* ================= gantt rendering ================= */

const MIN_STREAM_COL_W = 130;
const MIN_SUB_COL_W = 130;
const MAX_STREAM_COL_W = 210; // longer stream / sub-stream names wrap onto more lines rather than widening the column
const MAX_SUB_COL_W = 180;
const STREAM_LINE_H = 17;
const SUB_LINE_H = 15;
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

// Label columns grow to fit the longest stream and sub-stream names up to a cap; longer names wrap.
const hasSubStreams = () => state.items.some(m => m.substream);
const widest = (names, size, weight) => Math.max(0, ...[...new Set(names)].filter(Boolean).map(n => textW(n, size, weight)));
const streamColWidth = () => Math.ceil(Math.min(MAX_STREAM_COL_W, Math.max(hasSubStreams() ? MIN_STREAM_COL_W : 170, widest(state.items.map(m => streamName(m.stream_id)), 14, 700) + 40)));
const subColWidth = () => Math.ceil(Math.min(MAX_SUB_COL_W, Math.max(MIN_SUB_COL_W, widest(state.items.map(m => m.substream), 12, 600) + 24)));
const labelWidth = () => streamColWidth() + (hasSubStreams() ? subColWidth() : 0);

function svgEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const REF_GAP = 5;
const measureCtx = document.createElement('canvas').getContext('2d');

function textW(s, size, weight = 400) {
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(s).width;
}
// Word-wrap a name into lines no wider than px; a single word too long for a line is broken mid-word.
function wrapText(s, px, size, weight = 400) {
  const lines = [];
  let line = '';
  for (let word of String(s || '').split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textW(next, size, weight) <= px) { line = next; continue; }
    if (line) lines.push(line);
    while (textW(word, size, weight) > px && word.length > 1) {
      let n = word.length - 1;
      while (n > 1 && textW(word.slice(0, n), size, weight) > px) n--;
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}
// Multi-line SVG text, its lines centred vertically on cy.
function svgLines(attrs, lines, cy, lineH) {
  const t = svgEl('text', attrs);
  const y0 = cy - (lines.length - 1) * lineH / 2;
  lines.forEach((l, i) => t.appendChild(svgEl('tspan', { x: attrs.x, y: y0 + i * lineH }, l)));
  return t;
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
  return m.owner || '';
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

function layoutStreams(items, xOf, rm, minX, maxX) {
  // Group by stream → sub-stream (first-appearance order), then pack each sub-stream into rows.
  const streams = [], streamMap = new Map();
  streams.maxRight = 0; // rightmost label edge, so the chart can widen to show it whole
  for (const m of items) {
    let stream = streamMap.get(m.stream_id);
    if (!stream) {
      stream = { id: m.stream_id, name: streamName(m.stream_id), subs: [], subMap: new Map() };
      streamMap.set(m.stream_id, stream);
      streams.push(stream);
    }
    let sub = stream.subMap.get(m.substream);
    if (!sub) {
      sub = { name: m.substream, items: [] };
      stream.subMap.set(m.substream, sub);
      stream.subs.push(sub);
    }
    sub.items.push(m);
  }
  sortStreams(streams);
  const oneEach = ganttSort.rows !== 'packed';
  const folded = collapsedStreams();
  const subCol = hasSubStreams();
  const nameW = (subCol ? streamColWidth() : labelWidth()) - 40, subW = subColWidth() - 24;
  for (const stream of streams) {
    stream.lines = wrapText(stream.name, nameW, 14, 700);
    const nameH = stream.lines.length * STREAM_LINE_H + 14;
    if (folded.has(stream.id)) {
      // folded: one summary row for the whole stream
      const all = stream.subs.flatMap(sub => sub.items);
      for (const m of all) m._row = 0;
      stream.collapsed = true;
      stream.count = all.length;
      stream.subs = [{ name: '', lines: [], items: all, rows: 1, collapsed: true, h: Math.max(44, rm.h + rm.pad * 2, nameH + 13) }];
      stream.h = stream.subs[0].h;
      continue;
    }
    for (const sub of stream.subs) {
      // Milestones take the top rows of their sub-stream and the tasks that roll up to them sit
      // below, so each band is packed on its own.
      sub.items.sort((a, b) => a._task - b._task || (oneEach ? ganttItemOrder(a, b) : a._s - b._s || a._e - b._e));
      const rowEnds = [];
      let bandStart = 0, band = false;
      for (const m of sub.items) {
        if (m._task !== band) { band = m._task; bandStart = rowEnds.length; }
        const x1 = xOf(m._s), x2 = xOf(m._e);
        m._meta = rm.detail ? metaText(m) : '';
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
          const out = fitLabel(m, Infinity, 12.5);
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
        let r = oneEach ? -1 : rowEnds.findIndex((end, i) => i >= bandStart && left - 10 > end);
        if (r < 0) { r = rowEnds.length; rowEnds.push(right); } else rowEnds[r] = right;
        streams.maxRight = Math.max(streams.maxRight, right);
        m._row = r;
      }
      sub.rows = Math.max(1, rowEnds.length);
      sub.lines = subCol && sub.name ? wrapText(sub.name, subW, 12, 600) : [];
      sub.h = Math.max(sub.rows * rm.h + rm.pad * 2, sub.lines.length * SUB_LINE_H + 12);
    }
    stream.h = stream.subs.reduce((a, s) => a + s.h, 0);
    // a stream name on several lines needs the room: the last sub-stream takes up the slack
    if (stream.h < nameH) { stream.subs.at(-1).h += nameH - stream.h; stream.h = nameH; }
  }
  return streams;
}

// Every milestone is a diamond (a top level one also wears a ring, drawn by the caller).
function drawShape(parent, cx, cy, status, s) {
  const c = pal(status);
  const el = svgEl('path', { d: `M ${cx} ${cy - s - 2} L ${cx + s + 2} ${cy} L ${cx} ${cy + s + 2} L ${cx - s - 2} ${cy} Z` });
  el.setAttribute('fill', `url(#${gradId(status)})`);
  el.setAttribute('stroke', c.dark);
  el.setAttribute('stroke-width', '1.4');
  el.setAttribute('filter', 'url(#ms-shadow)');
  el.setAttribute('class', 'gantt-shape');
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
function drawLink(svg, a, b, rollup, rm, clash = false) {
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
    d, fill: 'none', class: `gantt-link${clash ? ' clash' : ''}`, 'data-from': a.id, 'data-to': b.id,
    stroke: clash ? G.accent : G.links[rollup ? 'roll' : 'dep'], 'stroke-width': clash ? 1.8 : 1.4, 'stroke-opacity': clash ? 0.9 : 0.75,
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
  const STREAM_COL_W = streamColWidth();
  const subCol = hasSubStreams();
  const rm = rowMetrics();

  const dated = state.items
    // a task's end date is inclusive, so its bar runs to the end of that day
    .map(m => ({ ...m, _s: parseDate(m.start), _e: parseDate(isTask(m) && m.end ? addDays(m.end, 1) : m.end), _task: isTask(m) }))
    .map(m => {
      // tag after a milestone's title: its % complete (a task's duration is in the hover card)
      const prog = !m._task && milestoneProgress(m);
      return { ...m, _tag: prog ? `${prog.pct}%` : '' };
    })
    .filter(m => m._s && m._e && ganttMatches(m));
  const inRange = (m) => m._e >= state.rangeStart && m._s <= state.rangeEnd;
  const items = dated.filter(inRange);
  renderGanttFilters();
  renderOutsideNote(dated.filter(m => !inRange(m)));

  const totalDays = Math.max(1, (state.rangeEnd - state.rangeStart) / MS_DAY);
  const chartW = totalDays * state.pxPerDay;
  const rawX = (d) => LABEL_W + ((d - state.rangeStart) / MS_DAY) * state.pxPerDay;
  const xOf = (d) => Math.min(LABEL_W + chartW, Math.max(LABEL_W, rawX(d)));

  const headerH = (state.showQuarters ? QUARTER_H : 0) + (state.showMonths ? MONTH_H : 0);
  const streams = layoutStreams(items, xOf, rm, LABEL_W, LABEL_W + chartW + PAD_RIGHT);
  // names are never cut short: a label near the end widens the chart rather than running off it
  const width = Math.ceil(Math.max(LABEL_W + chartW + PAD_RIGHT, streams.maxRight + 8));
  const bodyH = streams.reduce((a, l) => a + l.h, 0) || 120;
  const height = headerH + bodyH + 8;

  const svg = svgEl('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, class: state.linkMode === 'hover' ? 'links-hover' : '',
    xmlns: 'http://www.w3.org/2000/svg',
    style: `font-family:${getComputedStyle(document.body).fontFamily};`, // the page's typeface, so the chart matches it
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
  // glows for an item and its chain while it's picked out (see focusLinks): a soft halo in the link colour
  for (const [id, blur, opacity] of [['ms-glow', 3, 0.75], ['ms-glow-strong', 4.5, 1]]) {
    const gf = svgEl('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' });
    gf.appendChild(svgEl('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 1.5, result: 'grow' }));
    gf.appendChild(svgEl('feGaussianBlur', { in: 'grow', stdDeviation: blur, result: 'blur' }));
    gf.appendChild(svgEl('feFlood', { 'flood-color': G.links.dep, 'flood-opacity': opacity }));
    gf.appendChild(svgEl('feComposite', { operator: 'in', in2: 'blur', result: 'glow' }));
    const merge = svgEl('feMerge', {});
    merge.appendChild(svgEl('feMergeNode', { in: 'glow' }));
    merge.appendChild(svgEl('feMergeNode', { in: 'glow' }));
    merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    gf.appendChild(merge);
    defs.appendChild(gf);
  }
  for (const [id, color] of Object.entries(G.links)) {
    const mk = svgEl('marker', { id: `arrow-${id}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' });
    mk.appendChild(svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 Z', fill: color }));
    defs.appendChild(mk);
  }
  svg.appendChild(defs);

  // background
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: G.bg }));

  // Label column and timescale header are separate layers, pinned while the chart scrolls
  // (see syncGanttSticky) so stream names and dates stay in view, as in MS Project.
  const col = svgEl('g', { class: 'gantt-col' });
  const head = svgEl('g', { class: 'gantt-head' });
  const corner = svgEl('g', { class: 'gantt-corner' });
  head.appendChild(svgEl('rect', { x: 0, y: 0, width, height: headerH, fill: G.bg }));
  corner.appendChild(svgEl('rect', { x: 0, y: 0, width: LABEL_W, height: headerH, fill: G.bg }));
  corner.appendChild(svgEl('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: headerH, stroke: G.strong, 'stroke-width': 1 }));
  if (headerH) corner.appendChild(svgEl('line', { x1: 0, y1: headerH, x2: LABEL_W, y2: headerH, stroke: G.strong, 'stroke-width': 1 }));

  // stream backgrounds (alternating) + stream / sub-stream labels
  let y = headerH;
  streams.forEach((stream, i) => {
    if (i % 2 === 1) svg.appendChild(svgEl('rect', { x: 0, y, width, height: stream.h, fill: G.alt }));
    col.appendChild(svgEl('rect', { x: 0, y, width: LABEL_W, height: stream.h, fill: i % 2 ? G.alt : G.bg }));
    const accent = G.streamAccents[i % G.streamAccents.length];
    col.appendChild(svgEl('rect', { x: 0, y: y + 4, width: 4, height: stream.h - 8, rx: 2, fill: accent }));
    const streamColW = subCol ? STREAM_COL_W : LABEL_W;
    // click the stream's name to fold it into one summary row (and back)
    const toggle = svgEl('g', { class: 'stream-toggle', 'data-stream': stream.id, role: 'button', tabindex: 0,
      'aria-expanded': String(!stream.collapsed), 'aria-label': `${stream.collapsed ? 'Expand' : 'Collapse'} ${stream.name}` });
    toggle.appendChild(svgEl('rect', { x: 4, y, width: streamColW - 4, height: stream.h, fill: 'transparent' }));
    toggle.appendChild(svgEl('path', {
      d: stream.collapsed ? `M 14 ${y + stream.h / 2 - 4} l 4.5 4 l -4.5 4` : `M 12 ${y + stream.h / 2 - 2} l 4 4.5 l 4 -4.5`,
      fill: 'none', stroke: G.muted, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    const nameH = (stream.lines.length - 1) * STREAM_LINE_H;
    const nameY = stream.collapsed ? y + stream.h / 2 + 1 : y + stream.h / 2 + 5;
    toggle.appendChild(svgLines({ x: 26, 'font-size': 14, 'font-weight': 700, fill: G.text }, stream.lines, nameY, STREAM_LINE_H));
    if (stream.collapsed) toggle.appendChild(svgEl('text', { x: 26, y: nameY + nameH / 2 + 13, 'font-size': 10.5, fill: G.muted }, `${stream.count} ${stream.count === 1 ? T.item : T.items} folded`));
    col.appendChild(toggle);

    let sy = y;
    stream.subs.forEach((sub, j) => {
      sub._y = sy;
      if (subCol) {
        if (j > 0) {
          svg.appendChild(svgEl('line', { x1: STREAM_COL_W, y1: sy, x2: width, y2: sy, stroke: G.line, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
          col.appendChild(svgEl('line', { x1: STREAM_COL_W, y1: sy, x2: LABEL_W, y2: sy, stroke: G.line, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
        }
        if (sub.lines.length) {
          col.appendChild(svgLines({ x: STREAM_COL_W + 12, 'font-size': 12, 'font-weight': 600, fill: G.sub }, sub.lines, sy + sub.h / 2 + 4, SUB_LINE_H));
        }
      }
      sy += sub.h;
    });
    if (subCol) {
      col.appendChild(svgEl('line', { x1: STREAM_COL_W, y1: y, x2: STREAM_COL_W, y2: y + stream.h, stroke: G.line, 'stroke-width': 1 }));
    }
    svg.appendChild(svgEl('line', { x1: 0, y1: y + stream.h, x2: width, y2: y + stream.h, stroke: G.line, 'stroke-width': 1 }));
    col.appendChild(svgEl('line', { x1: 0, y1: y + stream.h, x2: LABEL_W, y2: y + stream.h, stroke: G.line, 'stroke-width': 1 }));
    y += stream.h;
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
  for (const stream of streams) {
    for (const sub of stream.subs) {
      for (const m of sub.items) {
        m._cy = sub.collapsed ? sub._y + sub.h / 2 : sub._y + rm.pad + m._row * rm.h + rm.h / 2 - rm.offset;
        m._sub = sub;
        m._collapsed = !!sub.collapsed;
        pos.set(m.id, { id: m.id, x1: xOf(m._s), x2: xOf(m._e), cy: m._cy, task: m._task });
      }
    }
  }

  // flagged roll-up clashes: their link is drawn red and the milestone gets a flag
  const clashList = rollupClashes();
  const clashed = new Set(clashList.map(x => x.c.id)), clashedInto = new Set(clashList.map(x => x.p.id));

  // ---- dependency + roll-up connectors (under the items) ----
  if (state.linkMode !== 'none') {
    const shown = (id) => pos.has(id) && !items.find(x => x.id === id)._collapsed; // folded streams draw no links
    for (const m of items) {
      if (m._collapsed) continue;
      const b = pos.get(m.id);
      for (const d of m.deps) if (shown(d)) drawLink(svg, pos.get(d), b, false, rm);
      if (m.parent && shown(m.parent)) drawLink(svg, b, pos.get(m.parent), true, rm, clashed.has(m.id));
    }
  }

  // ---- items ----
  for (const m of items) {
    const { x1, x2, cy } = pos.get(m.id);
    const c = pal(m.status);
    const g = svgEl('g', { 'data-id': m.id, class: 'gantt-item' });

    if (m._collapsed) {
      // a folded stream: every item on one row, small and unlabelled (the hover card still works)
      if (m._task) {
        g.appendChild(svgEl('rect', { x: x1, y: cy - 3.5, width: Math.max(2, x2 - x1), height: 7, rx: 3.5, fill: `url(#${gradId(m.status)})`, stroke: c.dark, 'stroke-width': 0.8, 'fill-opacity': 0.9 }));
      } else drawShape(g, x1, cy, m.status, 4.5);
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
        fill: `url(#${gradId(m.status)})`, stroke: c.dark, 'stroke-width': 1.2, filter: 'url(#ms-shadow)', class: 'gantt-shape',
      }));
      if (m._side === 'inside') {
        g.appendChild(titleText({ x: x1 + 8, y: cy + 4.5, 'font-size': 12, 'font-weight': 600, fill: c.text }, m, c.text, c.text));
        if (m._meta) g.appendChild(svgEl('text', { x: x1 + 2, y: cy + bh / 2 + 13, 'font-size': 10.5, fill: G.muted, ...halo() }, m._meta));
      }
    } else {
      // stem down to sub-stream bottom for readability
      g.appendChild(svgEl('line', {
        x1, y1: cy + rm.shapeS + 3, x2: x1, y2: m._sub._y + m._sub.h - 4, 'pointer-events': 'none',
        stroke: G.strong, 'stroke-width': 1, 'stroke-dasharray': '2 3',
      }));
      drawShape(g, x1, cy, m.status, rm.shapeS);
      // a top level milestone (under change control) wears a ring
      if (isTopLevel(m)) g.appendChild(svgEl('circle', { cx: x1, cy, r: rm.shapeS + 5, fill: 'none', stroke: G.text, 'stroke-width': 1.4, 'pointer-events': 'none', class: 'gantt-tl' }));
    }
    // a flagged roll-up clash: a red flag on the milestone's top-left corner
    if (clashedInto.has(m.id)) {
      const fx = m._task ? x1 + 1 : x1 - rm.shapeS - 1, fy = m._task ? cy - rm.barH / 2 : cy - rm.shapeS - 1;
      const flag = svgEl('g', { class: 'gantt-clash', 'pointer-events': 'none' });
      flag.appendChild(svgEl('circle', { cx: fx, cy: fy, r: 6.5, fill: G.accent, stroke: G.bg, 'stroke-width': 1.5 }));
      flag.appendChild(svgEl('path', { d: `M ${fx - 2} ${fy + 3.5} V ${fy - 3.5} H ${fx + 3} L ${fx + 1.6} ${fy - 1.8} L ${fx + 3} ${fy} H ${fx - 2}`, fill: '#fff', stroke: '#fff', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }));
      g.appendChild(flag);
    }
    if (m._side !== 'inside') {
      const anchor = m._side === 'left' ? 'end' : 'start';
      const ty = rm.detail ? cy + 1 : cy + 4.5;
      g.appendChild(titleText({ x: m._lx, y: ty, 'text-anchor': anchor, 'font-size': 12.5, 'font-weight': 600, fill: G.text, ...halo() }, m, G.accent, G.muted));
      if (m._meta) g.appendChild(svgEl('text', { x: m._lx, y: cy + 15, 'text-anchor': anchor, 'font-size': 10.5, fill: G.muted, ...halo() }, m._meta));
    }
    // a use case link: a dark badge with a document on its bottom-right corner
    if (m.use_case_url && !linkHidden('use_case_url')) {
      const ux = m._task ? x2 - 1 : x1 + rm.shapeS + 1, uy = m._task ? cy + rm.barH / 2 : cy + rm.shapeS + 1;
      const badge = svgEl('g', { class: 'gantt-usecase', 'pointer-events': 'none' });
      badge.appendChild(svgEl('circle', { cx: ux, cy: uy, r: 7, fill: G.text, stroke: G.bg, 'stroke-width': 1.5 }));
      badge.appendChild(svgEl('path', { d: `M ${ux - 2.5} ${uy - 3.5} h 3.2 l 1.8 1.8 v 5.2 h -5 Z`, fill: G.bg }));
      badge.appendChild(svgEl('path', { d: `M ${ux - 1.3} ${uy + 0.2} h 2.6 M ${ux - 1.3} ${uy + 1.9} h 2.6`, stroke: G.text, 'stroke-width': 0.8 }));
      g.appendChild(badge);
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
  markRecentMoved(svg);
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

// What a change would do, without keeping it: the item's new dates and what else would move
// (`shifts`: each other item that moves, and by how many days).
function previewUpdate(m, changes) {
  const saved = state.items.map(x => [x, x.start, x.end, x.type]);
  const gaps = clashGaps();
  const res = updateItem(m, changes);
  const clashes = res.error ? [] : freshClashes(gaps);
  const others = (res.moved || []).filter(id => id !== m.id);
  const shifts = new Map(saved.filter(([x]) => others.includes(x.id)).map(([x, a]) => [x.id, daysBetween(a, x.start)]));
  const topLevel = saved.filter(([x, , b]) => isTopLevel(x) && x.end !== b).map(([x]) => x);
  const out = { error: res.error, start: m.start, end: m.end, moved: others.length, shifts, topLevel, clashes };
  for (const [x, a, b, t] of saved) Object.assign(x, { start: a, end: b, type: t });
  return out;
}

// While dragging, everything the drag would move slides to where it would land, outlined and
// labelled with how far it moves; the rest of the chart fades back. Links stay where they were
// until you let go, so they fade too.
function showKnockOn(shifts) {
  const svg = document.querySelector('#gantt-container svg');
  if (!svg) return;
  for (const g of svg.querySelectorAll('.gantt-item')) {
    if (g === drag?.g) continue;
    const n = shifts.get(g.dataset.id);
    g.querySelectorAll('.knock-halo').forEach(h => h.remove());
    g.classList.toggle('knock', n !== undefined);
    if (n === undefined) { g.removeAttribute('transform'); continue; }
    g.setAttribute('transform', `translate(${n * state.pxPerDay} 0)`);
    addHalo(g, `${n > 0 ? '+' : '−'}${daysText(Math.abs(n))}`);
    g.classList.toggle('knock-tl', isTopLevel(itemById(g.dataset.id)));
  }
  svg.classList.toggle('drag-preview', shifts.size > 0);
  drag?.g.classList.toggle('knock-src', shifts.size > 0);
}

// An outline around an item's bar or shape, with an optional note beside it.
function addHalo(g, note) {
  const shape = g.querySelector('.gantt-shape');
  if (!shape) return;
  const b = shape.getBBox(), pad = 4;
  const halo = svgEl('rect', { class: 'knock-halo', 'pointer-events': 'none', x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, rx: 7 });
  g.insertBefore(halo, g.firstChild);
  if (note) { // on the outline's top edge, over the item, so it doesn't cover the label beside it
    const tag = svgEl('g', { class: 'knock-halo knock-tag', 'pointer-events': 'none' });
    const w = note.length * 5.6 + 10, x = b.x - pad, y = b.y - pad;
    tag.appendChild(svgEl('rect', { x, y: y - 7.5, width: w, height: 15, rx: 7.5 }));
    tag.appendChild(svgEl('text', { x: x + w / 2, y: y + 3.4, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700 }, note));
    g.appendChild(tag);
  }
  return halo;
}

// After a change on the chart, what moved stays outlined for a few seconds (through redraws).
let recentMoved = { ids: new Set(), until: 0 };
function flashMoved(ids) {
  recentMoved = { ids: new Set(ids), until: Date.now() + 4000 };
}
function markRecentMoved(svg) {
  const left = recentMoved.until - Date.now();
  if (left <= 0) return;
  for (const g of svg.querySelectorAll('.gantt-item')) {
    if (!recentMoved.ids.has(g.dataset.id)) continue;
    const halo = addHalo(g);
    if (!halo) continue;
    halo.classList.add('fading');
    halo.style.animationDuration = `${left}ms`;
  }
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
  showKnockOn(p.error ? new Map() : p.shifts);
  const what = mode === 'move' ? (days ? `${days > 0 ? '+' : '−'}${daysText(Math.abs(days))}` : 'No change')
    : `${mode === 'end' ? 'End' : 'Start'} ${days > 0 ? '+' : days < 0 ? '−' : ''}${days ? daysText(Math.abs(days)) : 'unchanged'}`;
  const tip = document.getElementById('tip');
  tip.innerHTML = `
    <div class="tip-head">${m.ref ? `<span class="tip-ref">${escAttr(m.ref)}</span>` : ''}<span>${what}</span></div>
    <div class="tip-row">${p.error ? escAttr(p.error) : isTask(m) ? `${fmtShort(p.start)} – ${fmtNice(p.end)} <span class="tip-muted">(${daysText(daysBetween(p.start, p.end) + 1)})</span>` : fmtNice(p.end)}</div>
    ${p.moved ? `<div class="tip-row tip-late amber">Moves ${count(p.moved, `${T.item} downstream`, `${T.items} downstream`)}</div>` : ''}
    ${p.topLevel?.length ? `<div class="tip-row tip-tl">⚠ Changes top level ${p.topLevel.length > 1 ? T.milestones : T.milestone} under change control: ${p.topLevel.map(x => escAttr(fullLabel(x))).join(', ')}</div>` : ''}
    ${p.clashes.map(x => `<div class="tip-row tip-tl">⚑ ${escAttr(itemLabel(x.c))} would end ${daysText(x.gap)} after ${escAttr(fullLabel(x.p))}, which it rolls up to</div>`).join('')}
    <div class="tip-hint">${p.topLevel?.length || p.clashes.length ? 'Let go to choose and confirm' : 'Let go to save'} · Esc to cancel</div>`;
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
  const res = await guardChange(() => updateItem(m, dragChanges(m, mode, days)));
  if (!res) return renderGantt();
  if (!res.error) { flashMoved([m.id, ...res.moved]); growRangeTo([m.id, ...res.moved]); }
  renderGantt();
  if (res.error) return showToast(res.error);
  const msg = [`${itemLabel(m)}: ${isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end)}`, movedMessage(m, res.moved)].filter(Boolean).join(' · ');
  offerUndo(snap, msg);
  await saveData(msg, 'Dragged on the plan');
}

/* ---- keyboard on the chart ---- */
// Tab into the chart, then the arrow keys move between items (← → along a stream, ↑ ↓ to the
// row above or below), Enter opens the quick update panel and Esc lets go.

function ganttKeyNav(e) {
  if (e.target.closest('.stream-toggle') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    return toggleStream(e.target.closest('.stream-toggle').dataset.stream);
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' '].includes(e.key)) return;
  const gs = [...document.querySelectorAll('#gantt-container .gantt-item')];
  if (!gs.length) return;
  const at = (g) => { const r = g.getBoundingClientRect(); return { g, x: r.left, y: r.top + r.height / 2, stream: itemById(g.dataset.id)?.stream_id }; };
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
    const stream = all.filter(a => a.stream === cur.stream && a !== cur && Math.sign(a.x - cur.x || a.y - cur.y) === dir);
    next = stream.sort((a, b) => dir * (a.x - b.x) || Math.abs(a.y - cur.y) - Math.abs(b.y - cur.y))[0];
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
  setTimeout(() => { // once scrolling (and, from a link, the first fit) has settled
    const el = kbId === id && isShown('gantt') && document.querySelector(`#gantt-container .gantt-item[data-id="${id}"]`); // afresh: the chart may have been redrawn
    if (!el) return;
    const r = el.getBoundingClientRect(), v = document.getElementById('gantt-scroll').getBoundingClientRect();
    if (!r.width || r.right < v.left || r.left > v.right || r.bottom < v.top || r.top > v.bottom) return; // not in view: no card
    showTip(itemById(id), { clientX: r.right, clientY: r.top + r.height / 2 });
  }, 160);
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
  for (const g of svg.querySelectorAll('.gantt-item')) {
    g.classList.toggle('dim', on && !ids.has(g.dataset.id));
    g.classList.toggle('lit', on && ids.has(g.dataset.id));
    g.classList.toggle('focus', on && g.dataset.id === m.id);
  }
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
// workspace changes. Sort sets the order of streams and, optionally, of items within them:
// "packed" fits several items to a row by date, the other orders give each item its own row.
// The sort is a per-browser preference.

const ganttFilter = { q: '', stream: '', owner: '', type: '', rag: [], late: false };
const GANTT_SORT_DEFAULT = { streams: 'name', rows: 'packed', dir: 1 }; // streams A–Z, items packed by date
const ganttSort = { ...GANTT_SORT_DEFAULT };

const ganttFiltered = () => !!(ganttFilter.q.trim() || ganttFilter.stream || ganttFilter.owner || ganttFilter.type || ganttFilter.rag.length || ganttFilter.late);

function ganttMatches(m) {
  const f = ganttFilter, q = f.q.trim().toLowerCase();
  return (!f.stream || m.stream_id === f.stream)
    && (!f.owner || m.owner === f.owner)
    && (!f.type || (f.type === 'task' ? isTask(m) : f.type === 'top' ? isTopLevel(m) : !isTask(m)))
    && (!f.rag.length || f.rag.includes(m.status))
    && (!f.late || isLate(m) || isLateStart(m))
    && (!q || [m.ref, m.title, m.description, m.owner, streamName(m.stream_id), m.substream].join(' ').toLowerCase().includes(q));
}

function clearGanttFilters() {
  Object.assign(ganttFilter, { q: '', stream: '', owner: '', type: '', rag: [], late: false });
}

// Folded streams, per workspace (a per-browser preference).
// Folded streams, by id, remembered per workspace in this browser.
function collapsedStreams() {
  return new Set(loadAppPrefs().folded?.[state.workspaceId] || []);
}
function toggleStream(id, fold) {
  const all = loadAppPrefs().folded || {};
  const set = new Set(all[state.workspaceId] || []);
  if (fold ?? !set.has(id)) set.add(id); else set.delete(id);
  saveAppPrefs({ folded: { ...all, [state.workspaceId]: [...set] } });
  renderGantt();
}
function foldAllStreams(fold) {
  const all = loadAppPrefs().folded || {};
  saveAppPrefs({ folded: { ...all, [state.workspaceId]: fold ? [...new Set(state.items.map(m => m.stream_id))] : [] } });
  renderGantt();
}

// Streams and their sub-streams share one order.
function sortStreams(streams) {
  const by = ganttSort.streams;
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
  streams.sort(cmp);
  for (const stream of streams) stream.subs.sort(cmp);
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
  const streamsHere = workspaceStreams().filter(l => state.items.some(m => m.stream_id === l.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (f.stream && !streamsHere.some(l => l.id === f.stream)) streamsHere.push(streamById(f.stream) || { id: f.stream, name: '(deleted stream)' });
  document.getElementById('gf-stream').innerHTML = '<option value="">All streams</option>' + streamsHere.map(l =>
    `<option value="${escAttr(l.id)}" ${l.id === f.stream ? 'selected' : ''}>${escAttr(l.name)}</option>`).join('');
  fill('gf-owner', 'All owners', distinct('owner'), f.owner);
  const types = [['', 'All'], ['top', 'Top level'], ['milestone', T.Milestones], ['task', T.Tasks]];
  document.getElementById('gf-type').innerHTML = types.map(([v, label]) =>
    `<button type="button" data-type="${v}" aria-pressed="${f.type === v}">${escAttr(label)}</button>`).join('');
  f.rag = f.rag.filter(st => STATUSES.includes(st));
  document.getElementById('gf-rag').innerHTML = STATUSES.map(st => `
    <button type="button" data-rag="${escAttr(st)}" aria-pressed="${f.rag.includes(st)}" style="--c:${STATUS[st].base};--t:${STATUS[st].text}">${escAttr(st)}</button>`).join('');

  document.getElementById('gf-late').setAttribute('aria-pressed', f.late);
  const q = document.getElementById('gf-q');
  if (document.activeElement !== q) q.value = f.q; // don't disturb the caret while typing

  const chips = [
    f.stream && ['stream', 'Stream', streamName(f.stream) || '(deleted stream)'],
    f.owner && ['owner', 'Owner', f.owner],
    f.type && ['type', 'Type', f.type === 'task' ? T.Tasks : f.type === 'top' ? T.Tops : T.Milestones],
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

  document.getElementById('gs-streams').value = ganttSort.streams;
  document.getElementById('gs-rows').value = ganttSort.rows;
  const packed = ganttSort.rows === 'packed';
  document.querySelectorAll('#gs-dir [data-dir]').forEach(b => {
    b.disabled = packed;
    b.setAttribute('aria-pressed', !packed && +b.dataset.dir === ganttSort.dir);
  });
  document.getElementById('gs-badge').hidden = ganttSort.streams === GANTT_SORT_DEFAULT.streams && packed;

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
  document.querySelectorAll('.tb-pop-list').forEach(pop => pop.addEventListener('click', (e) => { if (e.target.closest('button')) closeMenus(); }));
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
  for (const [id, k] of [['gf-stream', 'stream'], ['gf-owner', 'owner']]) {
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
  document.getElementById('gs-streams').addEventListener('change', (e) => { ganttSort.streams = e.target.value; saveSort(); });
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
  const where = [m.owner, [streamName(m.stream_id), m.substream].filter(Boolean).join(' › ')].filter(Boolean).map(escAttr).join(' · ');
  const prog = !task && milestoneProgress(m);
  const progress = prog ? `<div class="tip-row"><b>${prog.pct}% complete</b><span class="tip-muted">${prog.doneDays} of ${prog.total} days · ${prog.doneCount} of ${prog.count} ${prog.count === 1 ? T.task : T.tasks} done</span></div>` : '';
  tip.innerHTML = `
    <div class="tip-head">${m.ref ? `<span class="tip-ref">${escAttr(m.ref)}</span>` : ''}<span>${escAttr(m.title)}</span></div>
    <div class="tip-row"><span class="pill" style="background:${c.base};color:${c.text}">${m.status}</span><span>${escAttr(typeName(m))} · ${when}</span></div>
    ${progress}
    ${isTopLevel(m) ? `<div class="tip-row tip-tl">Top level — under change control</div>` : ''}
    ${clashTipRows(m)}
    ${isLate(m) ? `<div class="tip-row tip-late">${lateText(m)}</div>` : isLateStart(m) ? `<div class="tip-row tip-late amber">${lateStartText(m)}</div>` : ''}
    ${baselineRow(m)}
    ${where ? `<div class="tip-row tip-muted">${where}</div>` : ''}
    ${tipLinks(m)}
    ${m.description ? `<div class="tip-desc">${escAttr(m.description)}</div>` : ''}
    ${itemLinks(m).map(([k, u]) => `<div class="tip-row tip-muted">${k}: ${escAttr(u.replace(/^https?:\/\/(www\.)?/i, ''))}</div>`).join('')}
    ${lastReportLine(m)}
    ${raidTipLine(m)}
    <div class="tip-hint">Click to update RAG or dates, or to report</div>`;
  const ids = chainOf(m.id);
  tipAvoid = [...document.querySelectorAll('#gantt-container .gantt-item')].filter(g => ids.has(g.dataset.id)).map(g => g.getBoundingClientRect());
  tip.classList.add('show');
  moveTip(e);
}
// Flagged roll-up clashes: this item ends after what it rolls up to, or things rolling up to it end after it.
function clashTipRows(m) {
  const own = clashOf(m);
  return [
    own && `<div class="tip-row tip-tl">⚑ Ends ${daysText(own.gap)} after ${escAttr(fullLabel(own.p))}, which it rolls up to</div>`,
    ...clashesInto(m).map(x => `<div class="tip-row tip-tl">⚑ ${escAttr(fullLabel(x.c))} ends ${daysText(x.gap)} after this</div>`),
  ].filter(Boolean).join('');
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
let editOpened = null; // its values when the dialog opened
let edDeps = [];

const EDIT_FIELDS = ['ref', 'title', 'type', 'description', 'stream_id', 'substream', 'owner', 'start', 'end', 'status', 'parent',
  'gitlab_url', 'use_case_url'];
const URL_FIELDS = { gitlab_url: 'GitLab URL', use_case_url: 'Use case URL' };

const isWebUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
// "gitlab.example.com/x" → "https://gitlab.example.com/x"; anything else is left as typed.
const withScheme = (u) => (u && !/^[a-z][\w+.-]*:/i.test(u) ? `https://${u}` : u);
// A link that opens in a new tab, shown without the https:// prefix.
const linkOut = (u) => isWebUrl(u)
  ? `<a href="${escAttr(u)}" target="_blank" rel="noopener noreferrer" title="${escAttr(u)}">${escAttr(u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a>`
  : escAttr(u);
// A workspace can switch off the link fields and features it doesn't use (its `hidden` list):
// link fields leave the grid, the edit dialog and the Gantt chart; 'reports' hides reporting everywhere.
const LINK_FIELDS = ['gitlab_url', 'use_case_url'];
const hiddenFields = (wsId = state.workspaceId) => (workspaceById(wsId)?.hidden || '').split(';').filter(Boolean);
const linkHidden = (k, wsId) => LINK_FIELDS.includes(k) && hiddenFields(wsId).includes(k);
const reportsOff = (wsId) => hiddenFields(wsId).includes('reports');
const itemLinks = (m) => Object.entries({ GitLab: 'gitlab_url', 'Use case': 'use_case_url' })
  .filter(([, k]) => m[k] && !linkHidden(k, m.workspace_id || undefined)).map(([l, k]) => [l, m[k]]);

function openEditDialog(m) {
  hideTip();
  editing = m;
  editOpened = m && structuredClone(m);
  const f = document.getElementById('edit-form').elements;
  const last = state.items.at(-1);
  const today = fmtISO(new Date());
  const v = m || {
    ref: '', title: '', description: '', stream_id: last?.stream_id || workspaceStreams()[0]?.id || '', substream: '', owner: '', gitlab_url: '', use_case_url: '',
    type: 'milestone', start: today, end: today, status: DEFAULT_STATUS, parent: '', deps: [],
  };
  f.type.innerHTML = typeOptions(v.type);
  f.status.innerHTML = statusOptions(v.status);
  const parents = state.items.filter(p => !isTask(p) && p !== m).sort(cmpRef);
  if (v.parent && !parents.some(p => p.id === v.parent)) parents.push(state.items.find(p => p.id === v.parent));
  f.parent.innerHTML = '<option value="">— none —</option>' +
    parents.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('');
  f.stream_id.innerHTML = streamOptions(v.stream_id);
  for (const k of EDIT_FIELDS) f[k].value = v[k] ?? '';
  for (const k of LINK_FIELDS) f[k].closest('label').hidden = linkHidden(k);
  f.stream_id.dataset.prev = f.stream_id.value;
  closeNewStream(f);
  if (!v.stream_id) { pickEdStream(f.stream_id, true); f.newstream.value = m ? '' : 'General'; } // no streams yet: name the first
  edDeps = [...v.deps];

  document.getElementById('ed-heading').textContent = m ? `Edit ${itemLabel(m)}` : `New ${T.item}`;
  document.getElementById('ed-delete').hidden = !m;
  document.getElementById('ed-report').hidden = !m || reportsOff();
  const n = m ? reportsFor(m.id).length : 0;
  const hist = document.getElementById('ed-history');
  hist.hidden = !m || reportsOff();
  hist.disabled = !n;
  hist.textContent = `Reports (${n})`;
  document.getElementById('ed-dates').hidden = !m;
  const raidN = m ? raidLinkedTo(`item:${m.id}`).filter(r => !isClosed(r)).length : 0;
  document.getElementById('ed-raid').hidden = !m;
  document.getElementById('ed-raid').textContent = `Risks & issues${raidN ? ` (${raidN})` : ''}`;
  document.getElementById('ed-related').hidden = !m; // a new item has nothing yet
  document.getElementById('ed-error').textContent = '';
  refreshDatalists();
  renderEdDeps();
  updateEdType();
  document.getElementById('edit-dialog').showModal();
  f.title.focus();
}

// The workspace's streams (A–Z) by id, plus a way to start a new one.
function streamOptions(current) {
  const streams = [...workspaceStreams()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (current && !streams.some(l => l.id === current)) streams.push({ id: current, name: streamName(current) || '(deleted stream)' });
  return streams.map(l => `<option value="${escAttr(l.id)}">${escAttr(l.name)}</option>`).join('') +
    '<option value="" data-new>+ New stream…</option>';
}
// Choosing "+ New stream…" swaps the list for a name box; Esc (or leaving it empty) swaps back.
function pickEdStream(sel, force) {
  if (!force && !('new' in sel.selectedOptions[0].dataset)) return (sel.dataset.prev = sel.value);
  const box = sel.form.elements.newstream;
  sel.hidden = true;
  box.hidden = false;
  box.value = '';
  if (!force) box.focus();
}
function closeNewStream(f) {
  f.newstream.hidden = true;
  f.newstream.value = '';
  f.stream_id.hidden = false;
  f.stream_id.value = f.stream_id.dataset.prev || '';
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
  badge.textContent = typeLabel(f.type.value);
  badge.className = 'type-badge ' + (task ? 'task' : f.type.value === 'top' ? 'ms tl' : 'ms');
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
  const newStream = f.newstream.hidden ? null : f.newstream.value.trim();
  if (newStream === '' || (newStream === null && !changes.stream_id)) { (f.newstream.hidden ? f.stream_id : f.newstream).focus(); return (err.textContent = 'Name the new stream.'); }

  if (!changes.title) return (err.textContent = 'Title is required.');
  for (const k in URL_FIELDS) {
    changes[k] = withScheme(changes[k]);
    if (changes[k] && !isWebUrl(changes[k]) && !linkHidden(k)) { f[k].focus(); return (err.textContent = `The ${URL_FIELDS[k]} isn’t a web address.`); }
  }
  if (!changes.start && !changes.end) return (err.textContent = 'Enter a start or end date.');
  const clash = changes.ref && state.items.find(x => x !== editing && x.ref === changes.ref);
  if (clash) return (err.textContent = `Ref ${changes.ref} is already used by “${clash.title}”.`);

  if (editing && !state.items.includes(editing)) return (err.textContent = `Someone else has just deleted this ${T.item}.`);
  const snap = snapshotData();
  // A new stream is made now, once everything else has checked out (and unmade if the change is dropped).
  const madeStream = newStream !== null && !streamIdFor(state.workspaceId, newStream, false);
  if (newStream !== null) changes.stream_id = streamIdFor(state.workspaceId, newStream);
  const dropped = () => {
    if (!editing) removeItem(m.id);
    if (madeStream) { state.streams = state.streams.filter(l => l.id !== changes.stream_id); saveStreams(); }
  };
  let m = editing;
  if (!m) {
    m = { id: nextId(), workspace_id: state.workspaceId, ...changes, parent: '', deps: [] };
    state.items.push(m);
  }
  const res = await guardChange(() => updateItem(m, changedFrom(changes, editOpened)));
  if (!res) { dropped(); return; } // cancelled: the dialog stays open with the change in it
  if (res.error) { dropped(); return (err.textContent = res.error); }
  document.getElementById('edit-dialog').close();
  if (res.moved.length) flashMoved([m.id, ...res.moved]);
  growRangeTo([m.id, ...res.moved]);
  rerenderCurrentView();
  if (isShown('editor')) { // redraw the Items grid so saving can't copy its old values back; a new item goes at the bottom
    refreshEditor(editing ? [] : [m.id]);
    if (!editing) document.querySelector(`#editor-body tr[data-id="${m.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  const note = [editing ? `${itemLabel(m)} saved` : `Added ${fullLabel(m)}`, movedMessage(m, res.moved)].filter(Boolean).join(' · ');
  offerUndo(snap, note);
  await saveData(movedMessage(m, res.moved), editing ? 'Edit dialog' : 'New item dialog');
}

async function deleteFromDialog() {
  if (!editing) return;
  const snap = snapshotData();
  const label = `Deleted ${fullLabel(editing)}`;
  if (!await guardChange(() => removeItem(editing.id) ?? true)) return;
  document.getElementById('edit-dialog').close();
  rerenderCurrentView();
  if (isShown('editor')) refreshEditor();
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
  setDatalist('stream-list', workspaceStreams().map(l => l.name));
  setDatalist('substream-list', state.items.map(m => m.substream));
  setDatalist('owner-list', state.items.map(m => m.owner));
  setDatalist('people-list', [...allItems().map(m => m.owner), ...state.workspaces.flatMap(p => [p.owner, p.lead])].sort());
}

/* ---- spreadsheet-style tables: sort, filter, move and size columns ---- */
// Shared by the Items grid and the Reports list, and they behave like Excel:
// - click a heading to select the column (⌘/Ctrl-click to add one, shift-click for a range);
// - drag a heading to move the column — or all the selected ones — somewhere else;
// - drag a heading's edge to resize; every selected column takes the same width. Double-click
//   the edge to fit the contents;
// - the ▾ button on a heading sorts by the column and filters it to the values ticked in its list;
// - right-click a heading for autofit, distribute evenly, fit to window and the resets.
// A column's `vals(row)` gives its value (or values) for the filter list (default row[key]) and
// `show(v)` how one reads there; `kind` ('date', 'number', 'status') words the sort and orders the
// list, or `order(a, b)` does. `fixed` columns (tick boxes, row buttons) stay put and don't sort.
// Sort, widths, column order and the view mode are a per-browser convenience (storage may be
// unavailable) and never change the CSV order. Filters last until the page is reloaded.

function makeTable({ table, store, cols, rows, onChange, mode }) {
  const t = { table, store, baseCols: cols, rows, onChange, mode, sort: { key: null, dir: 1 }, filters: {}, widths: {}, order: {}, colSel: new Set(), anchor: null };
  try {
    const saved = JSON.parse(localStorage.getItem(store) || '{}');
    for (const k of ['sort', 'widths', 'mode', 'order']) if (saved[k]) t[k] = saved[k];
  } catch { /* ignore */ }
  t.cols = () => orderedCols(t);
  return t;
}
function saveTablePrefs(t) {
  try { localStorage.setItem(t.store, JSON.stringify({ sort: t.sort, widths: t.widths, mode: t.mode, order: t.order })); } catch { /* ignore */ }
}
const tableEl = (t) => document.getElementById(t.table);
const widthKey = (c) => c.wkey || c.key;
const colWidth = (t, c) => t.widths[widthKey(c)] ?? c.w;
const colLabel = (c) => (typeof c.label === 'function' ? c.label() : c.label);
const orderKey = (t) => t.mode || 'all'; // each view mode keeps its own column order

// The columns in the order the user has arranged them. Fixed columns at either end stay there.
function orderedCols(t) {
  const base = t.baseCols();
  const order = t.order[orderKey(t)];
  if (!order) return base;
  let a = 0, b = base.length;
  while (a < b && base[a].fixed) a++;
  while (b > a && base[b - 1].fixed) b--;
  const rank = (c) => { const i = order.indexOf(c.key); return i < 0 ? order.length + base.indexOf(c) : i; };
  return [...base.slice(0, a), ...base.slice(a, b).sort((x, y) => rank(x) - rank(y)), ...base.slice(b)];
}
const movableKeys = (t) => t.cols().filter(c => !c.fixed).map(c => c.key);

const FILTER_CARET = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5h6L6 8z" fill="currentColor"/></svg>';
const FILTER_FUNNEL = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2h9L7 6.2V10L5 9V6.2z" fill="currentColor"/></svg>';

function renderTableHead(t) {
  closeTablePop();
  const cols = t.cols();
  tableEl(t).querySelector('colgroup').innerHTML = cols.map(c => `<col data-key="${c.key}">`).join('');
  tableEl(t).querySelector('thead').innerHTML = `
    <tr>${cols.map(c => c.fixed ? `<th${c.head ? ` class="col-${c.key}"` : ''}>${c.head ? c.head() : ''}</th>` : `
      <th data-col="${c.key}" title="${escAttr(c.title ? `${c.title} · ` : '')}Click to select · drag to move · right-click for sizing">
        <span class="th-label">${escAttr(colLabel(c))}</span><span class="sort-ind"></span>
        <button type="button" class="th-menu" data-colmenu="${c.key}" aria-label="Sort and filter ${escAttr(colLabel(c))}"></button>
        <span class="col-resizer" data-resize="${c.key}" title="Drag to resize · double-click to fit the contents"></span>
      </th>`).join('')}</tr>`;
  applyTableWidths(t);
  updateHeadState(t);
}

// Sort arrows, filter buttons and the column selection, without redrawing the heading.
function updateHeadState(t) {
  const tbl = tableEl(t);
  for (const k of t.colSel) if (!t.cols().some(c => c.key === k)) t.colSel.delete(k);
  tbl.querySelectorAll('thead th[data-col]').forEach(th => {
    const k = th.dataset.col, sorted = t.sort.key === k, filtered = !!t.filters[k];
    th.classList.toggle('sorted', sorted);
    th.classList.toggle('filtered', filtered);
    th.classList.toggle('colsel', t.colSel.has(k));
    th.querySelector('.sort-ind').textContent = sorted ? (t.sort.dir > 0 ? '▲' : '▼') : '';
    const b = th.querySelector('.th-menu');
    b.innerHTML = filtered ? FILTER_FUNNEL : FILTER_CARET;
    b.title = filtered ? 'Filtered · click to sort or change the filter' : 'Sort and filter';
  });
  tbl.querySelectorAll('col').forEach(col => col.classList.toggle('colsel', t.colSel.has(col.dataset.key)));
}

// Like a spreadsheet: every column is exactly its width, and the table is as wide as its columns
// (it scrolls sideways when that's wider than the window).
const MIN_COL_W = 24, MAX_FIT_W = 640;
function applyTableWidths(t) {
  let total = 0;
  for (const c of t.cols()) {
    const w = colWidth(t, c);
    const col = tableEl(t).querySelector(`col[data-key="${c.key}"]`);
    if (col) col.style.width = w + 'px';
    total += w;
  }
  tableEl(t).style.width = total + 'px';
}

// Double-clicking a column's edge fits it to the widest thing in it, as a spreadsheet does:
// the heading, and each row's text (an input's or a list's chosen value, or the cell's content).
function fitColumn(t, c) {
  const i = t.cols().indexOf(c);
  const tbl = tableEl(t);
  const pad = (el) => { const cs = getComputedStyle(el); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth); };
  const measure = (text, el) => { measureCtx.font = getComputedStyle(el).font; return measureCtx.measureText(text).width; };
  const th = tbl.querySelector(`thead tr:first-child th:nth-child(${i + 1})`);
  const label = th?.querySelector('.th-label');
  let w = label ? label.scrollWidth + pad(th) + 36 : 0; // as shown (capitals, spacing), plus the sort arrow and ▾ button
  for (const td of tbl.querySelectorAll(`tbody tr > td:nth-child(${i + 1})`)) {
    if (td.colSpan > 1) continue;
    const el = td.children.length === 1 ? td.firstElementChild : null;
    let inner;
    if (el?.matches('input[type=date]')) inner = 118 + pad(el);
    else if (el?.matches('input[type=checkbox]')) inner = el.offsetWidth;
    else if (el?.matches('input')) inner = measure(el.value || el.placeholder || '', el) + pad(el) + 2;
    else if (el?.matches('select')) inner = measure(el.selectedOptions[0]?.text || '', el) + pad(el) + 22; // the arrow
    else { // other content: a copy laid out on one line, inside the cell so it's styled the same
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:max-content;white-space:nowrap;pointer-events:none';
      for (const n of td.childNodes) probe.appendChild(n.cloneNode(true));
      probe.querySelectorAll('*').forEach(x => { x.style.flexWrap = 'nowrap'; });
      td.appendChild(probe);
      inner = probe.offsetWidth;
      probe.remove();
    }
    w = Math.max(w, inner + pad(td));
  }
  return Math.round(Math.min(MAX_FIT_W, Math.max(MIN_COL_W, w + 2)));
}

// While a column is being resized, its width shows beside the pointer.
function showWidthTip(e, w, n = 1) {
  let tip = document.getElementById('col-width-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'col-width-tip';
    document.body.appendChild(tip);
  }
  tip.textContent = `Width: ${w} pixels${n > 1 ? ` (${n} columns)` : ''}`;
  tip.style.left = `${e.clientX + 12}px`;
  tip.style.top = `${e.clientY + 14}px`;
  tip.hidden = false;
}
const hideWidthTip = () => { const tip = document.getElementById('col-width-tip'); if (tip) tip.hidden = true; };

/* sizing: the selected columns (or the one under the pointer) */
const sizingTargets = (t, key) => (t.colSel.has(key) && t.colSel.size > 1
  ? t.cols().filter(c => t.colSel.has(c.key)) : t.cols().filter(c => c.key === key));
function setWidths(t, list) {
  for (const [c, w] of list) t.widths[widthKey(c)] = Math.max(MIN_COL_W, Math.round(w));
  applyTableWidths(t);
  saveTablePrefs(t);
}
const autofitCols = (t, cols) => setWidths(t, cols.map(c => [c, fitColumn(t, c)]));
// Share the columns' combined width out equally.
function distributeCols(t, cols) {
  const total = cols.reduce((s, c) => s + colWidth(t, c), 0);
  const each = Math.floor(total / cols.length);
  setWidths(t, cols.map((c, i) => [c, i === cols.length - 1 ? total - each * (cols.length - 1) : each]));
}
// Stretch or squeeze every column in proportion so the table just fills the space it's in.
function fitColsToWindow(t) {
  const avail = tableEl(t).closest('.table-wrap').clientWidth;
  const cols = t.cols(), flex = cols.filter(c => !c.fixed);
  const fixedW = cols.filter(c => c.fixed).reduce((s, c) => s + colWidth(t, c), 0);
  const cur = flex.reduce((s, c) => s + colWidth(t, c), 0);
  const room = Math.max(flex.length * MIN_COL_W, avail - fixedW);
  const ws = flex.map(c => Math.max(MIN_COL_W, Math.floor(colWidth(t, c) * room / cur)));
  ws[ws.length - 1] += Math.max(0, room - ws.reduce((s, w) => s + w, 0));
  setWidths(t, flex.map((c, i) => [c, ws[i]]));
}
function resetWidths(t) {
  for (const c of t.cols()) delete t.widths[widthKey(c)];
  applyTableWidths(t);
  saveTablePrefs(t);
}

/* sorting */
function setSort(t, key, dir) {
  t.sort = key ? { key, dir } : { key: null, dir: 1 };
  saveTablePrefs(t);
  updateHeadState(t);
  t.onChange();
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
function sortWords(c) {
  switch (c.kind) {
    case 'date': return ['Sort oldest to newest', 'Sort newest to oldest'];
    case 'number': return ['Sort smallest to largest', 'Sort largest to smallest'];
    case 'status': return ['Sort in RAG order', 'Sort in reverse RAG order'];
    default: return ['Sort A to Z', 'Sort Z to A'];
  }
}

/* filtering: each filtered column keeps the list of values still ticked */
const tableCol = (t, key) => t.baseCols().find(c => c.key === key);
function colVals(c, row) {
  const v = c.vals ? c.vals(row) : row[c.key];
  const list = (Array.isArray(v) ? v : [v]).map(x => String(x ?? '').trim());
  return list.length ? list : [''];
}
const showVal = (c, v) => (v === '' ? (c.blank || '(Blanks)') : c.show ? c.show(v) : v);
function passesFilters(t, row, except) {
  for (const [k, allowed] of Object.entries(t.filters)) {
    const c = k !== except && tableCol(t, k);
    if (c && !colVals(c, row).some(v => allowed.includes(v))) return false;
  }
  return true;
}
// The single value a column is filtered to, if that's what it is (e.g. the Reports item filter).
const filterValue = (t, key) => (t.filters[key]?.length === 1 ? t.filters[key][0] : '');
function choiceCmp(c) {
  const byLabel = (a, b) => String(showVal(c, a)).localeCompare(String(showVal(c, b)), undefined, { numeric: true, sensitivity: 'base' });
  const cmp = c.order || (c.kind === 'status' ? (a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b)
    : c.kind === 'number' ? (a, b) => a - b
    : c.kind === 'date' ? (a, b) => a.localeCompare(b) : byLabel);
  return (a, b) => (a === '') - (b === '') || cmp(a, b) || byLabel(a, b);
}
// Values in the list are those in the rows the other columns' filters let through, as in Excel.
function filterChoices(t, c) {
  const seen = new Set();
  for (const r of t.rows()) if (passesFilters(t, r, c.key)) for (const v of colVals(c, r)) seen.add(v);
  return [...seen].sort(choiceCmp(c));
}
function clearTableFilters(t) {
  t.filters = {};
  if (tableEl(t).querySelector('thead th')) updateHeadState(t);
}

/* the ▾ menu and right-click menu share one pop-up */
let tablePop = null; // { t, c, choices, checked, q }
function closeTablePop() {
  document.getElementById('tbl-pop')?.remove();
  tablePop = null;
}
function placePop(el, x, y) {
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, y + r.height > innerHeight - 8 ? innerHeight - r.height - 8 : y)}px`;
}
function newPop(cls) {
  closeTablePop();
  const el = document.createElement('div');
  el.id = 'tbl-pop';
  el.className = `tbl-pop ${cls}`;
  el.addEventListener('pointerdown', e => e.stopPropagation());
  return el;
}
function sortItems(t, c) {
  const [up, down] = sortWords(c);
  const on = t.sort.key === c.key;
  return `<button type="button" class="tp-item${on && t.sort.dir > 0 ? ' on' : ''}" data-tp="asc"><span class="tp-ic">↑</span>${up}</button>
    <button type="button" class="tp-item${on && t.sort.dir < 0 ? ' on' : ''}" data-tp="desc"><span class="tp-ic">↓</span>${down}</button>
    ${on ? '<button type="button" class="tp-item" data-tp="unsort"><span class="tp-ic"></span>Clear sort</button>' : ''}`;
}

function openFilterPop(t, key, anchor) {
  const c = tableCol(t, key);
  const choices = filterChoices(t, c);
  const allowed = t.filters[key];
  const el = newPop('tp-filter');
  tablePop = { t, c, el, choices, checked: new Set(allowed ? choices.filter(v => allowed.includes(v)) : choices), q: '' };
  el.innerHTML = `${sortItems(t, c)}
    <hr />
    <button type="button" class="tp-item" data-tp="clear" ${allowed ? '' : 'disabled'}><span class="tp-ic">${FILTER_FUNNEL}</span>Clear filter from “${escAttr(colLabel(c))}”</button>
    <input type="search" class="tp-search" placeholder="Search" aria-label="Search the values" />
    <div class="tp-list" role="group"></div>
    <div class="tp-foot"><button type="button" class="btn btn-sm btn-ghost" data-tp="cancel">Cancel</button><button type="button" class="btn btn-sm btn-primary" data-tp="ok">OK</button></div>`;
  wirePop(el);
  const r = anchor.getBoundingClientRect();
  renderPopList();
  placePop(el, r.left - 4, r.bottom + 4);
  el.querySelector('.tp-search').focus({ preventScroll: true });
}
const popShown = () => {
  const q = tablePop.q.trim().toLowerCase();
  return q ? tablePop.choices.filter(v => String(showVal(tablePop.c, v)).toLowerCase().includes(q)) : tablePop.choices;
};
function renderPopList() {
  const { el, c, checked, q } = tablePop;
  const shown = popShown();
  const on = shown.filter(v => checked.has(v)).length;
  el.querySelector('.tp-list').innerHTML = shown.length ? `
    <label class="tp-all"><input type="checkbox" data-tp-all ${on === shown.length ? 'checked' : ''} />${q.trim() ? '(Select all search results)' : '(Select all)'}</label>
    ${shown.map((v, i) => `<label title="${escAttr(showVal(c, v))}"><input type="checkbox" data-tp-i="${i}" ${checked.has(v) ? 'checked' : ''} /><span${v === '' ? ' class="tp-blank"' : ''}>${escAttr(showVal(c, v))}</span></label>`).join('')}`
    : '<p class="tp-none">No matches</p>';
  const all = el.querySelector('[data-tp-all]');
  if (all) all.indeterminate = on > 0 && on < shown.length;
  el.querySelector('[data-tp="ok"]').disabled = !on;
}
function applyPopFilter() {
  const { t, c, choices, checked } = tablePop;
  const keep = (tablePop.q.trim() ? popShown() : choices).filter(v => checked.has(v));
  if (!keep.length) return;
  if (keep.length === choices.length) delete t.filters[c.key]; else t.filters[c.key] = keep;
  closeTablePop();
  updateHeadState(t);
  t.onChange();
}

function openColMenu(t, key, x, y) {
  const c = tableCol(t, key);
  const sel = sizingTargets(t, key);
  const n = sel.length;
  const el = newPop('tp-menu');
  el.innerHTML = `${sortItems(t, c)}
    <button type="button" class="tp-item" data-tp="filter"><span class="tp-ic">${FILTER_FUNNEL}</span>Filter…</button>
    <hr />
    <button type="button" class="tp-item" data-tp="autofit"><span class="tp-ic">↔</span>Autofit ${n > 1 ? `${n} columns` : 'column width'}</button>
    <button type="button" class="tp-item" data-tp="distribute"><span class="tp-ic">⇹</span>Distribute ${n > 1 ? `${n} columns` : 'all columns'} evenly</button>
    <button type="button" class="tp-item" data-tp="fitwin"><span class="tp-ic">⇔</span>Fit all columns to window</button>
    <button type="button" class="tp-item" data-tp="resetw"><span class="tp-ic"></span>Reset column widths</button>
    <hr />
    <button type="button" class="tp-item" data-tp="reseto" ${t.order[orderKey(t)] ? '' : 'disabled'}><span class="tp-ic"></span>Reset column order</button>`;
  tablePop = { t, c, menu: true, sel };
  wirePop(el);
  placePop(el, x, y);
}

function wirePop(el) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tp]');
    if (!b || b.disabled || !tablePop) return;
    const { t, c } = tablePop;
    const act = b.dataset.tp;
    if (act === 'ok') return applyPopFilter();
    if (act === 'filter') {
      const btn = tableEl(t).querySelector(`[data-colmenu="${c.key}"]`);
      return openFilterPop(t, c.key, btn);
    }
    const sel = tablePop.sel;
    closeTablePop();
    if (act === 'asc') setSort(t, c.key, 1);
    else if (act === 'desc') setSort(t, c.key, -1);
    else if (act === 'unsort') setSort(t, null);
    else if (act === 'clear') { delete t.filters[c.key]; updateHeadState(t); t.onChange(); }
    else if (act === 'autofit') autofitCols(t, sel);
    else if (act === 'distribute') distributeCols(t, sel.length > 1 ? sel : t.cols().filter(x => !x.fixed));
    else if (act === 'fitwin') fitColsToWindow(t);
    else if (act === 'resetw') resetWidths(t);
    else if (act === 'reseto') { delete t.order[orderKey(t)]; saveTablePrefs(t); renderTableHead(t); t.onChange(); }
  });
  el.addEventListener('input', (e) => {
    if (!e.target.matches('.tp-search')) return;
    tablePop.q = e.target.value;
    renderPopList();
  });
  el.addEventListener('change', (e) => {
    if (!tablePop?.choices) return;
    const shown = popShown();
    if (e.target.matches('[data-tp-all]')) for (const v of shown) e.target.checked ? tablePop.checked.add(v) : tablePop.checked.delete(v);
    else if (e.target.dataset.tpI != null) {
      const v = shown[+e.target.dataset.tpI];
      e.target.checked ? tablePop.checked.add(v) : tablePop.checked.delete(v);
    }
    renderPopList();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeTablePop(); }
    else if (e.key === 'Enter' && tablePop?.choices && !e.target.matches('button')) { e.preventDefault(); applyPopFilter(); }
  });
}

/* column selection, like clicking Excel's column letters */
function selectCol(t, key, e) {
  const keys = movableKeys(t);
  if (e.shiftKey && t.anchor && keys.includes(t.anchor)) {
    const [a, b] = [keys.indexOf(t.anchor), keys.indexOf(key)].sort((x, y) => x - y);
    if (!(e.metaKey || e.ctrlKey)) t.colSel.clear();
    keys.slice(a, b + 1).forEach(k => t.colSel.add(k));
  } else if (e.metaKey || e.ctrlKey) {
    t.colSel.has(key) ? t.colSel.delete(key) : t.colSel.add(key);
    t.anchor = key;
  } else {
    t.colSel = new Set([key]);
    t.anchor = key;
  }
  updateHeadState(t);
}
function clearColSel(t) {
  if (!t.colSel.size) return;
  t.colSel.clear();
  updateHeadState(t);
}

/* moving columns: drag a heading; a line shows where it will go */
function startColMove(t, e, th) {
  const key = th.dataset.col, x0 = e.clientX;
  const wrap = tableEl(t).closest('.table-wrap');
  let drag = null;
  const begin = () => {
    if (!t.colSel.has(key)) { t.colSel = new Set([key]); t.anchor = key; updateHeadState(t); }
    const moving = movableKeys(t).filter(k => t.colSel.has(k));
    const ghost = document.createElement('div');
    ghost.className = 'col-drag-ghost';
    ghost.textContent = moving.map(k => colLabel(tableCol(t, k))).join(', ');
    const mark = document.createElement('div');
    mark.className = 'col-drop-mark';
    document.body.append(ghost, mark);
    document.body.classList.add('col-moving');
    return { moving, ghost, mark, gap: null };
  };
  const move = (ev) => {
    if (!drag && Math.abs(ev.clientX - x0) < 5) return;
    drag ||= begin();
    const wr = wrap.getBoundingClientRect();
    if (ev.clientX > wr.right - 30) wrap.scrollLeft += 18;
    else if (ev.clientX < wr.left + 30) wrap.scrollLeft -= 18;
    drag.ghost.style.left = `${ev.clientX + 10}px`;
    drag.ghost.style.top = `${ev.clientY + 12}px`;
    const ths = movableKeys(t).map(k => tableEl(t).querySelector(`thead th[data-col="${k}"]`)?.getBoundingClientRect()).filter(Boolean);
    if (!ths.length) return;
    drag.gap = ths.filter(r => r.left + r.width / 2 < ev.clientX).length;
    const x = drag.gap < ths.length ? ths[drag.gap].left : ths.at(-1).right;
    const top = ths[0].top;
    drag.mark.style.left = `${Math.max(wr.left, Math.min(wr.right, x)) - 1}px`;
    drag.mark.style.top = `${top}px`;
    drag.mark.style.height = `${Math.min(wr.bottom, tableEl(t).getBoundingClientRect().bottom) - top}px`;
  };
  const up = (ev) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!drag) return ev.type === 'pointerup' && selectCol(t, key, ev);
    drag.ghost.remove();
    drag.mark.remove();
    document.body.classList.remove('col-moving');
    if (ev.type !== 'pointerup' || drag.gap == null) return;
    const keys = movableKeys(t);
    const before = keys.slice(drag.gap).find(k => !drag.moving.includes(k)) ?? null;
    const rest = keys.filter(k => !drag.moving.includes(k));
    rest.splice(before == null ? rest.length : rest.indexOf(before), 0, ...drag.moving);
    if (rest.join() === keys.join()) return;
    t.order[orderKey(t)] = rest;
    saveTablePrefs(t);
    renderTableHead(t);
    t.onChange();
  };
  // On the window, so a redraw of the heading mid-drag (e.g. a live update) can't strand it.
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

function startColResize(t, e, handle) {
  e.preventDefault();
  const key = handle.dataset.resize;
  const targets = sizingTargets(t, key);
  const startX = e.clientX, startW = colWidth(t, t.cols().find(c => c.key === key));
  // The columns change; the ones to their right move along with the edge.
  document.body.classList.add('col-resizing');
  handle.closest('th').classList.add('resizing');
  showWidthTip(e, startW, targets.length);
  const move = (ev) => {
    const w = Math.max(MIN_COL_W, Math.round(startW + ev.clientX - startX));
    for (const c of targets) t.widths[widthKey(c)] = w;
    applyTableWidths(t);
    showWidthTip(ev, w, targets.length);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    document.body.classList.remove('col-resizing');
    tableEl(t).querySelector('th.resizing')?.classList.remove('resizing');
    hideWidthTip();
    saveTablePrefs(t);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

function wireTable(t) {
  const head = tableEl(t).querySelector('thead');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-resize]');
    if (handle) return startColResize(t, e, handle);
    const th = e.target.closest('th[data-col]');
    if (!th || e.target.closest('[data-colmenu]')) return;
    e.preventDefault();
    closeTablePop();
    startColMove(t, e, th);
  });
  head.addEventListener('click', (e) => {
    const b = e.target.closest('[data-colmenu]');
    if (!b) return;
    if (tablePop?.choices && tablePop.t === t && tablePop.c.key === b.dataset.colmenu) return closeTablePop();
    openFilterPop(t, b.dataset.colmenu, b);
  });
  head.addEventListener('contextmenu', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    e.preventDefault();
    if (!t.colSel.has(th.dataset.col)) { t.colSel = new Set([th.dataset.col]); t.anchor = th.dataset.col; updateHeadState(t); }
    openColMenu(t, th.dataset.col, e.clientX, e.clientY);
  });
  head.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('[data-resize]');
    if (handle) autofitCols(t, sizingTargets(t, handle.dataset.resize));
  });
  // Clicking anywhere else lets go of the selected columns and closes the menu.
  document.addEventListener('pointerdown', (e) => {
    if (tablePop && !e.target.closest('#tbl-pop, [data-colmenu]')) closeTablePop();
    if (!head.contains(e.target)) clearColSel(t);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (tablePop) closeTablePop(); else clearColSel(t);
  });
  tableEl(t).closest('.table-wrap').addEventListener('scroll', () => { if (tablePop?.t === t) closeTablePop(); });
}

/* ---- items grid ---- */

// How an item reads in a filter list; one that's gone shows its number.
const itemShow = (id) => { const m = itemById(id); return m ? fullLabel(m) : `#${id}`; };
const byItemRef = (a, b) => { const ma = itemById(a), mb = itemById(b); return ma && mb ? cmpRef(ma, mb) : !ma - !mb; };
// The item's ID is an internal key, so it isn't shown; Ref is how people know an item.
const GRID_COLS = [
  { key: 'sel', label: '', w: 36, fixed: true, head: () => `<input type="checkbox" id="grid-sel-all" title="Select all shown" />` },
  { key: 'ref', label: 'Ref', w: 96 },
  { key: 'title', label: 'Title', w: 260 },
  { key: 'description', label: 'Description', w: 220 },
  { key: 'status', label: 'RAG', w: 125, kind: 'status' },
  { key: 'start', label: 'Start', w: 135, kind: 'date', show: fmtNice },
  { key: 'end', label: 'End', w: 135, kind: 'date', show: fmtNice },
  { key: 'parent', label: 'Rolls up to', w: 170, show: itemShow, order: byItemRef, blank: '(None)' },
  { key: 'type', label: 'Type', w: 170, title: 'A single date (diamond; top level ones are under change control and ringed) or a date range (bar)', show: typeLabel },
  { key: 'deps', label: 'Depends on', w: 190, show: itemShow, order: byItemRef, blank: '(None)' },
  { key: 'stream', label: 'Stream', w: 120 },
  { key: 'owner', label: 'Owner', w: 120 },
  { key: 'gitlab_url', label: 'GitLab URL', w: 200 },
  { key: 'use_case_url', label: 'Use case URL', w: 200 },
  { key: 'substream', label: 'Sub-stream', w: 120 },
  { key: 'actions', label: '', w: 40, fixed: true },
];
// Quick update mode: just what changes week to week — RAG (one click) and dates, in this order.
const QUICK_COLS = {
  sel: {}, ref: { w: 70 }, title: { w: 180 }, status: { w: 205, wkey: 'status.compact' }, start: { w: 130 }, end: { w: 130 },
  type: { w: 160 }, owner: { w: 130 }, actions: { w: 90, wkey: 'actions.quick' },
};

const grid = makeTable({
  table: 'editor-table',
  store: 'milestone-tracker.grid',
  mode: 'quick',
  rows: () => state.items,
  cols: () => (grid.mode === 'quick'
    ? Object.entries(QUICK_COLS).map(([k, o]) => ({ ...GRID_COLS.find(c => c.key === k), ...o }))
    : GRID_COLS.filter(c => !linkHidden(c.key))),
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

// Rows to show: [{ m, i }] where i is the item's index in state.items.
// While editing (keepOrder) the rows stay where they are, like a spreadsheet: an edited row
// doesn't jump to its new sort position or vanish from a filter, and new items go at the bottom.
// Sorting, filtering, switching mode or view puts everything back in order.
let gridOrder = null; // ids in the order last shown
let gridKnown = null; // every item id at that point, so new items can be told apart
function gridRows(keepOrder) {
  let rows;
  if (keepOrder && gridOrder) {
    const index = new Map(state.items.map((m, i) => [m.id, i]));
    rows = [...gridOrder.filter(id => index.has(id)), ...state.items.filter(m => !gridKnown.has(m.id)).map(m => m.id)]
      .map(id => ({ m: state.items[index.get(id)], i: index.get(id) }));
  } else {
    const byId = new Map(state.items.map(m => [m.id, m]));
    rows = sortRows(grid, state.items
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => passesFilters(grid, m)),
    (r, key) => gridValue(r.m, key, byId), (a, b) => a.i - b.i);
  }
  gridOrder = rows.map(r => r.m.id);
  gridKnown = new Set(state.items.map(m => m.id));
  return rows;
}

// After an edit: redraw without re-sorting, so the row being worked on stays put.
const refreshEditor = (highlight = []) => renderEditor(highlight, true);

// Put new cell HTML in place. Only cells that changed are touched, and a cell holding the focus
// keeps its control (attributes and options are copied across), so typing — even halfway
// through a date — carries on undisturbed.
function setCell(td, html) {
  if (td._html === html) return;
  td._html = html;
  const live = td.firstElementChild;
  if (live && live === document.activeElement && td.children.length === 1) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    if (tpl.content.children.length === 1 && next.tagName === live.tagName) {
      for (const a of [...live.attributes]) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name);
      for (const a of [...next.attributes]) if (a.name !== 'value' && live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
      if (live.tagName === 'SELECT') { const v = live.value; live.innerHTML = next.innerHTML; live.value = v; }
      return;
    }
  }
  const had = td.contains(document.activeElement) ? document.activeElement : null;
  td.innerHTML = html;
  const same = had && (had.dataset.k ? `[data-k="${had.dataset.k}"]` : had.dataset.adddep != null ? '[data-adddep]' : null);
  if (same) td.querySelector(same)?.focus({ preventScroll: true });
}

function renderEditor(highlight = [], keepOrder = false) {
  const body = document.getElementById('editor-body');
  body.querySelector('.grid-empty')?.parentElement.remove();
  const existing = new Map([...body.children].map(tr => [tr.dataset.id, tr]));
  const byId = new Map(state.items.map(m => [m.id, m]));
  const milestones = state.items.filter(m => !isTask(m)).sort(cmpRef);
  const refCount = new Map();
  for (const m of state.items) if (m.ref) refCount.set(m.ref, (refCount.get(m.ref) || 0) + 1);

  const rows = gridRows(keepOrder);
  const cols = grid.cols();
  const colKeys = cols.map(c => c.key).join();
  let prev = null;
  for (const { m, i } of rows) {
    const task = isTask(m);
    let tr = existing.get(m.id);
    existing.delete(m.id);
    if (!tr || tr.dataset.cols !== colKeys) {
      tr?.remove();
      tr = document.createElement('tr');
      tr.dataset.id = m.id;
      tr.dataset.cols = colKeys;
      tr.innerHTML = cols.map(c => `<td${c.key === 'id' ? ' class="col-id"' : c.key === 'sel' ? ' class="col-sel"' : ''}></td>`).join('');
    }
    if (highlight.includes(m.id)) { // restart the animation on a row that's already showing
      tr.classList.remove('shifted');
      void tr.offsetWidth;
      tr.classList.add('shifted');
    }
    tr.classList.toggle('selected', gridSel.has(m.id));

    const parentOpts = milestones.filter(p => p.id !== m.id);
    if (m.parent && !parentOpts.some(p => p.id === m.parent)) parentOpts.push(byId.get(m.parent));
    const depOpts = state.items.filter(p => p.id !== m.id && !m.deps.includes(p.id)).sort(cmpRef);
    const chips = m.deps.map(d => `
      <span class="chip" title="${escAttr(byId.get(d)?.title)}">${escAttr(itemLabel(byId.get(d)))}<button data-rmdep="${i}" data-dep="${d}" title="Remove dependency">×</button></span>`).join('');
    const dup = refCount.get(m.ref) > 1;
    const late = isLate(m);
    const clash = clashOf(m);

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
      stream: `<input data-i="${i}" data-k="stream" value="${escAttr(streamName(m.stream_id))}" list="stream-list" placeholder="Stream" />`,
      substream: `<input data-i="${i}" data-k="substream" value="${escAttr(m.substream)}" list="substream-list" placeholder="Sub-stream" />`,
      owner: `<input data-i="${i}" data-k="owner" value="${escAttr(m.owner)}" list="owner-list" placeholder="Owner" />`,
      gitlab_url: `<input data-i="${i}" data-k="gitlab_url" type="url" value="${escAttr(m.gitlab_url)}" placeholder="https://…" />`,
      use_case_url: `<input data-i="${i}" data-k="use_case_url" type="url" value="${escAttr(m.use_case_url)}" placeholder="https://…" />`,
      start: `<input data-i="${i}" data-k="start" type="date" value="${escAttr(m.start)}"${dateTitle} />`,
      end: `<input data-i="${i}" data-k="end" type="date" value="${escAttr(m.end)}"${late || clash ? ` class="${late ? 'late' : 'clash'}" title="${escAttr([
        late && lateText(m), clash && `Flagged: ends ${daysText(clash.gap)} after ${fullLabel(clash.p)}, which it rolls up to`].filter(Boolean).join(' · '))}"` : dateTitle} />`,
      status: quick ? `<div class="rag-pick sm compact">${ragButtons(m.status, `data-i="${i}"`)}</div>`
        : `<select data-i="${i}" data-k="status" class="status-sel" style="color:${pal(m.status).dark}">${statusOptions(m.status)}</select>`,
      parent: `<select data-i="${i}" data-k="parent"><option value="">—</option>${parentOpts.map(p => `<option value="${p.id}" ${p.id === m.parent ? 'selected' : ''}>${escAttr(fullLabel(p))}</option>`).join('')}</select>`,
      deps: `<div class="deps">${chips}<select data-adddep="${i}" class="add-dep"><option value="">+ add</option>${depOpts.map(p => `<option value="${p.id}">${escAttr(fullLabel(p))}</option>`).join('')}</select></div>`,
      actions: quick ? (reportsOff() ? '' : `<button class="btn btn-sm" data-report="${m.id}" title="Write a report on this ${escAttr(T.item)}">New report</button>`)
        : `<button class="btn-del" data-del="${i}" title="Delete row">✕</button>`,
    };
    cols.forEach((c, j) => setCell(tr.children[j], cells[c.key]));
    const at = prev ? prev.nextSibling : body.firstChild;
    if (tr !== at) body.insertBefore(tr, at); // rows only move when the order really changed
    prev = tr;
  }
  for (const tr of existing.values()) tr.remove();
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="grid-empty">${state.items.length ? `No ${escAttr(T.items)} match the filters.` : `No ${escAttr(T.items)} in this workspace yet. Use <b>+ Add ${escAttr(T.item)}</b> to create one.`}</td></tr>`;
  }

  updateHeadState(grid);
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

const pendingDates = new WeakSet(); // date cells typed into but not yet applied

// Copy table edits into state (optionally skipping one control whose change is handled separately).
function syncEditorToState(skip) {
  document.querySelectorAll('#editor-body [data-k]').forEach(el => {
    // A date still being typed is left alone: applyDateEdit moves it, with its dependants, on leaving the field.
    if (el === skip || pendingDates.has(el)) return;
    const m = state.items[+el.dataset.i];
    // the stream cell is typed as a name: an existing stream of the workspace, or a new one
    if (el.dataset.k === 'stream') { if (el.value.trim() !== streamName(m.stream_id)) m.stream_id = streamIdFor(m.workspace_id, el.value); return; }
    m[el.dataset.k] = el.type === 'checkbox' ? (el.checked ? 'yes' : '') : el.value;
  });
}

async function applyTableChange(m, changes, msg) {
  const res = await guardChange(() => updateItem(m, changes));
  if (!res) { // cancelled: rebuild the row so its cells show the saved values again
    const tr = document.querySelector(`#editor-body tr[data-id="${m.id}"]`);
    if (tr) delete tr.dataset.cols;
    return refreshEditor();
  }
  if (res.error) {
    flashStatus(res.error, false);
    return refreshEditor();
  }
  growRangeTo([m.id, ...res.moved]);
  refreshEditor(res.moved);
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
    refreshEditor();
    return scheduleSave();
  }

  if (k === 'type') {
    syncEditorToState(t);
    return applyTableChange(m, { type: t.value }, `${itemLabel(m)} is now ${withArticle(typeLabel(t.value).toLowerCase())}`);
  }

  if (k === 'parent') {
    syncEditorToState(t);
    return applyTableChange(m, { parent: t.value });
  }

  if (k === 'start' || k === 'end') {
    // Date inputs fire change on every keystroke, so apply it once you leave the field (or press Enter).
    if (t === document.activeElement) return void pendingDates.add(t);
    return applyDateEdit(t);
  }

  syncEditorToState(); // plain field (title, owner, status, …) — sync now so a re-render can't drop it
  scheduleSave();
}

function applyDateEdit(t) {
  pendingDates.delete(t);
  if (t.value && (+t.value.slice(0, 4) < 1900 || !parseDate(t.value))) return; // half-typed, e.g. year 0002
  syncEditorToState(t);
  applyTableChange(state.items[+t.dataset.i], { [t.dataset.k]: t.value });
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
    refreshEditor();
    return scheduleSave();
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    syncEditorToState();
    const m = state.items[+del.dataset.del];
    const snap = snapshotData();
    guardChange(() => removeItem(m.id) ?? true).then(ok => {
      refreshEditor();
      if (!ok) return;
      offerUndo(snap, `Deleted ${fullLabel(m)}`);
      scheduleSave('Deleted');
    });
  }
}

/* ---- row selection + bulk actions ---- */
// Tick rows (shift-click for a range) to set one field on all of them, move their dates or delete them.

const gridSel = new Set(); // ids of the selected rows; always a subset of the rows shown
let gridSelAnchor = null;  // last row ticked, where a shift-click range starts
let bulkField = 'status';

const BULK_FIELDS = () => [
  ['status', 'RAG'], ['owner', 'Owner'], ['stream', 'Stream'], ['substream', 'Sub-stream'],
  ['type', 'Type'], ['parent', 'Rolls up to'], ['shift', 'Dates — move by'],
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
  const streams = (list) => `<input id="bulk-input" list="${list}" placeholder="Leave blank to clear" />`;
  switch (bulkField) {
    case 'status': return `<span>to</span><select id="bulk-input">${statusOptions(DEFAULT_STATUS)}</select>`;
    case 'owner': return `<span>to</span>${streams('owner-list')}`;
    case 'stream': return '<span>to</span><input id="bulk-input" list="stream-list" placeholder="Stream" />';
    case 'substream': return `<span>to</span>${streams('substream-list')}`;
    case 'type': return `<span>to</span><select id="bulk-input">${typeOptions('milestone')}</select>`;
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

async function applyBulk() {
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
    const ok = await guardChange(() => {
      for (const m of items) shiftItem(m, n);
      cascadeShift(items.map(m => m.id), n);
      enforceConstraints();
      return true;
    });
    if (!ok) return;
    const moved = others();
    for (const m of items) directEdits.add(m.id);
    for (const id of moved) knockOn.add(id);
    refreshEditor([...items.map(m => m.id), ...moved]);
    offerUndo(snap, `Moved ${count(items.length, T.item, T.items)} ${Math.abs(n)} day${Math.abs(n) > 1 ? 's' : ''} ${n > 0 ? 'later' : 'earlier'}`);
    return scheduleSave(`Moved ${count(items.length, T.item, T.items)} ${Math.abs(n)} day${Math.abs(n) > 1 ? 's' : ''} ${n > 0 ? 'later' : 'earlier'}${also(moved)}`);
  }
  if (bulkField === 'stream' && !v) return flashStatus('Enter a stream', false);

  let done = 0, skipped = 0;
  const ok = await guardChange(() => {
    done = skipped = 0;
    for (const m of items) {
      if (bulkField === 'parent' && v === m.id) { skipped++; continue; } // can't roll up to itself
      if (updateItem(m, bulkField === 'stream' ? { stream_id: streamIdFor(m.workspace_id, v) } : { [bulkField]: v }).error) skipped++; else done++;
    }
    return true;
  });
  if (!ok) return;
  const moved = others();
  const label = BULK_FIELDS().find(([k]) => k === bulkField)[1];
  refreshEditor(moved);
  if (done) offerUndo(snap, `${label} updated on ${count(done, T.item, T.items)}`);
  scheduleSave(`${label} updated on ${count(done, T.item, T.items)}` +
    (skipped ? ` · ${skipped} skipped (would roll up to itself or create a loop)` : '') + also(moved));
}

async function bulkDelete() {
  syncEditorToState();
  const items = selectedItems();
  if (!items.length) return;
  const what = count(items.length, T.item, T.items);
  const snap = snapshotData();
  if (!await guardChange(() => { for (const m of items) removeItem(m.id); return true; })) return;
  gridSel.clear();
  refreshEditor();
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
  const id = takeId('reports', () => String(Math.max(state.lastReportId, ...allReports().map(r => +r.id || 0)) + 1));
  state.lastReportId = Math.max(state.lastReportId, +id);
  return id;
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
  if (reportsOff()) return '';
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
  const rollsTo = m.parent && itemById(m.parent);
  document.getElementById('quick').innerHTML = `
    <form class="q-form" novalidate>
    <div class="q-head">
      <span class="type-badge ${task ? 'task' : isTopLevel(m) ? 'ms tl' : 'ms'}">${escAttr(typeName(m))}</span>
      <span class="q-title">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>
      <button type="button" class="dlg-close" data-act="cancel" title="Close without saving (Esc)">✕</button>
    </div>
    <div class="q-label">RAG</div>
    <div class="rag-pick">${ragButtons(d.status)}</div>
    <div class="q-row">
      <div>
        <div class="q-label">Type</div>
        <div class="q-type" role="group" aria-label="Type">${TYPES.map(t => `
          <button type="button" data-type="${t}" aria-pressed="${t === d.type}" title="${t === 'task' ? 'A date range, drawn as a bar' : t === 'top' ? 'A single date under change control, drawn as a ringed diamond' : 'A single date, drawn as a diamond'}">${escAttr(typeLabel(t))}</button>`).join('')}</div>
      </div>
      <div class="q-dates">
        ${task
          ? `<label>Start<input type="date" name="start" value="${d.start}" /></label><label>End<input type="date" name="end" value="${d.end}" /></label>`
          : `<label>Date<input type="date" name="end" value="${d.end}" /></label>`}
      </div>
    </div>
    ${itemLinks(m).length ? `<div class="q-links">${itemLinks(m).map(([k, u]) => `<span>${k}: ${linkOut(u)}</span>`).join('')}</div>` : ''}
    ${isTopLevel(m) ? `<p class="q-note q-tl">⚠ Top level ${escAttr(T.milestone)} — under change control. Saving a new date asks for confirmation.</p>` : ''}
    ${rollsTo ? `<p class="q-note">Rolls up to ${escAttr(fullLabel(rollsTo))} (${fmtNice(rollsTo.end)}). Ending after it asks whether to move it or flag the clash.</p>` : ''}
    ${deps ? `<p class="q-note">Moving the ${task ? 'end ' : ''}date moves ${deps} dependent ${escAttr(deps > 1 ? T.items : T.item)} by the same amount.</p>` : ''}
    <p class="q-msg">${escAttr(quickMsg)}</p>
    <div class="q-save">
      <span class="q-unsaved"></span>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
    <div class="q-foot">
      ${reportsOff() ? '' : `<button type="button" class="btn" data-act="report">New report…</button>
      <button type="button" class="btn" data-act="history" ${n ? '' : 'disabled'}>Reports (${n})</button>`}
      <button type="button" class="btn" data-act="dates">Date log</button>
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
  const changes = { type: d.type, end: d.end, start: task ? d.start : d.end };
  let res = { moved: [] };
  if (changes.type !== m.type || changes.end !== m.end || changes.start !== m.start) {
    const typeChanged = changes.type !== m.type;
    res = await guardChange(() => updateItem(m, changes));
    if (!res) return; // the panel stays open with the change in it
    if (res.error) {
      quickMsg = res.error;
      return renderQuick();
    }
    if (typeChanged) msgs.push(`now ${withArticle(task ? T.task : T.milestone)}`);
    msgs.push(task ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end));
  }
  if (d.status !== m.status) { m.status = d.status; msgs.unshift(`RAG ${d.status}`); }
  hideQuick();
  if (res.moved.length) flashMoved([m.id, ...res.moved]);
  growRangeTo([m.id, ...res.moved]);
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
let rpOpened = null;   // its values when the dialog opened
let rpItemId = '';
let rpDateTouched = false; // stop re-defaulting the period once the user picks a date
let rpPrevIdx = 0;         // which earlier report the side panel shows (0 = the one just before)

function openReportDialog({ report = null, itemId = '' } = {}) {
  hideTip();
  hideQuick();
  rpEditing = report;
  rpOpened = report && { ...report };
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

  document.getElementById('rp-heading').textContent = report ? 'Edit report' : 'New report';
  document.getElementById('rp-submit').textContent = 'Save report';
  document.getElementById('rp-delete').hidden = !report;
  document.getElementById('rp-meta').textContent = report
    ? `Submitted ${fmtStamp(report.created)}` + (report.updated !== report.created ? ` · last edited ${fmtStamp(report.updated)}` : '')
    : '';
  refreshDatalists();
  refreshReportForm();
  document.getElementById('report-dialog').showModal();
  if (rpItemId) focusText(f.exec_summary); else f.item_id.focus();
}

// Everything that leads up to a milestone, for the report on it: the items that roll up to it and
// the ones it depends on, followed all the way back (the chain the Gantt chart lights up when the
// milestone is hovered). Each with its RAG, dates and owner, in date order, and how the direct
// ones are linked. Nothing when the chain is empty.
function rollupListHtml(m) {
  if (!m || !state.items.includes(m)) return '';
  const up = [...chainParts(m.id).up].map(itemById).filter(Boolean)
    .sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start) || cmpRef(a, b));
  if (!up.length) return '';
  const when = (k) => (isTask(k) ? `${fmtShort(k.start)} – ${fmtShort(k.end)}` : fmtShort(k.end));
  const how = (k) => (k.parent === m.id ? 'rolls up to it' : m.deps.includes(k.id) ? 'it depends on this' : '');
  return `<div class="rp-rollup"><div class="rp-rollup-head">Leads up to it <span class="rp-rollup-n">${up.length}</span></div>
    <ul class="rp-rollup-list">${up.map(k => `<li>${statusPill(k.status)}<span class="rp-rollup-title">${k.ref ? `<b>${escAttr(k.ref)}</b> ` : ''}${escAttr(k.title)}</span>
      <small>${escAttr(typeName(k))} · ${when(k)}${k.owner ? ` · ${escAttr(k.owner)}` : ''}</small>${how(k) ? `<em class="rp-rollup-how">${how(k)}</em>` : ''}</li>`).join('')}</ul></div>`;
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
  hist.textContent = `Reports (${n})`;

  const strip = document.getElementById('rp-item');
  strip.hidden = !rpItemId;
  strip.innerHTML = m
    ? `${statusPill(m.status)}<span class="rp-item-title">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>
       <span class="rp-item-meta">${escAttr(typeName(m))} · ${isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : `due ${fmtNice(m.end)}`}${m.owner ? ` · ${escAttr(m.owner)}` : ''}</span>
       ${rollupListHtml(m)}`
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
  if (rpEditing && !state.reports.includes(rpEditing)) return (err.textContent = 'Someone else has just deleted this report.');
  if (rpEditing) Object.assign(rpEditing, changedFrom(v, rpOpened), { updated: now });
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
  const hadComments = dropComments([rpEditing.id]);
  document.getElementById('report-dialog').close();
  rerenderCurrentView();
  offerUndo(snap, label);
  await Promise.all([saveReports('Report deleted'), hadComments && saveComments()]);
}

// Reports whose item no longer exists, e.g. after the items file was replaced.
const orphanReports = () => state.reports.filter(r => !itemById(r.item_id));

async function deleteOrphanReports() {
  const gone = new Set(orphanReports());
  if (!gone.size || !leavePaneEdit()) return;
  const snap = snapshotData();
  state.reports = state.reports.filter(r => !gone.has(r));
  const hadComments = dropComments([...gone].map(r => r.id));
  paneEditing = false;
  rerenderCurrentView();
  offerUndo(snap, `Deleted ${count(gone.size, 'report', 'reports')} on deleted ${T.items}`);
  await Promise.all([saveReports(`${count(gone.size, 'report', 'reports')} deleted`), hadComments && saveComments()]);
}

function rerenderCurrentView() {
  updateDueBadge();
  updateRaidBadge();
  if (isShown('gantt')) renderGantt();
  if (isShown('dash')) renderDash();
  if (isShown('reports')) renderReports();
  if (isShown('workspaces')) renderWorkspaces();
  if (isShown('overview')) renderOverview();
  if (isShown('streams')) renderStreamOverview();
  if (isShown('changes')) renderChanges();
  if (isShown('raid')) renderRaid();
}

/* ---- reports list ---- */

const itemName = (id) => { const m = itemById(id); return m ? fullLabel(m) : `Deleted ${T.item} #${id}`; };

// `sort` is the value the column sorts by; `vals` what its filter list offers (a time by its day).
const stampDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : fmtISO(d); };
const RPT_COLS = [
  { key: 'period_end', label: 'Period ending', w: 150, kind: 'date', show: fmtNice },
  { key: 'item_id', label: () => T.Item, w: 230, sort: r => itemById(r.item_id) || null, show: itemName, order: byItemRef },
  { key: 'cadence', label: 'Cadence', w: 115, sort: r => CADENCES.indexOf(r.cadence), order: (a, b) => CADENCES.indexOf(a) - CADENCES.indexOf(b) },
  { key: 'status', label: 'RAG', w: 120, kind: 'status' },
  { key: 'exec_summary', label: 'Exec summary', w: 420, vals: r => mdToText(r.exec_summary) },
  { key: 'author', label: 'Author', w: 130 },
  { key: 'comments', label: 'Comments', w: 110, sort: r => openThreads(r.id).length, vals: r => (openThreads(r.id).length ? 'Open' : threadsOf(r.id).length ? 'Resolved' : 'None') },
  { key: 'created', label: 'Created', w: 120, kind: 'date', vals: r => stampDay(r.created), show: fmtNice },
  { key: 'updated', label: 'Last updated', w: 120, kind: 'date', vals: r => stampDay(r.updated), show: fmtNice },
];

// With the preview open the list keeps to what identifies a report; the pane shows the rest.
const PREVIEW_HIDDEN = ['cadence', 'exec_summary'];
const rptTable = makeTable({
  table: 'reports-table', store: 'milestone-tracker.reports-grid', onChange: () => renderReports(), rows: () => state.reports,
  cols: () => (rptPreview ? RPT_COLS.filter(c => !PREVIEW_HIDDEN.includes(c.key)) : RPT_COLS),
});
let rptSearch = ''; // free-text search across every report field, from the toolbar

function clearReportFilters() {
  clearTableFilters(rptTable);
  rptSearch = '';
}

function showReportsFor(itemId) {
  clearReportFilters();
  rptTable.filters.item_id = [itemId];
  switchView('reports');
}

// Newest period first, then by item ref.
const reportDefaultOrder = (a, b) => b.period_end.localeCompare(a.period_end)
  || ((ma, mb) => (ma && mb ? cmpRef(ma, mb) : 0))(itemById(a.item_id), itemById(b.item_id));

// Reports matching the filters on the Reports tab, in the table's sort order.
function filteredReports() {
  const q = rptSearch.trim().toLowerCase();
  const rows = state.reports.filter(r =>
    passesFilters(rptTable, r)
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

let rptMode = 'all'; // 'all' item reports, what's 'due', or the 'weekly' updates

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
              <td class="due-act"><button type="button" class="btn btn-sm" data-due-report="${d.m.id}">New report…</button></td>
            </tr>`).join('')}
        </tbody>`).join('')}
    </table>`
    : `<p class="due-empty">Every ${escAttr(T.item)} that’s under way has a report for this period. Nothing is due.</p>`;
}

// The weekly updates of this workspace and its streams, week by week, newest first. Each opens
// in the weekly update dialog, as from the Portfolio and Streams tables.
function renderWeekly() {
  const p = currentWorkspace();
  const rg = ragOf(p.id);
  const order = ['', ...streamsInOrder().filter(Boolean)];
  const ups = state.updates.filter(u => u.workspace_id === p.id);
  const weeks = [...new Set(ups.map(u => u.week_ending))].sort((a, b) => b.localeCompare(a));
  const thisWeek = defaultPeriodEnd('Weekly');
  const subjectName = (u) => (u.stream_id ? escAttr(streamName(u.stream_id) || '(Deleted stream)') : `<b>${escAttr(p.name)}</b> <span class="muted">· whole workspace</span>`);
  document.getElementById('rp-weekly').innerHTML = ups.length ? `
    <table class="due-table wk-table">
      <thead><tr><th>Week ending</th><th>For</th><th>RAG</th><th>Summary</th><th>Updated by</th><th></th></tr></thead>
      ${weeks.map(w => `
        <tbody>
          <tr class="due-owner"><th colspan="6">Week ending ${fmtNice(w)}${w === thisWeek ? ' <span class="muted">· this week</span>' : ''}</th></tr>
          ${ups.filter(u => u.week_ending === w).sort((a, b) => { const i = order.indexOf(a.stream_id || ''), j = order.indexOf(b.stream_id || ''); return (i < 0) - (j < 0) || i - j; }).map(u => `
            <tr data-update="${u.id}" tabindex="0" title="Open this update">
              <td class="wk-week">${fmtShort(u.week_ending)}</td>
              <td>${subjectName(u)}</td>
              <td>${statusPill(u.status, rg.map)}</td>
              <td class="wk-sum">${u.summary ? `<div class="md">${mdToHtml(u.summary)}</div>` : '<span class="muted">No summary</span>'}</td>
              <td>${escAttr(u.author)}</td>
              <td class="due-act"><button type="button" class="btn btn-sm" data-open-update="${u.id}">Open</button></td>
            </tr>`).join('')}
        </tbody>`).join('')}
    </table>`
    : `<p class="due-empty">No weekly updates yet. <b>+ New update</b> records this week’s update for ${escAttr(p.name)}; a stream’s is recorded from its row on <b>Streams</b>.</p>`;
}
function openUpdateById(id) {
  const u = state.updates.find(x => x.id === id);
  if (!u) return;
  const p = workspaceById(u.workspace_id);
  openUpdateDialog(u.stream_id ? streamSubject(p, u.stream_id) : programSubject(p));
  document.getElementById('update-form').elements.week_ending.value = u.week_ending;
  loadUpdateWeek(true);
}

function setReportsMode(mode) {
  if (mode === rptMode) return;
  if (mode !== 'all' && !leavePaneEdit()) return (document.querySelector('[name="rp-mode"][value="all"]').checked = true);
  rptMode = mode;
  saveAppPrefs({ reportsMode: mode });
  renderReports();
}

function renderReports() {
  updateDueBadge();
  document.querySelectorAll('[name="rp-mode"]').forEach(r => { r.checked = r.value === rptMode; });
  const due = rptMode === 'due', weekly = rptMode === 'weekly', list = !due && !weekly;
  document.getElementById('rp-due').hidden = !due;
  document.getElementById('rp-weekly').hidden = !weekly;
  document.getElementById('rp-split').hidden = !list;
  for (const el of document.querySelectorAll('#view-reports .rp-list-only')) el.hidden = !list; // search and preview belong to the list
  document.getElementById('rp-hint').classList.toggle('help-off', !list);
  document.getElementById('rp-due-hint').classList.toggle('help-off', !due);
  document.getElementById('rp-weekly-hint').classList.toggle('help-off', !weekly);
  document.getElementById('rp-count').hidden = !list;
  document.getElementById('ex-reports').parentElement.hidden = !list; // the list is what's exported
  document.getElementById('btn-new-report').hidden = weekly;
  document.getElementById('btn-new-update').hidden = !weekly;
  if (!list) {
    document.getElementById('btn-rp-orphans').hidden = true;
    return due ? renderDue() : renderWeekly();
  }
  updateHeadState(rptTable); // filters can be set from elsewhere, e.g. "All reports on this item"
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
    comments: r => { const n = openThreads(r.id).length, all = threadsOf(r.id).length; return `<td class="rc-cm">${n ? `<span class="cm-badge" title="${count(n, 'open comment thread', 'open comment threads')}">💬 ${n}</span>` : all ? `<small class="muted">${all} resolved</small>` : ''}</td>`; },
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
      : `No reports in this workspace yet. Click ${escAttr(withArticle(T.item))} on the plan and choose <b>New report</b>, or use <b>+ New report</b>.`}</td></tr>`;
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


/* ---- report comments ---- */
// Select some words of a report in the preview and a Comment button appears beside them, as in
// PowerPoint or Word. The comment is pinned to that passage (its section, where it sits and the
// words themselves) and shown as a highlight; anyone can reply in the thread, listed under the
// report. A thread is resolved once it's dealt with (resolved threads are hidden until "Show
// resolved") or deleted with its replies. Comments are a file of their own (report-comments.csv),
// so two people commenting at once never clash. If the report is edited the passage is found
// again by its words; if they're gone the thread says so and stays readable.

const COMMENT_COLUMNS = ['id', 'workspace_id', 'report_id', 'field', 'quote', 'start', 'end', 'parent_id', 'at', 'by', 'text', 'resolved'];
function rowsToComments(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  return rows.slice(1).map(r => {
    const c = Object.fromEntries(COMMENT_COLUMNS.map(k => [k, (r[header.indexOf(k)] ?? '').trim()]));
    c.resolved = /^(yes|true|1)$/i.test(c.resolved) ? 'yes' : '';
    return c;
  }).filter(c => ids.has(c.workspace_id) && c.report_id && c.text);
}
function commentsToCSV(list) {
  return [COMMENT_COLUMNS.join(','), ...list.map(c => COMMENT_COLUMNS.map(k => csvEscape(c[k])).join(','))].join('\n') + '\n';
}
const nextCommentId = () => takeId('report-comments', () => String(Math.max(0, ...state.reportComments.map(c => +c.id || 0)) + 1));
const commentsOf = (reportId) => state.reportComments.filter(c => c.report_id === reportId);
const byCommentTime = (a, b) => a.at.localeCompare(b.at) || +a.id - +b.id;
// A report's threads, oldest first: each root comment with its replies.
function threadsOf(reportId) {
  const all = commentsOf(reportId);
  return all.filter(c => !c.parent_id).sort(byCommentTime).map(root => ({ root, replies: all.filter(c => c.parent_id === root.id).sort(byCommentTime) }));
}
const openThreads = (reportId) => threadsOf(reportId).filter(t => !t.root.resolved);
// Deleted reports take their comments with them; true if there were any.
function dropComments(reportIds) {
  const gone = new Set(reportIds);
  const before = state.reportComments.length;
  state.reportComments = state.reportComments.filter(c => !gone.has(c.report_id));
  return state.reportComments.length !== before;
}

let cmDraft = null;    // a comment being written: { field, quote, start, end }
let cmReplyTo = null;  // the thread a reply is being written in
let cmDraftText = '';  // what's been typed, kept through a redraw (e.g. someone else's change arriving)
let cmActive = null;   // the thread picked out in the text and the list
let cmPending = null;  // what the Comment button beside the selection would comment on
function resetCommentUi() { cmDraft = null; cmReplyTo = null; cmDraftText = ''; cmActive = null; }

// Where a comment's passage sits in a section's text now: [start, end], or null if the words are gone.
function anchorIn(text, c) {
  const a = +c.start, b = +c.end, q = c.quote;
  if (!q) return null;
  if (text.slice(a, b) === q) return [a, b];
  const i = text.indexOf(q);
  return i < 0 ? null : [i, i + q.length];
}
// Wrap the characters [a, b) of an element's text (as textContent counts them) in elements from
// `make`, one per text node they cross, so the markup around them is left as it is.
function wrapTextRange(root, a, b, make) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = pos, e = pos + n.data.length;
    pos = e;
    if (e <= a || s >= b || e === s) continue;
    parts.push([n, Math.max(a, s) - s, Math.min(b, e) - s]);
  }
  for (const [n, from, to] of parts) {
    let t = n;
    if (to < t.data.length) t.splitText(to);
    if (from > 0) t = t.splitText(from);
    const m = make();
    t.replaceWith(m);
    m.append(t);
  }
}
// Highlight each thread's passage in the rendered report. Returns the ids of the threads whose
// words were found (resolved ones are found but only highlighted with "Show resolved").
function paintComments(el, r) {
  const found = new Set();
  const showAll = !!loadAppPrefs().cmShowResolved;
  const mark = (cls, cid) => () => { const m = document.createElement('mark'); m.className = cls; if (cid) m.dataset.cid = cid; return m; };
  for (const sec of el.querySelectorAll('.pane-sec')) {
    const md = sec.querySelector('.md');
    if (!md) continue;
    const text = md.textContent;
    for (const c of commentsOf(r.id).filter(c => !c.parent_id && c.field === sec.dataset.field)) {
      const at = anchorIn(text, c);
      if (!at) continue;
      found.add(c.id);
      if (c.resolved && !showAll) continue;
      wrapTextRange(md, at[0], at[1], mark(`cm${c.resolved ? ' resolved' : ''}${c.id === cmActive ? ' active' : ''}`, c.id));
    }
    if (cmDraft && cmDraft.field === sec.dataset.field) wrapTextRange(md, cmDraft.start, cmDraft.end, mark('cm draft'));
  }
  return found;
}

const shortQuote = (q) => { const s = q.replace(/\s+/g, ' ').trim(); return s.length > 160 ? s.slice(0, 160) + '…' : s; };
const sectionLabel = (field) => PANE_TEXTS.find(s => s.key === field)?.label || field;
function commentsPanelHtml(r, found) {
  const threads = threadsOf(r.id);
  const open = threads.filter(t => !t.root.resolved), resolved = threads.length - open.length;
  const showAll = !!loadAppPrefs().cmShowResolved;
  const shown = showAll ? threads : open;
  const who = escAttr(loadAppPrefs().commentAuthor || '');
  const composer = (kind, ph) => `
    <form class="cm-form" data-cm-form="${kind}">
      <textarea name="text" rows="2" placeholder="${ph}">${escAttr(cmDraftText)}</textarea>
      <div class="cm-form-row"><input name="by" placeholder="Your name" value="${who}" list="owner-list" title="Shown with your comment and remembered in this browser" />
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-cm="cancel" title="Esc">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary" title="${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter">${kind === 'reply' ? 'Reply' : 'Comment'}</button></div>
    </form>`;
  const one = (c, cls = '') => `<div class="cm-c ${cls}" data-cid="${c.id}"><div class="cm-meta"><b>${c.by ? escAttr(c.by) : 'Someone'}</b> · ${fmtStamp(c.at)}</div><div class="cm-text">${escAttr(c.text)}</div></div>`;
  const thread = ({ root, replies }) => {
    const lost = !found.has(root.id);
    return `<li class="cm-thread${root.resolved ? ' resolved' : ''}${lost ? ' lost' : ''}${root.id === cmActive ? ' active' : ''}" data-tid="${root.id}">
      <button type="button" class="cm-quote" data-cm="goto" title="${lost ? 'The words this was about are no longer in the report' : 'Show these words in the report'}">
        <span class="cm-sec">${escAttr(sectionLabel(root.field))}${lost ? ' · text since changed' : ''}${root.resolved ? ' · resolved' : ''}</span>“${escAttr(shortQuote(root.quote))}”</button>
      ${one(root, 'root')}
      ${replies.map(c => one(c, 'reply')).join('')}
      ${cmReplyTo === root.id ? composer('reply', 'Reply…') : `<div class="cm-actions">
        <button type="button" class="link-btn" data-cm="reply">Reply</button>
        <button type="button" class="link-btn" data-cm="resolve">${root.resolved ? 'Reopen' : 'Resolve'}</button>
        <button type="button" class="link-btn cm-del" data-cm="delete">Delete</button></div>`}
    </li>`;
  };
  return `<section class="pane-comments" aria-label="Comments">
    <div class="cm-head"><h3>Comments${open.length ? ` <span class="cm-n">${open.length} open</span>` : ''}</h3>
      ${resolved ? `<label class="check"><input type="checkbox" data-cm="show-resolved" ${showAll ? 'checked' : ''} /> Show resolved (${resolved})</label>` : ''}</div>
    ${cmDraft ? `<div class="cm-thread draft"><div class="cm-quote"><span class="cm-sec">${escAttr(sectionLabel(cmDraft.field))}</span>“${escAttr(shortQuote(cmDraft.quote))}”</div>${composer('new', 'Your comment on these words…')}</div>` : ''}
    ${shown.length ? `<ol class="cm-threads">${shown.map(thread).join('')}</ol>` : ''}
    ${!shown.length && !cmDraft ? `<p class="cm-hint">${threads.length ? 'Every thread is resolved.' : 'Select some words in the report and click <b>Comment</b> to start a thread on them.'}</p>` : ''}
  </section>`;
}

// What the current selection would comment on, if it's some words of the report being previewed.
function selectionAnchor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || paneEditing) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const md = (node.nodeType === 1 ? node : node.parentElement)?.closest('#rp-pane .pane-sec .md');
  if (!md) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const pre = document.createRange();
  pre.selectNodeContents(md);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const lead = quote.length - quote.trimStart().length, trail = quote.length - quote.trimEnd().length;
  return { field: md.closest('.pane-sec').dataset.field, quote: quote.trim(), start: start + lead, end: start + quote.length - trail, rect: range.getBoundingClientRect() };
}
// The Comment button floats just above (or below) the selected words, and goes when they're
// deselected or scrolled out of the pane.
function updateCommentFloat() {
  const btn = document.getElementById('cm-float');
  if (!btn) return;
  const a = isShown('reports') && rptPreview && !document.querySelector('dialog[open]') ? selectionAnchor() : null;
  cmPending = a;
  const pane = document.getElementById('rp-pane').getBoundingClientRect();
  if (!a || a.rect.bottom < pane.top || a.rect.top > pane.bottom) { btn.hidden = true; return; }
  btn.hidden = false;
  const w = btn.offsetWidth || 110;
  const x = Math.min(Math.max(pane.left + 8, a.rect.left + a.rect.width / 2 - w / 2), Math.max(pane.left + 8, pane.right - w - 8));
  const above = a.rect.top - 42 > pane.top;
  btn.style.left = `${Math.round(x)}px`;
  btn.style.top = `${Math.round(above ? a.rect.top - 38 : a.rect.bottom + 8)}px`;
}
function startComment(anchor) {
  if (!anchor || !selectedReport()) return;
  const { rect, ...a } = anchor;
  cmDraft = a;
  cmReplyTo = null;
  cmDraftText = '';
  window.getSelection()?.removeAllRanges();
  renderPane();
}
function focusThread(cid) {
  cmActive = cid;
  renderPane();
  const el = document.getElementById('rp-pane');
  el.querySelector(`.cm-thread[data-tid="${CSS.escape(cid)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function onCommentAction(btn) {
  const r = selectedReport();
  if (!r) return;
  const act = btn.dataset.cm;
  const tid = btn.closest('[data-tid]')?.dataset.tid;
  const root = tid && state.reportComments.find(c => c.id === tid);
  if (act === 'cancel') { cmDraft = null; cmReplyTo = null; cmDraftText = ''; return renderPane(); }
  if (act === 'show-resolved') { saveAppPrefs({ cmShowResolved: btn.checked }); return renderPane(); }
  if (act === 'goto') {
    cmActive = tid;
    renderPane();
    return document.querySelector(`#rp-pane mark.cm[data-cid="${CSS.escape(tid)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (!root) return;
  if (act === 'reply') { cmReplyTo = tid; cmDraft = null; cmDraftText = ''; cmActive = tid; return renderPane(); }
  if (act === 'resolve') {
    root.resolved = root.resolved ? '' : 'yes';
    renderReports(); // the list's counts, and the pane
    return saveComments(root.resolved ? 'Comment resolved' : 'Comment reopened');
  }
  if (act === 'delete') {
    const n = commentsOf(r.id).filter(c => c.parent_id === tid).length;
    if (!confirm(`Delete this comment${n ? ` and its ${count(n, 'reply', 'replies')}` : ''}?`)) return;
    const snap = snapshotData();
    state.reportComments = state.reportComments.filter(c => c.id !== tid && c.parent_id !== tid);
    if (cmReplyTo === tid) cmReplyTo = null;
    renderReports();
    offerUndo(snap, `Deleted a comment on the report for ${fmtShort(r.period_end)}`);
    await saveComments('Comment deleted');
  }
}
function submitComment(form) {
  const r = selectedReport();
  const text = form.elements.text.value.trim(), by = form.elements.by.value.trim();
  if (!r) return;
  if (!text) return form.elements.text.focus();
  saveAppPrefs({ commentAuthor: by });
  const reply = form.dataset.cmForm === 'reply';
  if (reply ? !cmReplyTo : !cmDraft) return;
  const c = {
    id: nextCommentId(), workspace_id: r.workspace_id, report_id: r.id, field: '', quote: '', start: '', end: '',
    parent_id: reply ? cmReplyTo : '', at: new Date().toISOString(), by, text, resolved: '',
  };
  if (!reply) Object.assign(c, { field: cmDraft.field, quote: cmDraft.quote, start: String(cmDraft.start), end: String(cmDraft.end) });
  state.reportComments.push(c);
  cmActive = reply ? cmReplyTo : c.id;
  cmDraft = null; cmReplyTo = null; cmDraftText = '';
  renderReports(); // the list's counts, and the pane
  saveComments(reply ? 'Reply added' : 'Comment added');
}
function wireComments() {
  const btn = document.createElement('button');
  btn.id = 'cm-float';
  btn.type = 'button';
  btn.className = 'cm-float';
  btn.hidden = true;
  btn.innerHTML = '<span aria-hidden="true">💬</span> Comment';
  btn.title = 'Comment on the selected words';
  btn.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the selection
  btn.addEventListener('click', () => startComment(cmPending));
  document.body.append(btn);
  document.addEventListener('selectionchange', updateCommentFloat);
  document.getElementById('rp-pane').addEventListener('scroll', updateCommentFloat, { passive: true });
  window.addEventListener('resize', updateCommentFloat);
  const pane = document.getElementById('rp-pane');
  pane.addEventListener('input', (e) => { if (e.target.matches('.cm-form textarea')) cmDraftText = e.target.value; });
  pane.addEventListener('keydown', (e) => {
    const form = e.target.closest?.('.cm-form');
    if (!form) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cmDraft = null; cmReplyTo = null; cmDraftText = ''; renderPane(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submitComment(form); }
  });
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
    resetCommentUi();
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
      ${openThreads(r.id).length ? `<span class="pane-cm-count" title="Open comment threads on this report">💬 ${openThreads(r.id).length}</span>` : ''}
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
      ${filterValue(rptTable, 'item_id') === r.item_id || n < 2 ? ''
        : `<button type="button" class="link-btn" data-pane="item">All ${n} reports on this ${escAttr(T.item)}</button>`}
    </div>${rollupListHtml(m)}`;
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
    const found = paintComments(el, r);
    el.querySelector('.pane-main').insertAdjacentHTML('beforeend', commentsPanelHtml(r, found));
    if (cmDraft || cmReplyTo) {
      const t = el.querySelector('.cm-form textarea');
      if (t && !t.matches(':focus')) { t.scrollIntoView({ block: 'nearest' }); t.focus({ preventScroll: true }); t.setSelectionRange(t.value.length, t.value.length); }
    }
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

let paneOpened = null; // the report as it was when editing began
function editPane(focusKey) {
  if (!selectedReport()) return;
  paneEditing = true;
  paneOpened = { ...selectedReport() };
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
  const changed = paneDirty(paneOpened || r, v);
  paneEditing = false;
  if (changed) {
    Object.assign(r, changedFrom({ ...v, period_start: periodStart(v.period_end, v.cadence) }, paneOpened), { updated: new Date().toISOString() });
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
  const hadComments = dropComments([r.id]);
  rptSelId = next?.id ?? null;
  paneEditing = false;
  rerenderCurrentView();
  focusSelectedRow();
  offerUndo(snap, `Deleted the report${m ? ` on ${itemLabel(m)}` : ''} for ${fmtShort(r.period_end)}`);
  await Promise.all([saveReports('Report deleted'), hadComments && saveComments()]);
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
  if (id !== rptSelId) resetCommentUi();
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
  const cm = e.target.closest('[data-cm]');
  if (cm) return onCommentAction(cm);
  const mark = e.target.closest('mark.cm[data-cid]');
  if (mark) return focusThread(mark.dataset.cid);
  if (e.target.closest('.pane-comments')) return;
  const act = e.target.closest('[data-pane]')?.dataset.pane;
  if (act === 'edit') return editPane('exec_summary');
  if (act === 'cancel') return cancelPane();
  if (act === 'delete') return deletePane();
  if (act === 'item') {
    const r = selectedReport();
    if (!leavePaneEdit()) return;
    clearReportFilters();
    rptTable.filters.item_id = [r.item_id];
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
  pane.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.matches('.cm-form')) submitComment(e.target); else savePane(); });
  wireComments();
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
    } else if (e.key === 'Enter' && !paneEditing && !e.target.closest('button, a, [data-pane], .pane-comments') && selectedReport()) {
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
  rptMode = ['due', 'weekly'].includes(loadAppPrefs().reportsMode) ? loadAppPrefs().reportsMode : 'all';
  document.querySelectorAll('[name="rp-mode"]').forEach(r => r.addEventListener('change', () => setReportsMode(r.value)));
  document.getElementById('rp-due').addEventListener('click', (e) => {
    const b = e.target.closest('[data-due-report]');
    if (b) openReportDialog({ itemId: b.dataset.dueReport });
  });
  document.getElementById('rp-weekly').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-update]');
    if (tr) openUpdateById(tr.dataset.update);
  });
  document.getElementById('rp-weekly').addEventListener('keydown', (e) => {
    const tr = e.target.closest('[data-update]');
    if (tr && e.key === 'Enter') openUpdateById(tr.dataset.update);
  });
  document.getElementById('btn-new-update').onclick = () => openUpdateDialog(programSubject(currentWorkspace()));
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
    if (leavePaneEdit()) openReportDialog({ itemId: filterValue(rptTable, 'item_id') });
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
const EXPORT_COLUMNS = COLUMNS.map(c => (c === 'parent' ? 'rolls_up_to' : c === 'stream_id' ? 'stream' : c)); // streams by name, for people
function itemsExportCSV(items) {
  const byId = new Map(state.items.map(m => [m.id, m]));
  const name = (id) => { const x = byId.get(id); return x?.ref || `#${id}`; };
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const m of items) {
    lines.push([m.id, m.workspace_id, m.ref, m.title, m.type, m.description, streamName(m.stream_id), m.substream, m.owner, m.start, m.end,
      m.status, m.parent ? name(m.parent) : '', m.deps.map(name).join(';'), m.baseline_start, m.baseline_end, m.gitlab_url, m.use_case_url].map(csvEscape).join(','));
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

const IMPORT_FIELDS = ['ref', 'title', 'type', 'description', 'stream', 'substream', 'owner', 'start', 'end', 'status', 'parent', 'deps',
  'baseline_start', 'baseline_end', 'gitlab_url', 'use_case_url', 'top_level', 'id'];
const IMPORT_DATES = ['start', 'end', 'baseline_start', 'baseline_end'];
const importFieldLabel = (k) => ({
  ref: 'Ref', title: 'Title', type: `Type (${T.top}, ${T.milestone} or ${T.task})`, description: 'Description', stream: 'Stream',
  substream: 'Sub-stream', owner: 'Owner', start: 'Start date', end: `End date / ${T.milestone} date`, status: 'RAG',
  parent: 'Rolls up to (ref)', deps: 'Depends on (refs)',
  baseline_start: 'Baseline start', baseline_end: `Baseline end / ${T.milestone} baseline date`, gitlab_url: 'GitLab URL', use_case_url: 'Use case URL',
  top_level: `Top level ${T.milestone} (yes or no)`, id: 'ID (used to match links)',
}[k]);
// Headings are compared with everything but letters and digits removed.
const IMPORT_ALIASES = {
  id: ['id', 'itemid', 'uniqueid', 'uid'],
  ref: ['ref', 'reference', 'refno', 'wbs', 'no', 'number', 'key', 'outlinenumber'],
  title: ['title', 'name', 'milestone', 'milestonename', 'task', 'taskname', 'item', 'itemname', 'summary', 'deliverable', 'activity', 'activityname'],
  type: ['type', 'kind', 'itemtype', 'milestoneortask'],
  description: ['description', 'desc', 'details', 'notes', 'comments', 'comment'],
  stream: ['stream', 'workstream', 'category', 'group', 'area', 'team', 'theme', 'project'],
  substream: ['substream', 'subworkstream', 'subcategory', 'subgroup'],
  owner: ['owner', 'assignee', 'assignedto', 'responsible', 'accountable', 'resource', 'resourcenames', 'lead'],
  start: ['start', 'startdate', 'begin', 'begindate', 'from', 'plannedstart', 'forecaststart', 'actualstart'],
  end: ['end', 'enddate', 'date', 'due', 'duedate', 'finish', 'finishdate', 'deadline', 'target', 'targetdate', 'to', 'plannedend',
    'plannedfinish', 'forecastend', 'forecastfinish', 'completiondate', 'milestonedate', 'deliverydate'],
  status: ['rag', 'status', 'ragstatus', 'health', 'rating'],
  parent: ['parent', 'parentref', 'parentid', 'rollsupto', 'rollup'],
  deps: ['dependson', 'dependencies', 'dependency', 'deps', 'predecessors', 'predecessor'],
  baseline_start: ['baselinestart', 'baselinestartdate', 'baselinebegin'],
  baseline_end: ['baselineend', 'baselineenddate', 'baselinefinish', 'baselinedate', 'baselinedue'],
  gitlab_url: ['gitlaburl', 'gitlab', 'gitlablink', 'repo', 'repository', 'repourl'],
  use_case_url: ['usecaseurl', 'usecase', 'usecaselink'],
  top_level: ['toplevel', 'toplevelmilestone', 'changecontrol', 'changecontrolled', 'undercontrol'],
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
    if (/baseline/.test(h)) take(i, /start|begin/.test(h) ? 'baseline_start' : 'baseline_end');
    else if (/start|begin/.test(h)) take(i, 'start');
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
  if ([T.top, T.tops].some(w => w.toLowerCase() === s) || /^top ?level( milestones?)?$|^(key|major) milestones?$/.test(s)) return 'top';
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
  const wsCol = imp.hasHeader ? imp.rows[0].findIndex(h => ['workspaceid', 'programid', 'programmeid'].includes(h.toLowerCase().replace(/[^a-z]/g, ''))) : -1;
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

    for (const k of ['ref', 'title', 'description', 'stream', 'substream', 'owner']) if (cell(k)) f[k] = cell(k);
    for (const k in URL_FIELDS) if (cell(k)) f[k] = withScheme(cell(k));
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
    if (type === null) { row.notes.push(`Type “${cell('type')}” isn't ${withArticle(T.top)}, ${withArticle(T.milestone)} or ${withArticle(T.task)}; worked out from the dates`); type = ''; }
    // Only one date: a new item is a milestone on it, an existing one keeps its type.
    let { start, end } = dates;
    if (start && end && end < start) { [start, end] = [end, start]; row.notes.push('The end date was before the start date, so they were swapped'); }
    if (!type) type = start && end ? (start < end ? 'task' : 'milestone') : t ? t.type : 'milestone';
    // A top level column (yes or no) marks a milestone as under change control, or takes it out.
    if (cell('top_level') && type !== 'task' && !(cell('type') && type === 'top')) type = readYes(cell('top_level')) ? 'top' : 'milestone';
    if (type !== 'task') start = end = end || start || t?.end || '';
    else {
      start ||= t?.start || end;
      end ||= t?.end || start;
      if (end < start) { if (dates.end) start = end; else end = start; }
    }
    if (row.action === 'add' && !end) { row.action = 'skip'; row.notes.push('No date'); }
    if (!t || type !== t.type) f.type = type;
    if (!t || start !== t.start) f.start = start;
    if (!t || end !== t.end) f.end = end;

    // Baseline: read like the dates. A milestone's baseline is one date; blank keeps what's there.
    const base = {};
    for (const k of ['baseline_start', 'baseline_end']) {
      const v = cell(k);
      const d = readDate(v, order);
      if (d === null) row.notes.push(`Couldn't read the baseline date “${v}”`);
      base[k] = d || '';
    }
    if (base.baseline_start || base.baseline_end) {
      let bs = base.baseline_start, be = base.baseline_end;
      if (type !== 'task') bs = be = be || bs;
      else {
        if (bs && be && be < bs) { [bs, be] = [be, bs]; row.notes.push('The baseline end was before the baseline start, so they were swapped'); }
        bs ||= t?.baseline_start || be;
        be ||= t?.baseline_end || bs;
        if (be < bs) { if (base.baseline_end) bs = be; else be = bs; }
      }
      f.baseline_start = bs;
      f.baseline_end = be;
    }

    const rag = cell('status');
    if (rag) {
      f.status = normaliseStatus(rag, state.workspaceId);
      if (!statuses.includes(f.status.toLowerCase())) {
        f.status = t ? t.status : DEFAULT_STATUS;
        row.notes.push(`RAG “${rag}” isn't one of this workspace's options, so ${t ? 'it stays' : 'it starts at'} ${f.status}`);
      }
    } else if (!t) f.status = DEFAULT_STATUS;
    if (!t && !f.stream) f.stream = 'General';
    if (t && f.stream && f.stream.toLowerCase() === streamName(t.stream_id).toLowerCase()) delete f.stream;
    if (has('parent') && cell('parent')) row.links = { ...row.links, parent: cell('parent') };
    if (has('deps') && cell('deps')) row.links = { ...row.links, deps: readLinks(cell('deps')) };
    row.fileId = cell('id');
    if (t) for (const k of Object.keys(f)) if (f[k] === t[k]) delete f[k];
    rows.push(row);
  });

  // Link cells name a ref: this file's refs first, then the workspace's. "#12" names an item by id
  // (the download does this for items without a ref). Downloads from before links were written as
  // refs (a "parent" column alongside id and workspace_id) hold bare ids: those name rows in the
  // same file wherever it's imported, and the workspace's items only in its own download.
  const live = rows.filter(r => r.action !== 'skip');
  const byFileId = new Map(live.filter(r => r.fileId).map(r => [r.fileId, r]));
  const byId = (id) => byFileId.get(id) || (ownExport && state.items.find(m => m.id === id));
  const byRef = (tok) => (refRow.get(tok)?.action !== 'skip' && refRow.get(tok)) || state.items.find(m => m.ref === tok);
  const legacyIds = wsCol >= 0 && has('id') && has('parent') && imp.rows[0][col.parent].toLowerCase().replace(/[^a-z]/g, '') === 'parent';
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
  let added = 0, updated = 0, dropped = 0;
  const ok = await guardChange(() => {
    itemOf.clear();
    added = updated = dropped = 0;
    for (const m of plan.deletes) removeItem(m.id);
    for (const r of plan.rows) {
      if (r.action === 'skip') continue;
      let m = r.target;
      if (!m) {
        m = {
          id: nextId(), workspace_id: state.workspaceId, type: 'milestone', ref: '', title: '', description: '', stream_id: '',
          substream: '', owner: '', start: '', end: '', status: DEFAULT_STATUS, parent: '', deps: [],
        };
        state.items.push(m);
        added++;
      } else if (r.action === 'update') updated++;
      const { stream, ...fields } = r.fields;
      Object.assign(m, fields);
      if (stream !== undefined) m.stream_id = streamIdFor(state.workspaceId, stream);
      itemOf.set(r, m);
    }
    const target = (x) => (x && (itemOf.get(x) || (state.items.includes(x) ? x : null)));
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
    return true;
  });
  if (!ok) return; // the import dialog stays open
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

// A file's text, or null (with the reason shown in `err`) for a workbook, which can't be read.
async function readTextFile(file, err) {
  if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(file.name)) {
    err.textContent = `${file.name} is a workbook, which can't be read directly. Save it as CSV (in Excel: File › Save As › CSV), or copy the cells and paste them.`;
    return null;
  }
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch {
    // UTF-16 (Excel "Unicode text") or Windows-1252 (Excel's plain CSV on Windows)
    const b = new Uint8Array(buf);
    return new TextDecoder(b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'windows-1252').decode(buf);
  }
}

async function readImportFile(file) {
  const text = await readTextFile(file, document.getElementById('im-error'));
  if (text != null) loadImportText(text, file.name);
}

function renderImport() {
  const data = imp.hasHeader ? imp.rows.slice(1) : imp.rows;
  const width = Math.max(...imp.rows.map(r => r.length));
  const header = Array.from({ length: width }, (_, i) =>
    (imp.hasHeader && imp.rows[0][i]) || `Column ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`);
  while (imp.map.length < width) imp.map.push('');

  const dateCols = imp.map.map((k, i) => (IMPORT_DATES.includes(k) ? i : -1)).filter(i => i >= 0);
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
      if (!IMPORT_DATES.includes(k)) return escAttr(v);
      const iso = readDate(v, plan.order);
      return iso ? `${escAttr(v)} <span class="im-date">→ ${fmtNice(iso)}</span>` : `${escAttr(v)} <span class="im-bad">→ can't read</span>`;
    }).join(' · ');
    return `<tr><td>${escAttr(h)}</td><td title="${escAttr(samples.join(' · '))}">${ex || '<span class="im-bad">empty</span>'}</td>
      <td><select data-col="${i}" class="${k ? '' : 'unmapped'}">${opts(k)}</select></td></tr>`;
  }).join('');

  // Preview
  const shown = ['ref', 'title', 'type', 'start', 'end', 'status', 'owner', 'stream'];
  if (imp.map.some(k => k.startsWith('baseline_'))) shown.splice(5, 0, 'baseline_start', 'baseline_end');
  const heads = { ref: 'Ref', title: 'Title', type: 'Type', start: 'Start', end: 'End', baseline_start: 'Baseline start', baseline_end: 'Baseline end',
    status: 'RAG', owner: 'Owner', stream: 'Stream' };
  document.getElementById('im-preview-head').innerHTML = `<tr><th>Row</th><th></th>${shown.map(k =>
    `<th>${escAttr(heads[k])}</th>`).join('')}<th>Links</th><th>Notes</th></tr>`;
  const actLabel = { add: 'Add', update: 'Update', same: 'No change', skip: 'Skip', delete: 'Delete' };
  const cellFor = (r, k) => {
    const v = k in r.fields ? r.fields[k] : r.target ? (k === 'stream' ? streamName(r.target.stream_id) : r.target[k]) : '';
    const text = k === 'type' ? (v === 'task' ? T.Task : v ? T.Milestone : '') : IMPORT_DATES.includes(k) ? (v ? fmtNice(v) : '') : v;
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
      `<td>${escAttr(k === 'type' ? typeName(m) : IMPORT_DATES.includes(k) ? (m[k] ? fmtNice(m[k]) : '') : k === 'stream' ? streamName(m.stream_id) : m[k])}</td>`).join('')}<td></td>
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
  'item_term', 'milestone_term', 'task_term', 'dep_priorities', 'dep_types', 'hidden', 'created', 'updated'];
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
  const id = takeId('workspaces', () => String(Math.max(state.lastWorkspaceId, ...state.workspaces.map(p => +p.id || 0)) + 1));
  state.lastWorkspaceId = Math.max(state.lastWorkspaceId, +id);
  const now = new Date().toISOString();
  const p = { id, created: now, updated: now, status: 'Not Started', ...DEFAULT_TERMS };
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
  switchView(view || (APP_VIEWS.includes(currentView()) ? 'dash' : currentView()));
}

// Sidebar, headings and every label that uses the workspace's own terms.
function applyWorkspaceChrome() {
  const p = currentWorkspace();
  document.querySelectorAll('[data-term]').forEach(el => { el.textContent = T[el.dataset.term]; });
  document.getElementById('nav-editor').title = T.Items;
  document.getElementById('nav-reports').hidden = reportsOff();
  if (reportsOff() && isShown('reports')) switchView('dash');
  document.getElementById('workspace-select').innerHTML = state.workspaces
    .map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${escAttr(x.name)}</option>`).join('');
  document.getElementById('workspace-dot').style.background = pal(p.status).base;
  document.getElementById('workspace-dot').title = `Workspace RAG: ${p.status}`;
  document.getElementById('workspace-code').textContent = p.code || p.name.slice(0, 4); // the collapsed menu shows this
  document.querySelector('.workspace-pick').title = p.name;
  renderTableHead(grid);
  renderTableHead(rptTable);
  renderReportRagChoices();
  renderRagLegend();
  updatePageHead();
  updateDueBadge();
  updateRaidBadge();
}

// The Gantt key lists the workspace's own RAG options.
function renderRagLegend() {
  const list = statusesFor(state.workspaceId);
  document.getElementById('legend-rag').innerHTML = list.map(s => `
    <span class="legend-item"><i class="dot" style="background:${paletteOf(s.color).base}"></i> ${escAttr(s.name)}${s.description ? ` — ${escAttr(s.description)}` : ''}</span>`).join('');
}

const VIEW_TITLES = { overview: () => 'Portfolio', streams: () => 'Streams', workspaces: () => 'Portfolio', dash: () => 'Dashboard', gantt: () => 'Plan', editor: () => T.Items, reports: () => 'Reports', changes: () => 'What changed', dates: () => 'Date log', raid: () => 'Risks & issues' };
function updatePageHead() {
  const view = currentView();
  const p = currentWorkspace();
  const inWorkspace = !APP_VIEWS.includes(view);
  document.getElementById('page-title').textContent = VIEW_TITLES[view]();
  const crumb = document.getElementById('page-workspace');
  crumb.hidden = !inWorkspace;
  crumb.innerHTML = inWorkspace ? `${p.code ? `<b>${escAttr(p.code)}</b> ` : ''}${escAttr(p.name)}` : '';
  const env = APP_CONFIG.environment.trim();
  const suffix = `${APP_CONFIG.title ? ` — ${APP_CONFIG.title}` : ''}${env ? ` [${env}]` : ''}`;
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
function milestoneOverview(workspaceId, stream = null) { // stream: only that stream's milestones (by id)
  const rg = ragOf(workspaceId);
  const out = { notStarted: 0, green: 0, redAmber: 0, closed: 0, total: 0 };
  for (const m of allItems()) {
    if (m.workspace_id !== workspaceId || isTask(m) || (stream != null && m.stream_id !== stream)) continue;
    out.total++;
    out[msBucket(m.status, workspaceId, rg)]++;
  }
  return out;
}

// A count is a way in: it opens the Gantt chart showing just those milestones.
async function openBucket(workspaceId, bucket, stream = '') {
  await switchWorkspace(workspaceId, 'gantt');
  clearGanttFilters();
  ganttFilter.type = 'milestone';
  ganttFilter.stream = stream;
  if (bucket !== 'total') ganttFilter.rag = STATUSES.filter(st => msBucket(st, workspaceId) === bucket);
  renderGantt();
}

function milestoneStrip(workspaceId) {
  const ov = milestoneOverview(workspaceId);
  return `<div class="ms-strip">${MS_BUCKETS.map(([k, label]) => ov[k]
    ? `<button type="button" class="ms-${k}" data-bucket="${k}" title="Show these on the plan"><b>${ov[k]}</b><span>${label}</span></button>`
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
          ${reportsOff(p.id) ? '' : `<div><dt>Last report</dt><dd>${st.lastReport ? `period ending ${fmtNice(st.lastReport)}` : 'none yet'}</dd></div>`}
        </dl>
        <div class="prog-rag">
          <div class="prog-ragbar">${bar}</div>
          <div class="prog-raglist">${ragList || `<span class="muted">No ${escAttr(t.items)} yet</span>`}</div>
        </div>
        <div class="prog-ms"><span class="prog-ms-label">${escAttr(t.Milestone)} overview</span>${milestoneStrip(p.id)}</div>
        <footer class="prog-foot">
          <span class="prog-counts">${count(n, t.item, t.items)} · ${count(n - st.tasks, t.milestone, t.milestones)} · ${count(st.tasks, t.task, t.tasks)} ${reportsOff(p.id) ? '' : `· ${count(st.reports.length, 'report', 'reports')}`}</span>
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
let pgOpened = null;  // its values when the dialog opened

function openWorkspaceDialog(p) {
  hideQuick();
  pgEditing = p;
  pgOpened = p && { ...p };
  const f = document.getElementById('workspace-form').elements;
  const v = p || { ...newWorkspaceDefaults() };
  // Default terms show as placeholders, so a new word can be typed straight in.
  for (const k of WORKSPACE_FIELDS) if (k !== 'status') f[k].value = (v[k] === DEFAULT_TERMS[k] ? '' : v[k]) ?? '';
  const hidden = (v.hidden || '').split(';');
  for (const box of document.querySelectorAll('[data-show-field]')) box.checked = !hidden.includes(box.dataset.showField);
  loadPgStatuses(p);
  loadPgDepLists(p);
  loadPgStreams(p);
  showPgTab('details');
  document.getElementById('pg-heading').textContent = p ? `Edit ${p.name}` : 'New workspace';
  document.getElementById('pg-submit').textContent = p ? 'Save' : 'Create workspace';
  document.getElementById('pg-history').hidden = !p;
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
let pgStatusesOpened = []; // the workspace's RAG options when the dialog opened

function statusUsage(workspaceId) {
  const used = {};
  for (const x of [...allItems(), ...allReports()]) if (x.workspace_id === workspaceId) used[x.status] = (used[x.status] || 0) + 1;
  return used;
}

function loadPgStatuses(p) {
  const used = p ? statusUsage(p.id) : {};
  pgStatusesOpened = statusesFor(p?.id);
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
  document.getElementById('pg-panel-deps').hidden = tab !== 'deps';
  document.getElementById('pg-panel-streams').hidden = tab !== 'streams';
  document.getElementById('workspace-dialog').classList.toggle('wide', tab === 'rag' || tab === 'streams');
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
  // Changed in the dialog (not just different from now: someone else may have changed it since it opened)
  const listChanged = key(next) !== key(pgStatusesOpened) && key(next) !== key(statusesFor(workspaceId));
  if (listChanged) {
    state.statuses = state.statuses.filter(s => s.workspace_id !== workspaceId);
    if (key(next) !== key(DEFAULT_STATUSES)) state.statuses.push(...next); // the standard list needs no rows
  }
  return { records, listChanged };
}

function newWorkspaceDefaults() {
  return { number: '', name: '', code: '', description: '', owner: '', lead: '', start: '', end: '', status: 'Not Started', trend: '', dep_priorities: '', dep_types: '', ...DEFAULT_TERMS };
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
  const depErr = checkPgDepLists();
  if (depErr) { showPgTab('deps'); return (err.textContent = depErr); }
  for (const k of DEP_LIST_KEYS) f[k].value = pgDepListValue(k);
  f.hidden.value = [...document.querySelectorAll('[data-show-field]')].filter(b => !b.checked).map(b => b.dataset.showField).join(';');
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
  const streamErr = checkPgStreams();
  if (streamErr) { showPgTab('streams'); return (err.textContent = streamErr); }
  v.status = f.status.value === 'stray' ? pgStrayStatus : pgStatusesSelected?.name ?? activePgStatuses()[0].name;

  document.getElementById('workspace-dialog').close();
  const p = pgEditing || newWorkspace();
  if (!pgEditing) state.workspaces.push(p);
  const res = applyPgStatuses(p.id);
  const depRenamed = applyPgDepRenames(p.id);
  const st = applyPgStreams(p.id);
  Object.assign(p, changedFrom(v, pgOpened), { updated: new Date().toISOString() });
  const saves = [saveWorkspaces(pgEditing ? 'Workspace saved' : 'Workspace created')];
  if (depRenamed || st.raid) saves.push(saveRaid());
  if (res.listChanged) saves.push(saveStatuses());
  if (st.streams) saves.push(saveStreams());
  if (st.updates) saves.push(saveUpdates());
  if (res.records || st.items) saves.push(saveData('', 'Workspace settings'), saveReports());
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
  if (isShown('editor')) { renderTableHead(grid); renderEditor(); } // new terms / RAG options / link columns in the grid
  await Promise.all(saves);
}

// Start a workspace's Date history and What changed afresh (see clearHistory in server.js).
async function clearWorkspaceHistory() {
  const p = pgEditing;
  if (!p) return;
  if (!confirm(`Clear the history of ${p.name}?\n\nIts Date log is emptied and starts again from its ${T.items}’ dates now, and What changed will compare from today. Nothing else changes, and other workspaces keep their history.\n\nThis can’t be undone.`)) return;
  flushSave();
  await saveQueue; // so what's on screen is what the history starts from
  let out;
  try {
    const res = await fetch(`api/clear-history?workspace=${encodeURIComponent(p.id)}`, { method: 'POST' });
    out = await res.json();
    if (!out.ok) throw new Error(out.error || `the server returned ${res.status}`);
  } catch (err) {
    return (document.getElementById('pg-error').textContent = `Couldn’t clear the history (${err.message}). Restart node server.js if the app was updated.`);
  }
  chHistory = null;
  chCache.clear();
  dlRows = [];
  dlItem = '';
  document.getElementById('workspace-dialog').close();
  rerenderCurrentView();
  if (isShown('dates')) renderDates();
  showToast(`History cleared for ${p.name}: ${count(out.removed, 'date log row', 'date log rows')} removed, ${count(out.copies, 'daily copy', 'daily copies')} reset`);
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
  const hadStreams = state.streams.some(l => l.workspace_id === p.id);
  state.streams = state.streams.filter(l => l.workspace_id !== p.id);
  const hadRaid = state.raid.some(r => r.workspace_id === p.id);
  state.raid = state.raid.filter(r => r.workspace_id !== p.id);
  const hadNotes = state.raidNotes.some(n => n.workspace_id === p.id);
  state.raidNotes = state.raidNotes.filter(n => n.workspace_id !== p.id);
  const hadComments = state.reportComments.some(c => c.workspace_id === p.id);
  state.reportComments = state.reportComments.filter(c => c.workspace_id !== p.id);
  applyWorkspaceChrome();
  rerenderCurrentView();
  offerUndo(snap, `Deleted the workspace ${p.name}${lost.length ? ` and its ${lost.join(' and ')}` : ''}`);
  await Promise.all([saveData(`Workspace deleted: ${p.name}`, 'Workspace deleted'), saveReports(), saveWorkspaces('Workspace deleted'), hadStatuses && saveStatuses(), hadUpdates && saveUpdates(), hadStreams && saveStreams(), hadRaid && saveRaid(), hadNotes && saveRaidNotes(), hadComments && saveComments()]);
}

function wireWorkspaces() {
  document.getElementById('workspace-select').onchange = (e) => switchWorkspace(e.target.value);
  document.querySelectorAll('.btn-new-workspace').forEach(b => { b.onclick = () => openWorkspaceDialog(null); });
  document.getElementById('nav-settings').onclick = () => openWorkspaceDialog(currentWorkspace());
  document.getElementById('workspace-cards').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-workspace]');
    if (edit) return openWorkspaceDialog(workspaceById(edit.dataset.editWorkspace));
    if (e.target.closest('[data-new-workspace]')) return openWorkspaceDialog(null);
    const card = e.target.closest('[data-pid]');
    const bucket = e.target.closest('[data-bucket]');
    if (card && bucket) return openBucket(card.dataset.pid, bucket.dataset.bucket);
    if (card) switchWorkspace(card.dataset.pid, 'dash');
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
  document.getElementById('pg-clear-history').onclick = clearWorkspaceHistory;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
}

/* ================= program and stream overviews ================= */
// Management tables: one row per workspace (program) across the app, or per stream within a
// workspace. Each row has an area lead, the RAG of its last two weekly updates, trend, the latest
// update's summary and a count of its milestones by status. Weekly updates live in updates.csv,
// one per program or stream per week (stream blank for the program); the newest is "current".
// A program's area lead and trend are workspace fields; a stream's are kept in streams.csv.

const UPDATE_COLUMNS = ['id', 'workspace_id', 'stream_id', 'week_ending', 'status', 'summary', 'author', 'created', 'updated'];
const STREAM_COLUMNS = ['id', 'workspace_id', 'name', 'lead', 'trend'];

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
const nextUpdateId = () => takeId('updates', () => String(Math.max(0, ...state.updates.map(u => +u.id || 0)) + 1));

// A stream is a record of its own: {id, workspace_id, name, lead, trend}. Items, weekly updates and
// RAID entries point at it by id, so renaming it keeps everything that belongs to it.
function rowsToStreams(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  const out = rows.slice(1).map(r => {
    const o = {};
    for (const k of STREAM_COLUMNS) o[k] = (r[colIndex(header, k)] ?? '').trim();
    return o;
  }).filter(l => ids.has(l.workspace_id) && l.name);
  const seen = new Set();
  return out.filter(l => { if (!/^\d+$/.test(l.id) || seen.has(l.id)) return false; seen.add(l.id); return true; });
}
function streamsToCSV(streams) {
  return [STREAM_COLUMNS.join(','), ...streams.map(l => STREAM_COLUMNS.map(k => csvEscape(l[k])).join(','))].join('\n') + '\n';
}
const streamById = (id) => (id ? state.streams.find(l => l.id === id) : undefined);
const streamName = (id) => streamById(id)?.name || '';
const workspaceStreams = (workspaceId = state.workspaceId) => state.streams.filter(l => l.workspace_id === workspaceId);
const nextStreamId = () => takeId('streams', () => String(Math.max(0, ...state.streams.map(l => +l.id || 0)) + 1));
// The id of the workspace's stream called `name` (two names differing only in case are one stream).
// When there's no such stream it's created, and streams.csv saved, unless `create` is false. '' for no name.
function streamIdFor(workspaceId, name, create = true) {
  name = String(name ?? '').trim();
  if (!name || !workspaceId) return '';
  const low = name.toLowerCase();
  const hit = state.streams.find(l => l.workspace_id === workspaceId && l.name.toLowerCase() === low);
  if (hit) return hit.id;
  if (!create) return '';
  const l = { id: nextStreamId(), workspace_id: workspaceId, name, lead: '', trend: '' };
  state.streams.push(l);
  if (dataLoaded) saveStreams();
  return l.id;
}

// What a row is about: a program, or one stream of it (by id). `rec` holds its area lead and trend.
const programSubject = (p) => ({ p, stream: '', rec: p, label: programLabel(p) });
const streamSubject = (p, id) => ({ p, stream: id, rec: streamById(id) || { id, workspace_id: p.id, name: '', lead: '', trend: '' }, label: `${p.code || p.name} · ${streamName(id)}` });

// Weekly updates for a program (stream '') or one of its streams (by id), newest first.
const updatesFor = (workspaceId, stream = '') => state.updates.filter(u => u.workspace_id === workspaceId && (u.stream_id || '') === stream)
  .sort((a, b) => b.week_ending.localeCompare(a.week_ending) || b.updated.localeCompare(a.updated));

// Programs in number order (numbers compared naturally), unnumbered ones last by name.
function programsInOrder() {
  return [...state.workspaces].sort((a, b) => (!a.number) - (!b.number)
    || a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}
// The current workspace's streams in the order the Gantt chart lists them (its Sort setting).
// The workspace's stream ids as the Gantt chart orders them; streams with no items follow, A–Z.
// Items whose stream is gone come under '' (shown as no stream).
function streamsInOrder() {
  const streams = [], byId = new Map();
  for (const m of state.items) {
    let stream = byId.get(m.stream_id);
    if (!stream) byId.set(m.stream_id, stream = { id: m.stream_id, name: streamName(m.stream_id), items: [], subs: [] }), streams.push(stream);
    stream.items.push({ ...m, _s: parseDate(m.start), _e: parseDate(isTask(m) && m.end ? addDays(m.end, 1) : m.end) });
  }
  sortStreams(streams);
  const empty = workspaceStreams().filter(l => !byId.has(l.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return [...streams.map(l => l.id), ...empty.map(l => l.id)];
}

const isStale = (u) => !u || u.week_ending < addDays(defaultPeriodEnd('Weekly'), -6);

function overviewRow(sub) {
  const { p, stream, rec } = sub;
  const [cur, prev] = sub.forStream && !stream ? [] : updatesFor(p.id, stream); // a stream without a name has no updates
  const rg = ragOf(p.id);
  const ov = milestoneOverview(p.id, sub.forStream ? stream : null);
  const stale = cur && isStale(cur);
  const ragCell = (u, isCur) => (u
    ? `${statusPill(u.status, rg.map)}<small class="ov-week${isCur && stale ? ' stale' : ''}" ${isCur && stale ? 'title="No update since this week"' : ''}>w/e ${fmtShort(u.week_ending)}</small>`
    : '<span class="muted">—</span>');
  const nameCell = sub.forStream
    ? `<td class="ov-prog">${stream
      ? `<button type="button" class="ov-name" data-open-stream title="Show this stream on the plan">${escAttr(streamName(stream))}</button>`
      : '<span class="muted">(No stream)</span>'}</td>`
    : `<td class="ov-num">${p.number ? escAttr(p.number) : '<span class="muted">—</span>'}</td>
      <td class="ov-prog">
        <button type="button" class="ov-name" data-open-workspace="${p.id}" title="Open this workspace">${escAttr(p.name)}</button>
        ${p.code ? `<span class="prog-code">${escAttr(p.code)}</span>` : ''}
        <small class="ov-overall">Overall ${statusPill(p.status, rg.map)}</small>
      </td>`;
  const key = sub.forStream ? `data-stream="${escAttr(stream)}"` : `data-pid="${p.id}"`;
  const canUpdate = !sub.forStream || stream; // a stream needs a name to hold updates
  return { sub, cur, prev, ov, html: `
    <tr ${key} style="--rag:${sub.forStream ? 'var(--border)' : pal(p.status, rg.map).base}">
      ${nameCell}
      ${cur ? `<td class="ov-lead">${rec.lead ? escAttr(rec.lead) : '<span class="muted">—</span>'}</td>
      <td class="ov-rag">${ragCell(prev, false)}</td>
      <td class="ov-rag">${ragCell(cur, true)}</td>
      <td class="ov-trend">${trendBadge(rec.trend)}</td>
      <td class="ov-summary">${cur.summary ? `<div class="md">${mdToHtml(cur.summary)}</div>` : '<span class="muted">No summary</span>'}</td>`
      : `<td colspan="5" class="ov-none muted">No weekly update yet${rec.lead ? ` · area lead ${escAttr(rec.lead)}` : ''}</td>`}
      ${MS_BUCKETS.map(([k]) => `<td class="ov-ms ms-${k}${ov[k] ? '' : ' zero'}">${ov[k] ? `<button type="button" class="ov-count" data-bucket="${k}" title="Show these on the plan">${ov[k]}</button>` : 0}</td>`).join('')}
      <td class="ov-act">${canUpdate ? `<button type="button" class="btn btn-sm" data-update>Weekly update</button>` : ''}</td>
    </tr>` };
}

// Fill one of the overview tables (programs or streams) and its totals row.
function renderOverviewTable(id, subjects, one, many) {
  const rows = subjects.map(overviewRow);
  const cols = document.querySelectorAll(`#${id}-table thead tr:first-child th:not(.ov-ms-group)`).length - 1;
  document.getElementById(`${id}-body`).innerHTML = rows.map(r => r.html).join('')
    || `<tr><td colspan="${cols + MS_BUCKETS.length + 1}" class="grid-empty">No ${many} yet.</td></tr>`;
  const sum = Object.fromEntries(MS_BUCKETS.map(([k]) => [k, rows.reduce((a, r) => a + r.ov[k], 0)]));
  document.getElementById(`${id}-foot`).innerHTML = `
    <tr><td colspan="${cols}">All ${many}</td>${MS_BUCKETS.map(([k]) => `<td class="ov-ms ms-${k}">${sum[k]}</td>`).join('')}<td></td></tr>`;
  const missing = rows.filter(r => (!r.sub.forStream || r.sub.stream) && isStale(r.cur)).length;
  document.getElementById(`${id}-count`).textContent = count(rows.length, one, many)
    + (!rows.length ? '' : missing ? ` · ${missing} without an update this week` : ' · all updated this week');
  return rows;
}

let overviewRows = [], streamRows = []; // as last rendered, for clicks and the CSV
function renderOverview() {
  overviewRows = renderOverviewTable('overview', programsInOrder().map(programSubject), 'workspace', 'workspaces');
}
function renderStreamOverview() {
  const p = currentWorkspace();
  streamRows = renderOverviewTable('streams', streamsInOrder().map(id => ({ ...streamSubject(p, id), forStream: true })), 'stream', 'streams');
}

function downloadOverviewCSV(forStream) {
  const rows = forStream ? (renderStreamOverview(), streamRows) : (renderOverview(), overviewRows);
  const head = [...(forStream ? ['Stream'] : ['Program number', 'Workspace']), 'Area lead', ...(forStream ? [] : ['Overall RAG']),
    'Previous weekly RAG', 'Previous week ending', 'Current weekly RAG', 'Current week ending', 'Trend', 'Summary',
    ...MS_BUCKETS.map(([, l]) => `Milestones ${l.toLowerCase()}`)];
  const lines = rows.map(({ sub: { p, stream, rec }, cur, prev, ov }) => [
    ...(forStream ? [streamName(stream)] : [p.number, p.name]), rec.lead, ...(forStream ? [] : [p.status]),
    prev?.status, prev?.week_ending, cur?.status, cur?.week_ending, rec.trend,
    mdToText(cur?.summary || ''), ...MS_BUCKETS.map(([k]) => ov[k]),
  ].map(csvEscape).join(','));
  const blob = new Blob(['﻿' + [head.map(csvEscape).join(','), ...lines].join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const p = currentWorkspace();
  const slug = (p.code || p.name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'workspace';
  a.download = `${forStream ? `${slug}-streams` : 'portfolio'}-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ================= dashboard ================= */
// One page that answers "how is this workspace doing?": progress against the time that's gone,
// what's overdue and what's coming up, where the items stand by RAG and by stream, the weekly RAG
// record, movement against the baseline, the milestones ahead month by month, the open risks and
// the latest reports. Every number is a way in — it opens the Gantt chart, the register or the
// reports showing just those things — and every chart has a table twin (the Table toggle), so
// nothing depends on colour alone. The charts use the workspace's own RAG colours for RAG, and
// one blue/red pair for early/late.

const DASH_HORIZONS = [14, 30, 60, 90];
let dashHorizon = DASH_HORIZONS.includes(+loadAppPrefs().dashHorizon) ? +loadAppPrefs().dashHorizon : 30;
const dashTables = new Set(); // cards showing their table rather than the chart
const DASH_BUCKET_COLORS = { closed: 'var(--closed)', green: 'var(--ok)', redAmber: 'var(--ra)', notStarted: 'var(--faint-2)' };

// What a click on a number or mark does; held as JSON in data-dash-go.
const dashGoAttr = (go) => `data-dash-go="${escAttr(JSON.stringify(go))}"`;
// A tooltip: a heading and lines of text, held in data-tip (JSON) and shown with the Gantt tip.
const dashTipAttr = (head, ...lines) => `data-tip="${escAttr(JSON.stringify({ h: head, l: lines.filter(Boolean) }))}"`;
const dashBtn = (cls, go, tip, inner, extra = '') => `<button type="button" class="${cls}" ${dashGoAttr(go)} ${tip ? dashTipAttr(...tip) : ''} ${extra}>${inner}</button>`;
const daysWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

// Progress: the share of all task-days that's complete (as a milestone's progress is counted),
// against the share of the plan's time that's gone.
function dashProgress(items) {
  const tasks = items.filter(isTask);
  const totalDays = tasks.reduce((a, t) => a + taskDays(t), 0);
  const doneDays = tasks.filter(t => isDoneStatus(t.status)).reduce((a, t) => a + taskDays(t), 0);
  const dates = items.flatMap(m => [m.start, m.end]).filter(Boolean).sort();
  const first = dates[0], last = dates.at(-1), today = todayISO();
  const span = first && last ? Math.max(1, daysBetween(first, last)) : 0;
  const elapsed = span ? Math.max(0, Math.min(100, Math.round((daysBetween(first, today) / span) * 100))) : null;
  return { pct: totalDays ? Math.round((doneDays / totalDays) * 100) : null, doneDays, totalDays, tasks: tasks.length, first, last, elapsed };
}

// A card: title, a note, the body and, when it has one, a table twin behind the Table toggle.
function dashCard(key, title, sub, body, { span = 6, table = null, actions = '', cls = '' } = {}) {
  const tbl = dashTables.has(key);
  return `<section class="dash-card ${cls}" style="--span:${span}" id="dash-${key}">
    <div class="dash-head"><h2>${title}</h2>${sub ? `<span class="dash-sub">${sub}</span>` : ''}
      <span class="dash-act">${actions}${table ? `<button type="button" class="dash-tbtn${tbl ? ' on' : ''}" data-dash-table="${key}" aria-pressed="${tbl}" title="Show the numbers as a table">Table</button>` : ''}</span></div>
    ${table ? `<div class="dash-chart" ${tbl ? 'hidden' : ''}>${body}</div><div class="dash-tbl" ${tbl ? '' : 'hidden'}>${table}</div>` : body}
  </section>`;
}
const dashEmpty = (text) => `<p class="dash-empty">${text}</p>`;
const dvTable = (head, rows) => `<table class="dv-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const dvLegend = (items) => `<div class="dv-legend">${items.map(([name, color, n]) =>
  `<span><i style="background:${color}"></i>${escAttr(name)}${n != null ? ` <b>${n}</b>` : ''}</span>`).join('')}</div>`;

// Stacked horizontal bars: rows of segments sized against `max` (counts), each a way in.
function dvStacked(rows, max) {
  return `<div class="dv-bars">${rows.map(r => `<div class="dv-row">
      <div class="dv-label">${r.labelHtml}</div>
      <div class="dv-bar" role="img" aria-label="${escAttr(`${r.label}: ${r.total}`)}">${r.segs.filter(s => s.n).map(s =>
        dashBtn('dv-seg', s.go, [r.label, `${s.n} ${s.name}`, `${pct(s.n, r.total)}% of ${r.total}`], '', `style="flex-basis:${(s.n / max) * 100}%;background:${s.color}" aria-label="${escAttr(`${s.n} ${s.name}`)}"`)).join('')}</div>
      <div class="dv-total">${r.total}</div>
    </div>`).join('')}</div>`;
}

function renderDash() {
  const p = currentWorkspace();
  const items = state.items, rg = ragOf(p.id), today = todayISO();
  const sel = document.getElementById('dash-horizon');
  sel.innerHTML = DASH_HORIZONS.map(n => `<option value="${n}" ${n === dashHorizon ? 'selected' : ''}>Next ${n} days</option>`).join('');
  document.getElementById('dash-asof').textContent = `${count(items.length, T.item, T.items)} · ${fmtNice(today)}`;
  const cards = [dashGlance(p, rg), dashHero(items), dashTiles(p, items)];
  if (items.length) {
    cards.push(dashStand(items, rg), dashStreams(p, items, rg), dashWeekly(p, rg), dashSlip(items), dashMonths(items, rg), dashOwners(items),
      dashComing(items), dashRisks(p));
    if (!reportsOff()) cards.push(dashReports());
  }
  document.getElementById('dash-grid').innerHTML = cards.join('')
    + (items.length ? '' : dashCard('none', 'Nothing to show yet', '', dashEmpty(`This workspace has no ${T.items} yet. Add some on the plan or in the ${T.Items} table and the dashboard fills itself in.`), { span: 12 }));
  dashDateChanges();
}

/* ---- the cards ---- */

// The workspace at a glance: its overall RAG and trend, who runs it, its dates and the latest weekly update.
function dashGlance(p, rg) {
  const [cur] = updatesFor(p.id);
  const stale = isStale(cur);
  const meta = [['Owner', p.owner], ['Lead', p.lead], ['Dates', p.start || p.end ? `${p.start ? fmtShort(p.start) : '…'} – ${p.end ? fmtNice(p.end) : '…'}` : '']]
    .filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${escAttr(v)}</dd></div>`).join('');
  const update = cur
    ? `<div class="dash-update${stale ? ' stale' : ''}">
        <div class="dash-update-head">${statusPill(cur.status, rg.map)} <span>w/e ${fmtShort(cur.week_ending)}${cur.author ? ` · ${escAttr(cur.author)}` : ''}</span>
          ${stale ? '<em class="dash-stale">No update this week</em>' : ''}</div>
        ${cur.summary ? `<div class="md dash-md">${mdToHtml(cur.summary)}</div>` : '<span class="muted">No summary</span>'}</div>`
    : `<div class="dash-update stale"><em class="dash-stale">No weekly update yet</em></div>`;
  return dashCard('glance', escAttr(p.name), p.code ? `<span class="prog-code">${escAttr(p.code)}</span>` : '', `
    <div class="dash-glance-top">${statusPill(p.status, rg.map)} ${trendBadge(p.trend)}${p.description ? `<p class="dash-desc">${escAttr(p.description)}</p>` : ''}</div>
    ${meta ? `<dl class="dash-meta">${meta}</dl>` : ''}
    <div class="dash-update-label">Latest weekly update</div>${update}`,
  { span: 7, actions: dashBtn('btn btn-sm', { k: 'update' }, null, 'Weekly update') });
}

// The one number the page leads with: how much of the work is done, against how much of the time has gone.
function dashHero(items) {
  const g = dashProgress(items);
  if (g.pct == null) {
    return dashCard('hero', 'Progress', '', dashEmpty(g.tasks ? `The ${T.tasks} have no dates yet, so there’s nothing to measure.` : `Progress is measured from ${T.tasks}; this workspace has none yet.`), { span: 5, cls: 'dash-hero' });
  }
  const diff = g.elapsed == null ? null : g.pct - g.elapsed;
  const why = `${g.pct}% of the work is done and ${g.elapsed}% of the plan’s time has passed`;
  const verdict = diff == null ? '' : diff >= 5 ? `<b class="ok" title="${escAttr(why)}">Ahead of the plan</b> by ${diff} points` : diff <= -5 ? `<b class="ra" title="${escAttr(why)}">Behind the plan</b> by ${-diff} points` : `<b title="${escAttr(why)}">On pace</b> with the plan`;
  return dashCard('hero', 'Progress', `${count(g.tasks, T.task, T.tasks)}`, `
    <div class="dash-hero-row"><span class="dash-hero-n">${g.pct}%</span><span class="dash-hero-of">of the work complete<br><small>${g.doneDays} of ${g.totalDays} ${T.task}-days</small></span></div>
    <div class="dv-meter" role="img" aria-label="${escAttr(`${g.pct}% complete; ${g.elapsed ?? 0}% of the time has gone`)}">
      <i class="dv-meter-fill" style="width:${g.pct}%"></i>${g.elapsed != null ? `<i class="dv-meter-mark" style="left:${g.elapsed}%" title="Today: ${g.elapsed}% of the plan’s time has gone"></i>` : ''}
    </div>
    <div class="dash-hero-foot">${g.elapsed != null ? `<span><b>${g.elapsed}%</b> of the plan’s time has passed <span class="muted">· ${fmtShort(g.first)} – ${fmtNice(g.last)}</span></span>` : ''}<span>${verdict}</span></div>`,
  { span: 5, cls: 'dash-hero' });
}

// Headline counts, each a way in.
function dashTiles(p, items) {
  const open = items.filter(m => !isDoneStatus(m.status));
  const ms = items.filter(m => !isTask(m));
  const closed = ms.filter(m => isDoneStatus(m.status)).length;
  const doneNames = STATUSES.filter(st => isDoneStatus(st));
  const late = open.filter(isLate), lateStart = open.filter(isLateStart);
  const horizon = addDays(todayISO(), dashHorizon);
  const soon = open.filter(m => m.end >= todayISO() && m.end <= horizon);
  const raid = raidOf().filter(r => !isClosed(r));
  const ri = raid.filter(r => r.kind !== 'dependency'), deps = raid.filter(r => r.kind === 'dependency');
  const high = ri.filter(r => raidRating(r).level === 'High').length;
  const blocked = deps.filter(r => r.status === 'Blocked').length, atRisk = deps.filter(r => r.status === 'At risk').length;
  const due = reportsOff() ? null : reportsDue().length;
  const tile = (key, label, value, sub, go, tone = '', extra = '') => dashBtn(`dash-tile${tone ? ` tone-${tone}` : ''}`, go, null,
    `<span class="dash-tile-l">${label}</span><span class="dash-tile-v">${value}</span>${sub ? `<span class="dash-tile-s">${sub}</span>` : ''}${extra}`, `id="dash-tile-${key}"`);
  const tiles = [
    tile('closed', `${T.Milestones} closed`, `${closed}<small>/${ms.length}</small>`, ms.length ? `${pct(closed, ms.length)}% of them` : `No ${T.milestones} yet`,
      { k: 'gantt', type: 'milestone', rag: doneNames }, '', `<span class="dv-meter dv-meter-sm"><i class="dv-meter-fill" style="width:${pct(closed, ms.length)}%"></i></span>`),
    tile('late', 'Overdue', late.length, lateStart.length ? `+ ${count(lateStart.length, 'late start', 'late starts')}` : late.length ? 'past their end date' : 'Nothing overdue',
      { k: 'gantt', late: true }, late.length ? 'bad' : 'good'),
    tile('soon', `Due in ${dashHorizon} days`, soon.length, soon.length ? `${count(soon.filter(m => !isTask(m)).length, T.milestone, T.milestones)}, ${count(soon.filter(isTask).length, T.task, T.tasks)}` : 'Nothing falls due', { k: 'scroll', card: 'coming' }),
    due == null ? '' : tile('due', 'Reports due', due, due ? 'for this period' : 'All reported', { k: 'reports', mode: 'due' }, due ? 'warn' : 'good'),
    tile('raid', 'Open risks & issues', ri.length, high ? `${count(high, 'rated High', 'rated High')}` : ri.length ? 'none rated High' : 'Register is clear', { k: 'raid' }, high ? 'bad' : ''),
    tile('deps', 'Open dependencies', deps.length, blocked || atRisk ? [blocked && `${blocked} blocked`, atRisk && `${atRisk} at risk`].filter(Boolean).join(' · ') : deps.length ? 'none blocked' : 'None open',
      { k: 'raid', kind: 'dependency' }, blocked ? 'bad' : atRisk ? 'warn' : ''),
    tile('dates', 'Date changes', '<span class="dash-tile-wait">…</span>', 'in the last 30 days', { k: 'view', view: 'dates' }),
  ];
  return `<div class="dash-tiles" style="--span:12">${tiles.join('')}</div>`;
}

// Where the items stand: a stacked bar per kind of item, by RAG.
function dashStand(items, rg) {
  const kinds = [['top', T.Tops, isTopLevel, { type: 'top' }], ['milestone', T.Milestones, (m) => m.type === 'milestone', { type: 'milestone' }], ['task', T.Tasks, isTask, { type: 'task' }]];
  const rows = kinds.map(([key, label, test, filter]) => {
    const list = items.filter(test);
    return { key, label, labelHtml: dashBtn('dv-name', { k: 'gantt', ...filter }, null, escAttr(label)), total: list.length,
      segs: rg.names.map(st => ({ name: st, n: list.filter(m => m.status === st).length, color: rg.map[st].base, go: { k: 'gantt', ...filter, rag: [st] } })) };
  }).filter(r => r.total);
  const max = Math.max(...rows.map(r => r.total));
  const totals = rg.names.map(st => [st, rg.map[st].base, items.filter(m => m.status === st).length]).filter(([, , n]) => n);
  return dashCard('stand', 'Where things stand', `by RAG`, dvStacked(rows, max) + dvLegend(totals),
    { table: dvTable(['', ...rg.names, 'Total'], rows.map(r => [escAttr(r.label), ...r.segs.map(s => s.n), r.total])) });
}

// Each stream's items by RAG, with the stream's latest weekly RAG beside its name.
function dashStreams(p, items, rg) {
  const rows = streamsInOrder().map(id => {
    const list = items.filter(m => m.stream_id === id);
    const [cur] = id ? updatesFor(p.id, id) : [];
    const name = id ? streamName(id) || 'Deleted stream' : '(No stream)';
    return { key: id, label: name, total: list.length,
      labelHtml: `${dashBtn('dv-name', { k: 'gantt', stream: id }, null, escAttr(name))}${cur ? `<span class="dv-weekly" title="Latest weekly update: ${escAttr(cur.status)}, w/e ${fmtShort(cur.week_ending)}">${statusPill(cur.status, rg.map)}</span>` : ''}`,
      segs: rg.names.map(st => ({ name: st, n: list.filter(m => m.status === st).length, color: rg.map[st].base, go: { k: 'gantt', stream: id, rag: [st] } })) };
  }).filter(r => r.total);
  if (!rows.length) return dashCard('streams', 'By stream', '', dashEmpty('No streams yet.'));
  const max = Math.max(...rows.map(r => r.total));
  return dashCard('streams', 'By stream', `${count(rows.length, 'stream', 'streams')} · pill = latest weekly RAG`, dvStacked(rows, max),
    { table: dvTable(['Stream', ...rg.names, 'Total'], rows.map(r => [escAttr(r.label), ...r.segs.map(s => s.n), r.total])) });
}

// The weekly RAG record: a cell per week for the program and each stream that has updates.
function dashWeekly(p, rg) {
  const end = defaultPeriodEnd('Weekly');
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(end, -7 * (11 - i)));
  const subjects = [{ id: '', name: p.code || 'Program', sub: programSubject(p) },
    ...streamsInOrder().filter(id => id && updatesFor(p.id, id).length).map(id => ({ id, name: streamName(id), sub: streamSubject(p, id) }))];
  const ups = subjects.map(s => ({ ...s, byWeek: new Map(updatesFor(p.id, s.id).map(u => [u.week_ending, u])) }));
  if (!ups.some(s => s.byWeek.size)) return dashCard('weekly', 'Weekly RAG', 'last 12 weeks', dashEmpty('No weekly updates yet. <b>Weekly update</b> above records this week’s; they’re listed under <b>Reports → Weekly updates</b>.'), { span: 7 });
  const body = `<div class="dv-weeks" style="--n:${weeks.length}">
    <div class="dv-weeks-row dv-weeks-head"><span></span>${weeks.map((w, i) => `<span class="dv-week${w === end ? ' now' : ''}">${i % 2 || w === end ? fmtShort(w).replace(/ .*/, '') : ''}<br><small>${w === end ? 'this wk' : i % 2 ? fmtShort(w).replace(/^\S+ /, '') : ''}</small></span>`).join('')}</div>
    ${ups.map(s => `<div class="dv-weeks-row"><span class="dv-weeks-name">${dashBtn('dv-name', { k: 'update', stream: s.id }, null, escAttr(s.name))}</span>
      ${weeks.map(w => { const u = s.byWeek.get(w); return u
        ? dashBtn('dv-cell', { k: 'update', stream: s.id, week: w }, [`${s.name} · w/e ${fmtShort(w)}`, u.status, u.summary ? mdToText(u.summary).slice(0, 160) : ''], '', `style="background:${rg.map[u.status]?.base || UNKNOWN_PALETTE.base}" aria-label="${escAttr(`${s.name}, week ending ${fmtShort(w)}: ${u.status}`)}"`)
        : `<i class="dv-cell none" title="${escAttr(`${s.name} · w/e ${fmtShort(w)} · no update`)}"></i>`; }).join('')}</div>`).join('')}
  </div>${dvLegend(rg.names.map(st => [st, rg.map[st].base]))}`;
  const table = dvTable(['', ...weeks.map(w => fmtShort(w))], ups.map(s => [escAttr(s.name), ...weeks.map(w => s.byWeek.get(w) ? escAttr(s.byWeek.get(w).status) : '—')]));
  return dashCard('weekly', 'Weekly RAG', 'last 12 weeks', body, { span: 7, table });
}

// Movement against the baseline: how far each baselined item's end has moved, late to the right.
function dashSlip(items) {
  const rows = items.filter(m => m.baseline_end).map(m => ({ m, d: daysBetween(m.baseline_end, m.end) })).sort((a, b) => b.d - a.d || cmpRef(a.m, b.m));
  if (!rows.length) return dashCard('slip', 'Against the baseline', '', dashEmpty(`No baseline dates yet. Set a baseline on the plan to see how far each ${T.item} has moved from it.`), { span: 5 });
  const late = rows.filter(r => r.d > 0), early = rows.filter(r => r.d < 0);
  const max = Math.max(1, ...rows.map(r => Math.abs(r.d)));
  const shown = rows.filter(r => r.d).slice(0, 10);
  const body = shown.length ? `<div class="dv-div" style="--max:${max}">${shown.map(({ m, d }) => `<div class="dv-div-row">
      <div class="dv-label">${dashBtn('dv-name', { k: 'item', id: m.id }, null, `${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}`)}</div>
      <div class="dv-div-track"><i class="dv-div-axis"></i>${dashBtn(`dv-div-bar ${d > 0 ? 'late' : 'early'}`, { k: 'item', id: m.id },
        [fullLabel(m), `Baseline end ${fmtNice(m.baseline_end)}`, `Now ${fmtNice(m.end)}`, `${d > 0 ? `${daysWord(d)} later` : `${daysWord(-d)} earlier`}`], '',
        `style="${d > 0 ? 'left:50%' : 'right:50%'};width:${(Math.abs(d) / max) * 50}%" aria-label="${escAttr(`${fullLabel(m)}: ${d > 0 ? `${daysWord(d)} later` : `${daysWord(-d)} earlier`}`)}"`)}
        <span class="dv-div-v ${d > 0 ? 'late' : 'early'}" style="${d > 0 ? `left:calc(50% + ${(d / max) * 50}% + 6px)` : `right:calc(50% + ${(-d / max) * 50}% + 6px)`}">${d > 0 ? '+' : '−'}${Math.abs(d)}d</span>
      </div></div>`).join('')}</div>
    ${dvLegend([['Later than baseline', 'var(--dv-late)', late.length], ['Earlier', 'var(--dv-early)', early.length], ['On the baseline', 'var(--faint)', rows.length - late.length - early.length]])}
    ${rows.filter(r => r.d).length > shown.length ? `<p class="dash-more">${rows.filter(r => r.d).length - shown.length} more have moved — see the table.</p>` : ''}`
    : dashEmpty(`Every baselined ${T.item} is still on its baseline end date.`);
  const sum = late.reduce((a, r) => a + r.d, 0);
  return dashCard('slip', 'Against the baseline', `${late.length} of ${rows.length} later${sum ? `, ${daysWord(sum)} in all` : ''}`, body,
    { span: 5, table: dvTable([T.Item, 'Baseline end', 'End now', 'Moved'], rows.map(({ m, d }) => [escAttr(fullLabel(m)), fmtShort(m.baseline_end), fmtShort(m.end), d ? `${d > 0 ? '+' : '−'}${Math.abs(d)}d` : '0'])) });
}

// The milestones month by month, by where they stand, around today.
function dashMonths(items, rg) {
  const ms = items.filter(m => !isTask(m) && m.end);
  if (!ms.length) return dashCard('months', `${T.Milestones} by month`, '', dashEmpty(`No ${T.milestones} with dates yet.`));
  const monthOf = (iso) => iso.slice(0, 7);
  const months = [...new Set(ms.map(m => monthOf(m.end)))].sort();
  const now = monthOf(todayISO());
  // span the plan, but no more than 18 months: around today when it's longer
  let first = months[0], last = months.at(-1);
  const step = (ym, n) => { const [y, mo] = ym.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const span = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
  if (span(first, last) > 17) { first = step(now, -6); last = step(now, 11); if (first < months[0]) { first = months[0]; last = step(first, 17); } if (last > months.at(-1)) { last = months.at(-1); first = step(last, -17); } }
  const cols = [];
  for (let ym = first; ym <= last; ym = step(ym, 1)) cols.push(ym);
  const buckets = ['closed', 'green', 'redAmber', 'notStarted'];
  const data = cols.map(ym => { const list = ms.filter(m => monthOf(m.end) === ym); const b = Object.fromEntries(buckets.map(k => [k, 0])); for (const m of list) b[msBucket(m.status, state.workspaceId, rg)]++; return { ym, list, b, total: list.length }; });
  const max = Math.max(1, ...data.map(d => d.total));
  const top = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const label = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5) - 1, 1).toLocaleDateString('en-GB', { month: 'short' });
  const outside = ms.length - data.reduce((a, d) => a + d.total, 0);
  const body = `<div class="dv-cols">
    <div class="dv-cols-y"><span>${top}</span><span>${top / 2 % 1 ? '' : top / 2}</span><span>0</span></div>
    <div class="dv-cols-plot" style="--n:${cols.length}">${data.map(d => `<div class="dv-col${d.ym === now ? ' now' : ''}">
        <div class="dv-col-stack" role="img" aria-label="${escAttr(`${label(d.ym)} ${d.ym.slice(0, 4)}: ${d.total}`)}">${buckets.filter(k => d.b[k]).map(k =>
          dashBtn('dv-col-seg', { k: 'gantt', type: 'milestone', rag: STATUSES.filter(st => msBucket(st, state.workspaceId, rg) === k) }, [`${label(d.ym)} ${d.ym.slice(0, 4)}`, `${d.b[k]} ${MS_BUCKETS.find(([b]) => b === k)[1].toLowerCase()}`, `${d.total} in all`], '',
            `style="height:${(d.b[k] / top) * 100}%;background:${DASH_BUCKET_COLORS[k]}"`)).join('')}</div>
        <span class="dv-col-x">${label(d.ym)}${d.ym.endsWith('-01') || d.ym === cols[0] ? `<small>${d.ym.slice(0, 4)}</small>` : ''}</span></div>`).join('')}</div>
  </div>${dvLegend(buckets.map(k => [MS_BUCKETS.find(([b]) => b === k)[1], DASH_BUCKET_COLORS[k], ms.filter(m => msBucket(m.status, state.workspaceId, rg) === k).length]))}
  ${outside ? `<p class="dash-more">${outside} fall outside these months.</p>` : ''}`;
  return dashCard('months', `${T.Milestones} by month`, `${count(ms.length, T.milestone, T.milestones)} by end date`, body,
    { table: dvTable(['Month', ...buckets.map(k => MS_BUCKETS.find(([b]) => b === k)[1]), 'Total'], data.map(d => [`${label(d.ym)} ${d.ym.slice(0, 4)}`, ...buckets.map(k => d.b[k]), d.total])) });
}

// Who holds the open items, and how many of theirs are overdue.
function dashOwners(items) {
  const open = items.filter(m => !isDoneStatus(m.status));
  if (!open.length) return dashCard('owners', 'Open items by owner', '', dashEmpty(`Everything is complete.`));
  const by = new Map();
  for (const m of open) { const k = m.owner || ''; if (!by.has(k)) by.set(k, { owner: k, n: 0, late: 0 }); const o = by.get(k); o.n++; if (isLate(m)) o.late++; }
  const rows = [...by.values()].sort((a, b) => b.n - a.n || a.owner.localeCompare(b.owner)).slice(0, 10);
  const max = Math.max(...rows.map(r => r.n));
  const body = `<div class="dv-bars">${rows.map(r => `<div class="dv-row">
      <div class="dv-label">${dashBtn('dv-name', { k: 'gantt', owner: r.owner }, null, r.owner ? escAttr(r.owner) : '<span class="muted">No owner</span>')}</div>
      <div class="dv-bar">${r.n - r.late ? dashBtn('dv-seg', { k: 'gantt', owner: r.owner }, [r.owner || 'No owner', `${r.n - r.late} open and on time`, `${r.n} open in all`], '', `style="flex-basis:${((r.n - r.late) / max) * 100}%;background:var(--dv-early)" aria-label="${escAttr(`${r.n - r.late} open`)}"`) : ''}
        ${r.late ? dashBtn('dv-seg', { k: 'gantt', owner: r.owner, late: true }, [r.owner || 'No owner', `${r.late} overdue`, `${r.n} open in all`], '', `style="flex-basis:${(r.late / max) * 100}%;background:var(--dv-late)" aria-label="${escAttr(`${r.late} overdue`)}"`) : ''}</div>
      <div class="dv-total">${r.n}</div></div>`).join('')}</div>
    ${dvLegend([['Open', 'var(--dv-early)', open.length - open.filter(isLate).length], ['Overdue', 'var(--dv-late)', open.filter(isLate).length]])}
    ${by.size > rows.length ? `<p class="dash-more">${by.size - rows.length} more owners — see the table.</p>` : ''}`;
  return dashCard('owners', `Open ${T.items} by owner`, `${count(open.length, T.item, T.items)} not complete`, body,
    { table: dvTable(['Owner', 'Open', 'Overdue'], [...by.values()].sort((a, b) => b.n - a.n).map(r => [r.owner ? escAttr(r.owner) : '(no owner)', r.n, r.late])) });
}

// What's overdue and what falls due within the horizon, soonest first.
function dashComing(items) {
  const today = todayISO(), horizon = addDays(today, dashHorizon);
  const list = items.filter(m => !isDoneStatus(m.status) && m.end && m.end <= horizon).sort((a, b) => a.end.localeCompare(b.end) || cmpRef(a, b));
  const shown = list.slice(0, 14);
  const when = (m) => { const d = daysBetween(today, m.end); return d < 0 ? `<em class="dv-when late">Overdue ${daysWord(-d)}</em>` : d === 0 ? '<em class="dv-when today">Due today</em>' : `<em class="dv-when">in ${daysWord(d)}</em>`; };
  const body = shown.length ? `<ul class="dash-list">${shown.map(m => `<li>${dashBtn('dash-item', { k: 'item', id: m.id }, null,
      `${statusPill(m.status)}<span class="dash-item-t">${m.ref ? `<b>${escAttr(m.ref)}</b> ` : ''}${escAttr(m.title)}</span>${when(m)}
       <small>${escAttr(typeName(m))} · ${fmtShort(m.end)}${m.owner ? ` · ${escAttr(m.owner)}` : ''}${streamName(m.stream_id) ? ` · ${escAttr(streamName(m.stream_id))}` : ''}</small>`)}</li>`).join('')}</ul>
    ${list.length > shown.length ? `<p class="dash-more">${list.length - shown.length} more within ${dashHorizon} days.</p>` : ''}`
    : dashEmpty(`Nothing is overdue or due in the next ${dashHorizon} days.`);
  const late = list.filter(m => m.end < today).length;
  return dashCard('coming', 'Coming up', `${late ? `${late} overdue · ` : ''}${list.length - late} due in ${dashHorizon} days`, body, { span: 4 });
}

// The open risks, issues and dependencies that matter most: by rating, then by due date.
function dashRisks(p) {
  const open = raidOf().filter(r => !isClosed(r));
  const rows = [...open].sort((a, b) => raidRating(b).score - raidRating(a).score || (!a.due) - (!b.due) || a.due.localeCompare(b.due)).slice(0, 8);
  const body = rows.length ? `<ul class="dash-list">${rows.map(r => `<li>${dashBtn('dash-item', { k: 'raid', id: r.id }, null,
      `<span class="dash-kind dash-kind-${r.kind}" title="${RAID_KINDS[r.kind].one}">${RAID_KINDS[r.kind].prefix}</span><span class="dash-item-t">${r.ref ? `<b>${escAttr(r.ref)}</b> ` : ''}${escAttr(r.title)}</span>${ratingPill(raidRating(r))}
       <small>${raidStatusBadge(r)}${r.owner ? ` · ${escAttr(r.owner)}` : ''}${r.due ? ` · <span class="${raidOverdue(r) ? 'dv-late-text' : ''}">due ${fmtShort(r.due)}</span>` : ''}</small>`)}</li>`).join('')}</ul>`
    : dashEmpty('No open risks, issues or dependencies.');
  return dashCard('risks', 'Risks, issues & dependencies', count(open.length, 'open', 'open'), body,
    { span: 4, actions: dashBtn('btn btn-sm', { k: 'raid' }, null, 'Register') });
}

// The reports written most recently.
function dashReports() {
  const rows = [...state.reports].sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created)).slice(0, 8);
  const body = rows.length ? `<ul class="dash-list">${rows.map(r => `<li>${dashBtn('dash-item', { k: 'report', id: r.id, item: r.item_id }, null,
      `${statusPill(r.status)}<span class="dash-item-t">${escAttr(itemName(r.item_id))}</span>
       <small>${r.cadence} · period ending ${fmtShort(r.period_end)}${r.author ? ` · ${escAttr(r.author)}` : ''}</small>
       ${r.exec_summary ? `<span class="dash-item-x">${escAttr(mdToText(r.exec_summary).slice(0, 150))}</span>` : ''}`)}</li>`).join('')}</ul>`
    : dashEmpty('No reports yet.');
  return dashCard('reports', 'Latest reports', count(state.reports.length, 'report', 'reports'), body,
    { span: 4, actions: dashBtn('btn btn-sm', { k: 'view', view: 'reports' }, null, 'All reports') });
}

// The Dates moved tile fills in once the date log has loaded (it's fetched, not held in memory).
function dashDateChanges() {
  loadDateLog().then(() => {
    const el = document.querySelector('#dash-tile-dates .dash-tile-v');
    if (!el || !isShown('dash')) return;
    const since = addDays(todayISO(), -30);
    const rows = dlRows.filter(r => r.workspace_id === state.workspaceId && r.at.slice(0, 10) >= since && ['Changed', 'Knock-on'].includes(r.action));
    const saves = new Set(rows.map(r => `${r.at}|${r.item_id}`)), items = new Set(rows.map(r => r.item_id));
    const knock = new Set(rows.filter(r => r.action === 'Knock-on').map(r => `${r.at}|${r.item_id}`)).size;
    el.textContent = saves.size;
    el.nextElementSibling.textContent = saves.size ? `in 30 days, on ${count(items.size, T.item, T.items)}${knock ? ` (${knock} knock-on)` : ''}` : 'in the last 30 days';
  }).catch(() => {
    const el = document.querySelector('#dash-tile-dates .dash-tile-v');
    if (el) el.textContent = '—';
  });
}

/* ---- ways in, tooltips and wiring ---- */

async function dashGo(go) {
  const p = currentWorkspace();
  switch (go.k) {
    case 'gantt':
      clearGanttFilters();
      Object.assign(ganttFilter, { stream: go.stream || '', owner: go.owner || '', type: go.type || '', rag: go.rag || [], late: !!go.late });
      return switchView('gantt');
    case 'item': return showItemOnGantt(go.id);
    case 'raid': {
      raidFilter.kind = go.kind || '';
      raidFilter.status = 'open';
      switchView('raid');
      const r = go.id && state.raid.find(x => x.id === go.id);
      if (r) openRaidDialog(r);
      return;
    }
    case 'reports': rptMode = go.mode || 'all'; return switchView('reports');
    case 'report': showReportsFor(go.item); return selectReport(go.id);
    case 'update': {
      openUpdateDialog(go.stream ? streamSubject(p, go.stream) : programSubject(p));
      if (go.week) { document.getElementById('update-form').elements.week_ending.value = go.week; loadUpdateWeek(true); }
      return;
    }
    case 'view': return switchView(go.view);
    case 'scroll': return document.getElementById(`dash-${go.card}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showDashTip(el, e) {
  let t;
  try { t = JSON.parse(el.dataset.tip); } catch { return; }
  const tip = document.getElementById('tip');
  tip.replaceChildren(...[Object.assign(document.createElement('div'), { className: 'tip-head', textContent: t.h }),
    ...t.l.map(line => Object.assign(document.createElement('div'), { className: 'tip-row', textContent: line }))]);
  tipAvoid = [];
  tip.classList.add('show');
  moveTip(e);
}

function wireDash() {
  const grid = document.getElementById('dash-grid');
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('[data-dash-table]');
    if (t) {
      const key = t.dataset.dashTable, on = !dashTables.has(key);
      dashTables[on ? 'add' : 'delete'](key);
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', on);
      const card = t.closest('.dash-card');
      card.querySelector('.dash-chart').hidden = on;
      card.querySelector('.dash-tbl').hidden = !on;
      return;
    }
    const go = e.target.closest('[data-dash-go]');
    if (go) { hideTip(); dashGo(JSON.parse(go.dataset.dashGo)); }
  });
  grid.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) showDashTip(el, e); else hideTip(); });
  grid.addEventListener('pointermove', (e) => { if (e.target.closest('[data-tip]')) moveTip(e); });
  grid.addEventListener('pointerleave', hideTip);
  grid.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (!el) return hideTip(); const r = el.getBoundingClientRect(); showDashTip(el, { clientX: r.left + r.width / 2, clientY: r.bottom }); });
  grid.addEventListener('focusout', hideTip);
  document.getElementById('dash-horizon').addEventListener('change', (e) => {
    dashHorizon = +e.target.value;
    saveAppPrefs({ dashHorizon });
    renderDash();
  });
}

/* ---- weekly update dialog ---- */
// For a program or a stream. Opens on this week's update if there is one, otherwise a new one
// starting from last week's RAG. Picking a week that already has an update loads it. The area
// lead and trend are saved to the program or stream; the trend is suggested from the change in
// RAG until it's chosen by hand.

let upSubject = null;   // {p, stream, rec, label} being updated
let upEditing = null;   // update being edited; null for a new one
let upOpened = null, upRecOpened = null; // it, and the area lead and trend, as the dialog showed them
let upTrendTouched = false;
const RAG_RANK = { red: 0, amber: 1, green: 2, complete: 3 };

function openUpdateDialog(sub) {
  hideQuick();
  upSubject = sub;
  const f = document.getElementById('update-form').elements;
  const rg = ragOf(sub.p.id);
  document.getElementById('up-heading').textContent = `Weekly update · ${sub.label}`;
  document.getElementById('up-badge').textContent = sub.stream ? 'Stream update' : 'Weekly update';
  document.getElementById('up-status').innerHTML = rg.names.map(st => `
    <label style="--c:${rg.map[st].base};--t:${rg.map[st].text}"><input type="radio" name="status" value="${escAttr(st)}" /><span>${escAttr(st)}</span></label>`).join('');
  document.getElementById('up-trend').innerHTML = TRENDS.map(t => `
    <label><input type="radio" name="trend" value="${t.name}" />${trendArrow(t)}</label>`).join('');
  f.week_ending.value = defaultPeriodEnd('Weekly');
  f.lead.value = sub.rec.lead;
  upRecOpened = { lead: sub.rec.lead, trend: sub.rec.trend };
  upEditing = null;
  loadUpdateWeek(true);
  document.getElementById('up-error').textContent = '';
  refreshDatalists();
  document.getElementById('update-dialog').showModal();
}

const subjectUpdates = () => updatesFor(upSubject.p.id, upSubject.stream);

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
  upOpened = found && { ...found };
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
  document.getElementById('up-submit').textContent = 'Save update';
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
  const { p, stream, rec } = upSubject;
  const now = new Date().toISOString();
  const v = { week_ending: week, status, summary: f.summary.value.trim(), author: f.author.value.trim(), updated: now };
  if (upEditing && !state.updates.includes(upEditing)) return (err.textContent = 'Someone else has just deleted this update.');
  if (upEditing) Object.assign(upEditing, changedFrom(v, upOpened), { updated: now });
  else state.updates.push({ id: nextUpdateId(), workspace_id: p.id, stream_id: stream, created: now, ...v });
  const saves = [saveUpdates(upEditing ? 'Update saved' : 'Update submitted')];
  const changes = changedFrom({ lead: f.lead.value.trim(), trend: f.trend.value }, upRecOpened);
  if (Object.keys(changes).length) {
    Object.assign(rec, changes);
    if (stream) {
      saves.push(saveStreams());
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

// Show one stream (by id) on the Gantt chart.
function openStreamOnGantt(id) {
  clearGanttFilters();
  ganttFilter.stream = id;
  switchView('gantt');
}

function wireOverview() {
  document.getElementById('btn-overview-csv').onclick = () => downloadOverviewCSV(false);
  document.getElementById('btn-streams-csv').onclick = () => downloadOverviewCSV(true);
  document.getElementById('overview-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pid]');
    if (e.target.closest('[data-update]')) return openUpdateDialog(programSubject(workspaceById(row.dataset.pid)));
    const bucket = e.target.closest('[data-bucket]');
    if (bucket) return openBucket(row.dataset.pid, bucket.dataset.bucket);
    const open = e.target.closest('[data-open-workspace]');
    if (open) switchWorkspace(open.dataset.openWorkspace, 'dash');
  });
  document.getElementById('streams-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-stream]');
    if (!row) return;
    if (e.target.closest('[data-update]')) return openUpdateDialog(streamSubject(currentWorkspace(), row.dataset.stream));
    const bucket = e.target.closest('[data-bucket]');
    if (bucket) return openBucket(state.workspaceId, bucket.dataset.bucket, row.dataset.stream);
    if (e.target.closest('[data-open-stream]')) openStreamOnGantt(row.dataset.stream);
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

/* ================= risks, issues and dependencies ================= */
// Each workspace keeps a register (raid.csv) of risks (what might happen), issues (what has
// happened) and dependencies (what the plan needs from others, or others need from it). An entry
// can be linked to any number of the workspace's items and streams: `links` holds them as
// `item:<id>` and `stream:<id>`, ;-separated in the file. A link to an item that's since been
// deleted is kept and shown as deleted, as reports are. A risk is rated by likelihood × impact,
// an issue by its impact. A dependency has its own statuses, a stream, a RAG (one of the
// workspace's RAG options), and a priority and type from lists set in Workspace settings.
//
// Any entry can have status updates (raid-notes.csv). Like a SharePoint "append changes" field,
// an update is added with the time, and then kept: updates are never edited, only added to.
// They're a file of their own so two people adding updates at once never clash; the server signs
// each new one with the login ID (changedBy in server.js).
// A dependency also records the impact if it's delayed or blocked, its mitigation and the people
// accountable for it (impact_if, mitigation, accountable).

const RAID_KINDS = {
  risk: {
    one: 'Risk', many: 'Risks', prefix: 'R', response: 'Mitigation', statuses: ['Open', 'In progress', 'Closed'], done: 'Closed',
    placeholder: 'What’s being done to make it less likely, or to soften the blow',
  },
  issue: {
    one: 'Issue', many: 'Issues', prefix: 'I', response: 'Resolution plan', statuses: ['Open', 'In progress', 'Closed'], done: 'Closed',
    placeholder: 'What’s being done to resolve it, and by when',
  },
  dependency: {
    one: 'Dependency', many: 'Dependencies', prefix: 'D', response: 'Agreement / next action', statuses: ['Not started', 'At risk', 'Blocked', 'Complete'], done: 'Complete',
    placeholder: 'What’s been agreed with the other party, and what happens next',
  },
};
const RAID_LEVELS = ['Low', 'Medium', 'High'];
const RAID_COLUMNS = ['id', 'workspace_id', 'kind', 'ref', 'title', 'description', 'stream_id', 'owner', 'status', 'rag', 'priority', 'dep_type',
  'likelihood', 'impact', 'due', 'party', 'response', 'impact_if', 'mitigation', 'accountable', 'links', 'raised', 'created', 'updated'];
const NOTE_COLUMNS = ['id', 'workspace_id', 'raid_id', 'at', 'by', 'text'];
// A workspace's dependency priorities (highest first) and types, until it sets its own.
const DEFAULT_DEP_LISTS = { dep_priorities: ['Critical', 'Major', 'Medium', 'Minor'], dep_types: ['External', 'Vendor', 'Resource', 'Technology', 'Governance', 'Operational'] };
const depList = (workspaceId, key) => {
  const own = (workspaceById(workspaceId)?.[key] || '').split(';').map(x => x.trim()).filter(Boolean);
  return own.length ? own : DEFAULT_DEP_LISTS[key];
};

const raidKind = (v) => { const t = String(v ?? '').trim().toLowerCase(); return t.startsWith('r') ? 'risk' : t.startsWith('i') ? 'issue' : t.startsWith('d') ? 'dependency' : ''; };
// A value from a fixed list, matched ignoring case; one that isn't in it is kept as it is.
const fromList = (v, list) => list.find(x => x.toLowerCase() === String(v ?? '').trim().toLowerCase()) || String(v ?? '').trim();
const raidLink = (v) => { const m = String(v).trim().match(/^(item|stream):(.+)$/i); return m ? `${m[1].toLowerCase()}:${m[2].trim()}` : ''; };
// Statuses from earlier files, in a dependency's terms.
const DEP_STATUS_WAS = { open: 'Not started', 'in progress': 'Not started', closed: 'Complete' };

function rowsToRaid(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  const out = rows.slice(1).map(r => {
    const o = {};
    for (const k of RAID_COLUMNS) o[k] = (r[header.indexOf(k)] ?? '').trim(); // by name only: `status` and `rag` are both columns here
    const kind = raidKind(o.kind);
    const d = RAID_KINDS[kind];
    let status = d ? fromList(o.status, d.statuses) : o.status;
    if (kind === 'dependency') status = DEP_STATUS_WAS[status.toLowerCase()] || status;
    return {
      ...o, kind, status: status || d?.statuses[0], rag: o.rag && normaliseStatus(o.rag, o.workspace_id),
      likelihood: fromList(o.likelihood, RAID_LEVELS), impact: fromList(o.impact, RAID_LEVELS),
      priority: fromList(o.priority, depList(o.workspace_id, 'dep_priorities')), dep_type: fromList(o.dep_type, depList(o.workspace_id, 'dep_types')),
      links: [...new Set(o.links.split(';').map(raidLink).filter(Boolean))],
    };
  }).filter(r => ids.has(r.workspace_id) && r.kind);
  let last = Math.max(0, ...out.map(r => (/^\d+$/.test(r.id) ? +r.id : 0)));
  const seen = new Set();
  for (const r of out) {
    if (!/^\d+$/.test(r.id) || seen.has(r.id)) r.id = String(++last);
    seen.add(r.id);
  }
  return out;
}
function raidToCSV(list) {
  return [RAID_COLUMNS.join(','), ...list.map(r => RAID_COLUMNS.map(k => csvEscape(k === 'links' ? r.links.join(';') : r[k])).join(','))].join('\n') + '\n';
}
function rowsToRaidNotes(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const ids = new Set(state.workspaces.map(p => p.id));
  return rows.slice(1).map(r => Object.fromEntries(NOTE_COLUMNS.map(k => [k, (r[header.indexOf(k)] ?? '').trim()])))
    .filter(n => ids.has(n.workspace_id) && n.raid_id && n.text);
}
function raidNotesToCSV(list) {
  return [NOTE_COLUMNS.join(','), ...list.map(n => NOTE_COLUMNS.map(k => csvEscape(n[k])).join(','))].join('\n') + '\n';
}
const nextRaidId = () => takeId('raid', () => String(Math.max(0, ...state.raid.map(r => +r.id || 0)) + 1));
const nextNoteId = () => takeId('raid-notes', () => String(Math.max(0, ...state.raidNotes.map(n => +n.id || 0)) + 1));
// The next free ref of a kind in a workspace: R1, R2… / I1… / D1….
function nextRaidRef(workspaceId, kind) {
  const pre = RAID_KINDS[kind].prefix;
  const n = state.raid.filter(r => r.workspace_id === workspaceId).map(r => r.ref.match(new RegExp(`^${pre}-?(\\d+)$`, 'i'))?.[1]).filter(Boolean);
  return `${pre}${Math.max(0, ...n.map(Number)) + 1}`;
}

const raidOf = (workspaceId = state.workspaceId) => state.raid.filter(r => r.workspace_id === workspaceId);
const isClosed = (r) => r.status === RAID_KINDS[r.kind].done;
const raidOverdue = (r) => !isClosed(r) && r.due && r.due < fmtISO(new Date());
// Entries linked to an item (directly) or a stream.
const raidLinkedTo = (link) => raidOf().filter(r => r.links.includes(link));
// An entry's notes, newest first.
const notesOf = (r) => state.raidNotes.filter(n => n.raid_id === r.id).sort((a, b) => b.at.localeCompare(a.at) || +b.id - +a.id);

// Rating: { level: 'High' | 'Medium' | 'Low' | '', score (0–9, for sorting), label } — a risk's
// from likelihood × impact, an issue's its impact, a dependency's its priority.
function raidRating(r) {
  if (r.kind === 'dependency') {
    const list = depList(r.workspace_id, 'dep_priorities'), i = list.indexOf(r.priority);
    if (!r.priority) return { level: '', score: 0, label: '' };
    if (i < 0) return { level: 'Medium', score: 0, label: r.priority };
    const pos = list.length < 2 ? 0 : i / (list.length - 1); // 0 = top priority
    return { level: pos < 1 / 3 ? 'High' : pos > 2 / 3 ? 'Low' : 'Medium', score: 9 * (1 - pos), label: r.priority };
  }
  const i = RAID_LEVELS.indexOf(r.impact) + 1;
  const l = RAID_LEVELS.indexOf(r.likelihood) + 1;
  if (r.kind !== 'risk' || !i || !l) return { level: i ? r.impact : '', score: i * 3, label: i ? r.impact : '' };
  const score = l * i;
  const level = score >= 6 ? 'High' : score >= 3 ? 'Medium' : 'Low';
  return { level, score, label: level };
}
const ratingPill = (rt, title = '') => (rt.label ? `<span class="lvl lvl-${rt.level.toLowerCase()}" ${title ? `title="${escAttr(title)}"` : ''}>${escAttr(rt.label)}</span>` : '<span class="muted">—</span>');
const raidStatusBadge = (r) => `<span class="raid-status raid-status-${r.status.toLowerCase().replace(/\s+/g, '-')}">${escAttr(r.status)}</span>`;

// What a link reads as, and whether it still points at something.
function linkInfo(link) {
  const [type, ...rest] = link.split(':');
  const key = rest.join(':');
  if (type === 'stream') { const l = streamById(key); return { type, key, label: l?.name || 'Deleted stream', title: `Stream: ${l?.name || '(deleted)'}`, live: !!l && l.workspace_id === state.workspaceId }; }
  const m = itemById(key);
  return { type, key, label: m ? fullLabel(m) : `#${key}`, title: m ? fullLabel(m) : `Deleted ${T.item} #${key}`, live: !!m };
}
const linkChip = (link, removable) => {
  const x = linkInfo(link);
  const cls = `chip raid-link raid-link-${x.type}${x.live ? '' : ' gone'}`;
  const body = `${x.type === 'stream' ? '<i class="raid-link-ico" aria-hidden="true">≡</i>' : ''}<span class="raid-link-text">${escAttr(x.label)}</span>`;
  return removable
    ? `<span class="${cls}" title="${escAttr(x.title)}">${body}<button type="button" data-rdrm="${escAttr(link)}" title="Remove link">×</button></span>`
    : `<button type="button" class="${cls}" data-raid-go="${escAttr(link)}" title="${escAttr(x.title)}${x.live ? ' — show on the plan' : ''}" ${x.live ? '' : 'disabled'}>${body}</button>`;
};
const streamGo = (id) => (streamById(id) ? `<button type="button" class="link-btn" data-raid-go="stream:${escAttr(id)}" title="Show this stream on the plan">${escAttr(streamName(id))}</button>` : '<span class="muted">—</span>');
const noteLine = (n) => `<span class="note-when">${fmtStamp(n.at)}${n.by ? ` · ${escAttr(n.by)}` : ''}</span> ${escAttr(n.text)}`;

/* ---- the register ---- */
const raidFilter = { kind: '', status: 'open', q: '', link: '' };
let raidRows = []; // as last rendered, for the CSV

function raidMatches(r, ignoreKind) {
  const f = raidFilter;
  if (!ignoreKind && f.kind && r.kind !== f.kind) return false;
  if (f.status === 'open' ? isClosed(r) : f.status === 'done' && !isClosed(r)) return false;
  if (f.link && !r.links.includes(f.link) && !(r.stream_id && f.link === `stream:${r.stream_id}`)) return false;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [r.ref, r.title, r.description, r.owner, r.party, r.response, r.impact_if, r.mitigation, r.accountable, streamName(r.stream_id), r.rag, r.priority, r.dep_type, RAID_KINDS[r.kind].one, r.status,
    ...notesOf(r).map(n => n.text), ...r.links.map(l => { const x = linkInfo(l); return `${x.label} ${x.title}`; })].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}
// Blocked and at risk first, closed last; then highest rated, soonest due, and by ref.
const STATUS_ORDER = { Blocked: 0, 'At risk': 1, 'In progress': 2, Open: 3, 'Not started': 3 };
const raidOrder = (a, b) => (isClosed(a) - isClosed(b)) || (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || raidRating(b).score - raidRating(a).score
  || (a.due || '9999').localeCompare(b.due || '9999') || cmpRef(a, b);

// The table's columns: one set for everything, and one for dependencies alone.
const dash = '<span class="muted">—</span>';
const cellOr = (v) => (v ? escAttr(v) : dash);
const RAID_TABLES = {
  all: [
    ['Ref', '', (r) => (r.ref ? escAttr(r.ref) : dash), 'raid-ref'],
    ['Type', '', (r) => `<span class="raid-kind raid-kind-${r.kind}">${RAID_KINDS[r.kind].one}</span>`],
    ['Title', 'raid-title', (r) => raidTitleCell(r), 'raid-title'],
    ['Linked to', '', (r) => r.links.map(l => linkChip(l)).join('') || dash, 'raid-links'],
    ['Owner', '', (r) => cellOr(r.owner)],
    ['Rating', '', (r) => ratingPill(raidRating(r), ratingTitle(r)), '', 'Risks: likelihood × impact. Issues: impact. Dependencies: priority'],
    ['Status', '', raidStatusBadge],
    ['Due', '', (r) => dueCell(r), 'raid-due'],
    ['Response', 'raid-resp', (r) => cellOr(r.response), 'raid-resp'],
  ],
  dependency: [
    ['Ref', '', (r) => (r.ref ? escAttr(r.ref) : dash), 'raid-ref'],
    ['Title', 'raid-title', (r) => raidTitleCell(r), 'raid-title'],
    ['Type', '', (r) => cellOr(r.dep_type)],
    ['Stream', '', (r) => streamGo(r.stream_id)],
    ['Linked to', '', (r) => r.links.map(l => linkChip(l)).join('') || dash, 'raid-links'],
    ['Owner', '', (r) => cellOr(r.owner)],
    ['Accountable', '', (r) => cellOr(r.accountable)],
    ['Priority', '', (r) => ratingPill(raidRating(r))],
    ['RAG', '', (r) => (r.rag ? statusPill(r.rag, ragOf(r.workspace_id).map) : dash)],
    ['Status', '', raidStatusBadge],
    ['Due', '', (r) => dueCell(r), 'raid-due'],
    ['Latest update', 'raid-resp', (r) => { const n = notesOf(r)[0]; return n ? `${noteLine(n)}${notesOf(r).length > 1 ? `<small class="muted"> · ${notesOf(r).length - 1} earlier</small>` : ''}` : dash; }, 'raid-resp raid-note'],
  ],
};
function raidTitleCell(r) {
  return `<b>${escAttr(r.title) || '<span class="muted">(untitled)</span>'}</b>${r.description ? `<div class="raid-desc">${escAttr(r.description)}</div>` : ''}`
    + `${r.kind === 'dependency' && r.party ? `<div class="raid-desc">With: ${escAttr(r.party)}</div>` : ''}`
    + `${r.kind === 'dependency' && r.impact_if ? `<div class="raid-desc">If delayed: ${escAttr(r.impact_if)}</div>` : ''}`;
}
const ratingTitle = (r) => (r.kind === 'risk' ? `Likelihood ${r.likelihood || '?'} × impact ${r.impact || '?'}` : r.kind === 'issue' ? `Impact ${r.impact || '?'}` : `Priority ${r.priority || '?'}`);
const dueCell = (r) => (r.due ? `<span class="${raidOverdue(r) ? 'late' : ''}" ${raidOverdue(r) ? 'title="Overdue"' : ''}>${fmtShort(r.due)}</span>` : dash);

function renderRaid() {
  const all = raidOf();
  const base = all.filter(r => raidMatches(r, true));
  const counts = Object.fromEntries(Object.keys(RAID_KINDS).map(k => [k, base.filter(r => r.kind === k).length]));
  document.getElementById('raid-kind').innerHTML = [['', 'All', base.length], ...Object.entries(RAID_KINDS).map(([k, d]) => [k, d.many, counts[k]])]
    .map(([k, label, n]) => `<label><input type="radio" name="raid-kind" value="${k}" ${raidFilter.kind === k ? 'checked' : ''} /><span>${label} <b class="seg-count raid-seg-count">${n}</b></span></label>`).join('');
  document.getElementById('raid-status').value = raidFilter.status;
  const chip = document.getElementById('raid-link');
  chip.hidden = !raidFilter.link;
  chip.innerHTML = raidFilter.link ? `Linked to ${escAttr(linkInfo(raidFilter.link).title)}<button type="button" data-raid-all title="Show everything">✕</button>` : '';
  document.getElementById('btn-raid-add').textContent = `+ Add ${raidFilter.kind ? RAID_KINDS[raidFilter.kind].one.toLowerCase() : ''}`.trim();
  raidRows = base.filter(r => raidMatches(r)).sort(raidOrder);
  const cols = RAID_TABLES[raidFilter.kind === 'dependency' ? 'dependency' : 'all'];
  document.getElementById('raid-head').innerHTML = `<tr>${cols.map(([h, cls, , , title]) => `<th class="${cls}" ${title ? `title="${escAttr(title)}"` : ''}>${h}</th>`).join('')}</tr>`;
  document.getElementById('raid-body').innerHTML = raidRows.map(r => `<tr data-raid="${r.id}" class="raid-row${isClosed(r) ? ' closed' : ''}">
      ${cols.map(([, , cell, cls]) => `<td class="${cls || ''}">${cell(r)}</td>`).join('')}
    </tr>`).join('')
    || `<tr><td colspan="${cols.length}" class="grid-empty">${all.length ? 'Nothing matches the filters.' : 'No risks, issues or dependencies yet. Use <b>+ Add</b> to record one.'}</td></tr>`;
  const overdue = raidRows.filter(raidOverdue).length;
  const blocked = raidRows.filter(r => r.status === 'Blocked').length;
  document.getElementById('raid-count').textContent = count(raidRows.length, 'entry', 'entries')
    + (blocked ? ` · ${blocked} blocked` : '') + (overdue ? ` · ${overdue} overdue` : '');
  updateRaidBadge();
}

// The menu shows how many entries are open in the workspace.
function updateRaidBadge() {
  const n = raidOf().filter(r => !isClosed(r)).length;
  const b = document.getElementById('nav-raid-count');
  b.hidden = !n;
  b.textContent = n;
  b.title = count(n, 'open entry', 'open entries');
}

// The register, showing only what's linked to an item or stream.
function showRaidFor(link) {
  raidFilter.link = link;
  raidFilter.kind = '';
  raidFilter.status = '';
  raidFilter.q = '';
  document.getElementById('raid-q').value = '';
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  switchView('raid');
}

function goToLink(link) {
  const x = linkInfo(link);
  if (!x.live) return;
  if (x.type === 'stream') openStreamOnGantt(x.key);
  else showItemOnGantt(x.key);
}

function downloadRaidCSV() {
  renderRaid();
  const head = ['Ref', 'Type', 'Title', 'Description', 'Stream', 'Linked to', 'Owner', 'Status', 'RAG', 'Priority', 'Dependency type', 'Likelihood', 'Impact', 'Rating',
    'Due', 'Raised', 'Other party', 'Response', 'Impact if delayed', 'Mitigation', 'Accountable people', 'Status updates'];
  const lines = raidRows.map(r => [r.ref, RAID_KINDS[r.kind].one, r.title, r.description, streamName(r.stream_id), r.links.map(l => linkInfo(l).title).join('; '), r.owner,
    r.status, r.rag, r.priority, r.dep_type, r.likelihood, r.impact, raidRating(r).label, r.due, r.raised, r.party, r.response, r.impact_if, r.mitigation, r.accountable,
    notesOf(r).map(n => `${fmtStamp(n.at)}${n.by ? ` (${n.by})` : ''}: ${n.text}`).join('\n')].map(csvEscape).join(','));
  const blob = new Blob(['﻿' + [head.map(csvEscape).join(','), ...lines].join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const p = currentWorkspace();
  const slug = (p.code || p.name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'workspace';
  const a = document.createElement('a');
  a.download = `${slug}-risks-issues-dependencies-${fmtISO(new Date())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ---- the dialog ---- */
let rdEditing = null; // entry being edited; null for a new one
let rdOpened = null;  // it as the dialog showed it, so only what's changed here is saved
let rdLinks = [];
const RD_FIELDS = ['ref', 'title', 'description', 'stream_id', 'owner', 'status', 'rag', 'priority', 'dep_type', 'likelihood', 'impact', 'due', 'raised', 'party', 'response', 'impact_if', 'mitigation', 'accountable'];
// Fields only some kinds have: cleared on saving any other kind.
const RD_ONLY = { likelihood: ['risk'], impact: ['risk', 'issue'], stream_id: ['dependency'], rag: ['dependency'], priority: ['dependency'], dep_type: ['dependency'], party: ['dependency'],
  impact_if: ['dependency'], mitigation: ['dependency'], accountable: ['dependency'] };

// Options for a select, keeping a value that isn't in the list so it can't be lost.
const keepOptions = (list, selected, blank = '—') => `<option value="">${blank}</option>`
  + [...list, ...(selected && !list.includes(selected) ? [selected] : [])].map(v => `<option value="${escAttr(v)}" ${v === selected ? 'selected' : ''}>${escAttr(v)}</option>`).join('');

// `preset` fills a new entry: { kind, links }.
function openRaidDialog(r, preset = {}) {
  hideQuick();
  hideTip();
  rdEditing = r;
  rdOpened = r && structuredClone(r);
  const f = document.getElementById('raid-form').elements;
  const kind = r?.kind || preset.kind || raidFilter.kind || 'risk';
  const linkedStream = preset.links?.find(l => l.startsWith('stream:'))?.slice(7) || '';
  const v = r || {
    kind, ref: nextRaidRef(state.workspaceId, kind), title: '', description: '', stream_id: linkedStream, owner: '', status: '', rag: ragOf(state.workspaceId).def,
    priority: '', dep_type: '', likelihood: 'Medium', impact: 'Medium', due: '', raised: fmtISO(new Date()), party: '', response: '', impact_if: '', mitigation: '', accountable: '',
    links: preset.links || [],
  };
  document.getElementById('rd-kind').innerHTML = Object.entries(RAID_KINDS).map(([k, d]) =>
    `<label><input type="radio" name="kind" value="${k}" ${k === v.kind ? 'checked' : ''} /><span>${d.one}</span></label>`).join('');
  f.likelihood.innerHTML = keepOptions(RAID_LEVELS, v.likelihood);
  f.impact.innerHTML = keepOptions(RAID_LEVELS, v.impact);
  const streams = streamsInOrder().filter(Boolean);
  f.stream_id.innerHTML = `<option value="">—</option>` + [...streams, ...(v.stream_id && !streams.includes(v.stream_id) ? [v.stream_id] : [])]
    .map(id => `<option value="${escAttr(id)}" ${id === v.stream_id ? 'selected' : ''}>${escAttr(streamName(id) || '(deleted stream)')}</option>`).join('');
  f.rag.innerHTML = keepOptions(ragOf(state.workspaceId).names, v.rag);
  f.priority.innerHTML = keepOptions(depList(state.workspaceId, 'dep_priorities'), v.priority);
  f.dep_type.innerHTML = keepOptions(depList(state.workspaceId, 'dep_types'), v.dep_type);
  for (const k of RD_FIELDS) if (k !== 'status') f[k].value = v[k] ?? '';
  f.note.value = '';
  rdLinks = [...v.links];
  document.getElementById('rd-delete').hidden = !r;
  document.getElementById('rd-error').textContent = '';
  refreshDatalists();
  updateRdKind(v.status);
  renderRdLinks();
  renderRdNotes();
  document.getElementById('raid-dialog').showModal();
  f.title.focus();
}

const rdKindNow = () => document.querySelector('#rd-kind input:checked')?.value || 'risk';
// The fields only one kind has, its statuses, and the words that change with the kind.
function updateRdKind(status) {
  const kind = rdKindNow(), d = RAID_KINDS[kind];
  const f = document.getElementById('raid-form').elements;
  for (const [k, kinds] of Object.entries(RD_ONLY)) f[k].closest('label').hidden = !kinds.includes(kind);
  // Changing the kind carries the status across: closed stays closed, anything else starts again.
  const was = status ?? f.status.value;
  const kinds = Object.values(RAID_KINDS);
  const keep = d.statuses.includes(was) ? was : kinds.some(x => x.done === was) ? d.done
    : kinds.some(x => x.statuses.includes(was)) || !was ? d.statuses[0] : was;
  f.status.innerHTML = optionList(d.statuses.includes(keep) ? d.statuses : [...d.statuses, keep], keep);
  document.getElementById('rd-badge').textContent = d.one;
  document.getElementById('rd-badge').className = `type-badge raid raid-kind-${kind}`;
  document.getElementById('rd-heading').textContent = rdEditing ? `Edit ${rdEditing.ref || d.one.toLowerCase()}` : `New ${d.one.toLowerCase()}`;
  document.getElementById('rd-response-label').textContent = d.response;
  f.response.placeholder = d.placeholder;
  // A new entry's ref follows its kind until it's typed over.
  if (!rdEditing && /^[RID]\d+$/.test(f.ref.value)) f.ref.value = nextRaidRef(state.workspaceId, kind);
}

// Linked items and streams as chips, and a list to add more: whole streams first, then each
// stream's items.
function renderRdLinks() {
  const streams = streamsInOrder().filter(Boolean);
  const free = (l) => !rdLinks.includes(l);
  const streamOpts = streams.filter(id => free(`stream:${id}`)).map(id => `<option value="stream:${escAttr(id)}">${escAttr(streamName(id))} (whole stream)</option>`).join('');
  const groups = streams.map(id => {
    const items = state.items.filter(m => m.stream_id === id && free(`item:${m.id}`)).sort(cmpRef);
    return items.length ? `<optgroup label="${escAttr(streamName(id))}">${items.map(m => `<option value="item:${m.id}">${escAttr(fullLabel(m))}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const loose = state.items.filter(m => !streamById(m.stream_id) && free(`item:${m.id}`)).sort(cmpRef);
  document.getElementById('rd-links').innerHTML = rdLinks.map(l => linkChip(l, true)).join('') +
    `<select id="rd-addlink" class="add-dep"><option value="">+ link ${escAttr(T.item)} or stream</option>
      ${streamOpts ? `<optgroup label="Streams">${streamOpts}</optgroup>` : ''}${groups}
      ${loose.length ? `<optgroup label="(No stream)">${loose.map(m => `<option value="item:${m.id}">${escAttr(fullLabel(m))}</option>`).join('')}</optgroup>` : ''}
    </select>`;
}

// The notes so far, newest first, under the box for a new one.
function renderRdNotes() {
  const notes = rdEditing ? notesOf(rdEditing) : [];
  document.getElementById('rd-notes').innerHTML = notes.length
    ? notes.map(n => `<li><div class="note-when">${fmtStamp(n.at)}${n.by ? ` · ${escAttr(n.by)}` : ''}</div><div class="note-text">${escAttr(n.text)}</div></li>`).join('')
    : '<li class="muted">No updates yet.</li>';
}

async function submitRaid(e) {
  e.preventDefault();
  const f = document.getElementById('raid-form').elements;
  const err = document.getElementById('rd-error');
  const v = Object.fromEntries(RD_FIELDS.map(k => [k, f[k].value.trim()]));
  v.kind = rdKindNow();
  v.links = [...rdLinks];
  if (!v.title) return (err.textContent = 'Give it a title.');
  if (v.ref && raidOf().some(r => r !== rdEditing && r.ref.toLowerCase() === v.ref.toLowerCase())) return (err.textContent = `${v.ref} is already used in this workspace.`);
  for (const [k, kinds] of Object.entries(RD_ONLY)) if (!kinds.includes(v.kind)) v[k] = '';
  if (rdEditing && !state.raid.includes(rdEditing)) return (err.textContent = 'Someone else has just deleted this.');
  const now = new Date().toISOString();
  const what = RAID_KINDS[v.kind].one;
  let r = rdEditing;
  if (r) Object.assign(r, changedFrom(v, rdOpened), { updated: now });
  else state.raid.push(r = { id: nextRaidId(), workspace_id: state.workspaceId, ...v, created: now, updated: now });
  const note = f.note.value.trim();
  if (note) state.raidNotes.push({ id: nextNoteId(), workspace_id: r.workspace_id, raid_id: r.id, at: now, by: '', text: note });
  document.getElementById('raid-dialog').close();
  rerenderCurrentView();
  const changed = !rdEditing || !same(r, rdOpened);
  await Promise.all([changed && saveRaid(`${what} ${rdEditing ? 'saved' : 'added'}`), note && saveRaidNotes('Status update added')]);
}

async function deleteRaid() {
  const r = rdEditing;
  if (!r) return;
  const snap = snapshotData();
  const hadNotes = state.raidNotes.some(n => n.raid_id === r.id);
  state.raid = state.raid.filter(x => x !== r);
  state.raidNotes = state.raidNotes.filter(n => n.raid_id !== r.id);
  document.getElementById('raid-dialog').close();
  rerenderCurrentView();
  offerUndo(snap, `Deleted ${RAID_KINDS[r.kind].one.toLowerCase()} ${r.ref || r.title}`);
  await Promise.all([saveRaid(`${RAID_KINDS[r.kind].one} deleted`), hadNotes && saveRaidNotes()]);
}

// A line in an item's hover card: what's open against it.
function raidTipLine(m) {
  const open = raidLinkedTo(`item:${m.id}`).filter(r => !isClosed(r));
  if (!open.length) return '';
  const n = Object.entries(RAID_KINDS).map(([k, d]) => { const c = open.filter(r => r.kind === k).length; return c && count(c, d.one.toLowerCase(), d.many.toLowerCase()); }).filter(Boolean);
  const blocked = open.some(r => r.status === 'Blocked');
  const high = open.some(r => raidRating(r).level === 'High');
  const flag = blocked ? ' — one is blocked' : high ? ' — rated high' : '';
  return `<div class="tip-row ${flag ? 'tip-late' : 'tip-muted'}">Open: ${n.join(', ')}${flag}</div>`;
}

/* ---- settings: dependency priorities and types ---- */
// Workspace settings → Dependencies edits the two lists (kept in workspaces.csv, ;-separated;
// blank means the standard lists). Renaming a value renames it on the workspace's dependencies;
// removing one leaves it on any dependency that has it, where it still shows.
const DEP_LIST_KEYS = ['dep_priorities', 'dep_types'];
let pgDepLists = {}; // key → [{ orig (name when the dialog opened, null if new), name }]

function loadPgDepLists(p) {
  for (const key of DEP_LIST_KEYS) pgDepLists[key] = depList(p?.id, key).map(name => ({ orig: p ? name : null, name }));
  renderPgDepLists();
}
const depUsage = (workspaceId, field, name) => state.raid.filter(r => r.workspace_id === workspaceId && r[field] === name).length;
function renderPgDepLists() {
  const field = { dep_priorities: 'priority', dep_types: 'dep_type' };
  for (const key of DEP_LIST_KEYS) {
    const list = pgDepLists[key];
    document.getElementById(`pg-${key}`).innerHTML = list.map((x, i) => {
      const used = pgEditing && x.orig ? depUsage(pgEditing.id, field[key], x.orig) : 0;
      return `<li data-i="${i}">
        <input value="${escAttr(x.name)}" data-dl-name aria-label="Name" />
        <button type="button" class="btn btn-sm btn-ghost" data-dl-move="-1" ${i ? '' : 'disabled'} title="Move up">↑</button>
        <button type="button" class="btn btn-sm btn-ghost" data-dl-move="1" ${i < list.length - 1 ? '' : 'disabled'} title="Move down">↓</button>
        <button type="button" class="btn btn-sm btn-ghost" data-dl-remove title="${used ? `Remove — ${count(used, 'dependency keeps', 'dependencies keep')} it` : 'Remove'}">✕</button>
        ${used ? `<small class="muted">${used} in use</small>` : ''}
      </li>`;
    }).join('');
  }
}
// Check the lists; an error message or null. Then the lists as stored ('' for the standard ones).
function checkPgDepLists() {
  const words = { dep_priorities: 'priority', dep_types: 'dependency type' };
  for (const key of DEP_LIST_KEYS) {
    const list = pgDepLists[key];
    for (const x of list) x.name = x.name.trim().replace(/;/g, ',');
    if (list.some(x => !x.name)) return `Every ${words[key]} needs a name.`;
    const seen = new Set();
    for (const x of list) {
      if (seen.has(x.name.toLowerCase())) return `There are two of “${x.name}” in the ${words[key]} list.`;
      seen.add(x.name.toLowerCase());
    }
  }
  return null;
}
const pgDepListValue = (key) => { const names = pgDepLists[key].map(x => x.name); return !names.length || names.join(';') === DEFAULT_DEP_LISTS[key].join(';') ? '' : names.join(';'); };
// Rename values on the workspace's dependencies to match; true if any changed.
function applyPgDepRenames(workspaceId) {
  const field = { dep_priorities: 'priority', dep_types: 'dep_type' };
  let changed = false;
  for (const key of DEP_LIST_KEYS) {
    for (const x of pgDepLists[key]) {
      if (x.orig == null || x.orig === x.name) continue;
      for (const r of state.raid) if (r.workspace_id === workspaceId && r[field[key]] === x.orig) { r[field[key]] = x.name; changed = true; }
    }
  }
  return changed;
}
function wirePgDepLists() {
  for (const key of DEP_LIST_KEYS) {
    const ul = document.getElementById(`pg-${key}`);
    ul.addEventListener('input', (e) => { if (e.target.matches('[data-dl-name]')) pgDepLists[key][+e.target.closest('li').dataset.i].name = e.target.value; });
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const i = +li.dataset.i, list = pgDepLists[key];
      const mv = e.target.closest('[data-dl-move]');
      if (mv) { const j = i + +mv.dataset.dlMove; [list[i], list[j]] = [list[j], list[i]]; renderPgDepLists(); }
      else if (e.target.closest('[data-dl-remove]')) { list.splice(i, 1); renderPgDepLists(); }
    });
  }
  document.querySelectorAll('[data-dl-add]').forEach(b => {
    b.onclick = () => {
      const list = pgDepLists[b.dataset.dlAdd];
      list.push({ orig: null, name: '' });
      renderPgDepLists();
      document.querySelector(`#pg-${b.dataset.dlAdd} li:last-child input`).focus();
    };
  });
  document.querySelectorAll('[data-dl-reset]').forEach(b => {
    b.onclick = () => {
      const key = b.dataset.dlReset;
      pgDepLists[key] = DEFAULT_DEP_LISTS[key].map(name => ({ orig: pgDepLists[key].some(x => x.orig === name) ? name : null, name }));
      renderPgDepLists();
    };
  });
}

/* ---- Streams tab ---- */
// pgStreams is the list being edited: { id (null for a new one), orig (name when the dialog opened),
// name, lead, used (items, updates and RAID entries pointing at it), deleted, replace (the entry
// what it holds moves to) }. A stream in use is only removed by moving what it holds to another.
let pgStreams = [];

function streamUsage(workspaceId, id) {
  const items = allItems().filter(m => m.workspace_id === workspaceId && m.stream_id === id).length;
  const updates = state.updates.filter(u => u.workspace_id === workspaceId && u.stream_id === id).length;
  const raid = state.raid.filter(r => r.workspace_id === workspaceId && (r.stream_id === id || r.links.includes(`stream:${id}`))).length;
  return { items, updates, raid, total: items + updates + raid };
}
function loadPgStreams(p) {
  pgStreams = (p ? workspaceStreams(p.id) : [])
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map(l => ({ id: l.id, orig: l.name, name: l.name, lead: l.lead, used: streamUsage(p.id, l.id), deleted: false, replace: null }));
  renderPgStreams();
}
function renderPgStreams() {
  const active = pgStreams.filter(x => !x.deleted);
  const usedText = (u) => (u.total ? [u.items && count(u.items, T.item, T.items), u.updates && count(u.updates, 'update', 'updates'), u.raid && `${u.raid} RAID`].filter(Boolean).join(' · ') : '—');
  document.getElementById('pg-streams').innerHTML = pgStreams.map((x, i) => (x.deleted ? `
    <tr class="pg-deleted" data-idx="${i}">
      <td colspan="3" class="pg-deleted-cell"><s>${escAttr(x.orig)}</s> holds ${usedText(x.used)} — move them to
        <select data-sreplace="${i}">${active.map(a => `<option value="${pgStreams.indexOf(a)}" ${a === x.replace ? 'selected' : ''}>${escAttr(a.name || '(unnamed)')}</option>`).join('')}</select></td>
      <td><button type="button" class="link-btn" data-sundo="${i}">Undo</button></td>
    </tr>` : `
    <tr data-idx="${i}">
      <td><input data-sf="name" value="${escAttr(x.name)}" placeholder="Stream name" aria-label="Name" /></td>
      <td><input data-sf="lead" value="${escAttr(x.lead)}" list="owner-list" placeholder="Area lead" aria-label="Area lead" /></td>
      <td class="pg-used-cell">${usedText(x.used)}</td>
      <td><button type="button" class="btn btn-sm btn-ghost" data-sremove="${i}" title="${x.used.total ? 'Remove, moving what it holds to another stream' : 'Remove'}" ${active.length < 2 && x.used.total ? 'disabled' : ''}>✕</button></td>
    </tr>`)).join('') || '<tr><td colspan="4" class="muted">No streams yet — they’re added here or by giving an item one.</td></tr>';
  // a removed stream's things go to the first other stream unless another is chosen
  document.querySelectorAll('#pg-streams [data-sreplace]').forEach(el => {
    const x = pgStreams[+el.dataset.sreplace];
    if (!x.replace || x.replace.deleted) x.replace = active[0] || null;
    el.value = String(pgStreams.indexOf(x.replace));
  });
}
// An error message, or null when the list is sound.
function checkPgStreams() {
  const seen = new Set();
  for (const x of pgStreams) {
    if (x.deleted) { if (x.used.total && (!x.replace || x.replace.deleted)) return `Choose where the things in “${x.orig}” should go.`; continue; }
    x.name = x.name.trim();
    x.lead = x.lead.trim();
    if (!x.name) return 'Every stream needs a name.';
    if (seen.has(x.name.toLowerCase())) return `There are two streams called “${x.name}”.`;
    seen.add(x.name.toLowerCase());
  }
  return null;
}
// Make the edits: renames and leads, new streams, and removed streams' items, updates and links
// moved to the chosen stream. Says which files changed.
function applyPgStreams(workspaceId) {
  const out = { streams: false, items: false, updates: false, raid: false };
  for (const x of pgStreams) {
    if (x.deleted) continue;
    if (!x.id) {
      x.id = nextStreamId();
      state.streams.push({ id: x.id, workspace_id: workspaceId, name: x.name, lead: x.lead, trend: '' });
      out.streams = true;
      continue;
    }
    const l = streamById(x.id);
    if (l && (l.name !== x.name || l.lead !== x.lead)) { l.name = x.name; l.lead = x.lead; out.streams = true; }
  }
  for (const x of pgStreams) {
    if (!x.deleted || !x.id) continue;
    const to = x.used.total ? x.replace.id : '';
    for (const m of allItems()) if (m.workspace_id === workspaceId && m.stream_id === x.id) { m.stream_id = to; out.items = true; }
    for (const u of state.updates) if (u.workspace_id === workspaceId && u.stream_id === x.id) { u.stream_id = to; out.updates = true; }
    for (const r of state.raid) {
      if (r.workspace_id !== workspaceId) continue;
      if (r.stream_id === x.id) { r.stream_id = to; out.raid = true; }
      if (r.links.includes(`stream:${x.id}`)) { r.links = [...new Set(r.links.map(l => (l === `stream:${x.id}` ? `stream:${to}` : l)))]; out.raid = true; }
    }
    state.streams = state.streams.filter(l => l.id !== x.id);
    out.streams = true;
  }
  return out;
}
function wirePgStreams() {
  const body = document.getElementById('pg-streams');
  body.addEventListener('input', (e) => {
    const f = e.target.dataset.sf;
    if (f) pgStreams[+e.target.closest('tr').dataset.idx][f] = e.target.value;
  });
  body.addEventListener('change', (e) => {
    if (e.target.dataset.sreplace != null) pgStreams[+e.target.dataset.sreplace].replace = pgStreams[+e.target.value];
  });
  body.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-sremove]'), un = e.target.closest('[data-sundo]');
    if (rm) {
      const x = pgStreams[+rm.dataset.sremove];
      if (!x.id) pgStreams.splice(pgStreams.indexOf(x), 1); // never saved: just drop it
      else { x.deleted = true; x.replace = null; }
      renderPgStreams();
    } else if (un) { pgStreams[+un.dataset.sundo].deleted = false; renderPgStreams(); }
  });
  document.getElementById('pg-add-stream').onclick = () => {
    pgStreams.push({ id: null, orig: null, name: '', lead: '', used: { items: 0, updates: 0, raid: 0, total: 0 }, deleted: false, replace: null });
    renderPgStreams();
    document.querySelector('#pg-streams tr:last-child input').focus();
  };
}

function wireRaid() {
  document.getElementById('raid-kind').addEventListener('change', (e) => { raidFilter.kind = e.target.value; renderRaid(); });
  document.getElementById('raid-status').onchange = (e) => { raidFilter.status = e.target.value; renderRaid(); };
  document.getElementById('raid-q').oninput = (e) => { raidFilter.q = e.target.value; renderRaid(); };
  document.getElementById('raid-link').addEventListener('click', (e) => { if (e.target.closest('[data-raid-all]')) { raidFilter.link = ''; raidFilter.status = 'open'; renderRaid(); } });
  document.getElementById('btn-raid-add').onclick = () => openRaidDialog(null, { links: raidFilter.link ? [raidFilter.link] : [] });
  document.getElementById('btn-raid-csv').onclick = downloadRaidCSV;
  document.getElementById('raid-body').addEventListener('click', (e) => {
    const go = e.target.closest('[data-raid-go]');
    if (go) return goToLink(go.dataset.raidGo);
    const row = e.target.closest('[data-raid]');
    if (row) openRaidDialog(state.raid.find(r => r.id === row.dataset.raid) || null);
  });
  const dlg = document.getElementById('raid-dialog');
  const form = document.getElementById('raid-form');
  form.addEventListener('submit', submitRaid);
  document.getElementById('rd-kind').addEventListener('change', () => updateRdKind());
  document.getElementById('rd-links').addEventListener('change', (e) => {
    if (e.target.id !== 'rd-addlink' || !e.target.value) return;
    rdLinks.push(e.target.value);
    renderRdLinks();
    document.getElementById('rd-addlink').focus();
  });
  document.getElementById('rd-links').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rdrm]');
    if (!b) return;
    rdLinks = rdLinks.filter(l => l !== b.dataset.rdrm);
    renderRdLinks();
  });
  document.getElementById('rd-cancel').onclick = () => dlg.close();
  document.getElementById('rd-close').onclick = () => dlg.close();
  document.getElementById('rd-delete').onclick = deleteRaid;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  wirePgDepLists();
  wirePgStreams();
  wireDash();
}

/* ---- import (built for SharePoint list exports) ---- */
// Brings risks, issues and dependencies in from a CSV file or pasted cells, as Import does for
// items: each column is matched to a field by its heading (and can be changed), and a preview
// shows what will be added, updated, deleted or skipped before anything is saved. Blank cells
// leave an existing entry's value alone.
//
// It's made for a SharePoint list exported to CSV. SharePoint's own columns (Item Type, Path,
// Created By…) are left out; rich text comes in as plain text; lookup and person values lose their
// ids ("12;#Jane Doe" → "Jane Doe"); a title row above the headings is passed over; and the list's
// ID becomes the ref (R12, I12, D12) when there's no ref column, so importing a later export of
// the same list updates the entries instead of adding them again. Without a ref or ID, an entry
// is matched by its kind and title.
//
// One file can hold every kind (read from a Type column, or a ref like R-12) or just one (chosen
// in the dialog, and guessed from the file name). Values are read generously: likelihood and
// impact from Low/Medium/High, 1–3, 1–5 or 1–10 scores, words like Rare…Almost certain or Minor…
// Severe, or percentages; statuses from the usual SharePoint words (Active, Mitigating, Resolved,
// Delivered…), and a value that can't be placed is kept as it is, with a note. A comments column
// becomes status updates: a cell can hold several, each starting with a date (and who wrote it,
// as Download CSV writes them), and an update that's already on the entry isn't added again. Links
// name items by ref or title, or a stream by name; a risk or issue's stream becomes a link.

const RI_FIELDS = ['kind', 'ref', 'spid', 'title', 'description', 'stream', 'owner', 'status', 'rag', 'priority', 'dep_type', 'likelihood', 'impact',
  'due', 'raised', 'party', 'response', 'impact_if', 'mitigation', 'accountable', 'links', 'notes', 'modified'];
// Several columns can go into these: their text is put together, each under its heading.
const RI_MULTI = ['description', 'response', 'impact_if', 'mitigation', 'links', 'notes'];
const RI_DATES = ['due', 'raised', 'modified'];
const riFieldLabel = (k) => ({
  kind: 'Type (risk, issue or dependency)', ref: 'Ref', spid: 'SharePoint ID (makes the ref if there’s no ref column)', title: 'Title',
  description: 'Description', stream: 'Stream', owner: 'Owner', status: 'Status', rag: 'RAG (dependencies)', priority: 'Priority (dependencies)',
  dep_type: 'Dependency type', likelihood: 'Likelihood (risks)', impact: 'Impact (risks and issues)', due: 'Due date', raised: 'Date raised',
  party: 'Other party (dependencies)', response: 'Mitigation / resolution / next action', impact_if: 'Impact if delayed or blocked (dependencies)',
  mitigation: 'Mitigation (dependencies)', accountable: 'Accountable people (dependencies)', links: `Linked ${T.items} or streams`,
  notes: 'Status updates', modified: 'Last modified (dates updates that have no date)',
}[k]);
// Headings are compared with everything but letters and digits removed; earlier names win.
const RI_ALIASES = {
  kind: ['raidtype', 'raidcategory', 'raid', 'entrytype', 'logtype', 'recordtype', 'type', 'kind', 'category'],
  ref: ['ref', 'reference', 'refno', 'referencenumber', 'raidref', 'raidid', 'riskid', 'issueid', 'dependencyid', 'depid', 'riskref', 'issueref',
    'dependencyref', 'riskno', 'issueno', 'dependencyno', 'riskreference', 'issuereference', 'logid', 'key', 'number', 'no'],
  spid: ['id'],
  title: ['title', 'risktitle', 'issuetitle', 'dependencytitle', 'name', 'riskname', 'issuename', 'dependencyname', 'subject', 'headline',
    'shortdescription', 'summary', 'risk', 'issue', 'dependency'],
  description: ['description', 'riskdescription', 'issuedescription', 'dependencydescription', 'desc', 'details', 'detail', 'fulldescription',
    'longdescription', 'background', 'context', 'cause', 'event', 'effect'],
  stream: ['stream', 'workstream', 'workstreams', 'streamname', 'area', 'team', 'function', 'theme'],
  owner: ['owner', 'riskowner', 'issueowner', 'dependencyowner', 'actionowner', 'assignedto', 'assignee', 'ownedby', 'responsible', 'accountable',
    'lead', 'pointofcontact', 'contact'],
  status: ['status', 'riskstatus', 'issuestatus', 'dependencystatus', 'currentstatus', 'state', 'stage', 'progress'],
  rag: ['rag', 'ragstatus', 'ragrating', 'health', 'rating'],
  priority: ['priority', 'dependencypriority', 'criticality', 'importance', 'urgency'],
  dep_type: ['dependencytype', 'deptype', 'typeofdependency', 'dependencycategory', 'direction', 'dependencydirection', 'inboundoutbound'],
  likelihood: ['likelihood', 'probability', 'likelihoodscore', 'probabilityscore', 'likelihoodrating', 'chance', 'prob'],
  impact: ['impact', 'severity', 'impactscore', 'impactrating', 'impactlevel', 'severityrating', 'consequence', 'consequences', 'seriousness'],
  due: ['due', 'duedate', 'datedue', 'targetdate', 'targetresolutiondate', 'expectedresolutiondate', 'resolutiondate', 'resolveby', 'neededby',
    'needbydate', 'neededbydate', 'requiredby', 'requiredbydate', 'requireddate', 'deadline', 'targetclosuredate'],
  raised: ['raised', 'dateraised', 'raisedon', 'raiseddate', 'dateidentified', 'identifieddate', 'identified', 'dateopened', 'openeddate',
    'datelogged', 'loggeddate', 'datecreated', 'created'],
  party: ['otherparty', 'party', 'dependenton', 'dependentupon', 'dependson', 'provider', 'providedby', 'supplier', 'thirdparty',
    'externalparty', 'counterparty', 'providingteam', 'deliveringteam', 'receivingteam', 'dependentteam'],
  response: ['response', 'mitigation', 'mitigations', 'mitigationplan', 'mitigatingactions', 'mitigationactions', 'mitigationstrategy',
    'responseplan', 'responsestrategy', 'resolution', 'resolutionplan', 'actionplan', 'actions', 'action', 'nextsteps', 'nextaction',
    'nextactions', 'agreement', 'agreementnextaction', 'treatment', 'contingency', 'contingencyplan'],
  impact_if: ['impactifdelayed', 'impactifblocked', 'impactifdelayedblocked', 'impactifdelayedorblocked', 'impactiflate', 'impactofdelay',
    'impactifmissed', 'impactifnotdelivered', 'consequenceofdelay', 'ifdelayed', 'ifblocked', 'delayimpact'],
  mitigation: ['dependencymitigation', 'mitigationifdelayed', 'mitigationifblocked', 'fallback', 'fallbackplan', 'workaround'],
  accountable: ['accountablepeople', 'accountableperson', 'accountablepersons', 'accountableparty', 'accountableparties', 'accountablestakeholders',
    'accountability', 'accountableexec', 'accountableexecutive', 'escalationcontact', 'escalateto'],
  links: ['links', 'linkedto', 'linkeditems', 'linkedmilestones', 'relatedmilestones', 'relatedmilestone', 'affectedmilestones',
    'impactedmilestones', 'relateditems', 'relatedto', 'milestones', 'milestone', 'deliverables', 'deliverable', 'relatedtasks', 'tasks', 'items'],
  notes: ['summarynotes', 'notes', 'comments', 'comment', 'updates', 'update', 'latestupdate', 'statusupdate', 'progressupdate', 'commentary',
    'progressnotes', 'history'],
  modified: ['modified', 'lastmodified', 'datemodified', 'lastupdated', 'updated', 'updatedon'],
};
// SharePoint's own columns, never imported.
const RI_IGNORED = ['itemtype', 'path', 'createdby', 'modifiedby', 'contenttype', 'attachments', 'complianceassetid', 'version', 'appcreatedby',
  'appmodifiedby', 'folderchildcount', 'itemchildcount', 'labelsetting', 'retentionlabel', 'retentionlabelapplied', 'labelappliedby',
  'itemislocked', 'sensitivity', 'edit', 'workspaceid'];
// (SharePoint's internal names write a space as _x0020_.)
const riNorm = (h) => String(h ?? '').replace(/_x([0-9a-f]{4})_/gi, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '');

const rimp = { name: '', rows: [], headerRow: 0, map: [], order: 'auto', mode: 'merge', kind: 'risk', plan: null, detected: null };

/* ---- cells ---- */
// Plain text from a SharePoint cell: rich text (HTML) loses its tags, lookups and people lose
// their ids, and stray invisible characters go.
function riClean(v) {
  let s = String(v ?? '');
  if (/<[a-z!/][^>]*>|&(nbsp|amp|lt|gt|quot|#\d+);/i.test(s)) {
    const doc = new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '• '), 'text/html');
    s = doc.body.textContent || '';
  }
  s = s.replace(/[​‎‏﻿]/g, '').replace(/ /g, ' ').replace(/i:0#\.[a-z]\|membership\|/gi, '');
  if (s.includes(';#')) s = s.split(';#').map(x => x.trim()).filter(x => x && !/^\d+$/.test(x)).join('; ');
  return s.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// risk / issue / dependency, 'other' for the RAID kinds the register doesn't keep (assumptions,
// actions, decisions), '' for a blank cell and null for anything else.
function readRaidKind(v) {
  const s = String(v ?? '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim();
  if (!s) return '';
  if (/^(r|risks?|threats?|opportunit(y|ies))$/.test(s)) return 'risk';
  if (/^(i|issues?|problems?|incidents?)$/.test(s)) return 'issue';
  if (/^(d|deps?|dependenc(y|ies))$/.test(s)) return 'dependency';
  if (/^(a|assumptions?|actions?|decisions?|lessons?( learned| learnt)?|changes?|change requests?)$/.test(s)) return 'other';
  if (/\brisk/.test(s)) return 'risk';
  if (/\bissue/.test(s)) return 'issue';
  if (/\bdepend/.test(s)) return 'dependency';
  if (/\b(assum|action|decision)/.test(s)) return 'other';
  return null;
}
// A ref like R-12, ISS012 or DEP 3 gives the kind away.
const kindFromRef = (ref) => {
  const m = String(ref).match(/^([a-z]+)[-_ ]?\d+$/i);
  if (!m) return '';
  const p = m[1].toLowerCase();
  return /^(r|rsk|risk)$/.test(p) ? 'risk' : /^(i|iss|issue)$/.test(p) ? 'issue' : /^(d|dep|dependency)$/.test(p) ? 'dependency' : '';
};

// Low / Medium / High from words, a score on a scale (the column's largest number tells which:
// 1–3, 1–5 or 1–10), or a percentage. '' for a blank cell, null if it can't be read.
function readLevel(v, scale) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  const w = s.replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (w) {
    if (/^[lmh]$/.test(w)) return { l: 'Low', m: 'Medium', h: 'High' }[w];
    if (/\b(very low|low|minor|negligible|insignificant|minimal|trivial|rare|remote|unlikely|improbable|green)\b/.test(w)) return 'Low';
    if (/\b(medium|med|moderate|possible|possibly|amber|average|mid|normal)\b/.test(w)) return 'Medium';
    if (/\b(very high|high|extreme|catastrophic|critical|severe|major|significant|almost certain|certain|very likely|likely|probable|red)\b/.test(w)) return 'High';
  }
  const m = s.match(/\d+(\.\d+)?/);
  if (!m) return null;
  let n = +m[0];
  if (s.includes('%') || (n > 0 && n < 1)) {
    if (n < 1) n *= 100;
    return n < 34 ? 'Low' : n < 67 ? 'Medium' : 'High';
  }
  const top = Math.max(scale || 0, n);
  if (top <= 3) return ['Low', 'Low', 'Medium', 'High'][Math.round(n)] || 'Low';
  if (top <= 5) return n <= 2 ? 'Low' : n < 4 ? 'Medium' : 'High';
  return n <= 3 ? 'Low' : n <= 7 ? 'Medium' : 'High';
}

// A status in a kind's own words: [status, true] if it could be placed, [the value as written,
// false] if not.
const RI_STATUS_WORDS = {
  closed: /^(closed?|resolved|retired|cancell?ed|completed?|done|archived|reali[sz]ed|occurred|materiali[sz]ed|transferred|superseded|duplicate|withdrawn|rejected|expired|obsolete|no longer (valid|relevant|required|applicable)|not required|mitigated|avoided|eliminated|terminated|finished|fixed|delivered|met|received|fulfill?ed|satisfied|achieved|provided|landed)$/,
  progress: /^(in progress|wip|work in progress|mitigating|being mitigated|under mitigation|active|ongoing|working|assigned|monitoring|monitor|managing|managed|in hand|investigating|under investigation|under review|in review|escalated|on hold|accepted|tolerated|treating|in treatment|started|actioned|tracking|on track|agreed|committed|planned)$/,
  open: /^(open|new|proposed|identified|raised|draft|submitted|not started|pending|logged|live|re ?opened|unassigned|to do|todo|awaiting|candidate|requested)$/,
  blocked: /^(blocked|missed|failed|stuck|halted|stalled)$/,
  atRisk: /^(at risk|amber|red|delayed|late|overdue|off track|slipping|behind|concern|issue|escalated)$/,
};
function readRaidStatus(v, kind) {
  const raw = String(v ?? '').trim();
  const d = RAID_KINDS[kind];
  const exact = d.statuses.find(x => x.toLowerCase() === raw.toLowerCase());
  if (exact) return [exact, true];
  const s = raw.toLowerCase().replace(/^\(?\d+\)?\s*[-.:)]?\s*/, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const W = RI_STATUS_WORDS;
  if (kind === 'dependency') {
    if (W.closed.test(s)) return ['Complete', true];
    if (W.blocked.test(s)) return ['Blocked', true];
    if (W.atRisk.test(s)) return ['At risk', true];
    if (W.open.test(s) || W.progress.test(s) || s === 'green') return ['Not started', true];
  } else {
    if (W.closed.test(s)) return ['Closed', true];
    if (W.progress.test(s) || W.blocked.test(s) || W.atRisk.test(s)) return ['In progress', true];
    if (W.open.test(s)) return ['Open', true];
  }
  return [raw, false];
}

// A value from one of the workspace's dependency lists: exactly, as part of the words ("High
// priority", "External dependency"), or for priorities by number (P1, 1, "(1) High") or the
// usual words for the top and bottom. Null if it can't be placed.
function readFromDepList(v, list, priorities) {
  const raw = String(v ?? '').trim(), s = raw.toLowerCase();
  if (!s) return '';
  const exact = list.find(x => x.toLowerCase() === s);
  if (exact) return exact;
  const words = s.replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const part = words && list.find(x => new RegExp(`\\b${x.toLowerCase().replace(/[^a-z0-9 ]+/g, '')}\\b`).test(words));
  if (part) return part;
  if (!priorities) return null;
  if (/\b(urgent|highest|very high|showstopper|blocker|top)\b/.test(words)) return list[0];
  if (/\b(lowest|very low|minor|trivial)\b/.test(words)) return list.at(-1);
  if (/\b(normal|moderate|med)\b/.test(words)) return list.find(x => /^medium$/i.test(x)) || list[Math.floor(list.length / 2)];
  const n = s.match(/\d+/);
  if (n && +n[0] >= 1) return list[Math.min(+n[0], list.length) - 1];
  return null;
}

// A date and time ("21 Oct 2026, 14:05", "10/21/2026 2:05 PM") as an ISO time stamp, or null.
// A date alone is taken as noon.
function readStamp(raw, order) {
  const s = String(raw ?? '').trim();
  const day = (o) => readDate(s.replace(/,\s*$/, ''), o) || readDate(stripTime(s).replace(/,\s*$/, ''), o);
  const d = day(order) || day(order === 'mdy' ? 'dmy' : 'mdy'); // a stamp that only reads the other way round
  if (!d) return null;
  const t = s.match(/(?:^|[\sT,])(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?\s*(?:z|[+-]\d{2}:?\d{2})?$/i);
  let h = 12, mi = 0;
  if (t) {
    h = +t[1] % (t[3] ? 12 : 24) + (t[3]?.toLowerCase() === 'p' ? 12 : 0);
    mi = +t[2];
  }
  if (/t\d.*z$/i.test(s)) { const z = new Date(s); if (!isNaN(z)) return z.toISOString(); }
  return new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h, mi).toISOString();
}

// The start of a note line: a date (and time), perhaps with who wrote it, then ": " or " - ".
// Download CSV writes "21 Oct 2026, 14:05 (A. Person): text"; others write "[21/10/2026] text",
// "A. Person (21/10/2026 14:05): text" or "21/10/2026 - text".
function noteHead(line, order) {
  for (const m of line.matchAll(/\]\s*|:\s+|\s+[-–]\s+/g)) {
    if (m.index > 70) break;
    let head = line.slice(0, m.index + (m[0].startsWith(']') ? 1 : 0)).trim().replace(/^\[|\]$/g, '').trim();
    const text = line.slice(m.index + m[0].length).trim();
    const tries = [[head, '']];
    const p = head.match(/^(.*?)\s*\(([^()]*)\)$/);
    if (p) tries.push([p[1], p[2]], [p[2], p[1]]);
    const b = head.match(/^(.*?)\s+(?:by|[-–])\s+(.+)$/i);
    if (b) tries.push([b[1], b[2]]);
    for (const [when, by] of tries) {
      if (!/\d/.test(when)) continue;
      const at = readStamp(when, order);
      if (at) return { at, by: by.trim(), text };
    }
  }
  return null;
}
// The notes in a cell, oldest first.
function readNotes(text, order, fallbackAt) {
  const notes = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = noteHead(line, order);
    if (head) notes.push(cur = head);
    else if (cur) cur.text += `\n${line}`;
    else if (line.trim()) notes.push(cur = { at: fallbackAt, by: '', text: line });
  }
  for (const n of notes) n.text = n.text.trim();
  return notes.filter(n => n.text).sort((a, b) => a.at.localeCompare(b.at));
}
const noteKey = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();

// Links: an item by ref, "ref title", title or #id, or a stream by name ("Stream: Design" as
// Download CSV writes it). `loose` also takes a ref followed by anything. Returns the link, or null.
// The id of the workspace's stream the file names, or '' when there's no such stream.
function riStreamId(name) {
  const k = riNorm(name);
  return workspaceStreams().find(l => riNorm(l.name) === k)?.id || '';
}
function resolveRaidLink(tok, loose) {
  const t = tok.trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(item|stream):(.+)$/i))) {
    if (m[1].toLowerCase() === 'item') return itemById(m[2].trim()) ? `item:${m[2].trim()}` : null;
    const n = riStreamId(m[2]);
    return n ? `stream:${n}` : null;
  }
  if ((m = t.match(/^#(\d+)$/))) return itemById(m[1]) ? `item:${m[1]}` : null;
  const k = riNorm(t), low = t.toLowerCase();
  const items = state.items;
  const hit = items.find(x => x.ref && x.ref.toLowerCase() === low) || items.find(x => riNorm(fullLabel(x)) === k)
    || (items.filter(x => riNorm(x.title) === k).length === 1 && items.find(x => riNorm(x.title) === k));
  if (hit) return `item:${hit.id}`;
  const n = riStreamId(t);
  if (n) return `stream:${n}`;
  // "M12 – Build the thing": a ref, then anything.
  const first = loose && t.match(/^(\S+?)[\s:–-]+\S/);
  const byRef = first && items.find(x => x.ref && x.ref.toLowerCase() === first[1].toLowerCase());
  return byRef ? `item:${byRef.id}` : null;
}
// A cell's links: [links, things it couldn't place].
function readRaidLinks(text) {
  const whole = resolveRaidLink(text);
  if (whole) return [[whole], []];
  const found = [], missing = [];
  for (const piece of text.split(/\s*(?:;|\n|\|)\s*/).filter(Boolean)) {
    const one = resolveRaidLink(piece, true);
    if (one) { found.push(one); continue; }
    const parts = piece.split(/\s*,\s*/).filter(Boolean);
    const each = parts.map(x => resolveRaidLink(x, true));
    if (parts.length > 1 && each.every(Boolean)) found.push(...each);
    else missing.push(piece);
  }
  return [found, missing];
}

/* ---- columns ---- */
// The heading row is usually the first, but an export saved from Excel can have a title above it.
function riHeaderRow(rows) {
  const known = new Set(Object.values(RI_ALIASES).flat().concat(RI_IGNORED));
  let best = 0, bestHits = 0;
  rows.slice(0, 6).forEach((r, i) => {
    const hits = r.filter(h => known.has(riNorm(h))).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });
  return bestHits >= 2 ? best : 0;
}

function guessRaidMap(header, data) {
  const norm = header.map(h => riNorm(h));
  const map = norm.map(() => '');
  const values = (i) => data.map(r => riClean(r[i])).filter(Boolean);
  const looksLikeKinds = (i) => { const v = values(i); return v.length > 0 && v.filter(x => readRaidKind(x)).length >= v.length * 0.8; };
  const free = (i) => !map[i] && !RI_IGNORED.includes(norm[i]);
  for (const k of RI_FIELDS) {
    for (const alias of RI_ALIASES[k]) {
      if (!RI_MULTI.includes(k) && map.includes(k)) break;
      norm.forEach((h, i) => {
        if (h !== alias || !free(i) || (!RI_MULTI.includes(k) && map.includes(k))) return;
        // A Type or Category column is the kind only if it holds kinds: otherwise, for a list of
        // dependencies, it's their type.
        if (k === 'kind' && !looksLikeKinds(i)) { if (['type', 'category'].includes(h) && rimp.kind === 'dependency' && !map.includes('dep_type')) map[i] = 'dep_type'; return; }
        map[i] = k;
      });
    }
  }
  // Looser second pass, e.g. "Risk mitigation actions" or "Date of next review".
  const take = (i, k) => { if (RI_MULTI.includes(k) || !map.includes(k)) map[i] = k; };
  norm.forEach((h, i) => {
    if (!free(i)) return;
    if (!map.includes('kind') && looksLikeKinds(i)) map[i] = 'kind';
    else if (/likel|probab/.test(h)) take(i, 'likelihood');
    else if (/impact.*(delay|block|late|miss)|(delay|block).*impact/.test(h)) take(i, 'impact_if');
    else if (/impact|severit|consequen/.test(h)) take(i, 'impact');
    else if (/mitigat|resolution|response|action|nextstep|contingen/.test(h)) take(i, 'response');
    else if (/accountab/.test(h)) take(i, 'accountable');
    else if (/owner|assign/.test(h)) take(i, 'owner');
    else if (/status/.test(h)) take(i, 'status');
    else if (/due|target|needby|neededby|requiredby|deadline/.test(h)) take(i, 'due');
    else if (/raised|identified|logged|opened/.test(h)) take(i, 'raised');
    else if (/comment|note|update/.test(h)) take(i, 'notes');
    else if (/descri|detail/.test(h)) take(i, 'description');
    else if (/milestone|linked|related/.test(h)) take(i, 'links');
    else if (/stream/.test(h)) take(i, 'stream');
    else if (/priorit/.test(h)) take(i, 'priority');
    else if (/title/.test(h)) take(i, 'title');
  });
  return map;
}

/* ---- plan ---- */
// Works out, row by row, what the import will do. Nothing changes until applyRaidImport.
function planRaidImport() {
  const order = rimp.order === 'auto' ? rimp.detected?.found || localDateOrder() : rimp.order;
  const ws = state.workspaceId;
  const data = rimp.rows.slice(rimp.headerRow + 1);
  const header = rimp.rows[rimp.headerRow];
  const cols = (k) => rimp.map.map((x, i) => (x === k ? i : -1)).filter(i => i >= 0);
  const has = (k) => cols(k).length > 0;
  // Likelihood and impact scores share a scale: the largest number in either column.
  const scale = Math.max(0, ...[...cols('likelihood'), ...cols('impact')].flatMap(i => data.map(r => String(r[i] ?? '')))
    .filter(v => !/%/.test(v) && !/[a-z]/i.test(v)).map(v => +(v.match(/\d+(\.\d+)?/)?.[0] ?? 0)));
  const existing = raidOf(ws);
  const rag = ragOf(ws);
  const rows = [], usedTargets = new Set(), refRow = new Map();
  const now = new Date().toISOString();

  data.forEach((r, i) => {
    const line = rimp.headerRow + i + 2;
    if (r.every(v => !String(v).trim())) return;
    const cell = (k) => { const c = cols(k); return c.length ? riClean(r[c[0]]) : ''; };
    // Several columns: each under its heading, when more than one has something.
    const joined = (k) => {
      const parts = cols(k).map(c => [header[c], riClean(r[c])]).filter(([, v]) => v);
      return parts.length > 1 ? parts.map(([h, v]) => `${h}: ${v}`).join('\n\n') : parts[0]?.[1] || '';
    };
    const row = { line, action: 'add', warn: [], fields: {}, target: null, links: [], newNotes: [] };
    rows.push(row);

    // Kind: the Type column, then the ref, then the dialog's choice.
    let ref = cell('ref');
    const kindCell = cell('kind');
    let kind = readRaidKind(kindCell);
    if (kind === 'other') { row.action = 'skip'; row.warn.push(`“${kindCell}” isn't kept in the register (only risks, issues and dependencies are)`); return; }
    if (kind === null) row.warn.push(`Type “${kindCell}” isn't a risk, issue or dependency, so it's taken as ${withArticle(RAID_KINDS[rimp.kind].one.toLowerCase())}`);
    kind = kind || kindFromRef(ref) || rimp.kind;
    const d = RAID_KINDS[kind];
    row.kind = kind;

    // Ref: a ref column; a bare number (SharePoint's ID) gets the kind's letter.
    const spid = cell('spid');
    const madeRef = /^\d+$/.test(ref) || (!ref && /^\d+$/.test(spid));
    if (/^\d+$/.test(ref)) ref = d.prefix + ref;
    else if (!ref && /^\d+$/.test(spid)) ref = d.prefix + spid;
    if (ref && refRow.has(ref.toLowerCase())) {
      row.action = 'skip';
      row.warn.push(`Ref ${ref} is already used on row ${refRow.get(ref.toLowerCase()).line}`);
      return;
    }
    if (ref) refRow.set(ref.toLowerCase(), row);
    row.ref = ref;

    const title = cell('title');
    const byTitle = () => title && existing.find(x => x.kind === kind && noteKey(x.title) === noteKey(title) && !usedTargets.has(x));
    let t = rimp.mode === 'add' ? null : ref ? existing.find(x => x.ref.toLowerCase() === ref.toLowerCase()) : byTitle();
    // A ref made from SharePoint's ID never takes over an entry that's plainly something else
    // (one added in the app, say): the row matches by title instead, or gets a new ref. One that
    // matches nothing can still be an entry first typed in by hand: matched by title.
    if (!t && madeRef && rimp.mode !== 'add') { t = byTitle() || null; if (t) row.ref = ref = t.ref; }
    else if (t && madeRef && title && noteKey(t.title) !== noteKey(title)) {
      t = byTitle() || null;
      if (!t) row.warn.push(`${ref} is already used here by “${existing.find(x => x.ref.toLowerCase() === ref.toLowerCase()).title}”, so this one gets a new ref`);
      row.ref = ref = t ? t.ref : '';
    }
    if (rimp.mode === 'add' && ref && existing.some(x => x.ref.toLowerCase() === ref.toLowerCase())) {
      row.warn.push(`Ref ${ref} is already used in this workspace, so this one gets a new ref`);
      row.ref = ref = '';
    }
    if (t && usedTargets.has(t)) { row.action = 'skip'; row.warn.push(`Matches ${t.ref || t.title}, which an earlier row already updates`); return; }
    if (t) { row.target = t; row.action = 'update'; usedTargets.add(t); }
    if (t && ref && title && noteKey(t.title) !== noteKey(title)) row.warn.push(`Matched to ${t.ref} by its ref, but the titles differ: check it's the same entry`);
    const f = row.fields;
    if (!t || t.kind !== kind) f.kind = kind;
    if (ref && !t) f.ref = ref;

    if (title) f.title = title;
    if (!t && !title) { row.action = 'skip'; row.warn.push('No title'); return; }
    for (const k of ['owner', 'party', 'accountable']) if (cell(k)) f[k] = cell(k);
    for (const k of ['description', 'response', 'impact_if', 'mitigation']) if (joined(k)) f[k] = joined(k);
    // A dependency's Mitigation column is its own field, not its agreement / next action.
    if (kind === 'dependency' && f.response && !has('mitigation') && cols('response').every(c => /mitigat/.test(riNorm(header[c])))) {
      f.mitigation = f.response;
      delete f.response;
    }

    // Stream: a dependency's own field; for a risk or issue, a link to the stream.
    // A stream the workspace doesn't have yet is created when the import is applied (see applyRaidImport).
    const streamRaw = cell('stream');
    if (streamRaw && !riStreamId(streamRaw)) row.warn.push(`Stream “${streamRaw}” isn't one of this workspace's streams yet, so it will be added`);
    if (streamRaw && kind === 'dependency') f.stream_id = riStreamId(streamRaw) || `new:${streamRaw}`;
    else if (streamRaw) row.links.push(riStreamId(streamRaw) ? `stream:${riStreamId(streamRaw)}` : `stream:new:${streamRaw}`);

    // Status: in the kind's own words. Blank keeps what's there (carried across a change of kind).
    const st = cell('status');
    if (st) {
      const [s, ok] = readRaidStatus(st, kind);
      f.status = s;
      if (!ok) row.warn.push(`Status “${st}” isn't one of ${d.statuses.join(', ')}, so it's kept as it is`);
    } else if (!t) f.status = d.statuses[0];
    else if (t.kind !== kind) {
      const kinds = Object.values(RAID_KINDS);
      f.status = d.statuses.includes(t.status) ? t.status : kinds.some(x => x.done === t.status) ? d.done : d.statuses[0];
    }

    if (kind === 'dependency') {
      const v = cell('rag');
      if (v) {
        const n = normaliseStatus(v, ws);
        if (rag.names.includes(n)) f.rag = n;
        else row.warn.push(`RAG “${v}” isn't one of this workspace's options, so ${t?.rag ? 'it stays' : 'it starts at'} ${t?.rag || rag.def}`);
      }
      if (!t?.rag && !f.rag) f.rag = rag.def;
      for (const [k, key, word] of [['priority', 'dep_priorities', 'priority'], ['dep_type', 'dep_types', 'dependency type']]) {
        const v = cell(k);
        if (!v) continue;
        const x = readFromDepList(v, depList(ws, key), k === 'priority');
        f[k] = x || v;
        if (!x) row.warn.push(`“${v}” isn't one of this workspace's ${word === 'priority' ? 'priorities' : 'dependency types'}, so it's kept as it is`);
      }
    }
    const levels = kind === 'risk' ? ['likelihood', 'impact'] : kind === 'issue' ? ['impact'] : [];
    for (const k of levels) {
      const v = cell(k);
      const x = readLevel(v, scale);
      if (x) f[k] = x;
      else if (x === null) row.warn.push(`Couldn't read ${k} “${v}” as low, medium or high`);
    }

    for (const k of ['due', 'raised']) {
      const v = cell(k);
      const x = readDate(v, order);
      if (x) f[k] = x;
      else if (x === null) row.warn.push(`Couldn't read the date “${v}”`);
    }

    // Links: added to the ones already there.
    for (const c of cols('links')) {
      const v = riClean(r[c]);
      if (!v) continue;
      const [found, missing] = readRaidLinks(v);
      row.links.push(...found);
      if (missing.length) row.warn.push(`Linked to ${missing.map(x => `“${x}”`).join(', ')}, not found in this workspace`);
    }
    row.links = [...new Set(row.links)].filter(l => !t?.links.includes(l));

    // Notes: only the ones not already on the entry.
    const modified = readStamp(cell('modified'), order) || now;
    const seen = new Set((t ? notesOf(t) : []).map(n => noteKey(n.text)));
    for (const c of cols('notes')) {
      const v = riClean(r[c]);
      if (!v) continue;
      for (const n of readNotes(v, order, modified)) {
        if (seen.has(noteKey(n.text))) continue;
        seen.add(noteKey(n.text));
        row.newNotes.push(n);
      }
    }

    // Fields the kind doesn't have are cleared, as the dialog does.
    for (const [k, kinds] of Object.entries(RD_ONLY)) if (!kinds.includes(kind)) { if (t?.[k]) f[k] = ''; else delete f[k]; }
    if (t) for (const k of Object.keys(f)) if (f[k] === (t[k] ?? '')) delete f[k];
    if (t && !Object.keys(f).length && !row.links.length && !row.newNotes.length) row.action = 'same';
  });

  // Refs for new entries that have none: the next free of their kind.
  const next = {};
  for (const r of rows) {
    if (r.action !== 'add' || r.ref) continue;
    const pre = RAID_KINDS[r.kind].prefix;
    if (!(pre in next)) {
      const nums = [...existing.map(x => x.ref), ...rows.map(x => x.ref || '')].map(x => x.match(new RegExp(`^${pre}-?(\\d+)$`, 'i'))?.[1]).filter(Boolean).map(Number);
      next[pre] = Math.max(0, ...nums) + 1;
    }
    r.ref = r.fields.ref = `${pre}${next[pre]++}`;
  }

  // Replace: entries of the kinds the file brings in, and not in it, are deleted.
  const kinds = new Set(rows.filter(r => r.action !== 'skip').map(r => r.kind));
  const deletes = rimp.mode === 'replace' ? existing.filter(x => kinds.has(x.kind) && !usedTargets.has(x)) : [];
  return { rows, deletes, order };
}

async function applyRaidImport() {
  const plan = planRaidImport();
  const snap = snapshotData();
  const now = new Date().toISOString();
  let added = 0, updated = 0, notes = 0;
  const gone = new Set(plan.deletes.map(r => r.id));
  state.raid = state.raid.filter(r => !gone.has(r.id));
  const hadNotes = state.raidNotes.some(n => gone.has(n.raid_id));
  state.raidNotes = state.raidNotes.filter(n => !gone.has(n.raid_id));
  for (const row of plan.rows) {
    if (row.action === 'skip' || row.action === 'same') continue;
    let r = row.target;
    if (r && !state.raid.includes(r)) continue; // deleted by someone else meanwhile
    if (!r) {
      r = {
        id: nextRaidId(), workspace_id: state.workspaceId, kind: row.kind, ref: '', title: '', description: '', stream_id: '', owner: '', status: '',
        rag: '', priority: '', dep_type: '', likelihood: '', impact: '', due: '', raised: '', party: '', response: '', impact_if: '', mitigation: '', accountable: '',
        links: [], created: now, updated: now,
      };
      state.raid.push(r);
      added++;
    } else if (Object.keys(row.fields).length || row.links.length) updated++;
    // streams named in the file that the workspace didn't have yet
    const fresh = (v) => (v.startsWith('new:') ? streamIdFor(state.workspaceId, v.slice(4)) : v);
    if (row.fields.stream_id) row.fields.stream_id = fresh(row.fields.stream_id);
    row.links = row.links.map(l => (l.startsWith('stream:') ? `stream:${fresh(l.slice(7))}` : l));
    Object.assign(r, row.fields);
    if (row.links.length) r.links = [...new Set([...r.links, ...row.links])];
    if (row.target && (Object.keys(row.fields).length || row.links.length)) r.updated = now;
    for (const n of row.newNotes) {
      state.raidNotes.push({ id: nextNoteId(), workspace_id: r.workspace_id, raid_id: r.id, at: n.at, by: n.by, text: n.text });
      notes++;
    }
  }
  document.getElementById('raid-import-dialog').close();
  rerenderCurrentView();
  const parts = [added && `${added} added`, updated && `${updated} updated`, plan.deletes.length && `${plan.deletes.length} deleted`,
    notes && count(notes, 'note', 'notes')].filter(Boolean);
  const label = `Imported: ${parts.join(', ') || 'nothing changed'}`;
  if (parts.length) offerUndo(snap, label);
  await Promise.all([(added || updated || plan.deletes.length) && saveRaid(label), (notes || hadNotes) && saveRaidNotes(label)]);
}

// Which way round the file writes numeric dates: the way most dates that only read one way
// read. A date that reads neither way (13/40/2026) doesn't count.
function riDateOrder(values) {
  let dmy = 0, mdy = 0, ambiguous = false;
  for (const v of values) {
    const m = stripTime(v).match(NUMERIC_DATE);
    if (!m) continue;
    const y = fullYear(m[3]), d = ymd(y, +m[2], +m[1]), md = ymd(y, +m[1], +m[2]);
    if (d && !md) dmy++;
    else if (md && !d) mdy++;
    else if (d && m[1] !== m[2]) ambiguous = true;
  }
  return { found: dmy > mdy ? 'dmy' : mdy > dmy ? 'mdy' : null, ambiguous, conflict: dmy > 0 && mdy > 0 };
}

/* ---- dialog ---- */
function openRaidImport() {
  document.getElementById('ri-workspace').textContent = currentWorkspace().name;
  document.getElementById('ri-paste').value = '';
  document.getElementById('ri-file').value = '';
  showRaidImportStep('source');
  document.getElementById('raid-import-dialog').showModal();
}

function showRaidImportStep(step) {
  document.getElementById('ri-step-source').hidden = step !== 'source';
  document.getElementById('ri-step-map').hidden = step !== 'map';
  document.getElementById('ri-error').textContent = '';
  document.getElementById('ri-submit').disabled = step !== 'map';
}

function loadRaidImportText(text, name) {
  const rows = parseAny(text.replace(/\u0000/g, '').replace(/^﻿?sep=.\r?\n/i, '')).map(r => r.map(v => v.trim()));
  const err = document.getElementById('ri-error');
  const headerRow = riHeaderRow(rows);
  if (rows.length - headerRow < 2) return (err.textContent = rows.length ? 'Only the headings were found: include at least one row under them.' : 'Nothing to import.');
  // One kind per file unless it says otherwise: the file name (Risks.csv, Issue log.csv…) or the current filter.
  const n = name.toLowerCase();
  const kind = /depend/.test(n) ? 'dependency' : /issue/.test(n) ? 'issue' : /risk/.test(n) ? 'risk' : raidFilter.kind || 'risk';
  Object.assign(rimp, { name, rows, headerRow, order: 'auto', mode: 'merge', kind });
  rimp.map = guessRaidMap(rows[headerRow], rows.slice(headerRow + 1));
  document.querySelector('[name="ri-mode"][value="merge"]').checked = true;
  showRaidImportStep('map');
  renderRaidImport();
}

async function readRaidImportFile(file) {
  const text = await readTextFile(file, document.getElementById('ri-error'));
  if (text != null) loadRaidImportText(text, file.name);
}

function renderRaidImport() {
  const header = rimp.rows[rimp.headerRow];
  const data = rimp.rows.slice(rimp.headerRow + 1);
  const width = Math.max(...rimp.rows.map(r => r.length));
  const heads = Array.from({ length: width }, (_, i) => header[i] || `Column ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`);
  while (rimp.map.length < width) rimp.map.push('');

  const dateCols = rimp.map.map((k, i) => (RI_DATES.includes(k) ? i : -1)).filter(i => i >= 0);
  rimp.detected = riDateOrder(dateCols.flatMap(i => data.map(r => r[i] ?? '')));
  const d = rimp.detected, local = localDateOrder();
  const label = { dmy: 'day first (3 April 2026)', mdy: 'month first (4 March 2026)' };
  document.getElementById('ri-order').innerHTML = [
    ['auto', d.found ? `Detected: ${label[d.found]}` : `Automatic: ${label[local]}`], ['dmy', 'Day first: 03/04 is 3 April'], ['mdy', 'Month first: 03/04 is 4 March'],
  ].map(([v, t]) => `<option value="${v}" ${v === rimp.order ? 'selected' : ''}>${t}</option>`).join('');
  const hasKind = rimp.map.includes('kind');
  document.getElementById('ri-kind-label').firstChild.textContent = hasKind ? 'Rows with no type are' : 'Every row is';
  document.getElementById('ri-kind').innerHTML = Object.entries(RAID_KINDS).map(([k, x]) =>
    `<option value="${k}" ${k === rimp.kind ? 'selected' : ''}>${hasKind ? x.many.toLowerCase() : `${withArticle(x.one.toLowerCase())}`}</option>`).join('');
  document.getElementById('ri-source-name').textContent = `${rimp.name} · ${count(data.length, 'row', 'rows')}${rimp.headerRow ? ` · headings on row ${rimp.headerRow + 1}` : ''}`;

  const plan = rimp.plan = planRaidImport();
  const opts = (sel) => `<option value="">— don't import —</option>` +
    RI_FIELDS.map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${escAttr(riFieldLabel(k))}</option>`).join('');
  document.getElementById('ri-cols').innerHTML = heads.map((h, i) => {
    const samples = [...new Set(data.map(r => riClean(r[i]).replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 3);
    const k = rimp.map[i];
    const ex = samples.map(v => {
      const short = v.length > 60 ? `${v.slice(0, 60)}…` : v;
      if (!RI_DATES.includes(k)) return escAttr(short);
      const iso = readDate(v, plan.order);
      return iso ? `${escAttr(short)} <span class="im-date">→ ${fmtNice(iso)}</span>` : `${escAttr(short)} <span class="im-bad">→ can't read</span>`;
    }).join(' · ');
    const sp = RI_IGNORED.includes(riNorm(h)) && !k ? ' <small class="muted">(SharePoint)</small>' : '';
    return `<tr><td>${escAttr(h)}${sp}</td><td title="${escAttr(samples.join(' · '))}">${ex || '<span class="im-bad">empty</span>'}</td>
      <td><select data-col="${i}" class="${k ? '' : 'unmapped'}">${opts(k)}</select></td></tr>`;
  }).join('');

  // Preview
  document.getElementById('ri-preview-head').innerHTML = `<tr><th>Row</th><th></th><th>Ref</th><th>Type</th><th>Title</th><th>Owner</th><th>Status</th>
    <th>Rating</th><th>Due</th><th>Links</th><th>Notes</th><th>Check</th></tr>`;
  const actLabel = { add: 'Add', update: 'Update', same: 'No change', skip: 'Skip', delete: 'Delete' };
  const preview = (row) => {
    const t = row.target;
    const v = { ...(t || {}), ...row.fields, kind: row.kind || t?.kind };
    v.links = [...(t?.links || []), ...row.links];
    const c = (k, html) => `<td class="${k === 'title' ? 'im-title' : ''} ${t && k in row.fields ? 'changed' : ''}">${html}</td>`;
    const rt = v.kind ? raidRating({ ...v, workspace_id: state.workspaceId }) : { label: '' };
    const links = v.links.map(l => linkInfo(l).label);
    return `<tr class="${row.action}"><td>${row.line}</td><td><span class="im-act ${row.action === 'same' ? 'skip' : row.action}">${actLabel[row.action]}</span></td>
      ${c('ref', escAttr(v.ref || row.ref || ''))}${c('kind', v.kind ? RAID_KINDS[v.kind].one : '')}${c('title', escAttr(v.title || ''))}
      ${c('owner', escAttr(v.owner || ''))}${c('status', escAttr(v.status || ''))}
      <td class="${t && ['likelihood', 'impact', 'priority'].some(k => k in row.fields) ? 'changed' : ''}">${escAttr(rt.label)}</td>
      ${c('due', v.due ? fmtNice(v.due) : '')}
      <td class="${row.links.length && t ? 'changed' : ''}" title="${escAttr(links.join('\n'))}">${escAttr(links.length > 2 ? `${links.slice(0, 2).join(', ')} +${links.length - 2}` : links.join(', '))}</td>
      <td class="${row.newNotes.length && t ? 'changed' : ''}" title="${escAttr(row.newNotes.map(n => `${fmtStamp(n.at)}${n.by ? ` (${n.by})` : ''}: ${n.text}`).join('\n'))}">${row.newNotes.length ? `+${row.newNotes.length}` : ''}</td>
      <td class="im-notes">${escAttr(row.warn.join('. '))}</td></tr>`;
  };
  document.getElementById('ri-preview').innerHTML = plan.rows.map(preview).join('')
    + plan.deletes.map(r => `<tr class="delete"><td></td><td><span class="im-act delete">Delete</span></td><td>${escAttr(r.ref)}</td><td>${RAID_KINDS[r.kind].one}</td>
      <td class="im-title">${escAttr(r.title)}</td><td>${escAttr(r.owner)}</td><td>${escAttr(r.status)}</td><td>${escAttr(raidRating(r).label)}</td>
      <td>${r.due ? fmtNice(r.due) : ''}</td><td></td><td></td><td class="im-notes">Not in the file${notesOf(r).length ? `; its ${count(notesOf(r).length, 'note goes', 'notes go')} too` : ''}</td></tr>`).join('');

  const n = (a) => plan.rows.filter(r => r.action === a).length;
  const noteN = plan.rows.reduce((s, r) => s + (r.action === 'skip' ? 0 : r.newNotes.length), 0);
  const warned = plan.rows.filter(r => r.action !== 'skip' && r.warn.length).length;
  const byKind = Object.entries(RAID_KINDS).map(([k, x]) => { const c = plan.rows.filter(r => r.action !== 'skip' && r.kind === k).length; return c && count(c, x.one.toLowerCase(), x.many.toLowerCase()); }).filter(Boolean);
  document.getElementById('ri-summary').textContent = [byKind.join(', '), n('add') && `${n('add')} to add`, n('update') && `${n('update')} to update`,
    n('same') && `${n('same')} unchanged`, plan.deletes.length && `${plan.deletes.length} to delete`, noteN && `${count(noteN, 'note', 'notes')} to add`,
    n('skip') && `${n('skip')} skipped`, warned && `${count(warned, 'row has', 'rows have')} something to check`].filter(Boolean).join(' · ');
  const btn = document.getElementById('ri-submit');
  const does = [n('add') && `add ${n('add')}`, n('update') && `update ${n('update')}`, plan.deletes.length && `delete ${plan.deletes.length}`,
    !n('add') && !n('update') && noteN && `add ${count(noteN, 'note', 'notes')}`].filter(Boolean);
  btn.disabled = !does.length;
  btn.textContent = does.length ? `Import: ${does.join(', ')}` : 'Import';
  document.getElementById('ri-error').textContent = d.conflict
    ? 'Some dates are written day first and others month first: check the dates in the preview.'
    : !rimp.map.includes('title') ? 'No column is imported as the title, so only existing entries (matched by ref) can be updated.' : '';
}

function wireRaidImport() {
  const dlg = document.getElementById('raid-import-dialog');
  const close = () => dlg.close();
  document.getElementById('btn-raid-import').onclick = openRaidImport;
  document.getElementById('ri-close').onclick = close;
  document.getElementById('ri-cancel').onclick = close;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.getElementById('ri-change').onclick = () => { document.getElementById('ri-file').value = ''; showRaidImportStep('source'); };
  document.getElementById('ri-file').addEventListener('change', (e) => { if (e.target.files[0]) readRaidImportFile(e.target.files[0]); });
  const drop = document.getElementById('ri-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readRaidImportFile(e.dataTransfer.files[0]);
  });
  document.getElementById('ri-paste').addEventListener('paste', () => {
    setTimeout(() => { const t = document.getElementById('ri-paste').value; if (t.trim()) loadRaidImportText(t, 'Pasted rows'); }, 0);
  });
  document.getElementById('ri-order').onchange = (e) => { rimp.order = e.target.value; renderRaidImport(); };
  document.getElementById('ri-kind').onchange = (e) => { rimp.kind = e.target.value; renderRaidImport(); };
  document.getElementById('ri-mode').addEventListener('change', (e) => { rimp.mode = e.target.value; renderRaidImport(); });
  document.getElementById('ri-cols').addEventListener('change', (e) => {
    const i = +e.target.dataset.col, k = e.target.value;
    if (k && !RI_MULTI.includes(k)) rimp.map = rimp.map.map(x => (x === k ? '' : x)); // one column per field, except those that join
    rimp.map[i] = k;
    renderRaidImport();
  });
  document.getElementById('raid-import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyRaidImport();
  });
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
  const link = (m) => `<button type="button" class="link-btn ch-open" data-ch-item="${m.id}" title="Show it on the plan">${lbl(m)}</button>`;
  const when = (m) => (isTask(m) ? `${fmtShort(m.start)} – ${fmtNice(m.end)}` : fmtNice(m.end));
  const section = (title, rows, empty) => `
    <section class="ch-sec">
      <h3>${title} <span class="muted">${rows.length || ''}</span></h3>
      ${rows.length ? `<ul>${rows.join('')}</ul>` : `<p class="muted">${empty}</p>`}
    </section>`;
  if (!n && !reports.length) {
    body.innerHTML = `<p class="due-empty">Nothing has changed since the start of ${fmtNice(chSince)}: no RAG changes, no dates moved, no ${escAttr(T.items)} added or removed and no reports written.</p>`;
    return;
  }
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

// Open the Gantt chart on one item: clear filters that hide it, unfold its stream, scroll to it
// and give it the keyboard focus (its chain lit and its card showing).
function showItemOnGantt(id) {
  const m = itemById(id);
  if (!m) return;
  switchView('gantt');
  if (!ganttMatches(m)) clearGanttFilters();
  if (collapsedStreams().has(m.stream_id)) toggleStream(m.stream_id, false);
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
      <td>${live ? `<button type="button" class="link-btn ch-open" data-ch-item="${g.item_id}" title="Show it on the plan">${lbl}</button>` : `<span class="dl-gone" title="No longer in this workspace">${lbl}</span>`}</td>
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
// One box to jump anywhere: any item in any workspace (by ref, title, owner or stream), a
// workspace, or a page. Every word typed has to match; refs and the starts of titles rank first.

let palHits = [], palSel = 0;

function palPages() {
  const ws = currentWorkspace();
  return [
    ['overview', 'Portfolio'], ['workspaces', 'Portfolio · cards'], ['dash', `Dashboard · ${ws.name}`], ['gantt', `Plan · ${ws.name}`],
    ['editor', `${T.Items} · ${ws.name}`], ['reports', `Reports · ${ws.name}`], ['due', `Reports due · ${ws.name}`], ['weekly', `Weekly updates · ${ws.name}`],
    ['raid', `Risks & issues · ${ws.name}`],
    ['changes', `What changed · ${ws.name}`], ['dates', `Date log · ${ws.name}`], ['streams', `Streams · ${ws.name}`],
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
    const s = score(m.ref, m.title, [m.ref, m.title, m.owner, streamName(m.stream_id), m.substream, p?.code, p?.name].join(' ').toLowerCase());
    if (s >= 0) hits.push({ kind: 'item', m, p, s });
  }
  for (const r of state.raid) {
    const p = workspaceById(r.workspace_id);
    const s = score(r.ref, r.title, [r.ref, r.title, r.owner, RAID_KINDS[r.kind].one, p?.code, p?.name].join(' ').toLowerCase());
    if (s >= 0) hits.push({ kind: 'raid', r, p, s: s + 0.25 });
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
      sub = `${statusPill(h.m.status, rg.map)} <span>${escAttr([h.p.code || h.p.name, streamName(h.m.stream_id), h.m.owner].filter(Boolean).join(' · '))}</span>`;
    } else if (h.kind === 'raid') {
      main = `${h.r.ref ? `<b class="ref">${escAttr(h.r.ref)}</b> ` : ''}${escAttr(h.r.title)}`;
      sub = `<span>${escAttr([RAID_KINDS[h.r.kind].one, h.r.status, h.p.code || h.p.name, h.r.owner].filter(Boolean).join(' · '))}</span>`;
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
    if (h.view === 'due' || h.view === 'weekly') { rptMode = h.view; return switchView('reports'); }
    if (h.view === 'reports') rptMode = 'all';
    return switchView(h.view);
  }
  if (h.kind === 'ws') return switchWorkspace(h.p.id, 'dash');
  if (h.kind === 'raid') {
    if (h.p.id !== state.workspaceId) await switchWorkspace(h.p.id, 'raid');
    else switchView('raid');
    return openRaidDialog(h.r);
  }
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
// #/ws/3/gantt?stream=Delivery&rag=Red,Amber&late=1. #…&item=12 opens the chart on item 12.

let routeReady = false; // until the first view is shown, nothing is written over the address
let lastHash = '';

// The address uses the page names people see; the names the pages had before still work.
const ROUTE_NAMES = { overview: 'portfolio', workspaces: 'workspaces', editor: 'items' };
const ROUTE_VIEWS = Object.fromEntries(Object.entries(ROUTE_NAMES).map(([v, n]) => [n, v]));
function readHash() {
  const m = location.hash.match(/^#\/(?:ws\/([^/?]+)\/)?(\w+)(?:\?(.*))?$/);
  if (m) m[2] = ROUTE_VIEWS[m[2]] || m[2];
  if (!m || !VIEWS.includes(m[2])) return null;
  const q = new URLSearchParams(m[3] || '');
  const filter = {};
  for (const k of ['q', 'owner']) if (q.has(k)) filter[k] = q.get(k);
  if (q.has('stream')) filter.streamName = q.get('stream'); // by name, for readable links; matched once the workspace is known
  if (TYPES.includes(q.get('type'))) filter.type = q.get('type');
  if (q.get('rag')) filter.rag = q.get('rag').split(',').filter(Boolean);
  if (q.get('late') === '1') filter.late = true;
  return { ws: m[1] ? decodeURIComponent(m[1]) : '', view: m[2], filter: m[2] === 'gantt' && Object.keys(filter).length ? filter : null, item: q.get('item') || '' };
}

function writeHash() {
  if (!routeReady) return;
  const view = currentView();
  const name = ROUTE_NAMES[view] || view;
  let h = APP_VIEWS.includes(view) ? `#/${name}` : `#/ws/${encodeURIComponent(state.workspaceId)}/${name}`;
  if (view === 'gantt') {
    const f = ganttFilter, q = new URLSearchParams();
    if (f.q.trim()) q.set('q', f.q.trim());
    if (f.stream) q.set('stream', streamName(f.stream) || f.stream);
    if (f.owner) q.set('owner', f.owner);
    if (f.type) q.set('type', f.type);
    if (f.rag.length) q.set('rag', f.rag.join(','));
    if (f.late) q.set('late', '1');
    if (q.toString()) h += `?${q}`;
  }
  lastHash = h; // remembered even when the address already says so, or the next typed address could be mistaken for ours
  if (h === location.hash) return;
  history.replaceState(null, '', h);
}

// An address typed or pasted into this tab.
async function followHash() {
  const link = readHash();
  if (!link) return;
  if (link.ws && link.ws !== state.workspaceId && workspaceById(link.ws)) await switchWorkspace(link.ws, link.view);
  if (link.view === 'gantt') {
    clearGanttFilters();
    const { streamName: name, ...filter } = link.filter || {};
    Object.assign(ganttFilter, filter);
    if (name) ganttFilter.stream = streamIdFor(state.workspaceId, name, false) || name;
  }
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

const PNG_TARGETS = { overview: 'overview-table', streams: 'streams-table', changes: 'ch-body', dash: 'dash-grid' };

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
    const box = view === 'changes' || view === 'dash' ? src : src.closest('.table-wrap');
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

const VIEWS = ['overview', 'workspaces', 'dash', 'gantt', 'editor', 'reports', 'raid', 'changes', 'dates', 'streams'];
const APP_VIEWS = ['overview', 'workspaces']; // views across every workspace
const isShown = (view) => !document.getElementById(`view-${view}`).classList.contains('hidden');
const currentView = () => VIEWS.find(isShown) || 'gantt';

function switchView(view) {
  if (view === 'reports' && reportsOff()) view = 'dash';
  if (view !== 'reports' && isShown('reports') && !leavePaneEdit()) return;
  hideQuick();
  if (document.getElementById('palette').open) document.getElementById('palette').close();
  if (view !== 'editor') {
    syncEditorToState();
    // Clear the hidden table so a later sync can't overwrite edits made elsewhere.
    document.getElementById('editor-body').innerHTML = '';
  }
  if (view === 'gantt') renderGantt();
  else if (view === 'dash') renderDash();
  else if (view === 'editor') renderEditor();
  else if (view === 'reports') renderReports();
  else if (view === 'overview') renderOverview();
  else if (view === 'streams') renderStreamOverview();
  else if (view === 'changes') renderChanges();
  else if (view === 'dates') renderDates();
  else if (view === 'raid') renderRaid();
  else renderWorkspaces();
  for (const v of VIEWS) document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.nav-item[data-view]').forEach(b => {
    const on = b.dataset.view.split(' ').includes(view);
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('input[name^="pf-mode"]').forEach(r => { r.checked = r.value === view; });
  document.getElementById('app-main').scrollTop = 0;
  showHelp(false);
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
// The menu can also be hidden altogether; a Menu button in the page header brings it back.
function setNavHidden(hidden) {
  document.body.classList.toggle('nav-hidden', hidden);
  document.getElementById('nav-show').hidden = !hidden;
  saveAppPrefs({ navHidden: hidden });
  if (state.rangeStart && isShown('gantt')) renderGantt(); // the chart takes the width freed up
}

// The ? beside the page title opens a short note on what the page is for. Each page keeps its
// note in a hidden .help block (so the workspace's own terms apply to it); the one not marked
// help-off is shown.
function showHelp(open) {
  const pop = document.getElementById('page-help');
  const btn = document.getElementById('page-help-btn');
  if (open) pop.innerHTML = document.querySelector(`#view-${currentView()} .help:not(.help-off)`)?.innerHTML || '<p>No notes for this page.</p>';
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', open);
}
function wireHelp() {
  const btn = document.getElementById('page-help-btn');
  const pop = document.getElementById('page-help');
  btn.onclick = () => showHelp(pop.hidden);
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) showHelp(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) showHelp(false); });
}

function wireEvents() {
  wireHelp();
  document.querySelectorAll('.nav-item[data-view]').forEach(b => { b.onclick = () => switchView(b.dataset.view.split(' ')[0]); });
  document.querySelectorAll('input[name^="pf-mode"]').forEach(r => r.addEventListener('change', () => switchView(r.value)));
  document.getElementById('nav-collapse').onclick = () => setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
  document.querySelector('.workspace-pick').addEventListener('click', (e) => { // collapsed, the workspace mark opens the menu to switch
    if (!document.body.classList.contains('nav-collapsed') || e.target.closest('.ws-gear')) return;
    setNavCollapsed(false);
    document.getElementById('workspace-select').focus();
  });
  document.getElementById('nav-hide').onclick = () => setNavHidden(true);
  document.getElementById('nav-show').onclick = () => setNavHidden(false);
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
  wireRaid();
  wireRaidImport();

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
  document.getElementById('range-auto').onclick = fitRange;
  document.getElementById('g-outside').onclick = (e) => { if (e.target.closest('[data-act="fit"]')) fitRange(); };

  document.getElementById('toggle-months').onchange = (e) => { state.showMonths = e.target.checked; renderGantt(); };
  document.getElementById('toggle-quarters').onchange = (e) => { state.showQuarters = e.target.checked; renderGantt(); };
  document.getElementById('toggle-today').onchange = (e) => { state.showToday = e.target.checked; renderGantt(); };
  document.getElementById('link-mode').onchange = (e) => { state.linkMode = e.target.value; saveAppPrefs({ linkMode: state.linkMode }); renderGantt(); };
  document.getElementById('toggle-baseline').onchange = (e) => { state.showBaseline = e.target.checked; saveAppPrefs({ showBaseline: state.showBaseline }); renderGantt(); };
  document.getElementById('fold-all').onclick = () => foldAllStreams(true);
  document.getElementById('unfold-all').onclick = () => foldAllStreams(false);
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
    if (!m || collapsedStreams().has(m.stream_id)) return;
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
    gc.style.cursor = m && !collapsedStreams().has(m.stream_id) && dragModeAt(g, m, e.clientX) !== 'move' ? 'ew-resize' : '';
  });
  gc.tabIndex = 0;
  gc.setAttribute('aria-label', 'Chart: use the arrow keys to move between items and Enter to update one');
  gc.addEventListener('keydown', ganttKeyNav);
  gc.addEventListener('focusout', (e) => { if (!gc.contains(e.relatedTarget) && kbId && !quickId) { kbId = null; document.querySelectorAll('#gantt-container .gantt-item.kb').forEach(g => g.classList.remove('kb')); hideTip(); focusLinks(null); } });
  for (const type of ['click', 'contextmenu']) gc.addEventListener(type, (e) => {
    if (dragSuppressClick) return;
    const stream = type === 'click' && e.target.closest('.stream-toggle');
    if (stream) return toggleStream(stream.dataset.stream);
    const m = itemAt(e);
    if (m) showQuick(m, e);
  });

  // edit dialog
  const dlg = document.getElementById('edit-dialog');
  const form = document.getElementById('edit-form');
  form.addEventListener('submit', submitEditDialog);
  form.elements.type.addEventListener('change', updateEdType);
  form.elements.stream_id.addEventListener('change', (e) => pickEdStream(e.target));
  form.elements.newstream.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); // keep the dialog open
    closeNewStream(form.elements);
    form.elements.stream_id.focus();
  });
  form.elements.newstream.addEventListener('blur', (e) => { if (!e.target.value.trim()) closeNewStream(form.elements); });
  form.elements.end.addEventListener('input', updateEdType); // keeps a milestone's hidden start in step
  document.getElementById('ed-cancel').onclick = () => dlg.close();
  document.getElementById('ed-close').onclick = () => dlg.close();
  document.getElementById('ed-delete').onclick = deleteFromDialog;
  document.getElementById('ed-report').onclick = () => { const m = editing; dlg.close(); openReportDialog({ itemId: m.id }); };
  document.getElementById('ed-history').onclick = () => { const m = editing; dlg.close(); showReportsFor(m.id); };
  document.getElementById('ed-dates').onclick = () => showDatesFor(editing.id);
  document.getElementById('ed-raid').onclick = () => showRaidFor(`item:${editing.id}`);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  document.getElementById('ed-deps').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-edrm]');
    if (rm) { edDeps = edDeps.filter(d => d !== rm.dataset.edrm); renderEdDeps(); }
  });
  document.getElementById('ed-deps').addEventListener('change', (e) => {
    if (e.target.id === 'ed-adddep' && e.target.value) { edDeps.push(e.target.value); renderEdDeps(); }
  });

  // editor table
  document.getElementById('btn-add').onclick = () => { syncEditorToState(); openEditDialog(null); };

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
  document.getElementById('editor-body').addEventListener('focusout', (e) => { if (pendingDates.has(e.target)) applyDateEdit(e.target); });
  document.getElementById('editor-body').addEventListener('keydown', (e) => { if (e.key === 'Enter' && pendingDates.has(e.target)) applyDateEdit(e.target); });
  wireBulk();

  wireReports();
  wireConflicts();
  wireChanges();
  wireDates();
  wirePalette();

  // undo: the toast's button, the chart's Undo button, or ⌘/Ctrl+Z when not typing (typing keeps the browser's own undo)
  document.getElementById('btn-undo').onclick = undoLast;
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
    // keepalive carries the version it's based on, so it can't overwrite someone else's save (it's
    // turned away instead), and the date log's headers. Too big for keepalive, it's not sent.
    const headers = { ...auditHeaders(pendingMsg, 'Items table'), 'X-Base-Version': synced.milestones.version };
    if (body.length < 60000) fetch('api/milestones', { method: 'POST', body, headers, keepalive: true });
  });

  // Auto-fit while the user hasn't chosen a zoom; re-render otherwise.
  new ResizeObserver(() => {
    if (document.getElementById('view-gantt').classList.contains('hidden')) return;
    if (state.userZoomed) renderGantt();
    else fitZoom();
  }).observe(document.getElementById('gantt-scroll'));
}

// config.json (via the server) sets the app's title and logo. Without it, the defaults stay.
const APP_CONFIG = { title: 'Tracker', logo: '', environment: '', environmentColor: '', version: '' };
async function loadConfig() {
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (res.ok) Object.assign(APP_CONFIG, await res.json());
  } catch { /* keep the defaults */ }
  const name = document.getElementById('brand-name');
  name.textContent = APP_CONFIG.title;
  name.hidden = !APP_CONFIG.title;
  document.title = APP_CONFIG.title;
  // Which instance this is: an environment name (e.g. Test) as a band across the top of every page
  // and beside the app's name, in the browser tab too, so a test copy is never mistaken for the live one.
  const env = APP_CONFIG.environment.trim();
  const band = document.getElementById('env-band');
  band.innerHTML = env ? `<b>${escAttr(env)}</b> instance${APP_CONFIG.version ? ` <span class="env-band-v">· version ${escAttr(APP_CONFIG.version)}</span>` : ''}` : '';
  band.hidden = !env;
  const brandEnv = document.getElementById('brand-env');
  brandEnv.textContent = env;
  brandEnv.hidden = !env;
  if (env) document.body.dataset.env = env; else delete document.body.dataset.env;
  if (/^#[0-9a-f]{3,8}$/i.test(APP_CONFIG.environmentColor)) document.documentElement.style.setProperty('--env', APP_CONFIG.environmentColor);
  const ver = document.getElementById('app-version');
  ver.textContent = [APP_CONFIG.version && `v${APP_CONFIG.version}`, env].filter(Boolean).join(' · ');
  ver.hidden = !ver.textContent;
  ver.title = 'The version of the app this instance is running';
  if (APP_CONFIG.logo) {
    const img = document.getElementById('brand-logo');
    img.alt = APP_CONFIG.title;
    img.onload = () => { img.hidden = false; document.getElementById('brand-mark').style.display = 'none'; };
    img.src = APP_CONFIG.logo;
  }
}

(async function init() {
  const f = document.getElementById('edit-form').elements;
  document.getElementById('row-slider').value = state.rowH;
  const prefs = loadAppPrefs();
  setNavCollapsed(!!prefs.navCollapsed);
  setNavHidden(!!prefs.navHidden);
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
  switchView(link?.view || (VIEWS.includes(prefs.view) ? prefs.view : 'dash'));
  setTimescale(prefs.timescale); // Quarters fits; the ResizeObserver keeps it fitted as layout settles
  if (link?.item && itemById(link.item)) requestAnimationFrame(() => showItemOnGantt(link.item)); // after the fit, so the card lands beside the item
  routeReady = true;
  writeHash();
  window.addEventListener('hashchange', () => { if (location.hash !== lastHash) followHash(); });
  listenForChanges();
})();
