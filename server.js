// Oreacle 服务端 —— 零依赖 Node.js（仅内置模块）
// 提供：访客统计 API + 算卦记录 API + 静态托管 Oreacle.html
// 运行：node server.js  （默认端口 3000，可用 PORT 环境变量覆盖）
// 数据：data/stats.json（按日统计）、data/records.json（最近 1000 条记录）
//
// 安全加固记录（2026-08-21 夜 · MVW-01~04 + NEW-01~04）：
//   MVW-01 存储型 XSS   → 展示字段改由服务端白名单生成，无注入面
//   MVW-02 PII 泄露     → 只落盘服务端打码 IP（形如 12.34.*.*）
//   MVW-03 刷统计       → /api/stats/visit、/api/stats/fortune 按 IP 限流，超限 429
//   MVW-04 刷记录       → /api/records 限流 + 单 IP 每日上限 + 字段校验
//   NEW-01 记录整体伪造 → 服务端收权：IP 服务端打码、卦象/等级白名单、颜色由等级映射、时间服务端生成，客户端字段全部不采信
//   NEW-02 无效请求耗配额 → 每日配额检查移到 JSON/白名单校验之后，垃圾请求不消耗配额
//   NEW-03 限流下刷数空间 → 访问/算卦按「签名 cookie uid（优先）或 IP」当日去重计数，刷新不重复计
//   NEW-04 并发写竞争   → 读-改-写经 Promise 串行化 + 临时文件重命名原子写

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const PORT = process.env.PORT || 3000;

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── 数据读写 ───
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
// NEW-04：原子写 —— 先写临时文件再 rename，崩溃时不会留下半截 JSON
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
// NEW-04：读-改-写串行化（Promise 链），防止并发丢更新
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

// UTC+8 今日日期
function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// NEW-01：记录时间由服务端生成（东八区 年月日 时:分:秒 完整时间），不采信客户端
function nowTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function getStats() {
  const s = readJson(STATS_FILE, {});
  const t = today();
  if (!s[t]) s[t] = { visits: 0, fortunes: 0 };
  return s[t];
}
function bumpStats(key) {
  return withLock(() => {
    const s = readJson(STATS_FILE, {});
    const t = today();
    if (!s[t]) s[t] = { visits: 0, fortunes: 0 };
    s[t][key]++;
    writeJsonAtomic(STATS_FILE, s);
    return s[t];
  });
}
function getRecords() {
  const r = readJson(RECORDS_FILE, []);
  return Array.isArray(r) ? r : [];
}
function addRecord(rec) {
  return withLock(() => {
    const r = getRecords();
    r.unshift(rec);
    writeJsonAtomic(RECORDS_FILE, r.slice(0, 1000));
    return r.slice(0, 1000);
  });
}

// ─── NEW-01 修复：服务端白名单 ───
// 卦名 = 上卦 + 下卦 + "卦"（8×8 = 64 种，与前端 TRIGRAMS 完全一致）
const TRIGRAM_NAMES = ['苦力怕', '岩浆', '泥土', '末影', '村民', '黑曜石', '红石', '钻石'];
const GUA_WHITELIST = new Set();
TRIGRAM_NAMES.forEach(u => TRIGRAM_NAMES.forEach(l => GUA_WHITELIST.add(u + l + '卦')));
// 等级白名单（与前端 FORTUNE_LEVELS 一致），颜色由服务端按等级映射
const LEVEL_COLOR_MAP = {
  '苦力怕大凶': '#F44336',
  '非酋小凶': '#FF9800',
  '平': '#999',
  '小吉': '#8BC34A',
  '中吉': '#5db63a',
  '欧皇大吉': '#D4A017'
};

