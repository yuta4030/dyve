// 利用者のパネル置き場：~/.dyve/panels。拡張の view はここに置き、dyve 本体には最小限だけを持つ。
// git で履歴を持つので、エージェントが書き換えても戻せる。画面は sandbox の iframe で描くので、view はボードの API に触れない
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const VIEW_NAME = /^[a-z][a-z0-9-]{0,40}$/;

const README = `# パネル置き場

dyve のパネルは「view（描き方）」と「データ」でできている。ここは利用者の view を置くところ。
dyve 本体が持つ view（say・text・list・table・task・summary・json）以外は、全部ここに置く。

## view の書き方

\`views/<名前>.js\` を一つ置くと、パネルの view に \`<名前>\` と書けば使える（名前は英小文字・数字・-）。
ファイルを書き換えると、画面はすぐ描き直す（読み直しは要らない）。

\`\`\`js
// views/bars.js：数の並びを横棒で
dyve.view((el, data, ctx) => {
  const rows = Array.isArray(data) ? data : Object.entries(data || {}).map(([label, value]) => ({ label, value }));
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  el.innerHTML = rows.map((r) => \`
    <div class="row"><span>\${r.label}</span><b style="width:\${(Number(r.value) / max) * 100}%"></b><em>\${r.value}</em></div>\`).join("");
});
\`\`\`

- \`dyve.view(fn)\` を一度呼ぶ。\`fn(el, data, ctx)\` は描くたびに呼ばれる
  - \`el\`：描く場所（空の div）
  - \`data\`：パネルのデータ（または shell コマンドの結果。JSON として読めればその形、読めなければ文字列）
  - \`ctx.panel\`：パネル（id・by・view・about…）
  - \`ctx.board()\`：ボードのパネル全部（Promise）
  - \`ctx.open(id)\`：ボードのそのパネルを見せる
- 描く場所は囲い（sandbox の iframe）の中。外のページやボードの API には触れない。外のスクリプトや CDN は読まない
- 色は CSS 変数で：\`--bg\` \`--card\` \`--ink\` \`--mute\` \`--line\` \`--accent\` \`--accent-soft\` \`--warn\` \`--ok\`
- 高さは中身に合わせて自動で決まる
- \`<style>\` は view の中で書いてよい（\`el.innerHTML\` に含める）

## データの流し込み方

- パネルの data に直接書く（エージェントは panel_add / panel_edit で）
- \`dyve put <id>\`：標準入力をそのパネルのデータにする（例：\`df -h | dyve put p12\`）
- パネルの source に shell コマンドを持たせる：\`{ "shell": "git log --oneline -5", "every": 60 }\`（every は秒、なければ一度だけ）。
  人が置いたコマンドはすぐ走る。エージェントが置いたコマンドは、人が「実行を許可」を押すまで走らない
- \`dyve add --view bars --shell "…" --every 30\`：人として、コマンド付きのパネルを置く

## 管理

画面の「パネルの管理」（\`/panels\`）で、view ごとに使う・使わない、既定の大きさ、消す（\`trash/\` に移すだけで戻せる）を決められる。
設定は人のものなので、この置き場の外（\`../panel-settings.json\`）に持つ。
`;

const EXAMPLE = `// 数の並びを横棒で。data は [{label, value}] か { ラベル: 数 }
dyve.view((el, data) => {
  const rows = Array.isArray(data) ? data : Object.entries(data || {}).map(([label, value]) => ({ label, value }));
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  el.innerHTML = \`<style>
    .row { display: grid; grid-template-columns: minmax(4em, 30%) 1fr auto; gap: 8px; align-items: center; margin: 3px 0; }
    .row span { color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row b { display: block; height: 10px; border-radius: 5px; background: var(--accent); min-width: 2px; }
    .row em { font-style: normal; font-variant-numeric: tabular-nums; }
  </style>\` + rows.map((r) => \`<div class="row"><span>\${esc(r.label)}</span><b style="width:\${(Number(r.value) / max) * 100}%"></b><em>\${esc(r.value)}</em></div>\`).join("");
});
`;

// 置き場がなければ作る（README と見本、git の履歴）
export function ensurePanels(dir) {
  const views = path.join(dir, "views");
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(views, { recursive: true });
  if (!fs.existsSync(path.join(dir, "README.md"))) fs.writeFileSync(path.join(dir, "README.md"), README);
  if (fresh) fs.writeFileSync(path.join(views, "bars.js"), EXAMPLE);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    try {
      const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=dyve", "-c", "user.email=dyve@localhost", "commit", "-q", "-m", "パネル置き場をつくる");
    } catch {}
  }
  return dir;
}

// 置いてある view の名前と、変わったら変わる印
export function listViews(dir) {
  const views = path.join(dir, "views");
  if (!fs.existsSync(views)) return [];
  return fs.readdirSync(views)
    .filter((f) => f.endsWith(".js") && VIEW_NAME.test(f.slice(0, -3)))
    .map((f) => {
      const st = fs.statSync(path.join(views, f));
      return { name: f.slice(0, -3), hash: `${st.size}-${Math.round(st.mtimeMs)}` };
    });
}

