// Tracker — zero-dependency Node server.
// Serves the static frontend and reads/writes workspaces.csv, statuses.csv, milestones.csv, reports.csv,
// updates.csv and swimlanes.csv, and appends every change to an item's dates to date-changes.csv.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_DEFAULTS = { title: 'Tracker', logo: '' };

// config.json sets the app's title and logo. It's read on every request, so edits show on the
// next page load without restarting. A missing or invalid file falls back to the defaults.
function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Couldn't read config.json: ${err.message}`);
  }
  return { ...CONFIG_DEFAULTS, ...cfg };
}
// A logo is either a web address (http(s):// or data:), used as-is, or a file path relative to
// config.json, which is served from /api/logo.
const isLogoURL = (logo) => /^(https?:|data:)/i.test(logo);

// Each API path is backed by one CSV file; the header is served when the file doesn't exist yet.
const DATASETS = {
  '/api/workspaces': {
    file: path.join(__dirname, 'workspaces.csv'),
    legacy: path.join(__dirname, 'programs.csv'), // read until workspaces.csv is first saved
    header: 'id,number,name,code,description,owner,lead,start,end,rag,trend,item_term,milestone_term,task_term,created,updated\n',
  },
  '/api/statuses': {
    file: path.join(__dirname, 'statuses.csv'),
    header: 'workspace_id,position,name,color,description,get_to_green,is_default\n',
  },
  '/api/milestones': {
    file: path.join(__dirname, 'milestones.csv'),
    header: 'id,workspace_id,ref,title,type,description,swimlane,subswimlane,owner,start,end,rag,shape,parent,depends_on,baseline_start,baseline_end,gitlab_url,use_case_url\n',
    audited: true, // date changes are logged to date-changes.csv
  },
  '/api/reports': {
    file: path.join(__dirname, 'reports.csv'),
    header: 'id,workspace_id,item_id,cadence,period_start,period_end,rag,exec_summary,achievements,next_steps,get_to_green,author,created,updated\n',
  },
  '/api/updates': {
    file: path.join(__dirname, 'updates.csv'),
    header: 'id,workspace_id,swimlane,week_ending,rag,summary,author,created,updated\n',
  },
  '/api/swimlanes': {
    file: path.join(__dirname, 'swimlanes.csv'),
    header: 'workspace_id,name,lead,trend\n',
  },
};

// Before a CSV is first overwritten each day, the day's starting copy is kept in backups/
// (e.g. backups/reports.2026-09-29.csv), so a bad save can be undone. The newest 30 per file are kept.
const BACKUP_DIR = path.join(__dirname, 'backups');
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
// outside the app are logged too. The log is only ever appended to: nothing in the app rewrites it.
const AUDIT_FILE = path.join(__dirname, 'date-changes.csv');
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
  const [header, ...rows] = parseCSV(log);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  auditKnown = new Map();
  for (const r of rows) {
    const id = r[col.item_id];
    auditNextId = Math.max(auditNextId, +r[col.id] + 1 || 0);
    if (r[col.action] === ACTIONS.deleted) { auditKnown.delete(id); continue; }
    if (!auditKnown.has(id)) auditKnown.set(id, { start: '', end: '', baseline_start: '', baseline_end: '' });
    Object.assign(auditKnown.get(id), { workspace_id: r[col.workspace_id], ref: r[col.ref], title: r[col.title], [r[col.field]]: r[col.to] });
  }
  checkOutsideEdits(now);
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

function serveAudit(res) {
  fs.readFile(AUDIT_FILE, (err, data) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(err ? AUDIT_COLUMNS.join(',') + '\n' : decodeCSV(data));
  });
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
  res.end(JSON.stringify({ title: String(cfg.title ?? ''), logo }));
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
  const ds = datasetFor(pathname);
  if (ds) {
    if (req.method === 'GET') {
      const send = (err, data) => {
        if (err && err.code !== 'ENOENT') console.error(`Couldn't read ${path.basename(ds.file)}: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err ? ds.header : decodeCSV(data));
      };
      fs.readFile(ds.file, (err, data) => {
        if (err && ds.legacy) fs.readFile(ds.legacy, send);
        else {
          if (ds.audited && !err) checkOutsideEdits(itemsFrom(decodeCSV(data)));
          send(err, data);
        }
      });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.setEncoding('utf8'); // keeps a character split across chunks intact
      req.on('data', (chunk) => { body += chunk; });
      // Saves to one file run one at a time, so the date log compares each with the one before.
      req.on('end', () => { ds.queue = (ds.queue || Promise.resolve()).then(() => new Promise((next) => backupDaily(ds.file, () => {
        let old = ''; // null: the file couldn't be read, so it isn't checked for outside edits
        if (ds.audited) try { old = decodeCSV(fs.readFileSync(ds.file)); } catch (e) { if (e.code !== 'ENOENT') old = null; }
        const tmp = ds.file + '.tmp';
        fs.writeFile(tmp, body, 'utf8', (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return next();
          }
          const done = (err2) => {
            if (err2) console.error(`Couldn't save ${path.basename(ds.file)}: ${err2.message}`);
            if (!err2 && ds.audited) {
              try { auditSave(req, old, body); } catch (err3) { console.error(`Couldn't write the date log: ${err3.message}`); }
            }
            res.writeHead(err2 ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !err2, error: err2 ? err2.message : undefined }));
            next();
          };
          fs.rename(tmp, ds.file, (err2) => {
            if (!err2) return done();
            // Windows won't replace a file another program has open; write it in place instead.
            fs.writeFile(ds.file, body, 'utf8', (err3) => { fs.unlink(tmp, () => {}); done(err3); });
          });
        });
      }))); });
      return;
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }
  serveStatic(req, res);
});

startAudit();
server.listen(PORT, () => {
  console.log(`${readConfig().title || 'Tracker'} running at http://localhost:${PORT}`);
});
