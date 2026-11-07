/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书 接口客户端
 * ══════════════════════════════════════════════════════════════
 *
 *  ★ 认证机制（★ 逆向自开源项目 onyas/weread-exporter 的 api.ts）★★
 *  · 请求头带 x-vid + x-skey（不是 Cookie）
 *  · skey 约 2 小时过期 → 用 refreshToken 调 /api/login/refresh 换新的
 *  · 失效特征：HTTP 401 或 errcode/errCode = -2012
 *
 *  ★★ 端点（★ 都是实测出来的，别猜 ★★）
 *  GET  /api/user/notebook                              有划线/笔记的书 + 书架
 *  GET  /web/book/info?bookId=xxx                     书籍详情
 *  GET  /web/book/bookmarklist?bookId=xxx              划线
 *  GET  /web/review/list?bookId=xxx&listType=11&mine=1&synckey=0   我的想法/笔记
 *  GET  /web/book/chapterInfos                         章节
 *  GET  /web/book/getProgress?bookId=xxx               阅读进度
 *  POST /api/login/refresh                             换新 skey
 */

const fs = require("fs");
const path = require("path");

const SYNC = __dirname;
const CRED_FILE = path.join(SYNC, "微信读书凭证.txt");

const BASE = "https://weread.qq.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════
//  凭证
// ══════════════════════════════════════════════════
function readCred() {
  const cred = { vid: "", skey: "", refreshToken: "" };

  // ★★ 云端（GitHub Actions）优先用环境变量 ★★
  if (process.env.WEREAD_VID || process.env.WEREAD_SKEY) {
    return {
      vid: String(process.env.WEREAD_VID || "").trim(),
      skey: String(process.env.WEREAD_SKEY || "").trim(),
      refreshToken: String(process.env.WEREAD_REFRESH_TOKEN || "").trim(),
    };
  }

  if (!fs.existsSync(CRED_FILE)) return cred;
  try {
    const txt = fs.readFileSync(CRED_FILE, "utf8");
    txt.split(/\r?\n/).forEach((line) => {
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      const k = m[1].toLowerCase();
      let v = m[2].trim();
      // ★ refreshToken 常是 URL 编码的 → 解码 ★
      if (k === "refreshtoken") { try { v = decodeURIComponent(v); } catch (e) { /* 原样 */ } }
      if (k === "vid") cred.vid = v;
      else if (k === "skey") cred.skey = v;
      else if (k === "refreshtoken") cred.refreshToken = v;
    });
  } catch (e) { /* 忽略 */ }
  return cred;
}

function saveCred(cred) {
  const lines = [
    "════ 微信读书登录凭证 ════",
    "★ 由「微信读书登录.js」自动生成",
    "★ 换电脑：在这台机器跑一次 node 微信读书登录.js 扫码即可",
    "",
    "vid=" + (cred.vid || ""),
    "skey=" + (cred.skey || ""),
    "refreshToken=" + (cred.refreshToken || ""),
    "",
  ];
  fs.writeFileSync(CRED_FILE, lines.join("\n"), "utf8");
}

// ══════════════════════════════════════════════════
//  HTTP
// ══════════════════════════════════════════════════
let _cred = null;

function headers(cred) {
  const h = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://weread.qq.com/",
  };
  if (cred && cred.vid) h["x-vid"] = cred.vid;
  if (cred && cred.skey) h["x-skey"] = cred.skey;
  // ★★★ Cookie 头【也要带】★★★ ★
  //   ★ 实测：/web/shelf 这类 HTML 端点【只认 Cookie】→ 不带就返回未登录页面（书全空）★
  //   ★ 而 /api/user/notebook 等 JSON 端点认 x-vid/x-skey ★
  //   ★ → ★ 两个都带，最稳 ★
  if (cred && cred.vid && cred.skey) {
    h["Cookie"] = "wr_vid=" + cred.vid + "; wr_skey=" + cred.skey +
      (cred.refreshToken ? "; wr_rt=" + encodeURIComponent(cred.refreshToken) : "");
  }
  return h;
}

