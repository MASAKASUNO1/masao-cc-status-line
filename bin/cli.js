#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const S = ""; // badge間スペーサーなし
const THEME = process.argv[2] || "default";

// --- Color utils ---

function gradient(pct) {
  const p = Math.round(Math.min(100, Math.max(0, pct)));
  let r, g;
  if (p <= 50) { r = Math.round(255 * p / 50); g = 255; }
  else { r = 255; g = Math.round(255 * (100 - p) / 50); }
  return [r, g, 0];
}

function ctxGradient(pct) {
  const p = Math.round(Math.min(100, Math.max(0, pct)));
  let r, g;
  if (p <= 50) { r = 0; g = 255; }
  else if (p <= 85) { r = Math.round(255 * (p - 50) / 35); g = 255; }
  else { r = 255; g = Math.round(255 * (1 - (p - 85) / 15)); }
  return [r, g, 0];
}

// --- Badge builders ---

function badge(pct, label, value) {
  const [r, g, b] = gradient(pct);
  const tag = `\x1b[48;2;${r*0.3|0};${g*0.3|0};${b*0.3|0}m\x1b[38;2;${r};${g};${b}m${BOLD} ${label} ${RST}`;
  const val = `\x1b[48;2;${r*0.15|0};${g*0.15|0};${b*0.15|0}m\x1b[38;2;${r};${g};${b}m ${value} ${RST}`;
  return tag + val;
}

function ctxBar(pct, totalTokens) {
  const width = 16;
  const filled = Math.round(width * pct / 100);
  const [r, g, b] = ctxGradient(pct);
  const tk = totalTokens != null ? `(${totalTokens >= 1000 ? Math.round(totalTokens / 1000) + "k" : totalTokens})` : "";
  const text = `${Math.round(pct)}%${tk}`;
  const pad = Math.max(0, width - text.length);
  const full = " ".repeat(pad / 2 | 0) + text + " ".repeat(Math.ceil(pad / 2));
  const fBg = `\x1b[48;2;${r*0.5|0};${g*0.5|0};0m`;
  const eBg = `\x1b[48;2;${r*0.12|0};${g*0.12|0};0m`;
  const fg = `\x1b[38;2;${r};${g};${b}m`;
  let bar = "";
  for (let i = 0; i < width; i++) {
    bar += (i < filled ? fBg : eBg) + (i === 0 ? `${fg}${BOLD}` : "") + full[i];
  }
  return `\x1b[48;2;${r*0.3|0};${g*0.3|0};0m${fg}${BOLD} ctx ${RST}${bar}${RST}`;
}

function staticBadge(emoji, label, bg, fg) {
  return `\x1b[48;2;${bg}m\x1b[38;2;${fg}m${BOLD} ${emoji}${label} ${RST}`;
}

// --- Helpers ---