// NEW-01：把真实 remoteAddress 打码成 x.x.*.*（仅保留省市级段信息，不存明文 PII）
//         只服务端计算，绝不采信客户端任何 IP 字段
function maskIp(remote) {
  const s = (remote || '').replace(/^::ffff:/, '');
  const parts = s.split('.');
  if (parts.length === 4 && /^\d{1,3}$/.test(parts[0]) && /^\d{1,3}$/.test(parts[1])) {
    return parts[0] + '.' + parts[1] + '.*.*';
  }
  return ''; // IPv6（::1 等）无法打码，不落盘
}

// ─── MVW-03 / MVW-04 修复：按 IP 限流（内存固定窗口） ───
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = {
  'visit':        { limit: 120, windowMs: 60000 }, // 访问上报：宽松，避免误伤共享 IP
  'fortune':      { limit: 30,  windowMs: 60000 }, // 算卦上报：前端本就一天一次
  'records_post': { limit: 10,  windowMs: 60000 }, // 记录写入：防刷
  'records_get':  { limit: 60,  windowMs: 60000 }  // 记录读取：轻限流，防爬
};
const DAILY_RECORD_LIMIT = 30; // 单 IP 每日可写记录数（CGNAT 共享 IP 下对多个用户仍够用）

const rateBuckets = new Map(); // 限流桶  key -> { count, resetAt }（按 IP+接口）
const dailyRecordCounts = new Map(); // 每日记录数  ip -> { date, count }
const dailyFortuneSeen = new Map(); // 访客当日已抽取记录  key(uid|ip) -> { date, gua, level }
const dailyIpFortunes = new Map(); // 单 IP 当日已抽取卦集合  ip -> { date, Set<"gua|level"> }

function clientIp(req) {
  const xri = (req.headers['x-real-ip'] || '').trim();
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xri || xff || (req.socket.remoteAddress || 'unknown');
  return raw.replace(/^::ffff:/, '');
}
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}
function allowDailyRecord(ip) {
  const row = dailyRecordCounts.get(ip);
  const t = today();
  if (!row || row.date !== t) {
    dailyRecordCounts.set(ip, { date: t, count: 1 });
    return true;
  }
  if (row.count >= DAILY_RECORD_LIMIT) return false;
  row.count++;
  return true;
}

// ─── NEW-03 修复：按访客当日去重计数（cookie uid 优先，无 uid 按 IP） ───
// uid = 随机 id + HMAC 签名（crypto 内置，零依赖）；HttpOnly，前端不可读
const UID_SECRET = crypto.randomBytes(32).toString('hex');
const dailyVisits = new Map();   // uid|ip -> date
const dailyFortunes = new Map(); // uid|ip -> date

// 短哈希：uid(或IP) 派生，用于访客记录展示小尾巴（区分同一 IP 下不同访客 + 本机标注）
function shortHash(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 4);
}

