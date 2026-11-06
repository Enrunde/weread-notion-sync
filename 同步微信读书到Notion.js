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

  const cred = W.readCred();
  if (!cred.vid || !cred.skey) {
    console.log("  ✘ 没有微信读书凭证");
    console.log("    → 双击「双击登录微信读书.bat」扫码登录");
    return;
  }

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
  const shelf = await W.getShelf(cred);
  const shelfIds = shelf.ids || Object.keys(shelf.books);
  console.log("    书架在架 " + shelfIds.length + " 本（全量索引 " + (shelf.allIds || []).length + " 本）");

  // ★ 目标书：在架的全部（★ 划线多的先做 ★）
  let targets = shelfIds.slice();

  // ★ 优先做有划线的书（★ 先把内容多的同步进来 ★）
  const withMarks = [];
  for (const id of targets) {
    try {
      const pg = await W.getProgress(id, cred);
      if (pg && (pg.readingTime > 0 || pg.progress > 0)) withMarks.push(id);
    } catch (e) { /* 忽略 */ }
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
      const one = await W.getBookInfo(bookId, cred);
      if (one) meta = one;
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
    try {
      const r = await W.getMarksAndNotes(bookId, cred);
      bmList = r.marks; rvList = r.notes;
    } catch (e) { /* 忽略 */ }

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
        nMark++;
      } catch (e) {
        console.log("    ✘ 划线 " + bm.id + " → " + String(e.message).slice(0, 90));
      }
    }

    // ★ 写「笔记」 ──
    for (const rv of rvList) {
      if (!rv.id) continue;
      const hit = notes.find(rv.id, null);
      const noteTitle = String(rv.content || "").slice(0, 190) || "（空笔记）";
      const props = {
        "标题": { title: [{ type: "text", text: { content: noteTitle } }] },
        "笔记ID": { rich_text: [{ type: "text", text: { content: rv.id } }] },
      };
      const tk = rv.updateTime ? N.timeKeys(rv.updateTime) : curTk;
      if (tk) {
        const y = await ensureTime(years, tk.year, token);
        const mo = await ensureTime(months, tk.month, token);
        const wk = await ensureTime(weeks, tk.week, token);
        if (y) props["年"] = { relation: [{ id: y.id }] };
        if (mo) props["月"] = { relation: [{ id: mo.id }] };
        if (wk) props["周"] = { relation: [{ id: wk.id }] };
      }
      if (DRY) { nNote++; noteIds.push({ id: "dry" }); continue; }
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
        nNote++;
      } catch (e) {
        console.log("    ✘ 笔记 " + rv.id + " → " + String(e.message).slice(0, 90));
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
    const prog = await W.getProgress(bookId, cred);
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

    if (DRY) {
      console.log("    · " + title + "（划线 " + markIds.length + " ｜ 笔记 " + noteIds.length + "）");
      nBook++;
      continue;
    }
    if (!canWrite) { nSkip++; continue; }
    try {
      if (bookHit) {
        await N.api("/pages/" + bookHit.id, "PATCH", { properties: bprops }, token);
      } else {
        await N.api("/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: N.DS_BOOK },
          properties: bprops,
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
