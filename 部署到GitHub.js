/**
 * ══════════════════════════════════════════════════════════════
 *  微信读书云端仓库部署（★ 照抄 flomo 那套：自动传 secret，零操作 ★）
 * ══════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SYNC = path.join(__dirname, "..");
const REPO = "Enrunde/weread-notion-sync";
const GH = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs", "GitHub CLI", "bin", "gh.exe"
);

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(opts || {}),
  });
}

/** 读本机凭证（★ 记事本能开的 txt ★）*/
function readCred() {
  const out = { vid: "", skey: "", refreshToken: "" };
  const p = path.join(SYNC, "微信读书凭证.txt");
  if (!fs.existsSync(p)) return out;
  try {
    fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line) => {
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === "vid") out.vid = v;
      else if (k === "skey") out.skey = v;
      else if (k === "refreshtoken") out.refreshToken = v;
    });
  } catch (e) { /* 忽略 */ }
  return out;
}

/** 读 Notion token（★ 从 notion-date-fix 仓库的 secret 拿不到本地文件 → 从 ~/.config ★）*/
function readNotionToken() {
  const p = path.join(process.env.HOME || process.env.USERPROFILE || "", ".config", "notion", "token");
  if (!fs.existsSync(p)) return "";
  try { return fs.readFileSync(p, "utf8").trim(); } catch (e) { return ""; }
}

function main() {
  console.log("═══ 微信读书云端仓库部署 ═══\n");

  const cred = readCred();
  if (!cred.vid || !cred.skey) {
    console.log("  ✘ 没有本机凭证");
    console.log("    → 先双击「双击登录微信读书.bat」扫码登录");
    return;
  }
  console.log("  ✔ 读到凭证：vid=" + cred.vid + "  skey=" + cred.skey.slice(0, 6) + "…");

  const nt = readNotionToken();
  if (!nt) {
    console.log("  ✘ 找不到 Notion token");
    return;
  }
  console.log("  ✔ 读到 Notion token");

  // ① 建仓库
  console.log("");
  console.log("  ── ① 建 GitHub 仓库 ──");
  try {
    sh(GH, ["repo", "view", REPO, "--json", "name"]);
    console.log("    · 仓库已存在");
  } catch (e) {
    try {
      sh(GH, ["repo", "create", REPO, "--public", "--description",
        "微信读书 → Notion「微信读书知识库」自动同步"]);
      console.log("    ✔ 仓库已建");
    } catch (e2) {
      console.log("    ✘ 建仓库失败：" + String(e2.stderr || e2.message).slice(0, 160));
      return;
    }
  }

  // ② 传 secret
  console.log("");
  console.log("  ── ② 传凭证为 secret ──");
  const secrets = [
    ["WEREAD_VID", cred.vid],
    ["WEREAD_SKEY", cred.skey],
    ["WEREAD_REFRESH_TOKEN", cred.refreshToken],
    ["NOTION_TOKEN", nt],
  ];
  for (const [k, v] of secrets) {
    if (!v) { console.log("    · 跳过 " + k + "（空）"); continue; }
    try {
      sh(GH, ["secret", "set", k, "--repo", REPO, "--body", v]);
      console.log("    ✔ " + k);
    } catch (e) {
      console.log("    ✘ " + k + " → " + String(e.stderr || e.message).slice(0, 120));
    }
  }

  // ③ 推代码
  console.log("");
  console.log("  ── ③ 推代码 ──");
  const dir = path.join(SYNC, "weread-notion-sync");
  const run = (args) => {
    try { return sh("git", args, { cwd: dir }); } catch (e) { return ""; }
  };
  run(["init", "-q"]);
  run(["checkout", "-B", "main"]);
  run(["add", "-A"]);
  run(["-c", "user.name=workbuddy", "-c", "user.email=workbuddy@local",
    "commit", "-q", "-m", "feat: 微信读书 → Notion 云端同步"]);
  run(["remote", "remove", "origin"]);
  run(["remote", "add", "origin", "https://github.com/" + REPO + ".git"]);
  let ok = false;
  let lastErr = "";
  for (let i = 1; i <= 5 && !ok; i++) {
    try {
      sh("git", ["push", "-u", "origin", "main"], { cwd: dir });
      ok = true;
      console.log("    ✔ 已推送");
    } catch (e) {
      lastErr = String(e.stderr || e.message || e).slice(0, 200);
      console.log("    · 重试 " + i + (i < 5 ? "（" + lastErr.split("\n").pop().slice(0, 60) + "）" : ""));
      // ★ 首次推送可能因为没有 main ref → 先建一个空的孤儿分支再推 ★
      if (i === 1) run(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: dir });
      execFileSync(process.platform === "win32" ? "timeout" : "sleep",
        process.platform === "win32" ? ["/t", "4"] : ["4"]);
    }
  }
  if (!ok) {
    console.log("    ✘ 推送失败：" + lastErr);
    return;
  }

  // ④ 触发一次
  console.log("");
  console.log("  ── ④ 触发一次运行 ──");
  try {
    sh(GH, ["workflow", "run", "weread-notion-sync.yml", "--repo", REPO, "--ref", "main"]);
    console.log("    ✔ 已触发（去 Actions 页面看日志）");
  } catch (e) {
    console.log("    ⚠ 触发失败：" + String(e.stderr || e.message).slice(0, 140));
  }
}

main();
