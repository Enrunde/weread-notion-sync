/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书 → Notion「微信读书知识库」写入器
 * ══════════════════════════════════════════════════════════════
 *
 *  ★ 模板结构（★ 用 Notion MCP 读出来的真实 schema）★★
 *  书籍  dsId=91192bf9-b4d9-83de-9bc9-07a43f0f5d1a
 *    标题/书籍ID/ISBN/作者(rel)/分类(rel)/标签(rel)
 *    阅读状态(status 想读在读已读)/阅读进度(number %)/阅读时长（分钟）
 *    推荐值/我的评分/简介/链接/开始阅读时间/最后阅读时间
 *    划线(rel)/笔记(rel)/年(rel)/月(rel)/周(rel)
 *  划线  dsId=9bc92bf9-b4d9-8272-93c7-07f4d89a63f8
 *    标题/划线ID/作者(rel)/分类(rel)/书籍(rel)/笔记(rel)/年/月/周
 *  笔记  dsId=a0b92bf9-b4d9-83b1-94de-0765658c57ca
 *    标题/笔记ID/作者(rel)/书籍(rel)/划线(rel)/年/月/周
 *  标签  dsId=3b192bf9-b4d9-823f-aaf6-0730426931e8
 *  作者  dsId=ac992bf9-b4d9-8294-b808-870d720fc2a1
 *  分类  dsId=69692bf9-b4d9-836f-b021-87bcbd2fa78a
 *  年    dsId=42392bf9-b4d9-8319-8871-07f3f8d7b55b
 *  月    dsId=7e192bf9-b4d9-829a-961f-87d9e0057ee3
 *  周    dsId=ece92bf9-b4d9-82d3-9776-071dfbe65bec
 *
 *  ★★ 幂等策略 ★★
 *  ① 认亲：书籍ID / 划线ID / 笔记ID（都是 text 唯一键）
 *  ② 已存在 → 更新属性 + 正文
 *  ③ 不存在 → 新建
 *  ④ 微信读书侧删了 → 探测不到 → 不动（★ 保守：宁可留着 ★）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SYNC = __dirname;
const TOKEN_FILE = path.join(os.homedir(), ".config", "notion", "token");

