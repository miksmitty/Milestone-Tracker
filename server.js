// Tracker — zero-dependency Node server.
// Serves the static frontend and reads/writes workspaces.csv, statuses.csv, milestones.csv, reports.csv,
// updates.csv, streams.csv, raid.csv (risks, issues and dependencies), raid-notes.csv (their
// status updates), meeting-series.csv (a workspace's regular meetings), meetings.csv (their minutes),
// meeting-actions.csv (the actions taken from them) and report-comments.csv (comments on passages of a report, with replies), and
// appends every change to an item's dates to date-changes.csv.
// Several people can use it at once: each file has a version, a save based on an older version is
// turned back with the current file for the browser to merge, and every save is pushed to the
// other browsers straight away (see "Working together" below).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Where the CSVs, the date log, backups and ids.json live: next to server.js unless DATA_DIR says
// otherwise (on Azure App Service, somewhere under /home, which is kept across deployments).
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_DEFAULTS = { title: 'Tracker', logo: '', environment: '', environmentColor: '' };
// What's running: the version from package.json unless the deployment names one (APP_VERSION, e.g.
// a build number or commit), and the environment (APP_ENVIRONMENT, e.g. "Test") so a test instance
// can't be mistaken for the live one. Both are shown on the page.
let APP_VERSION = '';
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || ''; } catch { /* no package.json: no version */ }
APP_VERSION = process.env.APP_VERSION || APP_VERSION;

// config.json sets the app's title and logo. It's read on every request, so edits show on the
// next page load without restarting. A missing or invalid file falls back to the defaults.
function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Couldn't read config.json: ${err.message}`);
  }
  const out = { ...CONFIG_DEFAULTS, ...cfg };
  if (process.env.APP_ENVIRONMENT != null) out.environment = process.env.APP_ENVIRONMENT; // the instance's setting wins over the file that travels with the code
  if (process.env.APP_ENVIRONMENT_COLOR) out.environmentColor = process.env.APP_ENVIRONMENT_COLOR;
  return out;
}
// A logo is either a web address (http(s):// or data:), used as-is, or a file path relative to
// config.json, which is served from /api/logo.
const isLogoURL = (logo) => /^(https?:|data:)/i.test(logo);

// Each API path is backed by one CSV file; the header is served when the file doesn't exist yet.
const DATASETS = {
  '/api/workspaces': {
    file: path.join(DATA_DIR, 'workspaces.csv'),
    legacy: path.join(DATA_DIR, 'programs.csv'), // read until workspaces.csv is first saved
    header: 'id,number,name,code,description,owner,lead,start,end,rag,trend,item_term,milestone_term,task_term,dep_priorities,dep_types,risk_statuses,issue_statuses,dep_statuses,raid_levels,hidden,created,updated\n',
  },
  '/api/statuses': {
    file: path.join(DATA_DIR, 'statuses.csv'),
    header: 'workspace_id,position,name,color,description,get_to_green,is_default\n',
  },
  '/api/milestones': {
    file: path.join(DATA_DIR, 'milestones.csv'),
    header: 'id,workspace_id,ref,title,type,description,stream_id,substream,owner,start,end,rag,parent,depends_on,baseline_start,baseline_end,gitlab_url,use_case_url\n',
    audited: true, // date changes are logged to date-changes.csv
  },
  '/api/reports': {
    file: path.join(DATA_DIR, 'reports.csv'),
    header: 'id,workspace_id,item_id,cadence,period_start,period_end,rag,exec_summary,achievements,next_steps,get_to_green,author,created,updated\n',
  },
  '/api/updates': {
    file: path.join(DATA_DIR, 'updates.csv'),
    header: 'id,workspace_id,stream_id,week_ending,rag,summary,author,created,updated\n',
  },
  '/api/streams': {
    file: path.join(DATA_DIR, 'streams.csv'),
    header: 'id,workspace_id,name,lead,trend\n',
  },
  '/api/raid': {
    file: path.join(DATA_DIR, 'raid.csv'),
    header: 'id,workspace_id,kind,ref,title,description,stream_id,owner,status,rag,priority,dep_type,likelihood,impact,due,party,response,impact_if,mitigation,accountable,links,raised,created,updated\n',
  },
  '/api/raid-notes': {
    file: path.join(DATA_DIR, 'raid-notes.csv'),
    header: 'id,workspace_id,raid_id,at,by,text\n',
    stampBy: true, // new notes are signed with the login ID (see changedBy)
  },
  '/api/meeting-series': {
    file: path.join(DATA_DIR, 'meeting-series.csv'),
    // A regular meeting: `cadence` Weekly, Fortnightly or Monthly (blank: no fixed cadence), `start`
    // the date of its first meeting, from which the others are counted; `attendees` the usual ones.
    header: 'id,workspace_id,name,cadence,start,attendees,notes,created,updated\n',
  },
  '/api/meetings': {
    file: path.join(DATA_DIR, 'meetings.csv'),
    // A meeting's minutes: `minutes` is Markdown (as an LLM or a person wrote them), `series_id`
    // the regular meeting it is one of (blank for a one-off), `attendees` free text, `link` where
    // the recording or original notes live.
    header: 'id,workspace_id,title,date,series_id,attendees,link,minutes,created,updated\n',
  },
  '/api/meeting-actions': {
    file: path.join(DATA_DIR, 'meeting-actions.csv'),
    // An action taken from a meeting's minutes (or added by hand): `meeting_id` where it came
    // from (blank for one added without a meeting), `status` Open or Done, `links` the items or
    // streams it concerns (item:<id>;stream:<id>, as in raid.csv).
    header: 'id,workspace_id,meeting_id,ref,text,owner,due,status,links,done_at,created,updated\n',
  },
  '/api/report-comments': {
    file: path.join(DATA_DIR, 'report-comments.csv'),
    // A comment on a passage of a report: `field` is the section (exec_summary …), `quote` the
    // text selected, `start`/`end` where it sits in the section's plain text. A reply has
    // `parent_id` set and no passage. `resolved` is 'yes' on a thread that's been dealt with.
    header: 'id,workspace_id,report_id,field,quote,start,end,parent_id,at,by,text,resolved\n',
    stampBy: true,
  },
};

