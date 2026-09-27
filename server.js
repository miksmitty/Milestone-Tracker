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

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const ds = DATASETS[new URL(req.url, 'http://x').pathname];
  if (ds) {
    if (req.method === 'GET') {
      const send = (err, data) => {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
        res.end(err ? ds.header : data);
      };
      fs.readFile(ds.file, 'utf8', (err, data) => {
        if (err && ds.legacy) fs.readFile(ds.legacy, 'utf8', send);
        else send(err, data);
      });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const tmp = ds.file + '.tmp';
        fs.writeFile(tmp, body, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          fs.rename(tmp, ds.file, (err2) => {
            res.writeHead(err2 ? 500 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !err2, error: err2 ? err2.message : undefined }));
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
