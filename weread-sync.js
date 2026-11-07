/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书 → Notion「微信读书知识库」云端入口
 * ══════════════════════════════════════════════════════════════
 *
 *  ★ 云端跑（★ GitHub Actions · 电脑关机也能跑）★★
 *  ★ 凭证从环境变量读（★ 不落进仓库 ★）：
 *    ★ WEREAD_API_KEY  ← ★ 官方 Agent API（★ 首选 ★）★
 *    WEREAD_VID / WEREAD_SKEY / WEREAD_REFRESH_TOKEN / NOTION_TOKEN
 *
 *  ★★★ 为什么官方 API 是首选 ★★★
 *   ★ Cookie 方案的 skey 约 2 小时过期 → 靠 refreshToken 续期 ★
 *   ★ ★ 但微信读书的续期端点【已全 404】→ 云端必然失效 ★
 *   ★ → 官方 API Key 不依赖 Cookie / 浏览器 / 续期 → ★ 云端能长期跑 ★
 */

const fs = require("fs");
const path = require("path");
const W = require("./微信读书接口.js");
const N = require("./微信读书写Notion.js");
const API = require("./微信读书官方API.js");

const DRY = process.argv.includes("--干跑");
const FULL = process.argv.includes("--全部");

/** 把凭证写进「假」的凭证文件 → 让接口模块复用同一套读取逻辑 */
function injectCreds() {
  // ★ API Key 走环境变量（★ 官方 API 模块自己读 ★）
  if (process.env.WEREAD_API_KEY) {
    console.log("  ✔ WEREAD_API_KEY 已设置（★ 官方 API 通道 ★）");
  }
  const vid = process.env.WEREAD_VID || "";
  const skey = process.env.WEREAD_SKEY || "";
  const rt = process.env.WEREAD_REFRESH_TOKEN || "";
  if (!vid || !skey) {
    if (!process.env.WEREAD_API_KEY) {
      console.log("  ✘ 缺少 WEREAD_API_KEY，也没有 WEREAD_VID / WEREAD_SKEY");
      process.exitCode = 1;
      return false;
    }
    console.log("  ⓘ 没有 Cookie 凭证 → 只用官方 API 通道");
    return true;
  }
  const line = "vid=" + vid + "\nskey=" + skey + "\nrefreshToken=" + rt + "\n";
  fs.writeFileSync(path.join(__dirname, "微信读书凭证.txt"), line, "utf8");
  console.log("  ✔ Cookie 凭证已注入（★ 兜底通道 ★）");
  return true;
}

(async () => {
  console.log("═══ 微信读书 → Notion（云端）═══\n");
  if (!injectCreds()) return;

  const cred = W.readCred();
  const token = process.env.NOTION_TOKEN || "";
  if (!token) {
    console.log("  ✘ 缺少 NOTION_TOKEN");
    process.exitCode = 1;
    return;
  }

  // ★ 只做 Notion 权限自检（★ 没登录态也能验云端能不能写 ★）
  try {
    const books = new N.Store(N.DS_BOOK, "书籍ID", "标题");
    const n = await books.load(token);
    console.log("  ✔ Notion 权限 OK ——「微信读书知识库」现有书籍 " + n + " 条");
  } catch (e) {
    console.log("  ✘ Notion 权限不足：" + String(e.message).slice(0, 150));
    console.log("    → 确认 secret NOTION_TOKEN 对应的 integration 已分享「微信读书知识库」");
    process.exitCode = 1;
    return;
  }

  // ★ 跑真正的同步（★ 复用主脚本的逻辑 ★）
  console.log("");
  const { execFileSync } = require("child_process");
  const args = [path.join(__dirname, "同步微信读书到Notion.js")];
  if (DRY) args.push("--干跑");
  if (FULL) args.push("--全部");
  try {
    const out = execFileSync("node", args, {
      cwd: __dirname, encoding: "utf8", timeout: 9 * 60 * 1000,
      env: {
        ...process.env,
        NOTION_TOKEN: token,
        // ★★★ 2026-11-07：★ 基线存进 Notion（★ 不依赖 git，跨机器一致 ★）★★★
        WEREAD_BASELINE_TO_NOTION: "1",
        // ★ 请求节流间隔（★ 350ms → 107 本约 2 分钟，不撞频率限流 ★）
        WEREAD_MIN_GAP: process.env.WEREAD_MIN_GAP || "900",
      },
    });
    console.log(out);
  } catch (e) {
    console.log(e.stdout || "");
    console.log("  ✘ 同步失败：" + String(e.message).slice(0, 200));
    process.exitCode = 1;
  }
})();
