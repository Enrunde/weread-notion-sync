/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书同步基线（★ 2026-11-07 新增 ★）
 * ══════════════════════════════════════════════════════════════
 *
 *  ★★★ 问题 ★★★
 *   现象：每次同步，Notion「微信读书知识库」里 107 本书的
 *        「最后编辑时间」全被刷新 → 看起来像【每次都重建】
 *   原因：writeBook() 无条件 PATCH 全部属性 + 重设封面
 *        → ① Notion 上 107 本书被反复改写
 *           ② 你在 Notion 上手动改的属性（评分/状态/标签）被覆盖
 *
 *  ★★★ 解法：三方合并 + 字段级跳过 ★★★
 *   每次同步后记录「当时的 Notion 值」和「当时的源值」。
 *   下次同步时三方对比：
 *     · Notion 改了 + 源没改 → ★ 保留你的修改 ★
 *     · 源改了   + Notion 没改 → 用源的（正常同步）
 *     · 两边都改了 → 以源为准 + 记冲突
 *     · 两边都没改 → ★ 跳过该字段（★ 不写 → 不刷新编辑时间 ★）
 *
 *  ★ 基线存放：Notion 特殊页面（★ 不依赖 git，跨机器一致 ★）
 */

const fs = require("fs");
const path = require("path");

const SYNC = __dirname;

// ★★★ 基线文件（★ 本地手动跑时用 ★）★★★ ★
const BASELINE_FILE = process.env.WEREAD_BASELINE_FILE
  || path.join(
    path.dirname(path.dirname(path.dirname(__dirname))),
    "同步状态", "微信读书基线.json"
  );
const STATE_DIR = path.dirname(BASELINE_FILE);

/** 基线页面标题（★ 放在「标签」库里，不污染书籍/划线/笔记 ★） */
const BASELINE_PAGE_TITLE = "🔒 微信读书同步基线（勿删）";

/** 读基线（★ 从文件 ★） */
function readBaseline() {
  try {
    if (!fs.existsSync(BASELINE_FILE)) return {};
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

/** 写基线（★ 到文件 ★） */
function saveBaseline(b) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 0), "utf8");
  } catch (e) {
    console.error("  ⚠ 基线写入失败：" + String(e.message).slice(0, 80));
  }
}

/** 取某条的基线 */
function getEntry(baseline, key) {
  return (baseline && baseline[key]) || {};
}

/**
 * ★ 记某条的基线
 * @param {Object} extra 附加信息 {A: 活动指纹, M: 划线id[], T: 笔记id[]}
 */
function setEntry(baseline, key, notionVals, srcVals, extra) {
  if (!key) return;
  const e = {
    N: notionVals || {},   // ★ 上次同步后的 Notion 值 ★
    S: srcVals || {},      // ★ 上次同步时的源值（★ 微信读书 ★）★
    t: Date.now(),
  };
  if (extra) {
    if (extra.A !== undefined) e.A = extra.A;      // ★ 阅读活动指纹 ★
    if (extra.M !== undefined) e.M = extra.M;      // ★ 划线 page id 列表 ★
    if (extra.T !== undefined) e.T = extra.T;      // ★ 笔记 page id 列表 ★
  }
  baseline[key] = e;
}

function eq(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null) return (b === undefined || b === null || b === "");
  if (b === undefined || b === null) return a === "";
  return String(a) === String(b);
}

/**
 * ★★ 三方合并（★ 字段级 ★）★★
 *
 * @param {Object} base   基线条目 {N, S}
 * @param {Object} now    本轮 Notion 现值（扁平）
 * @param {Object} srcNow 本轮源值（扁平）
 * @param {Array}  fields 要比较的字段名
 * @returns {{use: Object, changed: Object, kept: Array, conflict: Array}}
 *   use     → 最终该写入 Notion 的值（★ 只有 changed 里的字段要写 ★）
 *   changed → 真正需要写入的字段（★ 不变的不写 → 不刷新编辑时间 ★）
 *   kept    → 保留用户修改的字段
 *   conflict→ 两边都改了的字段
 */