// Before a CSV is first overwritten each day, the day's starting copy is kept in backups/
// (e.g. backups/reports.2026-09-29.csv), so a bad save can be undone. The newest 30 per file are kept.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_KEPT = 30;
function backupDaily(file, done) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = path.basename(file, '.csv');
  const target = path.join(BACKUP_DIR, `${base}.${day}.csv`);
  fs.mkdir(BACKUP_DIR, { recursive: true }, () => {
    fs.copyFile(file, target, fs.constants.COPYFILE_EXCL, (err) => {
      if (err && err.code !== 'EEXIST' && err.code !== 'ENOENT') console.error(`Couldn't back up ${path.basename(file)}: ${err.message}`);
      if (!err) fs.readdir(BACKUP_DIR, (err2, names) => {
        if (err2) return;
        const mine = names.filter(n => n.startsWith(base + '.') && /^\d{4}-\d{2}-\d{2}$/.test(n.slice(base.length + 1, -4))).sort();
        for (const n of mine.slice(0, -BACKUPS_KEPT)) fs.unlink(path.join(BACKUP_DIR, n), () => {});
      });
      done();
    });
  });
}

// The daily backups double as history, for "what changed since": /api/history lists the days kept
// for each file, and /api/history/<file>/<YYYY-MM-DD> returns that day's starting copy.
const HISTORY_FILES = ['milestones', 'reports', 'updates'];
function serveHistory(pathname, res) {
  const m = pathname.match(/\/api\/history(?:\/(\w+)\/(\d{4}-\d{2}-\d{2}))?\/?$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const [, file, day] = m;
  if (!file) {
    return fs.readdir(BACKUP_DIR, (err, names) => {
      const out = Object.fromEntries(HISTORY_FILES.map(f => [f, []]));
      for (const n of err ? [] : names) {
        const hit = n.match(/^(\w+)\.(\d{4}-\d{2}-\d{2})\.csv$/);
        if (hit && out[hit[1]]) out[hit[1]].push(hit[2]);
      }
      for (const f in out) out[f].sort();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
  }
  if (!HISTORY_FILES.includes(file)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(BACKUP_DIR, `${file}.${day}.csv`), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(decodeCSV(data));
  });
}

// Every change to an item's dates is appended to date-changes.csv, the audit log. The server
// compares each save of milestones.csv with the file it replaces, so no way of changing a date in
// the app can skip it, and it compares the file with what it last saw, so edits made to the CSV
// outside the app are logged too. The log is only ever appended to, except when history is
// cleared (see clearHistory).
const AUDIT_FILE = path.join(DATA_DIR, 'date-changes.csv');
const AUDIT_COLUMNS = ['id', 'at', 'by', 'workspace_id', 'item_id', 'ref', 'title', 'field', 'from', 'to', 'days', 'action', 'via', 'note'];
const DATE_FIELDS = ['start', 'end', 'baseline_start', 'baseline_end'];
const ACTIONS = { added: 'Added', changed: 'Changed', knockOn: 'Knock-on', deleted: 'Deleted', outside: 'Edited outside the app', started: 'Logging started' };

// A CSV parser that copes with quotes, line breaks in cells, and the semicolons or tabs Excel uses.
function parseCSV(text) {
  const first = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const delim = [',', ';', '\t'].reduce((a, d) => (first.split(d).length > first.split(a).length ? d : a), ',');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Items by id, with the fields the log records. Older files (a single `date` column, or no
// workspace_id) still read.
function itemsFrom(text) {
  const [header = [], ...rows] = parseCSV(text);
  const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const get = (r, k) => (col[k] === undefined ? '' : (r[col[k]] ?? '').trim());
  const out = new Map();
  for (const r of rows) {
    const id = get(r, 'id');
    if (!id) continue;
    const date = get(r, 'date');
    out.set(id, {
      workspace_id: get(r, 'workspace_id') || get(r, 'program_id'), ref: get(r, 'ref'), title: get(r, 'title') || get(r, 'name'),
      start: get(r, 'start') || date, end: get(r, 'end') || date, baseline_start: get(r, 'baseline_start'), baseline_end: get(r, 'baseline_end'),
    });
  }
  return out;
}

const dayNumber = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5 : NaN);
const daysMoved = (from, to) => { const n = dayNumber(to) - dayNumber(from); return Number.isFinite(n) ? n : ''; };

// One log row per date field that differs between two sets of items.
function dateChanges(before, after, how) {
  const rows = [];
  const add = (m, id, field, from, to, action) => rows.push({ workspace_id: m.workspace_id, item_id: id, ref: m.ref, title: m.title, field, from, to, days: from && to ? daysMoved(from, to) : '', action, ...how.meta });
  for (const [id, m] of after) {
    const o = before.get(id);
    const action = !o ? how.added : how.knockOn?.has(id) ? ACTIONS.knockOn : how.changed;
    for (const f of DATE_FIELDS) if ((o?.[f] ?? '') !== m[f] && (o || m[f])) add(m, id, f, o?.[f] ?? '', m[f], action);
  }
  for (const [id, o] of before) if (!after.has(id)) for (const f of DATE_FIELDS) if (o[f]) add(o, id, f, o[f], '', ACTIONS.deleted);
  return rows;
}

let auditNextId = 1;
let auditKnown = null; // the items as the log last saw them: replayed from the log at start-up

function appendAudit(rows) {
  if (!rows.length) return;
  const at = new Date().toISOString();
  const lines = rows.map(r => AUDIT_COLUMNS.map(k => csvCell(k === 'id' ? auditNextId++ : k === 'at' ? at : r[k] ?? '')).join(',')).join('\n') + '\n';
  const fresh = !fs.existsSync(AUDIT_FILE);
  fs.appendFileSync(AUDIT_FILE, (fresh ? AUDIT_COLUMNS.join(',') + '\n' : '') + lines, 'utf8');
}

// Rebuild the items' dates from the log, then log anything in milestones.csv that differs from it.
// When there's no log yet, every item's dates are recorded as where logging started.
function startAudit() {
  let log = '';
  try { log = decodeCSV(fs.readFileSync(AUDIT_FILE)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let disk = '';
  try { disk = decodeCSV(fs.readFileSync(DATASETS['/api/milestones'].file)); } catch { /* no items yet */ }
  const now = itemsFrom(disk);
  if (!log) {
    auditKnown = new Map();
    appendAudit(dateChanges(auditKnown, now, { added: ACTIONS.started, changed: ACTIONS.started, meta: { via: 'Start of the log', note: 'The dates each item had when date logging began' } }));
    auditKnown = now;
    return;
  }
  replayAudit(log);
  checkOutsideEdits(now);
}

// The items' dates as the log has them: each row's `to`, oldest first. Ids carry on from the
// highest seen, so none is reused, even after the log is cleared.
function replayAudit(log) {
  if (log === undefined) { try { log = decodeCSV(fs.readFileSync(AUDIT_FILE)); } catch (err) { if (err.code !== 'ENOENT') throw err; log = ''; } }
  auditKnown = new Map();
  if (!log) return;
  const [header, ...rows] = parseCSV(log);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const r of rows) {
    const id = r[col.item_id];
    auditNextId = Math.max(auditNextId, +r[col.id] + 1 || 0);
    if (r[col.action] === ACTIONS.deleted) { auditKnown.delete(id); continue; }
    if (!auditKnown.has(id)) auditKnown.set(id, { start: '', end: '', baseline_start: '', baseline_end: '' });
    Object.assign(auditKnown.get(id), { workspace_id: r[col.workspace_id], ref: r[col.ref], title: r[col.title], [r[col.field]]: r[col.to] });
  }
}

function checkOutsideEdits(now) {
  appendAudit(dateChanges(auditKnown, now, { added: ACTIONS.outside, changed: ACTIONS.outside, meta: { via: 'milestones.csv edited directly' } }));
  auditKnown = now;
}

// Who is making a change, for the date log. There's no sign-in yet, so it's blank; when the app is
// put behind a login, return the user's login ID here (e.g. from the session or the header the
// sign-in proxy adds). It's taken on the server so the browser can't claim to be someone else.
function changedBy(req) {
  return '';
}

// Log the dates a save of milestones.csv changes. The browser says what the change was (X-Change-Note, X-Change-Via) and which items only moved because something
// they depend on moved (X-Knock-On, comma-separated ids).
function auditSave(req, oldText, newText) {
  const header = (k) => { try { return decodeURIComponent(req.headers[k] || ''); } catch { return ''; } };
  if (oldText !== null) checkOutsideEdits(itemsFrom(oldText));
  const after = itemsFrom(newText);
  const knockOn = new Set(header('x-knock-on').split(',').filter(Boolean));
  appendAudit(dateChanges(auditKnown, after, {
    added: ACTIONS.added, changed: ACTIONS.changed, knockOn,
    meta: { by: changedBy(req), via: header('x-change-via'), note: header('x-change-note') },
  }));
  auditKnown = after;
}

// Clearing history — the one time the log is rewritten. For a workspace that's starting afresh
// (its demo or test data deleted), or for every workspace after a move to a new platform, so what
// went before stops showing in the Date log and What changed. It has to leave nothing stale behind:
//  - the date log loses the workspace's rows, and also any row for one of its items that carries
//    another workspace (or none), as rows from an older copy of the data can; clearing every
//    workspace empties it. It then starts again from the items' dates now ("Logging started").
//  - in every daily copy of the items, reports and updates, the workspace's rows are replaced with
//    today's, so comparing with an earlier day shows no change before today. A copy with no
//    workspace column (from before workspaces) can't say whose rows are whose, so it's replaced
//    with today's file outright.
//  - what the server remembers of the items' dates is rebuilt from the log as rewritten, so the
//    next save is compared with the items as they are, not with anything cleared.
// The files as they were are put in backups/cleared-<when>/ first, so a clear made by mistake can
// be put back by hand. Open pages are told (history-cleared) and drop what they'd loaded. It runs
// in the items file's save queue, so no save can interleave with it.
const wsCol = (header) => header.findIndex(h => ['workspace_id', 'program_id', 'programme_id'].includes(h.trim().toLowerCase()));
function clearHistory(workspaceId, req) {
  const all = workspaceId === 'all';
  const ds = DATASETS['/api/milestones'];
  const nowText = decodeCSV(readDataset(ds) || Buffer.from(ds.header));
  const nowItems = itemsFrom(nowText);
  const mine = new Map([...nowItems].filter(([, m]) => all || m.workspace_id === workspaceId));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  let archive = path.join(BACKUP_DIR, `cleared-${stamp}`);
  for (let n = 2; fs.existsSync(archive); n++) archive = path.join(BACKUP_DIR, `cleared-${stamp}-${n}`);
  const keepOriginal = (file) => { fs.mkdirSync(archive, { recursive: true }); fs.copyFileSync(file, path.join(archive, path.basename(file))); };
  const rewrite = (file, rows) => { fs.writeFileSync(file + '.tmp', serialize(rows), 'utf8'); fs.renameSync(file + '.tmp', file); };

  // 1. the date log
  let removed = 0;
  let log = '';
  try { log = decodeCSV(fs.readFileSync(AUDIT_FILE)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (log) {
    const [header, ...rows] = parseCSV(log);
    const col = header.indexOf('workspace_id'), itemCol = header.indexOf('item_id');
    const keep = all ? [] : rows.filter(r => r[col] !== workspaceId && !mine.has(r[itemCol]));
    removed = rows.length - keep.length;
    if (removed) { keepOriginal(AUDIT_FILE); rewrite(AUDIT_FILE, [header, ...keep]); }
  }
  replayAudit();
  appendAudit(dateChanges(new Map(), mine, {
    added: ACTIONS.started, changed: ACTIONS.started,
    meta: { by: changedBy(req), via: 'History cleared', note: all ? 'The dates each item had when every workspace’s history was cleared' : 'The dates each item had when the workspace’s history was cleared' },
  }));
  for (const [id, m] of mine) auditKnown.set(id, m);
  for (const id of [...auditKnown.keys()]) if (!nowItems.has(id)) auditKnown.delete(id); // nothing remembered for items that aren't there

  // 2. the daily copies
  let copies = 0;
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch { /* no backups yet */ }
  for (const file of HISTORY_FILES) {
    const cur = parseCSV(decodeCSV(readDataset(DATASETS['/api/' + file]) || Buffer.from('')));
    const [curHeader = [], ...curRows] = cur;
    const curCol = wsCol(curHeader);
    for (const n of names.filter(n => new RegExp(`^${file}\\.\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(n))) {
      const target = path.join(BACKUP_DIR, n);
      const [header = [], ...rows] = parseCSV(decodeCSV(fs.readFileSync(target)));
      const col = wsCol(header);
      keepOriginal(target);
      if (all || col < 0) { rewrite(target, cur); copies++; continue; }
      // today's rows, in this copy's columns (an older copy may have fewer, or older names)
      const today = curCol < 0 ? [] : curRows.filter(r => r[curCol] === workspaceId);
      const map = header.map(h => curHeader.findIndex(c => c.trim().toLowerCase() === h.trim().toLowerCase()));
      const fresh = today.map(r => map.map((i, j) => (j === col ? workspaceId : i < 0 ? '' : r[i] ?? '')));
      rewrite(target, [header, ...rows.filter(r => r[col] !== workspaceId), ...fresh]);
      copies++;
    }
  }
  broadcast('history-cleared', { workspace: workspaceId });
  return { removed, copies, archive: fs.existsSync(archive) ? path.relative(DATA_DIR, archive) : '' };
}
function serveClearHistory(req, res) {
  const workspaceId = new URL(req.url, 'http://x').searchParams.get('workspace') || '';
  if (!/^(\d+|all)$/.test(workspaceId)) return sendJSON(res, 400, { ok: false, error: 'which workspace?' });
  const ds = DATASETS['/api/milestones'];
  ds.queue = (ds.queue || Promise.resolve()).then(() => new Promise((next) => {
    ds.busy = true;
    try { sendJSON(res, 200, { ok: true, ...clearHistory(workspaceId, req) }); } catch (err) {
      console.error(`Couldn't clear the history: ${err.message}`);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
    ds.busy = false;
    next();
  }));
}

function serveAudit(res) {
  fs.readFile(AUDIT_FILE, (err, data) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(err ? AUDIT_COLUMNS.join(',') + '\n' : decodeCSV(data));
  });
}

/* ---- Working together ---- */
// Each file's version is a hash of its contents, sent with every read (X-Version). A save says
// which version it was made from (X-Base-Version); if the file has changed since, it isn't written:
// the reply is 409 with the current file and version, the browser merges its changes into it and
// saves again. Saves to one file run one at a time, so the check and the write can't interleave.
//
// Browsers hear about changes on /api/events (server-sent events): a `versions` event on
// connecting, then a `change` event each time a file changes, whether saved through the app or
// edited on disk (the files are checked every couple of seconds). Run one instance of the server:
// two would each keep their own date log counter and only tell their own browsers about saves.
const nameOf = (ds) => Object.keys(DATASETS).find(k => DATASETS[k] === ds).slice('/api/'.length);
const serialize = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
const versionOf = (buf) => (buf ? crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) : 'none');
// The file's bytes (or the legacy file's, until the new one is saved), or null when there's neither.
function readDataset(ds) {
  for (const f of [ds.file, ds.legacy].filter(Boolean)) {
    try { return fs.readFileSync(f); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return null;
}

const listeners = new Set();
const lastSeen = new Map(); // dataset → { stamp: size and mtime, version } as last told to browsers
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}
function currentVersions() {
  return Object.fromEntries(Object.values(DATASETS).map(ds => [nameOf(ds), lastSeen.get(ds)?.version ?? versionOf(readDataset(ds))]));
}
function serveEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\nevent: versions\ndata: ${JSON.stringify(currentVersions())}\n\n`);
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
}
// A comment every 20 seconds keeps idle connections open through proxies and load balancers
// (Azure closes them after about four minutes of silence).
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 20000).unref();

const stampOf = (ds) => { try { const s = fs.statSync(ds.file); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } };
// Tell browsers a file has changed, if its version isn't the one they were last told.
function noteVersion(ds, buf) {
  const version = versionOf(buf);
  const was = lastSeen.get(ds)?.version;
  lastSeen.set(ds, { stamp: stampOf(ds), version });
  if (was !== undefined && was !== version) broadcast('change', { file: nameOf(ds), version });
}
// Edits made on disk (a spreadsheet, a restored backup) are noticed by checking each file's size
// and modified time.
function checkFiles() {
  for (const ds of Object.values(DATASETS)) {
    if (ds.busy) continue; // a save is under way; it reports its own version
    const seen = lastSeen.get(ds);
    if (seen && seen.stamp === stampOf(ds)) continue;
    try { noteVersion(ds, readDataset(ds)); } catch (err) { console.error(`Couldn't read ${path.basename(ds.file)}: ${err.message}`); }
  }
}
setInterval(checkFiles, 2000).unref();

// New records get their ids from here, so two people adding at the same moment can't both take the
// next number. A browser reserves a few at a time (POST /api/ids?file=milestones&n=20). The last
// id given out per file is kept in ids.json; the next is always above every id in the file too.
const IDS_FILE = path.join(DATA_DIR, 'ids.json');
const ID_FILES = ['workspaces', 'milestones', 'reports', 'updates', 'streams', 'raid', 'raid-notes', 'meeting-series', 'meetings', 'meeting-actions', 'report-comments'];
function reserveIds(file, n) {
  let issued = {};
  try { issued = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch { /* none issued yet */ }
  const ds = DATASETS['/api/' + file];
  const buf = readDataset(ds);
  const [header = [], ...rows] = buf ? parseCSV(decodeCSV(buf)) : [];
  const col = header.findIndex(h => h.trim().toLowerCase() === 'id');
  const inFile = Math.max(0, ...rows.map(r => (/^\d+$/.test((r[col] ?? '').trim()) ? +r[col] : 0)));
  const first = Math.max(+issued[file] || 0, inFile) + 1;
  issued[file] = first + n - 1;
  fs.writeFileSync(IDS_FILE, JSON.stringify(issued, null, 2) + '\n');
  return Array.from({ length: n }, (_, i) => String(first + i));
}
// Notes are signed on the server, so a browser can't sign as someone else: a row that wasn't in
// the file before and has no `by` gets the login ID. Returns the text to write.
function stampAuthors(text, oldBuf, who) {
  if (!who) return text;
  const [header = [], ...rows] = parseCSV(text);
  const id = header.indexOf('id'), by = header.indexOf('by');
  if (id < 0 || by < 0) return text;
  const before = new Set(oldBuf ? parseCSV(decodeCSV(oldBuf)).slice(1).map(r => r[id]) : []);
  let changed = false;
  for (const r of rows) if (!before.has(r[id]) && !(r[by] ?? '').trim()) { r[by] = who; changed = true; }
  return changed ? serialize([header, ...rows]) : text;
}

function serveIds(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const file = q.get('file'), n = Math.min(500, Math.max(1, +q.get('n') || 20));
  if (!ID_FILES.includes(file)) { res.writeHead(404); return res.end('Not found'); }
  let ids;
  try { ids = reserveIds(file, n); } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, ids }));
}

/* ---- Streams as records ---- */
// A stream is a row of streams.csv with an id; items, weekly updates and RAID entries point at it
// (stream_id), and a RAID link to a whole stream reads stream:<id>. Files from before named the
// stream in each row instead, so renaming one lost its lead, trend and updates. Those files are
// converted once, at start-up, with the day's backup taken first: every name in use becomes a
// stream (a blank item stream is "General", as the app always showed it), and the rows point at it.
function migrateStreams() {
  const norm = (h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const read = (ds) => { const buf = readDataset(ds); return buf ? parseCSV(decodeCSV(buf)) : []; };
  const colOf = (header, name) => header.findIndex(h => norm(h) === name);
  const named = (table) => table.length > 0 && colOf(table[0], 'stream') >= 0 && colOf(table[0], 'stream_id') < 0;
  const S = DATASETS['/api/streams'], M = DATASETS['/api/milestones'], U = DATASETS['/api/updates'], R = DATASETS['/api/raid'];
  const tables = { S: read(S), M: read(M), U: read(U), R: read(R) };
  const streamsLackIds = tables.S.length > 0 && colOf(tables.S[0], 'id') < 0;
  const todo = { M: named(tables.M), U: named(tables.U), R: named(tables.R) };
  if (!streamsLackIds && !todo.M && !todo.U && !todo.R) return;

  // The streams, by workspace and name (names differing only in case are one stream).
  const streams = [], byKey = new Map();
  const keyOf = (ws, name) => `${ws}\u0000${name.trim().toLowerCase()}`;
  const [sHeader = [], ...sRows] = tables.S;
  const sc = Object.fromEntries(['id', 'workspace_id', 'name', 'lead', 'trend'].map(k => [k, colOf(sHeader, k)]));
  const cell = (r, i) => (i < 0 ? '' : (r[i] ?? '').trim());
  for (const r of sRows) {
    const s = { id: /^\d+$/.test(cell(r, sc.id)) ? cell(r, sc.id) : '', workspace_id: cell(r, sc.workspace_id), name: cell(r, sc.name), lead: cell(r, sc.lead), trend: cell(r, sc.trend) };
    if (!s.workspace_id || !s.name || byKey.has(keyOf(s.workspace_id, s.name))) continue;
    streams.push(s);
    byKey.set(keyOf(s.workspace_id, s.name), s);
  }
  const streamFor = (ws, name) => {
    name = name.trim();
    if (!ws || !name) return null;
    let s = byKey.get(keyOf(ws, name));
    if (!s) { s = { id: '', workspace_id: ws, name, lead: '', trend: '' }; streams.push(s); byKey.set(keyOf(ws, name), s); }
    return s;
  };

  // Each file's rows point at streams instead of naming them (ids are filled in below).
  const convert = (table, fallback, links) => {
    const header = table[0];
    const si = colOf(header, 'stream'), wi = colOf(header, 'workspace_id') >= 0 ? colOf(header, 'workspace_id') : colOf(header, 'program_id');
    const li = links ? colOf(header, 'links') : -1;
    header[si] = 'stream_id';
    const refs = [];
    for (const r of table.slice(1)) {
      const ws = cell(r, wi);
      const s = streamFor(ws, cell(r, si) || fallback);
      refs.push(() => { r[si] = s ? s.id : ''; });
      if (li >= 0 && r[li]) {
        const parts = r[li].split(';').map(l => l.trim()).filter(Boolean).map(l => {
          if (!l.startsWith('stream:')) return () => l;
          const t = streamFor(ws, l.slice(7));
          return () => (t ? `stream:${t.id}` : '');
        });
        refs.push(() => { r[li] = [...new Set(parts.map(p => p()).filter(Boolean))].join(';'); });
      }
    }
    return refs;
  };
  const fixes = [];
  if (todo.M) fixes.push(...convert(tables.M, 'General', false));
  if (todo.U) fixes.push(...convert(tables.U, '', false));
  if (todo.R) fixes.push(...convert(tables.R, '', true));

  // Ids for streams that have none, above every id in use and every id ever issued.
  let issued = {};
  try { issued = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch { /* none issued yet */ }
  let last = Math.max(+issued.streams || 0, ...streams.map(s => +s.id || 0));
  for (const s of streams) if (!s.id) s.id = String(++last);
  for (const fix of fixes) fix();

  // Write the converted files, each with its daily backup taken first.
  const day = new Date().toISOString().slice(0, 10);
  const write = (ds, rows) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    try { fs.copyFileSync(ds.file, path.join(BACKUP_DIR, `${path.basename(ds.file, '.csv')}.${day}.csv`), fs.constants.COPYFILE_EXCL); } catch (err) { if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err; }
    fs.writeFileSync(ds.file + '.tmp', serialize(rows), 'utf8');
    fs.renameSync(ds.file + '.tmp', ds.file);
    console.log(`Converted ${path.basename(ds.file)}: streams are now recorded by id`);
  };
  write(S, [['id', 'workspace_id', 'name', 'lead', 'trend'], ...streams.map(s => [s.id, s.workspace_id, s.name, s.lead, s.trend])]);
  if (todo.M) write(M, tables.M);
  if (todo.U) write(U, tables.U);
  if (todo.R) write(R, tables.R);
  issued.streams = Math.max(+issued.streams || 0, last);
  fs.writeFileSync(IDS_FILE, JSON.stringify(issued, null, 2) + '\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// Behind a proxy the app may be served under a path prefix (e.g. /proxy/3100/) that isn't
// stripped. The API is matched on the end of the path, and a static file that isn't found at
// its full path is looked for by its name alone.
function datasetFor(pathname) {
  const key = Object.keys(DATASETS).find(k => pathname === k || pathname.endsWith(k));
  return key && DATASETS[key];
}

// CSVs saved by Excel on Windows are often Windows-1252 rather than UTF-8, and may start with
// a byte order mark. Both are turned into plain UTF-8 text.
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeCSV(buf) {
  let text;
  try { text = utf8.decode(buf); } catch { text = buf.toString('latin1'); }
  return text.replace(/^\ufeff/, '');
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { urlPath = '/'; }
  const full = path.join(PUBLIC_DIR, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
  const byName = path.join(PUBLIC_DIR, urlPath.endsWith('/') ? 'index.html' : path.basename(urlPath));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) return fs.readFile(byName, (err2, data2) => send(err2, data2, byName));
    send(err, data, full);
  });
  function send(err, data, filePath) {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  }
}

function serveConfig(req, res) {
  const cfg = readConfig();
  const logo = cfg.logo && !isLogoURL(cfg.logo) ? 'api/logo' : cfg.logo;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ title: String(cfg.title ?? ''), logo, environment: String(cfg.environment ?? ''), environmentColor: String(cfg.environmentColor ?? ''), version: APP_VERSION }));
}

