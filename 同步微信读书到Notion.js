/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书 → Notion「微信读书知识库」主同步
 * ══════════════════════════════════════════════════════════════
 *
 *  ★ 流程 ★
 *  ① 读微信读书：书架 → 书籍信息 → 有划线/笔记的书
 *  ② Notion 侧准备：作者 / 分类 / 标签 / 年 / 月 / 周（按需创建）
 *  ③ 写「书籍」：一本书一条（书籍ID 认亲）
 *  ④ 写「划线」：一条划线一条（划线ID 认亲）
 *  ⑤ 写「笔记」：一条想法一条（笔记ID 认亲）
 *  ⑥ 回填 relation：书 ↔ 划线 ↔ 笔记
 *
 *  用法：
 *    node 同步微信读书到Notion.js            正常同步
 *    node 同步微信读书到Notion.js --干跑      只看会做什么
 *    node 同步微信读书到Notion.js --仅=书名    只处理一本
 *    node 同步微信读书到Notion.js --全部      全部书（含没有划线的）
 */

const fs = require("fs");
const path = require("path");

const SYNC = __dirname;
const W = require(path.join(SYNC, "微信读书接口.js"));
const N = require(path.join(SYNC, "微信读书写Notion.js"));
// ★★★ 三方合并基线（★ 支撑「Notion 端改动不被覆盖」+「不重复刷新」★★★ ★
const BASE = require(path.join(SYNC, "微信读书基线.js"));

