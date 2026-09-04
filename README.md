# Oreacle · 我的世界赛博算卦所

> **Oreacle** = Ore（矿石）+ Oracle（神谕）—— 挖矿与占卜的双关。本页中文名：我的世界 · 赛博算卦所。

一个纯前端的 Minecraft 主题"每日一卦"网页 —— 打开页面，点一下"开始算卦"，红石电路帮你算今日运势。

## 功能

- **每日一卦**：按下按钮 → 加载动画（模拟红石信号）→ 生成卦象
- **卦象体系**：苦力怕 / 岩浆 / 泥土 / 末影 / 村民 / 黑曜石 / 红石 / 钻石 八卦 + 六爻
- **今日指引**：卦辞、宜 / 忌、今日提示、幸运物 / 幸运坐标 / 幸运附魔 / 幸运羊毛、签诗
- **每日限制**：每日 00:00 刷新，一天只能算一次（localStorage + 设备指纹 + Cookie + IndexedDB 五层防护）
- **逆天改命检测**：清缓存重算会被识别，欧气减半 😏
- **真实访客记录**：算卦后自动保存真实记录并展示（无伪造数据）
- **真实统计**：「今日访问 / 今日算卦」真实计数（无模拟数字）—— 部署时由服务端统一记录
- **上次卦象记忆**：算过的卦自动记住，回访时顶部显示

## 为什么是"干净版"

原版页面塞了一批**模拟数据**（假访客 IP、假时间、假访问量"今日访问1320"），用于演示效果。这份版本已把这些**全部清除**：

- ❌ 删掉：模拟访客列表、假时间戳、伪造的访问量基数
- ✅ 保留：访客记录功能（改读真实记录）、统计功能（改真实计数）、全部算卦主体逻辑

数据的呈现方式现在是**真实本机数据**，方便直接做开源基础版。

## 开源 / 部署为网站

本页面为**纯前端 + 可选服务端**架构。访客统计和算卦记录由 **`server.js` 统一记录**（服务端优先），无服务端时自动回退本机真实计数。

| 能力 | 本地打开（file://） | 部署后（node server.js） |
|---|---|---|
| 今日访问/算卦统计 | localStorage 按日真实计数 | `GET /api/stats` / `POST /api/stats/visit` |
| 访客记录 | 本机真实算卦记录 | `GET /api/records` / `POST /api/records`（掩码访客 IP，不落盘真实 IP） |
| 上次卦象 | localStorage | localStorage（可扩展为服务端会话记忆） |
| 每日一卦限制 | 本机指纹/存储 | 本机指纹/存储（可扩展为服务端限流） |

前端通过 `IS_DEPLOYED` 自动判断：以 http/https 打开时走服务端 API，直接双击本地打开时走 localStorage 兜底，无需改代码。

## 项目结构

```
Oreacle/
├── Oreacle.html   # 赛博算卦所 单页应用
├── server.js      # 零依赖 Node.js 服务端（统计/记录 API + 静态托管）
├── data/          # 服务端数据（stats.json 按日统计 / records.json 算卦记录，自动生成）
├── test_api.js    # 服务端 API 自测脚本（node test_api.js）
├── LICENSE        # MIT 许可证
└── README.md      # 本说明
```

## 部署方式

### 方式一：本地使用（纯前端，无需服务器）

直接双击 `Oreacle.html` 即可本地算卦。访问/算卦统计在本机真实计数。

### 方式二：服务端记录（推荐，node 环境）

```bash
node server.js   # 默认端口 3000，可用 PORT 环境变量覆盖
```

启动后访问 `http://localhost:3000/Oreacle.html`，访问和算卦全部由服务端记录：

- `GET  /api/stats` → `{ visits, fortunes }`（今日统计）
- `POST /api/stats/visit` → 上报一次访问（同一访客每日只计一次，服务端签发 HttpOnly cookie 去重）
- `POST /api/stats/fortune` → 上报一次算卦（同一访客每日只计一次）
- `GET  /api/records` → 最近算卦记录
- `POST /api/records` → 写入一条算卦记录（卦象/等级走服务端白名单，IP 服务端打码为 `x.x.*.*`，时间服务端生成，客户端字段一律不采信）

数据落在 `data/` 目录（`stats.json` 按日统计、`records.json` 最近 50 条，均为 JSON 明文），服务端零依赖，无需 `npm install`。

## 安全加固说明（2026-08-21 夜，MVW + NEW 全量修复）