/** ★ 登录态失效 → 用 refreshToken 换新的 ★ */
async function refresh(cred) {
  if (!cred.refreshToken || !cred.vid) return false;
  try {
    const r = await fetch(BASE + "/api/login/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Accept: "application/json" },
      body: JSON.stringify({ vid: cred.vid, refreshToken: cred.refreshToken }),
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* 忽略 */ }
    if (j && (j.succeed === true || j.success === true) && j.accessToken) {
      cred.skey = String(j.accessToken);
      if (j.refreshToken) cred.refreshToken = String(j.refreshToken);
      saveCred(cred);
      return true;
    }
  } catch (e) { /* 忽略 */ }
  // ★★★ HTTP 续期端点已失效（★ 实测 /api/login/refresh 全 404 ★）→ 走 CDP 兜底 ★★★
  return await refreshViaCDP(cred);
}

/**
 * ★★★ CDP 兜底续期（★ HTTP 端点 404 时的唯一可行路 ★）★★
 *
 *  ★ 原理：微信读书 HTTP 续期接口已下线 → 但浏览器里的 Cookie 仍是活的 ★
 *   → 通过 Chrome DevTools Protocol 从【专用 profile】里读最新 Cookie ★
 *   → wr_skey 就是新的 skey，wr_vid 是真正的账号 ID ★
 *
 *  ★ 前提：专用 profile 的浏览器还在跑（微信读书登录.js 启动的那个）★
 *   → 没跑就返回 false → 提示用户重新扫码 ★
 */
async function refreshViaCDP(cred) {
  const PORT = 9333;
  // ★ 与 微信读书登录.js 保持一致（★ profile 已搬到 vault 外 ★）
  const PROFILE_DIR = path.join(
    path.dirname(path.dirname(path.dirname(__dirname))),
    "同步仓库", "weread_chrome_profile"
  );
  try {
    // ① CDP 是否可用
    let targets = [];
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (!r.ok) return false;
      targets = await r.json();
    } catch (e) {
      return false;
    }
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) return false;

    // ② 读 Cookie
    const cookies = await new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch (e) { return reject(e); }
      const timer = setTimeout(() => {
        try { ws.close(); } catch (e) { /* ignore */ }
        reject(new Error("CDP 超时"));
      }, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { /* ignore */ }
        if (msg && msg.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch (e) { /* ignore */ }
          if (msg.error) return reject(new Error(msg.error.message || "CDP 错误"));
          resolve(msg.result && msg.result.cookies ? msg.result.cookies : []);
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket 连接失败")); };
    });

    // ③ 挑出 wr_vid / wr_skey / wr_rt
    const pick = {};
    for (const c of cookies) {
      const d = String(c.domain || "");
      if (d.indexOf("weread.qq.com") < 0) continue;
      const n = String(c.name || "");
      if (n === "wr_vid" || n === "wr_skey" || n === "wr_rt" || n === "wr_localvid") {
        pick[n] = String(c.value || "").trim();
      }
    }
    // ★ 必须有 wr_vid（账号 ID）→ 只有 wr_localvid 的话 API 会报「用户不存在」★
    if (!pick.wr_skey || !pick.wr_vid) return false;

    cred.vid = pick.wr_vid;
    cred.skey = pick.wr_skey;
    if (pick.wr_rt) cred.refreshToken = pick.wr_rt;
    saveCred(cred);
    return true;
  } catch (e) {
    return false;
  }
}

function isAuthExpired(status, json) {
  if (status === 401) return true;
  const code = json && (json.errcode ?? json.errCode);
  // ★★ -2012 = 登录超时；-2010 = 「用户不存在」→ 都是认证问题 ★★
  //   ★ -2010 的成因：vid 存成了设备 ID（wr_localvid）而不是账号 ID（wr_vid）★
  //   ★ → 续期（CDP）能同时修好两个 ★
  return Number(code) === -2012 || Number(code) === -2010;
}

