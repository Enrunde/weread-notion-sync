/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书 · 官方 Agent API Gateway 客户端（★ 2026-11-07 新增 ★）
 * ══════════════════════════════════════════════════════════════
 *
 *  ★★★ 为什么加这个（★ 解决「大问题」★★★）
 *   ★ 之前的方案（微信读书接口.js）靠 Cookie 里的 wr_vid + wr_skey ★
 *   ★ 实测踩坑：
 *     · wr_localvid（设备 ID）被当成账号 ID → API 报 -2010「用户不存在」
 *     · /api/login/refresh 续期端点【已全 404】→ HTTP 续期走不通
 *     · 症状极具误导性：书架能读（HTML 不校验）但划线/进度全 0
 *       → 看起来像「账号没划线」→ 排查方向全错
 *   ★ 官方 Gateway 用【API Key】认证 → Key 直接绑定 vid → 不依赖 Cookie ★
 *   ★ ★ 而且【云端 GitHub Actions 也能用】→ 不需要浏览器、不需要扫码 ★
 *
 *  ★★★ 认证 ★★★
 *   POST https://i.weread.qq.com/api/agent/gateway
 *   Header: Authorization: Bearer wrk-xxxx
 *   Body:   { api_name, skill_version, ...业务参数平铺 }
 *
 *  ★★★ 关键约束（★ 官方 skill 文档写明的 ★）★★
 *   · 业务参数【平铺在 body 顶层】→ 包在 params 里后端收不到
 *   · 每次请求必须带 skill_version（用于版本检查）
 *   · 回包出现 upgrade_info → 必须按指引升级后重试
 *   · 翻页用 lastSort 游标（notebooks）/ synckey（review），不要用 offset/limit
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SYNC = __dirname;
const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.5";

/** ★ 凭证文件（★ 与 微信读书凭证.txt 分开 ★）*/
const APIKEY_FILE = path.join(SYNC, "微信读书APIKey.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 API Key（★ 优先环境变量 → 云端可用 ★）*/
function readApiKey() {
  const fromEnv = String(process.env.WEREAD_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (!fs.existsSync(APIKEY_FILE)) return "";
  try {
    const txt = fs.readFileSync(APIKEY_FILE, "utf8");
    const m = /wrk-[A-Za-z0-9_-]+/.exec(txt);
    return m ? m[0] : "";
  } catch (e) {
    return "";
  }
}

function saveApiKey(key) {
  fs.writeFileSync(
    APIKEY_FILE,
    ["════ 微信读书 官方 API Key ════", "★ 从微信读书 App 生成（设置 → 开发者 → API Key）", "", "key=" + key, ""].join("\n"),
    "utf8"
  );
}

function hasApiKey() {
  return !!readApiKey();
}

/**
 * 调用 Gateway
 * @param {string} apiName  如 /user/notebooks
 * @param {object} params   业务参数（★ 平铺在 body 顶层 ★）
 * @returns {Promise<object>}
 */
/**
 * ★★★ 请求节流（★ 2026-11-07 新增 ★）★★★
 *   ★ 为什么要：★ 全量同步 107 本书 = 300+ 次请求 → 必撞「频率超限 -2014」★
 *   ★ 表现：HTTP 499 → 抛错 → 降级 Cookie → 整个同步中止 ✘✘✘ ★
 *   ★ 做法：★ 全局最小间隔（默认 350ms）→ 主动慢下来，不撞限流 ★
 *   ★ 限流是【账号级】的 → 全局串行排队最稳 ★
 */
let _lastReqAt = 0;
let _minGap = 350;
function setMinGap(ms) {
  const n = Number(ms);
  if (n > 0) _minGap = n;
}
async function throttle() {
  const now = Date.now();
  const wait = _lastReqAt + _minGap - now;
  if (wait > 0) await sleep(wait);
  _lastReqAt = Date.now();
}

async function gw(apiName, params, opt) {
  const key = (opt && opt.apiKey) || readApiKey();
  if (!key) throw new Error("没有微信读书 API Key（跑 双击登录微信读书.bat 或写入 微信读书APIKey.txt）");

  const body = Object.assign({ api_name: apiName, skill_version: SKILL_VERSION }, params || {});

  for (let attempt = 1; attempt <= 5; attempt++) {
    await throttle();
    const r = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = { _raw: t.slice(0, 300) }; }

    // ★★★ 频率超限：★ HTTP 429 或 HTTP 499 + errcode -2014 ★★★ ★
    //   ★ 微信读书的限流【不】返回 429，而是 499 + errcode -2014 ★
    //   ★ 之前只认 429 → 限流直接抛错 → 降级 Cookie → 整个同步中止 ✘✘✘ ★
    const code0 = j && j.errcode !== undefined ? Number(j.errcode) : 0;
    const rateLimited =
      r.status === 429 ||
      r.status === 499 ||
      code0 === -2014 ||
      /频率超限|请求过于频繁|too many requests/i.test(String((j && j.errmsg) || "") + " " + t);
    if (rateLimited) {
      // ★ 指数退避：2s / 4s / 8s / 16s ★
      if (attempt >= 5) {
        throw new Error("微信读书 API 频率超限（重试 5 次仍失败）→ 稍后再跑一次即可");
      }
      await sleep(Math.min(2000 * Math.pow(2, attempt - 1), 30000));
      continue;
    }
    if (!r.ok) throw new Error("微信读书 API HTTP " + r.status + " → " + t.slice(0, 200));

    const code = code0;
    if (code !== 0) {
      throw new Error("微信读书 API 报错 " + code + " → " + String(j.errmsg || j.errMsg || "").slice(0, 120));
    }
    // ★ 版本升级提示 → 必须按指引升级后重试（★ 官方 skill 规则 ★）★
    if (j.upgrade_info) {
      throw new Error("微信读书技能需要升级：" + String(j.upgrade_info.message || "").slice(0, 200));
    }
    return j;
  }
  throw new Error("微信读书 API 重试耗尽");
}

/**
 * 书架（★ 返回 { books, albums, mp } ★）
 */
async function getShelf() {
  const j = await gw("/shelf/sync", {});
  return {
    books: j.books || [],
    albums: j.albums || [],
    mp: j.mp || null,
  };
}

/**
 * 有划线/笔记的书（★ 游标分页翻到底 ★）
 */
async function getNotebooks(opt) {
  const out = [];
  let lastSort = 0;
  let guard = 0;
  for (;;) {
    const p = lastSort ? { count: 100, lastSort } : { count: 100 };
    const j = await gw("/user/notebooks", p, opt);
    const bs = j.books || [];
    out.push(...bs);
    if (!j.hasMore || !bs.length) break;
    lastSort = bs[bs.length - 1].sort;
    if (++guard > 50) break;
  }
  return out;
}

/**
 * 单本书的划线（★ 字段名与旧接口一致，便于复用 ★）
 */
async function getBookmarks(bookId, opt) {
  const j = await gw("/book/bookmarklist", { bookId: String(bookId) }, opt);
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
      note: "",
    });
  }
  return out;
}