const DRY = process.argv.includes("--干跑");
const FULL = process.argv.includes("--全部");
const ONLY = (
  process.argv.find((a) => a.startsWith("--仅=")) || ""
).split("=").slice(1).join("=").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════
async function main() {
  console.log("═══ 微信读书 → Notion「微信读书知识库」同步 ═══\n");

  // ★ 2026-11-07：★ Cookie 通道一旦认证失效 → 后续不再用它（★ 官方 API 兜着 ★）
  //   ★ 必须在这里声明（★ 前面「优先探测」阶段也要用 ★）
  let cookieAuthDead = false;

  // ★ 凭证（★ Cookie 通道用；官方 API 用 API Key，两者独立 ★）
  const cred = W.readCred();

  const token = N.loadToken();
  const books = new N.Store(N.DS_BOOK, "书籍ID", "标题");
  const marks = new N.Store(N.DS_MARK, "划线ID", "标题");
  const notes = new N.Store(N.DS_NOTE, "笔记ID", "标题");
  const tags = new N.Store(N.DS_TAG, null, "标题");
  const authors = new N.Store(N.DS_AUTHOR, null, "标题");
  const cats = new N.Store(N.DS_CAT, null, "标题");
  const years = new N.Store(N.DS_YEAR, null, "标题");
  const months = new N.Store(N.DS_MONTH, null, "标题");
  const weeks = new N.Store(N.DS_WEEK, null, "标题");

  let canWrite = true;
  // ★★★ 2026-11-07：★ 加载三方合并基线 ★★★ ★
  //   ★ 云端：从 Notion 读（★ 不依赖 git ★）★
  //   ★ 本地：从文件读（★ D:/Obsidian/同步状态/微信读书基线.json ★）
  let baseline = {};
  try {
    if (process.env.WEREAD_BASELINE_TO_NOTION) {
      const b = await BASE.loadBaselineFromNotion(N.api, N.DS_TAG, token);
      if (b) {
        baseline = b;
        console.log("  基线从 Notion 读回（" + Object.keys(baseline).length + " 条）");
      } else {
        baseline = BASE.readBaseline();
        console.log("  ⓘ Notion 里还没有基线 → 用本地文件（" + Object.keys(baseline).length + " 条）");
      }
    } else {
      baseline = BASE.readBaseline();
      console.log("  基线：" + Object.keys(baseline).length + " 条");
    }
  } catch (e) {
    baseline = {};
    console.log("  ⚠ 基线读不到（" + String(e.message).slice(0, 60) + "）→ 首次同步模式");
  }
  try {
    const n = await books.load(token);
    await marks.load(token);
    await notes.load(token);
    await tags.load(token);
    await authors.load(token);
    await cats.load(token);
    await years.load(token);
    await months.load(token);
    await weeks.load(token);
    console.log("  Notion 现有：书籍 " + n + " ｜ 划线 " + marks.byKey.size +
      " ｜ 笔记 " + notes.byKey.size + " ｜ 标签 " + tags.byTitle.size +
      " ｜ 作者 " + authors.byTitle.size + " ｜ 分类 " + cats.byTitle.size);
  } catch (e) {
    canWrite = false;
    console.log("  ⚠ 读不到 Notion「微信读书知识库」：" + String(e.message).slice(0, 120));
    console.log("    → 需要把该库分享给你的 Notion integration（Obsidian Notes）");
    console.log("    → 分享前只能干跑\n");
  }

  // ── ① 读微信读书 ──
  console.log("");
  console.log("  ── 读取微信读书 ──");

  // ★★★ 双通道取数（★ 2026-11-07：官方 API 优先，Cookie 兜底 ★）★★★
  //   ★ 官方 Agent API：API Key 认证 → 不依赖 Cookie → 云端也能跑 ★
  //   ★ Cookie 方案：只能读「浏览器登录的那个账号」→ 且续期端点已 404 ★
  //   ★ → 两个渠道的书架【合并】，划线各取各的（谁有就用谁的）★
  const API = require("./微信读书官方API");
  const hasKey = API.hasApiKey();
  // ★★★ 请求节流（★ 2026-11-07 ★）★★★ ★
  //   ★ 全量同步 = 107 本 × 3 次请求 ≈ 320 次 → 不节流必撞「频率超限 -2014」★
  //   ★ 350ms 间隔 → 约 2 分钟跑完 107 本，安全不撞限流 ★
  const MIN_GAP = Number(process.env.WEREAD_MIN_GAP || 900);
  API.setMinGap(MIN_GAP);
  const shelfMap = {};          // bookId → 书籍概要
  const allIds = [];
  let apiShelfCount = 0;
  let cookieShelfCount = 0;
  let useApi = false;

  // ① 官方 API
  if (hasKey) {
    try {
      const sh = await API.getShelf();
      apiShelfCount = sh.books.length;
      for (const b of sh.books) {
        const id = String(b.bookId || "");
        if (!id) continue;
        shelfMap[id] = {
          bookId: id,
          title: b.title || "",
          author: b.author || "",
          intro: b.intro || "",
          isbn: b.isbn || "",
          category: (b.categories && b.categories[0] && b.categories[0].title) || "",
          bookUrl: b.readerLink || b.deepLink || ("https://weread.qq.com/web/reader/" + id),
          cover: b.cover || "",
          readState: b.readState || 0,
          publishTime: b.publishTime || "",
          wordCount: b.wordCount || 0,
        };
        allIds.push(id);
      }
      useApi = true;
      console.log("    ✔ 官方 API：书架 " + apiShelfCount + " 本");
    } catch (e) {
      console.log("    ⚠ 官方 API 不可用：" + String(e.message).slice(0, 100));
    }
  } else {
    console.log("    ⓘ 没有 API Key → 只用 Cookie 通道");
  }

  // ② Cookie 通道（★ 兜底 / 补漏 ★）
  if (cred.vid && cred.skey) {
    try {
      const shelf = await W.getShelf(cred);
      const ids = shelf.ids || Object.keys(shelf.books || {});
      cookieShelfCount = ids.length;
      for (const id of ids) {
        if (!shelfMap[id]) {
          const b = (shelf.books || {})[id] || {};
          shelfMap[id] = Object.assign({ bookId: id }, b);
          allIds.push(id);
        }
      }
      console.log("    ✔ Cookie 通道：书架 " + cookieShelfCount + " 本" +
        (useApi ? "（已合并去重）" : ""));
    } catch (e) {
      console.log("    ⚠ Cookie 通道不可用：" + String(e.message).slice(0, 90));
      if (!useApi) {
        console.log("    ✘ 两个通道都不可用 → 没有可同步的数据");
        console.log("      → 双击「双击登录微信读书.bat」扫码，或补上 API Key");
        return;
      }
    }
  } else if (!useApi) {
    console.log("  ✘ 没有微信读书凭证，也没有 API Key");
    console.log("    → 双击「双击登录微信读书.bat」扫码，或补上 API Key");
    return;
  }

  const shelf = { books: shelfMap, ids: allIds };
  const shelfIds = allIds;
  console.log("    合计在架 " + shelfIds.length + " 本（官方 " + apiShelfCount +
    " + Cookie " + cookieShelfCount + "）");

  // ★ 目标书：在架的全部（★ 划线多的先做 ★）
  let targets = shelfIds.slice();

  // ★ 优先做有划线的书（★ 先把内容多的同步进来 ★）
  // ★★★ 2026-11-07：★ 删掉了「优先探测」阶段 ★★★ ★
  //   ★ 原因：★ 它【单独】给每本书发一次 getProgress → 107 次额外请求 ★
  //   ★   → 全量同步变成 320+ 次 → ★ 必撞微信 WAF 限流（HTTP 403）★
  //   ★ 现在：★ 进度在主循环里拉（★ 复用，不重复 ★）→ 少 107 次请求 ★

  if (ONLY) {
    targets = targets.filter((id) => {
      const b = shelf.books[id] || {};
      return String(b.title || "").indexOf(ONLY) >= 0;
    });
    console.log("    --仅=" + ONLY + " → " + targets.length + " 本");
  }
  console.log("    ★ 待处理 " + targets.length + " 本");

  if (!targets.length) {
    console.log("    · 没有内容");
    return;
  }

  let nBook = 0, nMark = 0, nNote = 0, nSkip = 0;
  let curAuthor = null, curCat = null, curTk = null;

  for (let bi = 0; bi < targets.length; bi++) {
    const bookId = targets[bi];
    const raw = shelf.books[bookId] || {};

    // ★ 书籍详情（★ shelf 里没有就单独拉 ★）
    let meta = raw;
    if (!meta.title) {
      // ★ 双通道：官方 API 优先，失败降级 Cookie ★
      if (useApi) {
        const one = await API.getBookInfo(bookId);
        if (one) meta = one;
      }
      if (!meta.title && cred.vid && cred.skey && !cookieAuthDead) {
        const one = await W.getBookInfo(bookId, cred);
        if (one) meta = one;
      }
    }
    const title = String(meta.title || "").trim();
    if (!title) { nSkip++; continue; }

    // ★ 作者 / 分类 ──
    // ★ 作者名常常带国别前缀（"[美]埃德加·斯诺"）→ 清理掉 ★
    const rawAuthor = String(meta.author || "").split(/[,，、]/)[0].trim();
    const authorName = rawAuthor.replace(/^\s*[[（(][^\]）)]{1,6}[\]）)]\s*/, "").trim();
    const catName = String(meta.category || "").trim();
    if (authorName) {
      curAuthor = DRY ? { id: "dry", title: authorName }
        : await authors.ensure(authorName, token);
    }
    curCat = catName ? (DRY ? { id: "dry", title: catName } : await cats.ensure(catName, token)) : null;

    // ★ 划线 + 笔记（★ 一次拿全并按 range 关联 ★）
    let bmList = [], rvList = [];
    let gotMarks = false;

    // ════════════════════════════════════════════════════════════
    //  ★★★ 2026-11-07：★ 增量筛选（★ 省请求 ★）★★★
    //   ★ 问题：★ 107 本 × 3 次请求 = 320 次 → ★ 必撞微信 WAF 限流（403）★
    //   ★ 做法：★ 先拉进度（1 次）→ 和基线比「阅读活动指纹」★
    //   ★        指纹没变 → ★ 这本书这轮没动 → 跳过拉划线+笔记（省 2 次）★
    //   ★ 效果：★ 常规同步 107 次（进度）+ 少量活跃书的划线 → 不撞限流 ★
    // ════════════════════════════════════════════════════════════
    let prog = null;
    if (useApi) {
      try { prog = await API.getProgress(bookId); } catch (e) { prog = null; }
    }
    if (!prog && cred.vid && cred.skey && !cookieAuthDead) {
      try { prog = await W.getProgress(bookId, cred); } catch (e) { prog = null; }
    }
    // ★ 阅读活动指纹（★ 变了就说明这轮有活动 ★）
    const actSig = prog
      ? [Number(prog.readingTime || 0), Number(prog.overallProgress || 0),
         Number(prog.finishTime || 0), Number(prog.startReadingTime || 0),
         Number(prog.updateTime || 0)].join("|")
      : "";
    const baseEntry0 = BASE.getEntry(baseline, String(bookId));
    const lastActSig = (baseEntry0 && baseEntry0.A) || "";
    // ★ 没有基线（首次）→ 必须拉（★ 否则一条划线都同步不进来 ★）
    // ★ 有基线且指纹没变 → 跳过划线（★ 省 2 次请求 ★）
    const skipMarks = !!(lastActSig && actSig && lastActSig === actSig && !FULL);
    if (skipMarks) {
      // ★ 复用基线里的划线/笔记 id（★ 不重新拉 ★）
      markIds.length = 0; noteIds.length = 0;
      const prevMarks = (baseEntry0 && baseEntry0.M) || [];
      const prevNotes = (baseEntry0 && baseEntry0.T) || [];
      for (const pid of prevMarks) markIds.push({ id: pid });
      for (const pid of prevNotes) noteIds.push({ id: pid });
      bmList = []; rvList = [];
      gotMarks = true;
    }

    // ★★★ 双通道：官方 API 优先（★ API Key 绑的账号 → 云端也能用 ★）★★★ ★
    if (!skipMarks && useApi) {
      try {
        const r = await API.getMarksAndNotes(bookId);
        bmList = r.marks; rvList = r.notes; gotMarks = true;
      } catch (e) { /* 降级到 Cookie */ }
    }
    // ★ Cookie 兜底（★ 官方拿不到时用浏览器登录的账号 ★）
    if (!gotMarks && cred.vid && cred.skey && !cookieAuthDead) {
      try {
        const r = await W.getMarksAndNotes(bookId, cred);
        bmList = r.marks; rvList = r.notes; gotMarks = true;
      } catch (e) {
        // ★★★ 认证错误的处理（★ 分两种情况 ★）★★★ ★
        //   ★ 情况 A：官方 API 通道【也】失败 → 真认证问题 → 必须中断 ★
        //     ★ 吞掉 → 「划线 0 条」→ 看起来像【账号没划线】→ 方向全错 ★
        //   ★ 情况 B：官方 API 通道是好的（★ 只是这一本拉失败 ★）★
        //     ★ → Cookie 失效【不】该中断 → 跳过这本继续 ★
        const authErr = /登录态失效|账号 ID 无效|没有微信读书凭证|登录超时|用户不存在/.test(String(e.message || ""));
        if (authErr && !useApi) {
          console.log("");
          console.log("  ✘ 微信读书认证失效 → 中止同步");
          console.log("    " + String(e.message).slice(0, 100));
          console.log("    → 请跑【双击登录微信读书.bat】重新扫码后再同步");
          throw e;
        }
        if (authErr) {
          // ★ 官方 API 还在用 → 只跳过这本书 ★
          cookieAuthDead = true;
          console.log("    ⚠ Cookie 通道已失效（★ 但官方 API 正常 → 跳过这本 ★）");
        }
      }
    }

    // ★ 时间关系（★ 用最新一条的时间 ★）
    const allTs = []
      .concat(bmList.map((b) => Number(b.updateTime || b.createTime || 0)))
      .concat(rvList.map((r) => Number(r.updateTime || r.createTime || 0)))
      .filter((n) => n > 0);
    const lastTs = allTs.length ? Math.max.apply(null, allTs) : 0;
    curTk = lastTs ? N.timeKeys(lastTs) : N.timeKeys();

    const bookHit = books.find(String(bookId), title);
    const markIds = [];
    const noteIds = [];

    // ★ 写「划线」 ──
    // ★★★ 2026-11-07：★ 先写笔记，再写划线 ★★★ ★
    //   ★ 原来先写划线 → 写划线时笔记还不存在 → 挂不上「笔记」关系 ★
    //   ★ → 划线变成孤儿，笔记也不知道自己属于哪条划线 ★
    //   ★ 现在：① 先写笔记（拿到 pageId，按 range 建索引）★
    //     ★ ② 再写划线 → 用 range 查索引 → 挂上「笔记」relation ★
    //   ★ 顺序不能反：Notion relation 必须指向已存在的页面 ★
    const markIdByRange = new Map();   // range → 划线页 id
    const noteIdByRange = new Map();   // range → 笔记页 id

    // ★ 写「笔记」 ──
    for (const rv of rvList) {
      if (!rv.id) continue;
      const hit = notes.find(rv.id, null);
      const noteTitle = String(rv.content || rv.abstract || "").slice(0, 190) || "（空笔记）";
      const props = {
        "标题": { title: [{ type: "text", text: { content: noteTitle } }] },
        "笔记ID": { rich_text: [{ type: "text", text: { content: rv.id } }] },
      };
      const tk = rv.updateTime || rv.createTime ? N.timeKeys(rv.updateTime || rv.createTime) : curTk;
      if (tk) {
        const y = await ensureTime(years, tk.year, token);
        const mo = await ensureTime(months, tk.month, token);
        const wk = await ensureTime(weeks, tk.week, token);
        if (y) props["年"] = { relation: [{ id: y.id }] };
        if (mo) props["月"] = { relation: [{ id: mo.id }] };
        if (wk) props["周"] = { relation: [{ id: wk.id }] };
      }
      if (DRY) { nNote++; noteIds.push({ id: "dry" }); if (rv.range) noteIdByRange.set(rv.range, "dry"); continue; }
      if (!canWrite) { nSkip++; continue; }
      try {
        let pageId = hit ? hit.id : null;
        if (hit) {
          await N.api("/pages/" + hit.id, "PATCH", { properties: props }, token);
        } else {
          const p = await N.api("/pages", "POST", {
            parent: { type: "data_source_id", data_source_id: N.DS_NOTE },
            properties: props,
          }, token);
          pageId = p.id;
          notes.byKey.set(rv.id, { id: p.id, url: p.url, title: noteTitle });
          const blocks = N.noteBlocks(rv);
          if (blocks.length) await N.appendBlocks(p.id, blocks, token);
        }
        noteIds.push({ id: pageId });
        // ★ 记录 range → 笔记 id（★ 供划线挂关系 ★）
        if (rv.range) noteIdByRange.set(rv.range, pageId);
        nNote++;
      } catch (e) {
        console.log("    ✘ 笔记 " + rv.id + " → " + String(e.message).slice(0, 90));
      }
    }

    // ★ 写「划线」 ──
    for (const bm of bmList) {
      if (!bm.id) continue;
      const hit = marks.find(bm.id, null);
      const markTitle = String(bm.text || "").slice(0, 190) || "（空划线）";
      const props = {
        "标题": { title: [{ type: "text", text: { content: markTitle } }] },
        "划线ID": { rich_text: [{ type: "text", text: { content: bm.id } }] },
      };
      const rel = [];
      if (curAuthor) rel.push({ id: curAuthor.id });
      if (rel.length) props["作者"] = { relation: rel };
      if (curCat) props["分类"] = { relation: [{ id: curCat.id }] };
      // ★★ 挂上关联的笔记（★ 按 range 匹配 ★）★★
      const noteRel = bm.range && noteIdByRange.get(bm.range);
      if (noteRel && noteRel !== "dry") props["笔记"] = { relation: [{ id: noteRel }] };
      const tk = bm.updateTime ? N.timeKeys(bm.updateTime) : curTk;
      if (tk) {
        const y = await ensureTime(years, tk.year, token);
        const mo = await ensureTime(months, tk.month, token);
        const wk = await ensureTime(weeks, tk.week, token);
        if (y) props["年"] = { relation: [{ id: y.id }] };
        if (mo) props["月"] = { relation: [{ id: mo.id }] };
        if (wk) props["周"] = { relation: [{ id: wk.id }] };
      }
      if (DRY) { nMark++; markIds.push({ id: "dry" }); continue; }
      if (!canWrite) { nSkip++; continue; }
      try {
        let pageId = hit ? hit.id : null;
        if (hit) {
          await N.api("/pages/" + hit.id, "PATCH", { properties: props }, token);
        } else {
          const p = await N.api("/pages", "POST", {
            parent: { type: "data_source_id", data_source_id: N.DS_MARK },
            properties: props,
          }, token);
          pageId = p.id;
          marks.byKey.set(bm.id, { id: p.id, url: p.url, title: markTitle });
          const blocks = N.markBlocks(bm);
          if (blocks.length) await N.appendBlocks(p.id, blocks, token);
        }
        markIds.push({ id: pageId });
        if (bm.range) markIdByRange.set(bm.range, pageId);
        nMark++;
      } catch (e) {
        console.log("    ✘ 划线 " + bm.id + " → " + String(e.message).slice(0, 90));
      }
    }

    // ★★★ 回填：把笔记挂到对应的划线上（★ 反向关系 ★）★★★ ★
    //   ★ Notion 的 relation 是单向存储的 → 写划线时挂笔记还不够 ★
    //   ★ 笔记页自己的「划线」relation 也得写上 → 双向都能看到 ★
    for (const rv of rvList) {
      if (!rv.range) continue;
      const markId = markIdByRange.get(rv.range);
      const noteId = noteIdByRange.get(rv.range);
      if (!markId || !noteId || markId === "dry" || noteId === "dry") continue;
      try {
        await N.api("/pages/" + noteId, "PATCH", {
          properties: { "划线": { relation: [{ id: markId }] } },
        }, token);
      } catch (e) {
        console.log("    ⚠ 笔记←划线 关系回填失败：" + String(e.message).slice(0, 70));
      }
    }


    // ★ 写「书籍」 ──
    const bprops = {
      "标题": { title: [{ type: "text", text: { content: title } }] },
      "书籍ID": { rich_text: [{ type: "text", text: { content: String(bookId) } }] },
    };
    if (meta.isbn) bprops["ISBN"] = { rich_text: [{ type: "text", text: { content: String(meta.isbn) } }] };
    if (meta.intro) bprops["简介"] = { rich_text: [{ type: "text", text: { content: String(meta.intro).slice(0, 1900) } }] };
    if (meta.bookUrl) bprops["链接"] = { url: String(meta.bookUrl) };
    if (curAuthor) bprops["作者"] = { relation: [{ id: curAuthor.id }] };
    if (curCat) bprops["分类"] = { relation: [{ id: curCat.id }] };

    // ★ 阅读状态（★ 用进度/完成时间判断，比 readState 可靠 ★）
    // ★★★ 2026-11-07：★ prog 已在【上面】拉过了（★ 增量筛选时拉的 ★）★★★
    //   ★ 这里直接复用 → ★ 不重复发请求（★ 省 107 次 ★）
    const readState = Number(meta.readState || 0);
    let stateName = "";
    if (readState === 1) stateName = "在读";
    else if (readState === 2) stateName = "已读";
    else if (readState === 3) stateName = "想读";
    if (!stateName) {
      // ★ 兜底：有完成时间 → 已读；有阅读时长/进度 → 在读；否则 想读 ★
      if (prog && prog.finishTime > 0) stateName = "已读";
      else if (prog && (prog.readingTime > 0 || prog.overallProgress > 0)) stateName = "在读";
      else stateName = "想读";
    }
    bprops["阅读状态"] = { status: { name: stateName } };

    // ★ 阅读进度 + 阅读时长 ──
    if (prog) {
      // ★ 微信读书给的是 0-100 → Notion 用 0-1 ★
      const pct = Number(prog.overallProgress || 0);
      if (pct > 0) bprops["阅读进度"] = { number: Math.min(pct / 100, 1) };
      if (prog.readingTime > 0) bprops["阅读时长（分钟）"] = { number: prog.readingTime };
      if (prog.startReadingTime > 0) {
        bprops["开始阅读时间"] = { date: { start: N.ts2iso(prog.startReadingTime) } };
      }
      if (prog.finishTime > 0) {
        bprops["最后阅读时间"] = { date: { start: N.ts2iso(prog.finishTime) } };
      }
    }

    // ★ relation 回填：书 ↔ 划线 ↔ 笔记 ★
    if (markIds.length) bprops["划线"] = { relation: markIds };
    if (noteIds.length) bprops["笔记"] = { relation: noteIds };

    // ★★★ 封面 URL 写进属性字段 ★★★ ★
    //   ★ 原因：Notion【列表视图】不渲染 page.cover → 只显示灰色占位 ★
    //   ★ 有「封面」URL 字段 → 列表里直接显示缩略图 ★
    const coverUrl = meta.cover || "";
    if (coverUrl) bprops["封面"] = { url: String(coverUrl) };

    if (DRY) {
      console.log("    · " + title + "（划线 " + markIds.length + " ｜ 笔记 " + noteIds.length + "）");
      nBook++;
      continue;
    }
    if (!canWrite) { nSkip++; continue; }

    // ════════════════════════════════════════════════════════════
    //  ★★★ 2026-11-07：★ 三方合并 + 字段级跳过 ★★★
    //   ★ 之前：无条件 PATCH 全部属性 + 每次重设封面
    //   ★   → ① Notion 上 107 本书每次都被【重写】→ 看起来像「每次都重建」
    //   ★   → ② 你在 Notion 上手改的属性（评分/状态/标签）被【覆盖】★
    //   ★ 现在：三方对比 → 只写【真正变了】的字段 → 没变就完全不碰
    // ════════════════════════════════════════════════════════════
    const srcFlat = N.flatProps(bprops);
    const nowFlat = (bookHit && bookHit.snap) || {};
    const baseEntry = BASE.getEntry(baseline, String(bookId));
    // ★ 要参与合并的字段（★ 关系型也参与 → 划线/笔记变化才回填 ★）
    const MERGE_FIELDS = Object.keys(srcFlat);
    // ★ 用户【可能手改】的字段 → 首次跑（无基线）时保守保留 Notion 现值 ★
    const CAUTIOUS = ["标题", "简介", "阅读状态", "分类", "作者"];
    const mg = BASE.merge3(baseEntry, nowFlat, srcFlat, MERGE_FIELDS, CAUTIOUS);

    // ★★★ 只把【真正变了】的字段放进要写的 props ★★★
    const writeProps = {};
    for (const f of Object.keys(mg.changed)) {
      const v = srcFlat[f];
      if (v === "" || v === undefined) continue;
      // ★ 把扁平值还原成 Notion 属性格式 ★
      const orig = bprops[f];
      if (!orig) continue;
      writeProps[f] = orig;
    }

    // ★★ 封面：★ 只有封面 URL 变了才设（★ 每次都设 → 每次都刷编辑时间 ★）★★
    const coverChanged = !BASE.eq(
      (nowFlat["封面"] || ""),
      coverUrl || ""
    );

    try {
      if (bookHit) {
        // ★★★ 没有任何字段变化 → 完全跳过 PATCH（★ 不刷新编辑时间 ★）★★★
        const nFields = Object.keys(writeProps).length;
        if (!nFields && !coverChanged) {
          nSkip++;
          // ★ 基线照旧记（★ 记录这次看到的 Notion 值 ★）
          BASE.setEntry(baseline, String(bookId), nowFlat, srcFlat,
            { A: actSig, M: markIds.map((x) => x.id), T: noteIds.map((x) => x.id) });
          continue;
        }
        if (nFields) {
          await N.api("/pages/" + bookHit.id, "PATCH", { properties: writeProps }, token);
        }
        if (coverChanged && coverUrl) {
          await N.setCover(bookHit.id, coverUrl, token);
        }
        // ★ 保留用户修改的字段 → 记进基线（★ 下次还认得出是你改的 ★）
        const mergedSnap = Object.assign({}, nowFlat);
        for (const f of Object.keys(mg.use)) {
          if (mg.kept.indexOf(f) >= 0) mergedSnap[f] = mg.use[f];
        }
        for (const f of Object.keys(writeProps)) {
          mergedSnap[f] = srcFlat[f];
        }
        BASE.setEntry(baseline, String(bookId), mergedSnap, srcFlat,
          { A: actSig, M: markIds.map((x) => x.id), T: noteIds.map((x) => x.id) });
        console.log("    ✔ " + title + "（更新 " + nFields + " 项" +
          (coverChanged && coverUrl ? " + 封面" : "") +
          (mg.kept.length ? "｜保留你的修改 " + mg.kept.join("、") : "") +
          (mg.conflict.length ? "｜冲突 " + mg.conflict.join("、") : "") +
          "）");
      } else {
        // ★ 新建：全量写入 + 记录基线 ★
        const p = await N.api("/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: N.DS_BOOK },
          properties: bprops,
          ...(coverUrl ? { cover: { type: "external", external: { url: String(coverUrl) } } } : {}),
        }, token);
        books.byKey.set(String(bookId), { id: p.id, url: p.url, title, snap: srcFlat });
        BASE.setEntry(baseline, String(bookId), srcFlat, srcFlat,
          { A: actSig, M: markIds.map((x) => x.id), T: noteIds.map((x) => x.id) });
        console.log("    ✔ " + title + "（新建｜划线 " + markIds.length + " ｜ 笔记 " + noteIds.length + "）");
      }
      nBook++;
    } catch (e) {
      console.log("    ✘ 书籍 " + title + " → " + String(e.message).slice(0, 120));
      nSkip++;
    }
    if (bi % 5 === 4) await sleep(500);
  }

  // ════════════════════════════════════════════════════════════
  //  ★★★ 保存基线（★ 云端存 Notion，本地存文件 ★）★★★
  // ════════════════════════════════════════════════════════════
  if (!DRY) {
    try {
      if (process.env.WEREAD_BASELINE_TO_NOTION) {
        await BASE.saveBaselineToNotion(baseline, N.api, N.DS_TAG, token);
        console.log("  ✔ 基线已存进 Notion（" + Object.keys(baseline).length + " 条）");
      } else {
        BASE.saveBaseline(baseline);
        console.log("  ✔ 基线已保存 → " + BASE.BASELINE_FILE + "（" + Object.keys(baseline).length + " 条）");
      }
    } catch (e) {
      console.log("  ⚠ 基线保存失败：" + String(e.message).slice(0, 100));
    }
  }

  console.log("");
  console.log("── 汇总 ──");
  console.log("  书籍 " + nBook + " ｜ 划线 " + nMark + " ｜ 笔记 " + nNote + " ｜ 跳过 " + nSkip);
  if (DRY) console.log("  （干跑，未写入）");
}

/** 确保年/月/周 存在 */
async function ensureTime(store, name, token) {
  if (!name) return null;
  const hit = store.byTitle.get(name);
  if (hit) return hit;
  if (DRY) return { id: "dry", title: name };
  return await store.ensure(name, token);
}

main().catch((e) => {
  console.log("  ✘ " + String(e.message || e));
});