/** 统一请求（★ 认证失效时自动续期重试一次 ★）*/
async function req(method, apiPath, body, cred) {
  const c = cred || _cred || (_cred = readCred());
  if (!c.vid || !c.skey) throw new Error("没有微信读书凭证（先跑 微信读书登录.js）");

  const doOnce = async () => {
    const r = await fetch(BASE + apiPath, {
      method,
      headers: headers(c),
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = { _raw: t.slice(0, 300) }; }
    return { status: r.status, json: j };
  };

  let res = await doOnce();
  if (isAuthExpired(res.status, res.json)) {
    if (await refresh(c)) {
      res = await doOnce();
    } else {
      const code = res.json && (res.json.errcode ?? res.json.errCode);
      if (Number(code) === -2010) {
        throw new Error("微信读书：账号 ID 无效（vid 是设备 ID 不是账号 ID）" +
          " → 请跑 双击登录微信读书.bat 重新扫码");
      }
      throw new Error("微信读书登录态失效 → 请跑 双击登录微信读书.bat 重新扫码");
    }
  }
  if (res.status >= 400) {
    throw new Error("HTTP " + res.status + " " + JSON.stringify(res.json).slice(0, 180));
  }
  // ★ 服务端也可能用 200 + errcode 报错 ★
  const code = res.json && (res.json.errcode ?? res.json.errCode);
  if (code !== undefined && Number(code) !== 0) {
    throw new Error("接口报错 " + code + " → " +
      String(res.json.errmsg || res.json.errmsg || res.json.errMsg || "").slice(0, 120));
  }
  return res.json;
}

// ══════════════════════════════════════════════════
//  数据接口
// ══════════════════════════════════════════════════

/**
 * 笔记本（★ 一次拿到「有划线/笔记的书」+ 书架概要 ★）
 * @returns {Array} [{ bookId, book:{title,author,...}, reviewCount, noteCount, bookmarkCount }]
 */
async function getNotebooks(cred) {
  const j = await req("GET", "/api/user/notebook", null, cred);
  const out = [];
  for (const b of j.books || []) {
    const book = b.book || {};
    out.push({
      bookId: String(b.bookId || book.bookId || ""),
      book: {
        title: book.title || "",
        author: book.author || "",
        bookId: book.bookId || b.bookId || "",
        cover: book.cover || "",
        intro: book.intro || "",
        category: (book.categories && book.categories[0] && book.categories[0].title) || "",
        isbn: book.isbn || "",
        bookUrl: book.bookUrl || "",
      },
      reviewCount: b.reviewCount || 0,
      noteCount: b.noteCount || 0,
      bookmarkCount: b.bookmarkCount || 0,
      readState: b.readState || 0,
      updateTime: b.updateTime || 0,
    });
  }
  return out;
}

/**
 * 书架（★ 从 /web/shelf 的 HTML 里解析 window.__INITIAL_STATE__ ★）
 *  ★★ 关键（★ 实测踩坑 ★★）：
 *  · shelf.books 是【空的】→ 真正的书在 rawBooks / shelfIndexes / rawIndexes 里
 *  · rawIndexes = 全量索引（含已归档，107 条）
 *  · shelfIndexes = 在架的（16 条）★ 这才是"我的书架" ★
 *  · rawBooks = 有详情的（31 条）
 * @returns {Object} { books: {bookId: {...}}, ids: [bookId...] }
 */
async function getShelf(cred) {
  const html = await fetchText("/web/shelf", cred);
  const st = extractState(html);
  if (!st) throw new Error("shelf 页面解析失败（可能需要重新登录）");

  const sh = st.shelf || {};
  const books = {};

  // ① rawBooks：带详情的
  for (const b of sh.rawBooks || []) {
    const id = String(b.bookId || "");
    if (!id) continue;
    books[id] = {
      bookId: id,
      title: b.title || "",
      author: b.author || "",
      intro: b.intro || "",
      isbn: b.isbn || "",
      category: (b.categories && b.categories[0] && b.categories[0].title) || "",
      bookUrl: b.bookUrl || ("https://weread.qq.com/web/reader/" + id),
      cover: b.cover || "",
      readState: b.readState || 0,
      publishTime: b.publishTime || "",
      wordCount: b.wordCount || 0,
    };
  }

  // ② 在架的 bookId 列表
  const inShelf = (sh.shelfIndexes || []).map((x) => String(x.bookId || "")).filter(Boolean);
  // ③ 有进度的书也一并算进去
  for (const p of sh.bookProgress || []) {
    const id = String(p.bookId || "");
    if (id && inShelf.indexOf(id) < 0) inShelf.push(id);
  }

  return { books, ids: inShelf, allIds: (sh.rawIndexes || []).map((x) => String(x.bookId || "")).filter(Boolean) };
}

/** 从 html 里提取 window.__INITIAL_STATE__（★ 括号配平，因为 state 里可能有 </script> 字符串 ★）*/
function extractState(html) {
  const key = "window.__INITIAL_STATE__";
  const i = html.indexOf(key);
  if (i < 0) return null;
  const eq = html.indexOf("=", i);
  if (eq < 0) return null;
  let p = eq + 1;
  while (p < html.length && /\s/.test(html[p])) p++;
  if (html[p] !== "{") return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = p; k < html.length; k++) {
    const ch = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(p, k + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/** 取纯文本（★ HTML 端点用 ★）*/
async function fetchText(apiPath, cred) {
  const c = cred || _cred || (_cred = readCred());
  const r = await fetch(BASE + apiPath, { method: "GET", headers: headers(c) });
  const t = await r.text();
  if (r.status === 401) {
    if (await refresh(c)) return await fetchText(apiPath, c);
    throw new Error("微信读书登录态失效 → 请重跑 微信读书登录.js 扫码");
  }
  if (r.status >= 400) throw new Error("HTTP " + r.status + " " + t.slice(0, 120));
  return t;
}

/** 书籍详情（★ 单本 GET ★）*/
async function getBookInfo(bookId, cred) {
  try {
    const j = await req("GET", "/web/book/info?bookId=" + encodeURIComponent(bookId), null, cred);
    const b = j || {};
    return {
      bookId: String(b.bookId || bookId),
      title: b.title || "",
      author: b.author || "",
      intro: b.intro || "",
      isbn: b.isbn || "",
      category: (b.categories && b.categories[0] && b.categories[0].title) || "",
      bookUrl: b.bookUrl || ("https://weread.qq.com/web/reader/" + bookId),
      cover: b.cover || "",
      readState: b.readState || 0,
      publishTime: b.publishTime || "",
      wordCount: b.wordCount || 0,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 划线（★ 结构实测自 onyas/weread-exporter 的 parseResponse.ts ★）
 *  ★★ 关键（★ 我一开始搞错了 ★★）：
 *  · 划线在 【updated[]】★★ 不是 chapters[].bookmarks ★★
 *  · 划线文字字段是 【markText】★★ 不是 content ★★
 *  · 章节在 chapters[] 里，用 chapterUid 关联
 *  · 笔记（review）在 reviews[].review 里，靠 【range】 与划线关联
 */
async function getBookmarks(bookId, cred) {
  const j = await req("GET", "/web/book/bookmarklist?bookId=" + encodeURIComponent(bookId), null, cred);
  const chapters = j.chapters || [];
  const out = [];
  for (const bm of j.updated || []) {
    const ch = chapters.find((c) => c.chapterUid === bm.chapterUid);
    out.push({
      id: String(bm.bookmarkId || "").replace(/[_~]/g, "-"),
      text: bm.markText || "",
      chapter: (ch && ch.title) || "",
      chapterUid: bm.chapterUid || 0,
      range: bm.range || "",
      createTime: bm.createTime || "",
      updateTime: bm.updateTime || bm.createTime || "",
      style: bm.style || 0,
      colorStyle: bm.colorStyle || "",
      note: "",                       // ← 笔记靠 range 关联后填
    });
  }
  return out;
}

/**
 * 我的想法 / 笔记
 * ★ 返回里同时带上 range → 用来和划线关联 ★
 */
async function getReviews(bookId, cred) {
  const out = [];
  try {
    const url = "/web/review/list?bookId=" + encodeURIComponent(bookId) +
      "&listType=11&mine=1&synckey=0";
    const j = await req("GET", url, null, cred);
    for (const r of j.reviews || []) {
      // ★ reviews[].review 才是内容本体（★ 也可能直接是 r.content ★）
      const rv = r.review || r;
      out.push({
        id: String(rv.reviewId || r.reviewId || ""),
        content: rv.content || "",
        createTime: rv.createTime || "",
        updateTime: rv.updateTime || rv.createTime || "",
        star: rv.star || 0,
        chapter: rv.chapterTitle || "",
        range: rv.range || r.range || "",
        type: rv.type || 0,
      });
    }
  } catch (e) {
    // ★★★ 认证错误【不能吞】★★★ ★
    //   ★ 吞掉 → 「划线 0 条」看起来像「账号没划线」→ 误判方向全错 ★
    //   ★ 只有【真的没有笔记】才返回空 ★
    if (isAuthError(e)) throw e;
    return [];
  }
}

/** ★ 这个错误是不是认证问题（★ 决定要不要往上抛 ★）*/
function isAuthError(e) {
  const m = String((e && e.message) || "");
  return /登录态失效|账号 ID 无效|没有微信读书凭证|登录超时|用户不存在/.test(m);
}

/**
 * 一次拿到「划线 + 笔记」并按 range 关联（★ 笔记挂在对应划线下面 ★）
 */
async function getMarksAndNotes(bookId, cred) {
  const bm = await getBookmarks(bookId, cred);
  const rv = await getReviews(bookId, cred);
  // ★ 把笔记挂到对应划线上 ★
  const byRange = new Map();
  for (const r of rv) if (r.range) byRange.set(r.range, r);
  for (const b of bm) {
    const hit = b.range ? byRange.get(b.range) : null;
    if (hit) {
      b.note = hit.content;
      b.noteId = hit.id;
      b.noteCreateTime = hit.createTime;
    }
  }
  return { marks: bm, notes: rv };
}

/**
 * 阅读进度（★ 结构实测：顶层 {bookId, book:{...}, canFreeRead, timestamp} ★）
 *  ★ 进度数字在 book.progress（0-100），不是 0-1 ★
 */
async function getProgress(bookId, cred) {
  try {
    const j = await req("GET", "/web/book/getProgress?bookId=" + encodeURIComponent(bookId), null, cred);
    const b = j.book || {};
    return {
      chapterIndex: b.chapterUid || 0,
      chapterOffset: b.chapterOffset || 0,
      updateTime: b.updateTime || 0,
      readingTime: b.readingTime || 0,          // ★ 阅读时长（分钟）★
      overallProgress: b.progress || 0,          // ★ 0-100 ★
      startReadingTime: b.startReadingTime || 0,
      finishTime: b.finishTime || 0,
      isStartReading: b.isStartReading || 0,
      timestamp: j.timestamp || 0,
    };
  } catch (e) {
    // ★★★ 认证错误【不能吞】★★★ ★
    //   ★ 吞掉 → 进度显示 0 → 看起来像「没读过」→ 误判 ★
    if (isAuthError(e)) throw e;
    return null;
  }
}

module.exports = {
  readCred, saveCred, refresh, extractState,
  getShelf, getNotebooks, getBookInfo, getBookmarks, getReviews, getMarksAndNotes, getProgress,
  BASE, UA,
};