/**
 * 单本书的个人想法 / 点评
 */
async function getReviews(bookId, opt) {
  const j = await gw("/review/list/mine", { bookid: String(bookId), count: 100 }, opt);
  const out = [];
  for (const r of j.reviews || []) {
    const rv = r.review || r;
    out.push({
      id: String(rv.reviewId || r.reviewId || ""),
      content: rv.content || "",
      // ★ abstract = 想法对应的划线原文 ★
      abstract: rv.abstract || "",
      createTime: rv.createTime || "",
      updateTime: rv.updateTime || rv.createTime || "",
      star: rv.star || 0,
      chapter: rv.chapterName || "",
      chapterUid: rv.chapterUid || 0,
      range: rv.range || "",
      type: rv.type || 0,
    });
  }
  return out;
}

/**
 * 一次拿到「划线 + 想法」并按 range 关联（★ 与旧接口同签名 ★）
 */
async function getMarksAndNotes(bookId, opt) {
  const bm = await getBookmarks(bookId, opt);
  const rv = await getReviews(bookId, opt);
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
 * 阅读进度（★ 与旧接口同结构 ★）
 */
async function getProgress(bookId, opt) {
  const j = await gw("/book/getprogress", { bookId: String(bookId) }, opt);
  const b = j.book || {};
  return {
    chapterIndex: b.chapterUid || 0,
    chapterOffset: b.chapterOffset || 0,
    updateTime: b.updateTime || 0,
    readingTime: Math.round((b.recordReadingTime || 0) / 60),   // ★ 秒 → 分钟（与旧接口一致）★
    overallProgress: b.progress || 0,                            // ★ 0-100（与旧接口一致）★
    startReadingTime: b.startReadingTime || 0,
    finishTime: b.finishTime || 0,
    isStartReading: b.isStartReading || 0,
    timestamp: j.timestamp || 0,
  };
}

/**
 * 书籍详情（★ 补齐书架里没有的字段 ★）
 */
async function getBookInfo(bookId, opt) {
  try {
    const j = await gw("/book/info", { bookId: String(bookId) }, opt);
    const b = j.book || j;
    return {
      bookId: String(b.bookId || bookId),
      title: b.title || "",
      author: b.author || "",
      intro: b.intro || "",
      isbn: b.isbn || "",
      category: (b.categories && b.categories[0] && b.categories[0].title) || "",
      bookUrl: b.readerLink || b.deepLink || ("https://weread.qq.com/web/reader/" + bookId),
      cover: b.cover || "",
      readState: b.readState || 0,
      publishTime: b.publishTime || "",
      wordCount: b.wordCount || 0,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  readApiKey, saveApiKey, hasApiKey, gw, setMinGap,
  getShelf, getNotebooks, getBookmarks, getReviews, getMarksAndNotes, getProgress, getBookInfo,
  GATEWAY, SKILL_VERSION, APIKEY_FILE,
};