function merge3(base, now, srcNow, fields, cautiousFields) {
  // ★ cautiousFields：★ 用户【可能手改】的字段 ★
  //   ★ 无基线时（首次跑）→ 这些字段保守保留 Notion 现值 ★
  //   ★ 其余字段（客观数据：进度/时长/链接/封面/relation）→ 以源为准 ★
  const cautious = cautiousFields || [];
  const use = {};
  const changed = {};
  const kept = [];
  const conflict = [];
  const bn = (base && base.N) || {};
  const bs = (base && base.S) || {};
  const hasBase = !!(base && (base.t || Object.keys(bn).length));

  for (const f of fields) {
    const nv = now[f];
    const sv = srcNow[f];
    const bv = bn[f];        // 上次同步后的 Notion 值
    const bsv = bs[f];       // 上次同步时的源值

    // ★★★ 基线【没记录】这个字段 → 无法判断是谁改的 → 保守处理 ★★★ ★
    //   ★ 典型：第一次跑新代码，基线是空的 ★
    //   ★   → Notion 上有值 = ★ 可能是你手改的（评分/状态/标题）★ → 不能覆盖 ★
    //   ★   → Notion 上没值 = 源侧有 → 用源的补上 ★
    //   ★ ★ 这一条【不受 hasBase 影响】★ → 首次跑也不覆盖已有数据 ★
    const baseHasField = !(bv === undefined && bsv === undefined);
    if (!baseHasField) {
      if (nv !== undefined && nv !== null && nv !== "") {
        // ★ Notion 有值 → 以你的为准，不动 ★
        use[f] = nv;
        kept.push(f);
        continue;
      }
      // ★ Notion 空 → 用源的值补上 ★
      use[f] = sv;
      if (!eq(sv, nv)) changed[f] = sv;
      continue;
    }

    // ★★★ 无基线（首次）→ 分两类处理 ★★★ ★
    //   ★ 谨慎字段（标题/简介/阅读状态/分类）→ ★ 保留 Notion 现值 ★
    //     ★ 理由：★ 无法区分「你手改的」还是「源更新的」→ 宁可不覆盖 ★
    //     ★ 下次跑就有了基线 → 能正常判断了 ★
    //   ★ 客观字段（进度/时长/时间/链接/封面/关系）→ 以源为准 ★
    if (!hasBase) {
      if (cautious.indexOf(f) >= 0 && nv !== undefined && nv !== null && nv !== "") {
        use[f] = nv;
        kept.push(f);
        continue;
      }
      use[f] = sv;
      if (!eq(sv, nv)) changed[f] = sv;
      continue;
    }

    const notionChanged = !eq(nv, bv);
    const srcChanged = !eq(sv, bsv);

    if (notionChanged && !srcChanged) {
      // ★★ 只有 Notion 改了 → 【保留用户的修改】★★
      use[f] = nv;
      kept.push(f);
      continue;
    }
    if (!notionChanged && srcChanged) {
      // ★ 源改了 → 正常同步 ★
      use[f] = sv;
      if (!eq(sv, nv)) changed[f] = sv;
      continue;
    }
    if (notionChanged && srcChanged) {
      // ★★ 两边都改了 → 源为准 + 记冲突 ★★
      use[f] = sv;
      if (!eq(sv, nv)) changed[f] = sv;
      conflict.push(f);
      continue;
    }
    // ★ 两边都没改 → 保持 Notion 现值（★ 不写 ★）
    use[f] = nv;
  }
  return { use, changed, kept, conflict };
}

// ══════════════════════════════════════════════════
//  ★ 基线存到 Notion（★ 云端用这个代替 git 提交 ★）
// ══════════════════════════════════════════════════

/**
 * ★ 基线存进 Notion（★ 建成/更新一个特殊页面 ★）
 * @param {Object} baseline  基线对象
 * @param {Function} api     api(path, method, body, token)
 * @param {String} dsId      数据源 id（★ 用「标签」库 ★）
 * @param {String} token
 */
async function saveBaselineToNotion(baseline, api, dsId, token) {
  const payload = JSON.stringify(baseline);
  // ★★★ Notion rich_text 单段上限 2000 字符 → 必须切片 ★★★
  const CHUNK = 1800;
  const chunks = [];
  for (let i = 0; i < payload.length; i += CHUNK) {
    chunks.push(payload.slice(i, i + CHUNK));
  }
  const pageId = await findBaselinePage(api, dsId, token);
  const blocks = chunks.map((c) => ({
    object: "block",
    type: "code",
    code: { rich_text: [{ type: "text", text: { content: c } }], language: "json" },
  }));
  if (pageId) {
    // 清掉旧块
    const kids = await api("/blocks/" + pageId + "/children?page_size=100", "GET", null, token);
    for (const b of (kids.results || [])) {
      await api("/blocks/" + b.id, "PATCH", { archived: true }, token);
    }
    for (let i = 0; i < blocks.length; i += 80) {
      await api("/blocks/" + pageId + "/children", "PATCH", { children: blocks.slice(i, i + 80) }, token);
    }
  } else {
    await api("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: dsId },
      properties: {
        "标题": { title: [{ type: "text", text: { content: BASELINE_PAGE_TITLE } }] },
      },
      children: blocks.slice(0, 80),
    });
    for (let i = 80; i < blocks.length; i += 80) {
      await api("/blocks/" + pageId + "/children", "PATCH", { children: blocks.slice(i, i + 80) }, token);
    }
  }
  return true;
}

/** 找基线页面 id */
async function findBaselinePage(api, dsId, token) {
  const q = await api("/data_sources/" + dsId + "/query", "POST", { page_size: 100 }, token);
  for (const p of (q.results || [])) {
    const pr = p.properties || {};
    let title = "";
    for (const k of Object.keys(pr)) {
      if (pr[k].type === "title") title = (pr[k].title || []).map((x) => x.plain_text).join("");
    }
    if (title === BASELINE_PAGE_TITLE) return p.id;
  }
  return null;
}

/**
 * ★ 从 Notion 读回基线 ★
 */
async function loadBaselineFromNotion(api, dsId, token) {
  try {
    const pageId = await findBaselinePage(api, dsId, token);
    if (!pageId) return null;
    const kids = await api("/blocks/" + pageId + "/children?page_size=100", "GET", null, token);
    // ★ 基线可能分成多个 code 块（★ Notion rich_text 单段上限 2000 ★）→ 拼接 ★
    const parts = [];
    for (const b of (kids.results || [])) {
      if (b.type !== "code") continue;
      parts.push(((b.code.rich_text || []).map((x) => x.plain_text || (x.text && x.text.content) || "")).join(""));
    }
    if (!parts.length) return null;
    try { return JSON.parse(parts.join("")); } catch (e) { return null; }
  } catch (e) {
    // ★ 读不到就返回 null（★ 让上层用文件版的 ★）
  }
  return null;
}

module.exports = {
  BASELINE_FILE, STATE_DIR, BASELINE_PAGE_TITLE,
  readBaseline, saveBaseline, getEntry, setEntry, merge3, eq,
  saveBaselineToNotion, loadBaselineFromNotion, findBaselinePage,
};
