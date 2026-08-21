// Oreacle 服务端 —— 零依赖 Node.js
// 提供：访客统计 API + 算卦记录 API + 静态托管 Oreacle.html
// 运行：node server.js  （默认端口 3000，可用 PORT 环境变量覆盖）
// 数据：data/stats.json（按日统计）、data/records.json（最近 50 条记录）

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const PORT = process.env.PORT || 3000;

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// UTC+8 今日日期
function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function getStats() {
  const s = readJson(STATS_FILE, {});
  const t = today();
  if (!s[t]) s[t] = { visits: 0, fortunes: 0 };
  return s[t];
}
function bumpStats(key) {
  const s = readJson(STATS_FILE, {});
  const t = today();
  if (!s[t]) s[t] = { visits: 0, fortunes: 0 };
  s[t][key]++;
  writeJson(STATS_FILE, s);
  return s[t];
}
function getRecords() {
  const r = readJson(RECORDS_FILE, []);
  return Array.isArray(r) ? r : [];
}
function addRecord(rec) {
  const r = getRecords();
  r.unshift(rec);
  writeJson(RECORDS_FILE, r.slice(0, 50));
  return r.slice(0, 50);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => cb(body));
  req.on('error', () => cb(''));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  // ─── 统计 API ───
  if (p === '/api/stats' && req.method === 'GET') {
    sendJson(res, 200, { date: today(), visits: getStats().visits, fortunes: getStats().fortunes });
    return;
  }
  if (p === '/api/stats/visit' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, ...bumpStats('visits') });
    return;
  }
  if (p === '/api/stats/fortune' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, ...bumpStats('fortunes') });
    return;
  }

  // ─── 算卦记录 API ───
  if (p === '/api/records' && req.method === 'GET') {
    sendJson(res, 200, { records: getRecords().slice(0, 10) });
    return;
  }
  if (p === '/api/records' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const rec = JSON.parse(body || '{}');
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        addRecord({
          ip: ip,
          guaName: String(rec.guaName || '?'),
          levelName: String(rec.levelName || ''),
          levelColor: String(rec.levelColor || '#999'),
          time: String(rec.time || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
        });
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 400, { ok: false, error: 'bad json' }); }
    });
    return;
  }

  // ─── 静态托管 ───
  let filePath = p === '/' ? path.join(ROOT, 'Oreacle.html') : path.join(ROOT, decodeURIComponent(p));
  if (!filePath.startsWith(ROOT)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return; } // 防路径穿越
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream' }, CORS));
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('▶ Oreacle 服务已启动：http://localhost:' + PORT);
  console.log('  静态页面：http://localhost:' + PORT + '/Oreacle.html');
  console.log('  API：/api/stats  /api/stats/visit  /api/stats/fortune  /api/records');
});