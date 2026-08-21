// Oreacle 服务端一次性 API 测试（测完即停，不遗留后台进程）
const { spawn } = require('child_process');
const http = require('http');

function call(method, path, body) {
  return new Promise(resolve => {
    const u = new URL('http://localhost:3000' + path);
    const req = http.request(u, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERROR: ' + e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 以 shell 方式启动（在 Git Bash / Windows 下最可靠）
const srv = spawn('node server.js', { cwd: 'C:/Users/32117/OneDrive/Desktop/Oreacle', shell: true, stdio: 'ignore' });

// 探活：最多等 5 秒
function waitUp(n) {
  if (n <= 0) { console.log('❌ 服务 5 秒内未就绪'); srv.kill(); return Promise.resolve(false); }
  return call('GET', '/api/stats').then(r => {
    if (r.status) return true;
    return new Promise(res => setTimeout(() => res(waitUp(n - 1)), 400));
  });
}

waitUp(12).then(ok => {
  if (!ok) return;
  return (async () => {
    const steps = [
      ['POST', '/api/stats/visit', {}, null],
      ['GET', '/api/stats', null, null],
      ['POST', '/api/stats/fortune', {}, null],
      ['POST', '/api/records', { guaName: '钻石卦·上', levelName: '欧皇大吉', levelColor: '#D4A017', time: '21:33' }, null],
      ['GET', '/api/records', null, null],
      ['GET', '/Oreacle.html', null, 'text/html'],
      ['GET', '/', null, 'text/html'],
      ['GET', '/api/nope', null, '404']
    ];
    for (const [m, p, b, expect] of steps) {
      const r = await call(m, p, b);
      const exp = expect ? (r.status === expect ? '✓' : '✗(期望' + expect + ')') : (r.status === 0 ? '✗' : '✓');
      console.log(`${m.padEnd(6)} ${p.padEnd(18)} → ${r.status} ${exp} ${r.status ? '' : r.body}`);
      if (r.status && (expect === 'text/html')) console.log('   正文片段:', (r.body.match(/<title>.*?<\/title>/) || [''])[0]);
    }
  })().then(() => { srv.kill(); console.log('（服务已停止）'); });
});
srv.on('exit', c => console.log('server 进程已退出, code=' + c));