export function readView(dir, name) {
  if (!VIEW_NAME.test(name)) return null;
  const file = path.join(dir, "views", `${name}.js`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

// ── 管理：画面の /panels から人だけが変える ──
// 本体の view。消せない・使わないにできない（結果を置く先がなくなり、見えない結果ができてしまうので）
export const BUILTIN = ["say", "text", "list", "table", "task", "topic", "summary", "json"];
// 置かれる場所が決まっている view には既定の大きさがない
const NO_SIZE = new Set(["say", "summary"]);
const TRASHED = /^([a-z][a-z0-9-]{0,40})\.\d+\.js$/;

// 設定は置き場の外に持つ（置き場はパネルの仕事のエージェントが書ける。使う・使わないを決めるのは人）
const settingsFile = (dir) => path.join(path.dirname(dir), "panel-settings.json");

export function readSettings(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
    return { views: s.views && typeof s.views === "object" ? s.views : {} };
  } catch {
    return { views: {} };
  }
}

export const offViews = (dir) => new Set(Object.entries(readSettings(dir).views).filter(([, v]) => v?.off).map(([k]) => k));

const badSize = (v, min) => v != null && !(Number.isInteger(v) && v >= min && v <= 2000);

// 渡した項目だけ変える。off：使わない。w・h：既定の大きさ（ピクセル。null で自動）
export function setView(dir, name, { off, w, h } = {}) {
  if (!VIEW_NAME.test(name)) throw new Error("view の名前が正しくない");
  if (off !== undefined && BUILTIN.includes(name)) throw new Error("本体の view は使わないにできない");
  if (NO_SIZE.has(name) && (w !== undefined || h !== undefined)) throw new Error("この view には既定の大きさがない");
  if (badSize(w, 120)) throw new Error("幅は 120 から 2000 まで");
  if (badSize(h, 60)) throw new Error("高さは 60 から 2000 まで");
  const set = readSettings(dir), v = { ...set.views[name] };
  if (off !== undefined) { if (off) v.off = true; else delete v.off; }
  for (const [k, x] of [["w", w], ["h", h]]) if (x !== undefined) { if (x == null) delete v[k]; else v[k] = x; }
  if (Object.keys(v).length) set.views[name] = v; else delete set.views[name];
  fs.writeFileSync(settingsFile(dir), JSON.stringify(set, null, 2) + "\n");
  return v;
}

// 履歴に残す（git がなくても trash/ に残るので、失敗しても止めない）
function record(dir, message, paths) {
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    for (const p of paths) { try { git("add", "-A", "--", p); } catch {} }
    git("-c", "user.name=dyve", "-c", "user.email=dyve@localhost", "commit", "-q", "-m", message);
  } catch {}
}

// 消す：trash/ へ移すだけ。そのボードに残ったパネルは JSON のまま見える（データは落とさない）
export function trashView(dir, name, now = Date.now()) {
  if (!VIEW_NAME.test(name)) throw new Error("view の名前が正しくない");
  const file = path.join(dir, "views", `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`その view はない：${name}`);
  fs.mkdirSync(path.join(dir, "trash"), { recursive: true });
  const to = `${name}.${now}.js`;
  fs.renameSync(file, path.join(dir, "trash", to));
  record(dir, `${name} を消す（trash へ）`, [`views/${name}.js`, `trash/${to}`]);
  return to;
}

export function restoreView(dir, file) {
  const m = TRASHED.exec(String(file));
  if (!m) throw new Error("消したものの名前が正しくない");
  const from = path.join(dir, "trash", file), to = path.join(dir, "views", `${m[1]}.js`);
  if (!fs.existsSync(from)) throw new Error(`消したものにない：${file}`);
  if (fs.existsSync(to)) throw new Error(`同じ名前の view がある：${m[1]}`);
  fs.renameSync(from, to);
  record(dir, `${m[1]} を戻す`, [`views/${m[1]}.js`, `trash/${file}`]);
  return m[1];
}

export function listTrash(dir) {
  const t = path.join(dir, "trash");
  if (!fs.existsSync(t)) return [];
  return fs.readdirSync(t)
    .map((file) => ({ file, m: TRASHED.exec(file) }))
    .filter((x) => x.m)
    .map(({ file, m }) => ({ file, name: m[1], at: new Date(Number(file.split(".")[1])).toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// 管理の一覧：本体・置き場の view と、ボードで使われているのに描き方のないもの。here：このボードの枚数、all：全ボードの枚数
export function catalog(dir, { here = {}, all = {} } = {}) {
  const { views } = readSettings(dir);
  const user = listViews(dir).map((v) => v.name).filter((n) => !BUILTIN.includes(n)).sort();
  const known = new Set([...BUILTIN, ...user]);
  const missing = [...new Set([...Object.keys(here), ...Object.keys(all)])].filter((n) => !known.has(n)).sort();
  const row = (name, kind) => ({ name, kind, off: !!views[name]?.off, w: views[name]?.w ?? null, h: views[name]?.h ?? null, sizable: !NO_SIZE.has(name), here: here[name] || 0, all: all[name] || 0 });
  return {
    views: [...user.map((n) => row(n, "user")), ...missing.map((n) => row(n, "missing")), ...BUILTIN.map((n) => row(n, "builtin"))],
    trash: listTrash(dir),
  };
}