const DS_BOOK = "91192bf9-b4d9-83de-9bc9-07a43f0f5d1a";   // 书籍
const DS_MARK = "9bc92bf9-b4d9-8272-93c7-07f4d89a63f8";   // 划线
const DS_NOTE = "a0b92bf9-b4d9-83b1-94de-0765658c57ca";   // 笔记
const DS_TAG = "3b192bf9-b4d9-823f-aaf6-0730426931e8";    // 标签
const DS_AUTHOR = "ac992bf9-b4d9-8294-b808-870d720fc2a1"; // 作者
const DS_CAT = "69692bf9-b4d9-836f-b021-87bcbd2fa78a";    // 分类
const DS_YEAR = "42392bf9-b4d9-8319-8871-07f3f8d7b55b";  // 年
const DS_MONTH = "7e192bf9-b4d9-829a-961f-87d9e0057ee3";  // 月
const DS_WEEK = "ece92bf9-b4d9-82d3-9776-071dfbe65bec";   // 周

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadToken() {
  // ★ 云端（GitHub Actions）用环境变量，本机用文件 ★
  if (process.env.NOTION_TOKEN) return String(process.env.NOTION_TOKEN).trim();
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

async function api(pathname, method, body, token) {
  const tok = token || loadToken();
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch("https://api.notion.com/v1" + pathname, {
      method,
      headers: {
        Authorization: "Bearer " + tok,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    if (r.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = { _raw: t.slice(0, 200) }; }
    if (!r.ok) throw new Error("HTTP " + r.status + " → " + JSON.stringify(j).slice(0, 200));
    return j;
  }
  throw new Error("Notion API 一直 429");
}

// ══════════════════════════════════════════════════
//  通用：一个库的行管理器
// ══════════════════════════════════════════════════
/**
 * ★★★ 把 Notion 属性转成【可比对的扁平值】★★★ ★
 *   ★ 用于三方合并：★ 判断「Notion 现在的值」和「上次同步时的值」是否不同 ★
 *   ★ → 不用 hash（★ hash 碰撞风险 + 不好调试 ★）→ 直接存可读值 ★
 */
function snapshotProps(pr) {
  const out = {};
  for (const k of Object.keys(pr || {})) {
    const v = pr[k];
    if (!v) continue;
    const t = v.type;
    if (t === "title") {
      out[k] = (v.title || []).map((x) => x.plain_text).join("");
    } else if (t === "rich_text") {
      out[k] = (v.rich_text || []).map((x) => x.plain_text).join("");
    } else if (t === "number") {
      out[k] = v.number === null || v.number === undefined ? "" : String(v.number);
    } else if (t === "url") {
      out[k] = v.url || "";
    } else if (t === "status") {
      out[k] = (v.status && v.status.name) || "";
    } else if (t === "select") {
      out[k] = (v.select && v.select.name) || "";
    } else if (t === "date") {
      out[k] = (v.date && v.date.start) || "";
    } else if (t === "relation") {
      // ★ relation 用「排序后的 id 列表」→ 顺序不同不算变化 ★
      out[k] = (v.relation || []).map((x) => x.id).sort().join(",");
    } else if (t === "checkbox") {
      out[k] = v.checkbox ? "1" : "";
    }
  }
  return out;
}

/**
 * ★★★ 把【要写入的属性】转成同样的扁平值（★ 和 snapshotProps 对齐 ★）★★★
 */
function flatProps(props) {
  const out = {};
  for (const k of Object.keys(props || {})) {
    const v = props[k];
    if (!v) continue;
    if (v.title) out[k] = (v.title || []).map((x) => (x.text && x.text.content) || x.plain_text || "").join("");
    else if (v.rich_text) out[k] = (v.rich_text || []).map((x) => (x.text && x.text.content) || x.plain_text || "").join("");
    else if (v.number !== undefined) out[k] = v.number === null ? "" : String(v.number);
    else if (v.url !== undefined) out[k] = v.url || "";
    else if (v.status) out[k] = (v.status && v.status.name) || "";
    else if (v.select) out[k] = (v.select && v.select.name) || "";
    else if (v.date) out[k] = (v.date && v.date.start) || "";
    else if (v.relation) out[k] = (v.relation || []).map((x) => x.id).sort().join(",");
    else if (v.checkbox !== undefined) out[k] = v.checkbox ? "1" : "";
  }
  return out;
}

class Store {
  /**
   * @param {String} dsId   数据源 id
   * @param {String} keyProp 唯一键属性名（如「书籍ID」）
   * @param {String} titleProp 标题属性名（如「标题」）
   */
  constructor(dsId, keyProp, titleProp) {
    this.dsId = dsId;
    this.keyProp = keyProp;
    this.titleProp = titleProp;
    this.byKey = new Map();
    this.byTitle = new Map();
  }

  async load(token) {
    let cur = null;
    do {
      // ★★★ 2026-11-07 修：start_cursor 必须放在【body】里 ★★★ ★
      //   ★ 之前拼在 URL query 上 → Notion 2025-09-03 报 validation_error ★
      //   ★ → 库里有 100+ 条就要翻页 → 一翻页就 400 → ★ 云端同步直接 exit 1 ★
      const body = { page_size: 100 };
      if (cur) body.start_cursor = cur;
      const q = await api("/data_sources/" + this.dsId + "/query", "POST", body, token);
      for (const p of q.results || []) {
        const pr = p.properties || {};
        const key = this._txt(pr[this.keyProp]);
        const title = this._txt(pr[this.titleProp]);
        const rec = { id: p.id, url: p.url, title };
        // ★★★ 2026-11-07：★ 记录 Notion 现值快照（★ 三方合并要用 ★）★★★ ★
        //   ★ 没有它 → 无法判断「是你改的」还是「同步改的」→ 只能全量覆盖 ★
        rec.snap = snapshotProps(pr);
        if (key) this.byKey.set(key, rec);
        if (title) this.byTitle.set(title, rec);
      }
      cur = q.has_more ? q.next_cursor : null;
    } while (cur);
    return this.byKey.size;
  }

  _txt(v) {
    if (!v) return "";
    if (v.title) return v.title.map((x) => x.plain_text).join("").trim();
    if (v.rich_text) return v.rich_text.map((x) => x.plain_text).join("").trim();
    return "";
  }

  find(key, title) {
    if (key && this.byKey.has(key)) return this.byKey.get(key);
    if (title && this.byTitle.has(title)) return this.byTitle.get(title);
    return null;
  }

  /** 按 key 找/建（★ relation 目标必须指向真实页面 ★）*/
  async ensure(title, token, key) {
    const hit = this.find(key, title);
    if (hit) return hit;
    if (!title) return null;
    const props = {};
    props[this.titleProp] = { title: [{ type: "text", text: { content: String(title).slice(0, 190) } }] };
    if (key && this.keyProp) {
      props[this.keyProp] = { rich_text: [{ type: "text", text: { content: String(key) } }] };
    }
    const p = await api("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: this.dsId },
      properties: props,
    }, token);
    const rec = { id: p.id, url: p.url, title };
    if (key) this.byKey.set(key, rec);
    this.byTitle.set(title, rec);
    return rec;
  }
}

// ══════════════════════════════════════════════════
//  工具
// ══════════════════════════════════════════════════

/** 微信读书的时间戳（秒）→ ISO 字符串 */
function ts2iso(ts) {
  const n = Number(ts);
  if (!n) return "";
  return new Date(n * 1000).toISOString();
}

/** 「20260115」这种 → ISO 日期 */
function ymd2iso(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
  if (!m) return "";
  return m[1] + "-" + m[2] + "-" + m[3];
}

/** ★ 年 / 月 / 周 的键（★ relation 用 ★）*/
function timeKeys(ts) {
  const d = ts ? new Date(Number(ts) * 1000) : new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  // ★ ISO 周（周一为一周开始）★
  const tmp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (tmp.getDay() + 6) % 7;           // 周一=0
  tmp.setDate(tmp.getDate() - dow + 3);          // 该周周四
  const firstThu = new Date(tmp.getFullYear(), 0, 4);
  const week = 1 + Math.round(
    ((tmp - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7
  );
  const wk = y + "-W" + String(week).padStart(2, "0");
  return { year: y, month: y + "-" + m, week: wk };
}

/** 划线正文块（★ quote + 章节小标题 ★）*/
function markBlocks(mark) {
  const blocks = [];
  if (mark.chapter) {
    blocks.push({
      object: "block", type: "heading_3",
      heading_3: { rich_text: [{ type: "text", text: { content: String(mark.chapter).slice(0, 190) } }] },
    });
  }
  if (mark.text) {
    blocks.push({
      object: "block", type: "quote",
      quote: { rich_text: [{ type: "text", text: { content: String(mark.text).slice(0, 1900) } }] },
    });
  }
  return blocks;
}

/** 笔记正文块 */
function noteBlocks(note) {
  const blocks = [];
  if (note.content) {
    for (const line of String(note.content).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: t.slice(0, 1900) } }] },
      });
    }
  }
  return blocks;
}