function timeUntil(ts) {
  const s = Math.max(0, Math.floor(ts - Date.now() / 1000));
  if (s === 0) return "now";
  const d = s / 86400 | 0, h = (s % 86400) / 3600 | 0, m = (s % 3600) / 60 | 0;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function gitBranch(cwd) {
  if (!cwd) return "";
  try {
    return execSync("git --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks rev-parse --short HEAD 2>/dev/null", {
      cwd, encoding: "utf8", timeout: 2000,
    }).trim();
  } catch { return ""; }
}

function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

// codexbar から codex のセッション(5h)/週(7d)使用率を取得。
// codexbar 呼び出しは遅い(~0.5s)ため、キャッシュを即読みしつつ
// 古ければバックグラウンドで更新する。
function codexUsage() {
  const dir = `${homedir()}/.cache`;
  const cacheFile = `${dir}/cc-statusline-codex.json`;
  const TTL = 60_000; // 60秒

  let data = null, stale = true;
  try {
    const arr = JSON.parse(readFileSync(cacheFile, "utf8"));
    const u = arr?.[0]?.usage;
    if (u) {
      data = {
        session: Math.round(u.primary?.usedPercent ?? 0),
        week: Math.round(u.secondary?.usedPercent ?? 0),
        email: u.accountEmail || u.identity?.accountEmail || arr?.[0]?.openaiDashboard?.signedInEmail || "",
      };
    }
    stale = Date.now() - statSync(cacheFile).mtimeMs > TTL;
  } catch { stale = true; }

  if (stale) {
    try {
      mkdirSync(dir, { recursive: true });
      const child = spawn("sh", ["-c",
        `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" codexbar usage --provider codex --source cli --json > "${cacheFile}.tmp" 2>/dev/null && mv "${cacheFile}.tmp" "${cacheFile}"`,
      ], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {}
  }
  return data;
}

// Claude アカウントのメールアドレスの prefix (@より前) を取得。
function claudeEmailPrefix() {
  try {
    const d = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf8"));
    return (d.oauthAccount?.emailAddress || "").split("@")[0];
  } catch { return ""; }
}

// --- Simple theme utils ---

function simpleStatusColor(pct) {
  if (pct <= 50) return "\x1b[38;2;110;185;165m"; // muted teal
  if (pct <= 80) return "\x1b[38;2;195;175;105m"; // muted amber
  return "\x1b[38;2;195;115;115m";                 // muted rose
}

function renderSimple(d) {
  const BG  = "\x1b[48;2;28;28;34m";
  const DIM = "\x1b[38;2;85;85;100m";
  const TXT = "\x1b[38;2;165;165;178m";
  const YEL = "\x1b[38;2;220;200;110m"; // muted yellow (email)
  const SEP = ` ${BG}${DIM}│ `;

  const L1 = [];
  const L2 = [];

  // Model
  const raw = d.model?.display_name || d.model?.id || "";
  const name = raw.replace(/^Claude\s*/i, "").replace(/\s*\(.*\)/, "").split(/\s+/)[0];
  const mc = { Opus: "\x1b[38;2;190;150;170m", Sonnet: "\x1b[38;2;190;170;130m", Haiku: "\x1b[38;2;130;190;160m" };
  const me = { Opus: "🔮", Sonnet: "✨", Haiku: "🍃" };
  let effortTag = "";
  try {
    const st = JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, "utf8"));
    if (st.effortLevel) {
      const m = { low: "l", medium: "m", high: "h", max: "mx" };
      effortTag = `/${m[st.effortLevel] || st.effortLevel}`;
    }
  } catch {}
  if (name) L1.push(`${mc[name] || TXT}${me[name] || "●"} ${BOLD}${name}${RST}${BG}${mc[name] || TXT}${effortTag}`);

  // Dir + Branch
  const cwd = d.workspace?.current_dir || d.cwd || "";
  const branch = gitBranch(cwd);
  const dir = cwd.split("/").pop() || "";
  if (dir) {
    let br = branch ? ` ${DIM}→ ${TXT}${branch}` : "";
    if (THEME === "slave") {
      const ep = claudeEmailPrefix();
      if (ep) br += ` ${DIM}· ${YEL}${ep}`;
    }
    L1.push(`${TXT}${dir}${br}`);
  }

  // Context — slave は 2行目の先頭、それ以外は 1行目
  const ctxPct = Math.round(d.context_window?.used_percentage ?? 0);
  const ctxSeg = `ctx ${simpleStatusColor(ctxPct)}${BOLD}${ctxPct}%`;
  if (THEME === "slave") L2.push(`${RST}${BG}${DIM}${ctxSeg}`);
  else L1.push(`${DIM}${ctxSeg}`);

  // 5h
  const five = d.rate_limits?.five_hour;
  const p5 = Math.round(five?.used_percentage ?? 0);
  let v5 = `${p5}%`;
  if (five?.resets_at) v5 += `${RST}${BG}${DIM}(${timeUntil(five.resets_at)})`;
  L2.push(`${RST}${BG}${DIM}5h ${simpleStatusColor(p5)}${BOLD}${v5}`);

  // 7d
  const seven = d.rate_limits?.seven_day;
  const p7 = Math.round(seven?.used_percentage ?? 0);
  let v7 = `${p7}%`;
  if (seven?.resets_at) v7 += `${RST}${BG}${DIM}(${timeUntil(seven.resets_at)})`;
  L2.push(`${RST}${BG}${DIM}7d ${simpleStatusColor(p7)}${BOLD}${v7}`);

  if (THEME === "slave") {
    // Codex 使用率 (session 5h / week 7d)。コスト・継続時間の代わり。
    const cdx = codexUsage();
    if (cdx) {
      let seg =
        `${RST}${BG}${DIM}cdx ${simpleStatusColor(cdx.session)}${BOLD}${cdx.session}%` +
        `${RST}${BG}${DIM}/${simpleStatusColor(cdx.week)}${BOLD}${cdx.week}%`;
      const cep = (cdx.email || "").split("@")[0];
      if (cep) seg += ` ${YEL}${cep}`;
      L2.push(seg);
    } else {
      L2.push(`${RST}${BG}${DIM}cdx ${TXT}—`);
    }
  } else {
    // Cost
    const cost = d.cost?.total_cost_usd;
    if (cost != null) L2.push(`${RST}${BG}${DIM}$ ${TXT}${cost.toFixed(2)}`);

    // Duration
    const dur = d.cost?.total_duration_ms;
    if (dur != null) {
      const s = dur / 1000 | 0;
      const h = s / 3600 | 0, m = (s % 3600) / 60 | 0;
      const t = h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
      L2.push(`${RST}${BG}${DIM}${t}`);
    }
  }

  if (THEME === "simple-1") {
    process.stdout.write(`${BG} ${[...L1, ...L2].join(SEP)} ${RST}\n`);
  } else {
    let out = `${BG} ${L1.join(SEP)} ${RST}`;
    if (L2.length) out += `\n${BG} ${L2.join(SEP)} ${RST}`;
    process.stdout.write(out + "\n");
  }
}

// --- Claude rate-limits tee ---
// Claude Code はアカウントの 5h/7d 使用率を statusline stdin で渡してくる
// (Messages API 応答由来 — 稼働中のセッションが常に最新値を持つ)。これを
// ~/.cache/cc-statusline-claude.json へ書き出し、macker agent の usage
// collector が codexbar probe の 429 時に代替ソースとして読む (bd macker-6dr2:
// 忙しいノードほど usage endpoint の per-account 予算が枯れて外部 probe が
// 全滅する — この tee は endpoint への追加リクエストゼロで逆転させる)。
// statusline は描画のたびに走るので mtime で 10s に絞る。失敗しても
// statusline 本体は絶対に壊さない。
function teeRateLimits(d) {
  try {
    const rl = d.rate_limits;
    if (!rl || (rl.five_hour == null && rl.seven_day == null)) return;
    const file = `${homedir()}/.cache/cc-statusline-claude.json`;
    try {
      if (Date.now() - statSync(file).mtimeMs < 10_000) return;
    } catch {}
    mkdirSync(`${homedir()}/.cache`, { recursive: true });
    let email = "";
    try {
      email = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf8")).oauthAccount?.emailAddress || "";
    } catch {}
    const payload = JSON.stringify({
      v: 1,
      written_at: new Date().toISOString(),
      email,
      rate_limits: rl,
    });
    const tmp = `${file}.${process.pid}.tmp`; // pid 付き tmp: 並行セッションの衝突回避、rename は原子的
    try {
      writeFileSync(tmp, payload);
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch {} // rename 失敗時の残骸を残さない
      throw e;
    }
  } catch {}
}

// --- Main ---

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(input);
    teeRateLimits(d);

    if (THEME.startsWith("simple") || THEME === "slave") { renderSimple(d); return; }

    const L1 = [];
    const L2 = [];

    // Model
    const raw = d.model?.display_name || d.model?.id || "";
    const name = raw.replace(/^Claude\s*/i, "").replace(/\s*\(.*\)/, "").split(/\s+/)[0];
    const styles = {
      Opus:   { e: "🔮", bg: "80;20;40",  fg: "255;140;180" },
      Sonnet: { e: "✨", bg: "70;30;10",  fg: "255;170;80" },
      Haiku:  { e: "🍃", bg: "15;50;40",  fg: "120;230;180" },
    };
    const ms = styles[name] || { e: "●", bg: "50;50;50", fg: "200;200;200" };
    let effortTag = "";
    try {
      const st = JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, "utf8"));
      const e = st.effortLevel;
      if (e) {
        const m = { low: "l", medium: "m", high: "h", max: "mx" };
        effortTag = `/${m[e] || e}`;
      }
    } catch {}
    if (name) L1.push(staticBadge(ms.e + " ", name + effortTag, ms.bg, ms.fg));

    // Dir + Branch
    const cwd = d.workspace?.current_dir || d.cwd || "";
    const branch = gitBranch(cwd);
    const dir = cwd.split("/").pop() || "";
    if (dir) {
      const inner = branch
        ? `${dir} \x1b[38;2;120;110;60m→\x1b[38;2;180;220;255m${BOLD} ${branch}`
        : dir;
      L1.push(`\x1b[48;2;50;45;20m\x1b[38;2;230;210;120m 📁 ${inner} ${RST}`);
    }

    // Cost
    const cost = d.cost?.total_cost_usd;
    if (cost != null) {
      L1.push(
        `\x1b[48;2;40;40;60m\x1b[38;2;180;180;255m${BOLD} $ ${RST}` +
        `\x1b[48;2;25;25;40m\x1b[38;2;180;180;255m ${cost.toFixed(2)} ${RST}`
      );
    }

    // Diff
    const added = d.cost?.total_lines_added;
    const removed = d.cost?.total_lines_removed;
    if (added != null || removed != null) {
      L1.push(`\x1b[48;2;30;30;30m\x1b[38;2;100;255;100m ↑${fmt(added||0)}\x1b[38;2;70;70;70m/\x1b[38;2;255;100;100m↓${fmt(removed||0)} ${RST}`);
    }

    // Context bar
    L2.push(ctxBar(d.context_window?.used_percentage ?? 0, d.context_window?.total_input_tokens));

    // 5h
    const five = d.rate_limits?.five_hour;
    {
      const p = Math.round(five?.used_percentage ?? 0);
      let v = five?.used_percentage != null ? `${p}%` : "-";
      if (five?.resets_at) v += `(${timeUntil(five.resets_at)})`;
      L2.push(badge(p, "5h", v));
    }

    // 7d
    const seven = d.rate_limits?.seven_day;
    {
      const p = Math.round(seven?.used_percentage ?? 0);
      let v = seven?.used_percentage != null ? `${p}%` : "-";
      if (seven?.resets_at) v += `(${timeUntil(seven.resets_at)})`;
      L2.push(badge(p, "7d", v));
    }

    // Session duration
    const dur = d.cost?.total_duration_ms;
    if (dur != null) {
      const s = dur / 1000 | 0;
      const h = s / 3600 | 0, m = (s % 3600) / 60 | 0;
      const t = h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
      L2.push(staticBadge("⏱", t, "40;40;40", "180;180;180"));
    }

    // Output
    let out = L1.join(S);
    if (L2.length) out += "\n" + L2.join(S);
    process.stdout.write(out + "\n");
  } catch {
    process.stdout.write("statusline error\n");
  }
});
