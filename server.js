// Tracker — zero-dependency Node server.
// Serves the static frontend and reads/writes workspaces.csv, statuses.csv, milestones.csv and reports.csv.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Each API path is backed by one CSV file; the header is served when the file doesn't exist yet.
const DATASETS = {
  '/api/workspaces': {
    file: path.join(__dirname, 'workspaces.csv'),
    legacy: path.join(__dirname, 'programs.csv'), // read until workspaces.csv is first saved
    header: 'id,name,code,description,owner,lead,start,end,rag,item_term,milestone_term,task_term,created,updated\n',
  },
  '/api/statuses': {
    file: path.join(__dirname, 'statuses.csv'),
    header: 'workspace_id,position,name,color,description,get_to_green,is_default\n',
  },
  '/api/milestones': {
    file: path.join(__dirname, 'milestones.csv'),
    header: 'id,workspace_id,ref,title,type,description,swimlane,subswimlane,owner,start,end,rag,shape,parent,depends_on\n',
  },
  '/api/reports': {
    file: path.join(__dirname, 'reports.csv'),
    header: 'id,workspace_id,item_id,cadence,period_start,period_end,rag,exec_summary,achievements,next_steps,get_to_green,author,created,updated\n',
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

const server = http.createServer((req, res) => {
  const ds = datasetFor(new URL(req.url, 'http://x').pathname);
  if (ds) {
    if (req.method === 'GET') {
      const send = (err, data) => {
        if (err && err.code !== 'ENOENT') console.error(`Couldn't read ${path.basename(ds.file)}: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err ? ds.header : decodeCSV(data));
      };
      fs.readFile(ds.file, (err, data) => {
        if (err && ds.legacy) fs.readFile(ds.legacy, send);
        else send(err, data);
      });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.setEncoding('utf8'); // keeps a character split across chunks intact
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const tmp = ds.file + '.tmp';
        fs.writeFile(tmp, body, 'utf8', (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          const done = (err2) => {
            if (err2) console.error(`Couldn't save ${path.basename(ds.file)}: ${err2.message}`);
            res.writeHead(err2 ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !err2, error: err2 ? err2.message : undefined }));
          };
          fs.rename(tmp, ds.file, (err2) => {
            if (!err2) return done();
            // Windows won't replace a file another program has open; write it in place instead.
            fs.writeFile(ds.file, body, 'utf8', (err3) => { fs.unlink(tmp, () => {}); done(err3); });
          });
        });
      });
      return;
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Tracker running at http://localhost:${PORT}`);
});