| 编号 | 问题 | 修复方式 |
|---|---|---|
| MVW-01 | 存储型 XSS | 展示字段改由服务端白名单生成，无注入面；前端仍以 `textContent` 渲染兜底 |
| MVW-02 | 访客真实 IP 明文存储并公开返回 | 只落盘服务端打码 IP（`remoteAddress` → `x.x.*.*`），不存明文 PII |
| MVW-03 | `/api/stats/visit`、`/api/stats/fortune` 可刷数 | 按 IP 限流（访问 120 次/分，算卦 30 次/分），超限返回 `429` |
| MVW-04 | `/api/records` 可刷库挤占 | 写入限流（10 次/分）+ 单 IP 每日上限 30 条 + 字段白名单校验 |
| NEW-01 | 访客记录可整体伪造 | **服务端收权**：IP 服务端打码、卦象走六十四卦白名单（8 上卦×8 下卦）、等级走六等级白名单、颜色由等级映射、时间服务端生成——客户端字段一律不再采信 |
| NEW-02 | 无效请求消耗每日配额 | 每日配额检查移到 JSON/白名单校验**之后**，垃圾请求不再占额度 |
| NEW-03 | 限流阈值下的刷数空间 | 访问/算卦按「签名 cookie uid（优先）或 IP」**每日去重**计数，刷新页面不重复计 |
| NEW-04 | `stats.json` 并发写竞争 | 读-改-写经 Promise 串行化 + 临时文件重命名**原子写**，防并发丢更新 / 半截 JSON |

限流与每日计数/去重均为内存态，服务重启即重置；数据文件依旧零依赖、明文 JSON。







更新：
2026/8/23
删除了 <head> 里的 __itrace（阿里云）监控上报脚本（含 g.alicdn.com/woodpeckerx/... 与 px.effirst.com 上报），功能无影响。
server.js（在 NEW-01~04 版本基础上）

nowTime()：记录时间从 HH:MM → 年-月-日 时:分:秒（东八区）
记录上限：50 条 → 1000 条，slice(0,1000)，超出自动删最旧；GET /api/records 返回从 10 → 1000
clientIp()：改为读取 X-Real-IP/X-Forwarded-For（部署相关：在 nginx 反向代理后，否则 maskIp 会把所有访客打成 127.0.*.* 且限流失效）
绑定 127.0.0.1（部署相关：不对外暴露 node 端口）
新增 /data/、server.js、test_api.js、.user.ini、.htaccess 静态访问拦截（安全加固）
修改了底下的小字
核心（server.js）：服务端每日一卦收权（NEW-05）

有签名 uid cookie（正常访客）→ 一天仅一条：
同卦重抽（清存储重抽同一卦，路径A）→ 返回 {ok:true, already:true}，幂等，不重复入库
试图换卦（换浏览器/时区/API 直打，路径B/C/D 主体）→ HTTP 409 already done，拒绝入库
无 uid（清 Cookie 后 / curl 直打） → 回退 IP：
同卦幂等去重（防刷重复记录）
保留单 IP 每日上限（30 条），垃圾请求不占配额
新增 dailyFortuneSeen 表 + 每分钟清理
前端加固（路径 B）

从设备指纹中移除时区字段：切时区不再改变指纹 → 不再因此产生新种子/新卦
第一层 —— 单 IP 当天相同卦去重

新增 dailyIpFortunes（ip -> {date, Set<卦|等级">}）：同一 IP 当天已抽过完全相同的卦+等级（无论 uid 是什么）→ 视为重复，返回 {ok:true, already:true}，不再入库。
直接拦截报告复现："铸造多个 uid、同一 IP 发相同卦。
第二层 —— 每日上限对所有请求统一生效

原代码 if (!uid) { allowDailyRecord(ip) } 是缺口；现改为无条件 allowDailyRecord(ip)（单 IP 每日 30 条，含带 uid 的请求）。
所以即使攻击者不断铸造新 uid，也只能受单 IP 每日 30 条 + 每分钟 10 条约束，无法无上限。
服务端（server.js）

每条记录新增 tag 字段：uid（无 uid 时用 IP）派生的 4 位短哈希（sha256(...).slice(0,4)）
POST /api/records 响应体返回 hash（本机小尾巴，前端可用）
GET /api/records 额外返回 isMine：用请求方 uid 派生哈希，自动标出属于本访客的那条记录
前端（Oreacle.html，已同步 index.html）

访客列显示小尾巴：47.239.*.*·a3f2
本机记录：整行高亮（浅绿）+ 尾缀 · 本机
## 开源协议

MIT License（见 `LICENSE` 文件）—— 可自由使用、修改、商用，保留版权声明即可。

---

**说明**：卦象纯属娱乐，挖矿请遵守（游戏内的）物理规律。

---

## 🤖 AI 使用声明 / AI Usage Disclosure

本项目在开发与维护过程中使用了 AI 编程助手（Claude / Anthropic）辅助代码编写、文档整理与问题排查；核心决策、内容审核与最终发布由维护者完成。

This project was developed and maintained with the assistance of an AI coding assistant (Claude / Anthropic) for coding, documentation, and troubleshooting. Core decisions, content review, and final releases are made by the maintainer.