function getUid(req) {
  const m = (req.headers.cookie || '').match(/oreacle_uid=([^;]+)/);
  if (!m) return null;
  const v = m[1];
  const i = v.lastIndexOf('.');
  if (i < 1 || i === v.length - 1) return null;
  const id = v.slice(0, i);
  const sig = v.slice(i + 1);
  const expect = crypto.createHmac('sha256', UID_SECRET).update(id).digest('hex').slice(0, 16);
  // 返回完整「id.sig」作为去重 key，与首次预注册时 newUid() 的 key 保持一致
  return expect === sig ? v : null;
}
function newUid() {
  const id = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', UID_SECRET).update(id).digest('hex').slice(0, 16);
  return id + '.' + sig;
}
function setUidCookie(res, uid) {
  res.setHeader('Set-Cookie', 'oreacle_uid=' + uid + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax');
}
function wasCounted(map, key, t) {
  if (map.get(key) === t) return true;
  map.set(key, t);
  return false;
}

// 每分钟清理限流桶与每日去重/配额表，防止内存膨胀
setInterval(() => {
  const now = Date.now();
  const t = today();
  for (const [k, v] of rateBuckets) if (now >= v.resetAt) rateBuckets.delete(k);
  for (const [k, v] of dailyRecordCounts) if (v.date !== t) dailyRecordCounts.delete(k);
  for (const [k, v] of dailyVisits) if (v !== t) dailyVisits.delete(k);
  for (const [k, v] of dailyFortunes) if (v !== t) dailyFortunes.delete(k);
  for (const [k, v] of dailyFortuneSeen) if (v.date !== t) dailyFortuneSeen.delete(k);
  for (const [k, v] of dailyIpFortunes) if (v.date !== t) dailyIpFortunes.delete(k);
}, RATE_WINDOW_MS).unref();

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
  req.on('data', c => { body += c; if (body.length > 16 * 1024) { req.destroy(); return; } });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ─── 统计 API ───
  if (p === '/api/stats' && req.method === 'GET') {
    sendJson(res, 200, { date: today(), visits: getStats().visits, fortunes: getStats().fortunes });
    return;
  }
  if (p === '/api/stats/visit' && req.method === 'POST') {
    const rt = RATE_LIMITS.visit;
    if (!allowRate('v:' + ip, rt.limit, rt.windowMs)) {
      sendJson(res, 429, { ok: false, error: 'too many requests' });
      return;
    }
    // NEW-03：有签名 cookie 按 uid 去重；首次（无 cookie）按 IP 当日去重并签发 uid
    const t = today();
    let uid = getUid(req);
    const isNewUid = !uid;
    uid = uid || newUid();
    const counted = !wasCounted(dailyVisits, isNewUid ? ip : uid, t);
    if (isNewUid) dailyVisits.set(uid, t); // 预注册新 uid：二次访问（带 cookie）不重复计
    const stats = counted ? await bumpStats('visits') : getStats();
    setUidCookie(res, uid);
    sendJson(res, 200, { ok: true, date: t, visits: stats.visits, fortunes: stats.fortunes });
    return;
  }
  if (p === '/api/stats/fortune' && req.method === 'POST') {
    const rt = RATE_LIMITS.fortune;
    if (!allowRate('f:' + ip, rt.limit, rt.windowMs)) {
      sendJson(res, 429, { ok: false, error: 'too many requests' });
      return;
    }
    const t = today();
    let uid = getUid(req);
    const isNewUid = !uid;
    uid = uid || newUid();
    const counted = !wasCounted(dailyFortunes, isNewUid ? ip : uid, t);
    if (isNewUid) dailyFortunes.set(uid, t);
    const stats = counted ? await bumpStats('fortunes') : getStats();
    setUidCookie(res, uid);
    sendJson(res, 200, { ok: true, date: t, visits: stats.visits, fortunes: stats.fortunes });
    return;
  }

  // ─── 算卦记录 API ───
  if (p === '/api/records' && req.method === 'GET') {
    const rt = RATE_LIMITS.records_get;
    if (!allowRate('rg:' + ip, rt.limit, rt.windowMs)) {
      sendJson(res, 429, { ok: false, error: 'too many requests' });
      return;
    }
    // 标注本机：用请求方 uid（若已签发）派生短哈希，匹配该访客自己的记录
    const meUid = getUid(req);
    const meTag = meUid ? shortHash(meUid) : '';
    const records = getRecords().slice(0, 1000).map(r => Object.assign({}, r, { isMine: !!meTag && r.tag === meTag }));
    sendJson(res, 200, { records });
    return;
  }
  if (p === '/api/records' && req.method === 'POST') {
    readBody(req, async body => {
      const rt = RATE_LIMITS.records_post;
      if (!allowRate('rp:' + ip, rt.limit, rt.windowMs)) {
        sendJson(res, 429, { ok: false, error: 'too many requests' });
        return;
      }
      try {
        const rec = JSON.parse(body || '{}');
        // NEW-01：卦象 / 等级走服务端白名单，不在白名单一律 400
        const guaName = String(rec.guaName || '').trim();
        const levelName = String(rec.levelName || '').trim();
        if (!GUA_WHITELIST.has(guaName)) {
          sendJson(res, 400, { ok: false, error: 'invalid gua' });
          return;
        }
        if (!LEVEL_COLOR_MAP[levelName]) {
          sendJson(res, 400, { ok: false, error: 'invalid level' });
          return;
        }
        // NEW-05：服务端「每日一卦」enforcement —— 有签名 uid 时一天仅一条（同卦幂等、异卦拒绝）
        //         无 uid（清 Cookie / API 直打）回退 IP：同卦幂等去重 + 单 IP 每日上限
        const t = today();
        const uid = getUid(req);
        const key = uid || ('ip:' + ip);
        const visitorHash = shortHash(uid || ('ip:' + ip)); // uid(或IP)派生的短哈希, 用于记录小尾巴
        const seen = dailyFortuneSeen.get(key);
        if (seen && seen.date === t) {
          if (seen.gua === guaName && seen.level === levelName) {
            // 同一访客清存储重抽到的同一卦：幂等，不重复入库（路径A）
            sendJson(res, 200, { ok: true, already: true, hash: visitorHash });
            return;
          }
          if (uid) {
            // 有 uid 却试图换卦（换浏览器/时区等重抽）：服务端拒绝该记录（路径B/C主体）
            sendJson(res, 409, { ok: false, error: 'already done', hash: visitorHash });
            return;
          }
          // 无 uid（共享 IP 下不同访客抽到不同卦）：放行，由下方每日上限约束
        }
        // MVW-11 修复（IP 级）：单 IP 当天相同的「卦+等级」，不论 uid 是否铸造，一律视为重复，幂等返回。
        // 攻击者用 POST /api/stats/visit 铸造多 uid 发【相同卦】的刷记录行为在此被拦截。
        const pair = guaName + '|' + levelName;
        const ipRow = dailyIpFortunes.get(ip);
        if (ipRow && ipRow.date === t && ipRow.set.has(pair)) {
          sendJson(res, 200, { ok: true, already: true, hash: visitorHash });
          return;
        }
        // MVW-11 修复（IP 级）：每日上限对【所有】记录请求统一生效（含带 uid 的）。
        // uid 可被无限铸造，若仅对无 uid 的请求限流则可被绕过；发【不同卦】仍受此上限约束。
        if (!allowDailyRecord(ip)) {
          sendJson(res, 429, { ok: false, error: 'daily record limit reached' });
          return;
        }
        // 全部字段服务端生成/映射：IP 打码、颜色按等级、时间当前时间
        await addRecord({
          ip: maskIp(ip),
          guaName: guaName,
          levelName: levelName,
          levelColor: LEVEL_COLOR_MAP[levelName],
          time: nowTime(),
          tag: visitorHash
        });
        if (ipRow && ipRow.date === t) ipRow.set.add(pair);
        else dailyIpFortunes.set(ip, { date: t, set: new Set([pair]) });
        dailyFortuneSeen.set(key, { date: t, gua: guaName, level: levelName });
        sendJson(res, 200, { ok: true, hash: visitorHash });
      } catch (e) { sendJson(res, 400, { ok: false, error: 'bad json' }); }
    });
    return;
  }

  // ─── 静态托管 ───
  let filePath = p === '/' ? path.join(ROOT, 'Oreacle.html') : path.join(ROOT, decodeURIComponent(p));
  if (!filePath.startsWith(ROOT)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return; } // 防路径穿越
  // 防护：禁止直接读取内部数据与源码文件（nginx 层亦拦截 /data/）
  if (p === '/data' || p.startsWith('/data/') ||
      /^\/(server\.js|test_api\.js|\.user\.ini|\.htaccess)$/.test(p)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' }); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream' }, CORS));
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('▶ Oreacle 服务已启动：http://localhost:' + PORT);
  console.log('  静态页面：http://localhost:' + PORT + '/Oreacle.html');
  console.log('  API：/api/stats  /api/stats/visit  /api/stats/fortune  /api/records');
});