function serveLogo(req, res) {
  const { logo } = readConfig();
  if (!logo || isLogoURL(logo)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const file = path.resolve(__dirname, logo);
  fs.readFile(file, (err, data) => {
    if (err) {
      console.error(`Couldn't read logo ${logo}: ${err.message}`);
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && pathname.endsWith('/api/config')) return serveConfig(req, res);
  if (req.method === 'GET' && pathname.endsWith('/api/logo')) return serveLogo(req, res);
  if (req.method === 'GET' && /\/api\/history(\/|$)/.test(pathname)) return serveHistory(pathname, res);
  if (req.method === 'GET' && pathname.endsWith('/api/date-changes')) return serveAudit(res);
  if (req.method === 'GET' && pathname.endsWith('/api/events')) return serveEvents(req, res);
  if (req.method === 'GET' && pathname.endsWith('/api/versions')) return sendJSON(res, 200, currentVersions());
  if (req.method === 'POST' && pathname.endsWith('/api/ids')) return serveIds(req, res);
  if (req.method === 'POST' && pathname.endsWith('/api/clear-history')) return serveClearHistory(req, res);
  const ds = datasetFor(pathname);
  if (ds) {
    if (req.method === 'GET') {
      let buf;
      try { buf = readDataset(ds); } catch (err) { console.error(`Couldn't read ${path.basename(ds.file)}: ${err.message}`); }
      const text = buf ? decodeCSV(buf) : ds.header;
      if (ds.audited && buf) checkOutsideEdits(itemsFrom(text));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Version': versionOf(buf) });
      return res.end(text);
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.setEncoding('utf8'); // keeps a character split across chunks intact
      req.on('data', (chunk) => { body += chunk; });
      // Saves to one file run one at a time, so each is checked against the one before (and the
      // date log compares each with the one it replaces).
      req.on('end', () => { ds.queue = (ds.queue || Promise.resolve()).then(() => new Promise((next) => {
        ds.busy = true;
        const finish = (status, out) => { sendJSON(res, status, out); ds.busy = false; next(); };
        let current;
        try { current = readDataset(ds); } catch (err) { return finish(500, { ok: false, error: err.message }); }
        const base = req.headers['x-base-version'];
        if (base && base !== versionOf(current)) {
          return finish(409, { ok: false, conflict: true, version: versionOf(current), text: current ? decodeCSV(current) : ds.header });
        }
        const sent = body;
        if (ds.stampBy) body = stampAuthors(body, current, changedBy(req));
        backupDaily(ds.file, () => {
          // the file being replaced, for the date log ('' when it's new)
          const old = !ds.audited ? '' : current && fs.existsSync(ds.file) ? decodeCSV(current) : '';
          const tmp = ds.file + '.tmp';
          fs.writeFile(tmp, body, 'utf8', (err) => {
            if (err) return finish(500, { ok: false, error: err.message });
            const done = (err2) => {
              if (err2) console.error(`Couldn't save ${path.basename(ds.file)}: ${err2.message}`);
              if (!err2 && ds.audited) {
                try { auditSave(req, old, body); } catch (err3) { console.error(`Couldn't write the date log: ${err3.message}`); }
              }
              const version = versionOf(Buffer.from(body, 'utf8'));
              if (!err2) noteVersion(ds, Buffer.from(body, 'utf8'));
              // When the server changed what was sent (signed notes), the browser takes the file back.
              finish(err2 ? 500 : 200, { ok: !err2, error: err2 ? err2.message : undefined, version, text: body !== sent ? body : undefined });
            };
            fs.rename(tmp, ds.file, (err2) => {
              if (!err2) return done();
              // Windows won't replace a file another program has open; write it in place instead.
              fs.writeFile(ds.file, body, 'utf8', (err3) => { fs.unlink(tmp, () => {}); done(err3); });
            });
          });
        });
      })); });
      return;
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }
  serveStatic(req, res);
});

function sendJSON(res, status, out) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(out));
}

migrateStreams();
startAudit();
// node server.js --clear-history [<workspace id>|all]: clear history without the app running,
// e.g. after copying the data to a new platform (see the README). It clears and exits.
const clearArg = process.argv.indexOf('--clear-history');
if (clearArg > 0) {
  const which = process.argv[clearArg + 1] || 'all';
  if (!/^(\d+|all)$/.test(which)) { console.error('Usage: node server.js --clear-history [<workspace id>|all]'); process.exit(1); }
  const out = clearHistory(which, null);
  console.log(`History cleared for ${which === 'all' ? 'every workspace' : `workspace ${which}`}: ${out.removed} date log rows removed, ${out.copies} daily copies reset${out.archive ? `; the files as they were are in ${out.archive}` : ''}.`);
  process.exit(0);
}
checkFiles();
server.listen(PORT, () => {
  console.log(`${readConfig().title || 'Tracker'} running at http://localhost:${PORT}`);
  if (DATA_DIR !== __dirname) console.log(`Data in ${DATA_DIR}`);
});
