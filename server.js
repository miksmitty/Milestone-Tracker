// Milestone Tracker — zero-dependency Node server.
// Serves the static frontend and reads/writes milestones.csv.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CSV_PATH = path.join(__dirname, 'milestones.csv');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CSV_HEADER = 'name,description,rag,date,shape,swimlane\n';

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
  if (req.url.startsWith('/api/milestones')) {
    if (req.method === 'GET') {
      fs.readFile(CSV_PATH, 'utf8', (err, data) => {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
        res.end(err ? CSV_HEADER : data);
      });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const tmp = CSV_PATH + '.tmp';
        fs.writeFile(tmp, body, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          fs.rename(tmp, CSV_PATH, (err2) => {
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
  console.log(`Milestone Tracker running at http://localhost:${PORT}`);
});