/** 清正文（逐个 DELETE 子块）*/
async function clearChildren(pageId, token) {
  let cur = null;
  const ids = [];
  do {
    const j = await api(
      "/blocks/" + pageId + "/children?page_size=100" + (cur ? "&start_cursor=" + cur : ""),
      "GET", null, token
    );
    for (const b of j.results || []) ids.push(b.id);
    cur = j.has_more ? j.next_cursor : null;
  } while (cur);
  for (const id of ids) {
    try { await api("/blocks/" + id, "DELETE", null, token); } catch (e) { /* 忽略 */ }
  }
  return ids.length;
}

/** 追加块 */
async function appendBlocks(pageId, blocks, token) {
  if (!blocks.length) return 0;
  let n = 0;
  for (let i = 0; i < blocks.length; i += 80) {
    const j = await api("/blocks/" + pageId + "/children", "PATCH", {
      children: blocks.slice(i, i + 80),
    }, token);
    n += (j.results || []).length;
    if (i + 80 < blocks.length) await sleep(300);
  }
  return n;
}

/**
 * 设置页面封面（★ Notion 的画廊视图用 page.cover 显示大图 ★）
 * @param {String} pageId
 * @param {String} url  封面图片 URL
 */
async function setCover(pageId, url, token) {
  if (!pageId || !url) return false;
  try {
    await api("/pages/" + pageId, "PATCH", {
      cover: { type: "external", external: { url: String(url) } },
    }, token);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  loadToken, api, Store, sleep, setCover,
  DS_BOOK, DS_MARK, DS_NOTE, DS_TAG, DS_AUTHOR, DS_CAT, DS_YEAR, DS_MONTH, DS_WEEK,
  ts2iso, ymd2iso, timeKeys, markBlocks, noteBlocks, clearChildren, appendBlocks,
  snapshotProps, flatProps,
};
