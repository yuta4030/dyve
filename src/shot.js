// パネルの本当の見た目を撮る：入っているブラウザをヘッドレスで呼ぶ（npm の依存は増やさない）。なければ撮れないと返す
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
const PLACES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // WSL から Windows のブラウザを呼ぶ
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

export function findBrowser(configured = null, { exists = fs.existsSync, env = process.env } = {}) {
  if (configured) return configured;
  for (const dir of (env.PATH || "").split(path.delimiter)) for (const n of NAMES) if (dir && exists(path.join(dir, n))) return path.join(dir, n);
  return PLACES.find((p) => exists(p)) ?? null;
}

// Windows のブラウザは WSL のパスに書けないので、Windows の一時フォルダを使い、パスを変換して渡す
function workArea(browser) {
  if (!browser.endsWith(".exe")) return { dir: fs.mkdtempSync(path.join(os.tmpdir(), "dyve-shot-")), outward: (p) => p };
  const win = execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { cwd: "/mnt/c", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const base = execFileSync("wslpath", ["-u", win], { encoding: "utf8" }).trim();
  return { dir: fs.mkdtempSync(path.join(base, "dyve-shot-")), outward: (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim() };
}

const defaultRun = (cmd, args, cwd) => new Promise((ok, no) => execFile(cmd, args, { timeout: 30000, cwd }, (e) => (e ? no(e) : ok())));

// 起動の口が先に戻ることがある（Windows のブラウザの立ち上がりが遅いとき）ので、絵ができるまで待つ
async function waitFor(file, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    await new Promise((ok) => setTimeout(ok, 200));
  }
}

export async function screenshot({ browser, url, width = 900, height = 800, run = defaultRun, area = workArea, patience = 20000 }) {
  const { dir, outward } = area(browser);
  try {
    const out = path.join(dir, "shot.png");
    await run(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${outward(path.join(dir, "profile"))}`, `--window-size=${width},${height}`, "--virtual-time-budget=5000", `--screenshot=${outward(out)}`, url], dir);
    await waitFor(out, patience);
    return fs.readFileSync(out);
  } finally {
    // ブラウザがまだプロファイルを掴んでいると消せないことがある。絵は取れているので止めない
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  }
}
