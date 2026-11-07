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
  const withMarks = [];
  for (const id of targets) {
    // ★ 双通道：官方 API 优先，失败降级 Cookie ★
    let pg = null;
    if (useApi) {
      try { pg = await API.getProgress(id); } catch (e) { pg = null; }
    }
    if (!pg && cred.vid && cred.skey) {
      try { pg = await W.getProgress(id, cred); } catch (e) { /* 忽略 */ }
    }
    if (pg && (pg.readingTime > 0 || pg.overallProgress > 0)) withMarks.push(id);
  }
  if (withMarks.length) {
    targets = withMarks.concat(targets.filter((x) => withMarks.indexOf(x) < 0));
    console.log("    ★ " + withMarks.length + " 本读过（优先同步）");
  }

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
      if (!meta.title && cred.vid && cred.skey) {
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
    // ★★★ 双通道：官方 API 优先（★ API Key 绑的账号 → 云端也能用 ★）★★★ ★
    if (useApi) {
      try {
        const r = await API.getMarksAndNotes(bookId);
        bmList = r.marks; rvList = r.notes; gotMarks = true;
      } catch (e) { /* 降级到 Cookie */ }
    }
    // ★ Cookie 兜底（★ 官方拿不到时用浏览器登录的账号 ★）
    if (!gotMarks && cred.vid && cred.skey) {
      try {
        const r = await W.getMarksAndNotes(bookId, cred);
        bmList = r.marks; rvList = r.notes; gotMarks = true;
      } catch (e) {
        // ★★★ 认证错误【必须中断】★★★ ★
        //   ★ 吞掉 → 「划线 0 条」→ 同步到 Notion 的也是 0 → 看起来像【账号没划线】★
        //   ★ 实际是登录态坏了 → 方向全错 ★
        if (/登录态失效|账号 ID 无效|没有微信读书凭证|登录超时|用户不存在/.test(String(e.message || ""))) {
          console.log("");
          console.log("  ✘ 微信读书认证失效 → 中止同步");
          console.log("    " + String(e.message).slice(0, 100));
          console.log("    → 请跑【双击登录微信读书.bat】重新扫码后再同步");
          throw e;
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
    // ★ 双通道：官方 API 优先，失败降级 Cookie ★
    let prog = null;
    if (useApi) {
      try { prog = await API.getProgress(bookId); } catch (e) { prog = null; }
    }
    if (!prog && cred.vid && cred.skey) {
      try { prog = await W.getProgress(bookId, cred); } catch (e) { prog = null; }
    }
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
    try {
      // ★ 封面：默认占位图也设上（★ 至少不是灰色图标 ★）
      if (bookHit) {
        await N.api("/pages/" + bookHit.id, "PATCH", { properties: bprops }, token);
        if (coverUrl) await N.setCover(bookHit.id, coverUrl, token);
      } else {
        const p = await N.api("/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: N.DS_BOOK },
          properties: bprops,
          ...(coverUrl ? { cover: { type: "external", external: { url: String(coverUrl) } } } : {}),
        }, token);
      }
      console.log("    ✔ " + title + "（划线 " + markIds.length + " ｜ 笔记 " + noteIds.length + "）");
      nBook++;
    } catch (e) {
      console.log("    ✘ 书籍 " + title + " → " + String(e.message).slice(0, 120));
      nSkip++;
    }
    if (bi % 5 === 4) await sleep(500);
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
