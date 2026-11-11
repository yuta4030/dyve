// 利用者のパネル置き場：~/.dyve/panels。拡張の view はここに置き、dyve 本体には最小限だけを持つ。
// git で履歴を持つので、エージェントが書き換えても戻せる。画面は sandbox の iframe で描くので、view はボードの API に触れない
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  - \`ctx.send(値)\`：パネルの送り出し（下の「外への送り出し方」）に、これを送りたいと頼む。view は自分では送れない。送る中身がパネルの下に出て、人が「送る」を押すと走る
- 描く場所は囲い（sandbox の iframe）の中。外のページやボードの API には触れない。外のスクリプトや CDN は読まない
- 色は CSS 変数で：\`--bg\` \`--card\` \`--ink\` \`--mute\` \`--line\` \`--accent\` \`--accent-soft\` \`--warn\` \`--ok\`
- 高さは中身に合わせて自動で決まる
- \`<style>\` は view の中で書いてよい（\`el.innerHTML\` に含める）
- ファイルの頭のコメントに、データの形を書いておく。エージェントは view を選ぶとき、ここを読む
- 見本（bars・cards・change・tree・days）は dyve が配る。新しい見本は、まだ配っていないものだけ足す（\`.samples\` に記録する。消したものや同じ名前のものは上書きしない）

## データの流し込み方

- パネルの data に直接書く（エージェントは panel_add / panel_edit で）
- \`dyve put <id>\`：標準入力をそのパネルのデータにする（例：\`df -h | dyve put p12\`）
- パネルの source に shell コマンドを持たせる：\`{ "shell": "git log --oneline -5", "every": 60 }\`（every は秒、なければ一度だけ）。
  人が置いたコマンドはすぐ走る。エージェントが置いたコマンドは、人が「実行を許可」を押すまで走らない
- \`dyve add --view bars --shell "…" --every 30\`：人として、コマンド付きのパネルを置く

## 外への送り出し方

- パネルの send に shell コマンドを持たせる：\`{ "shell": "tee -a notes.txt", "label": "書き足す" }\`（label は「送る」のボタンの字）
- 人がパネルの下の欄に書いて「送る」を押すと、入力を標準入力に渡してコマンドを走らせる。文字列はそのまま、\`ctx.send\` で渡したオブジェクトは JSON。環境変数 \`DYVE_PANEL\` にパネルの id
- 送るのは人だけ。エージェントが置いた・変えたコマンドは、人が「送り出しを許可」を押すまで走らない
- 送ったものはボードに残る。うまくいくと、同じパネルの source を取り直す
- \`dyve add --view text --send "…" --label 書き足す\`：人として、送り出し付きのパネルを置く

## 管理

画面の「パネルの管理」（\`/panels\`）で、view ごとに使う・使わない、既定の大きさ、消す（\`trash/\` に移すだけで戻せる）を決められる。
設定は人のものなので、この置き場の外（\`../panel-settings.json\`）に持つ。
`;

// 配る見本の view（汎用のものだけ。本体の view には足さない）。中身は src/samples/<名前>.js、管理の絵に使う見本のデータは src/samples/data.json
const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
export const SAMPLES = ["bars", "cards", "change", "tree", "days"];
export const sampleSource = (name) => fs.readFileSync(path.join(SAMPLE_DIR, `${name}.js`), "utf8");
export function sampleData() {
  try { return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, "data.json"), "utf8")); } catch { return {}; }
}
// 配った見本の名前の記録（置き場の中に持ち、履歴にも積む）。一度配ったものは、消されても上書きされていても二度と配らない
const HANDED = ".samples";

// 置き場がなければ作る（README と見本、git の履歴）。すでにあれば、まだ配っていない見本だけ足す。
// 同じ名前の view があれば上書きしない。消したもの（trash に移したもの）は戻さない
export function ensurePanels(dir) {
  const views = path.join(dir, "views");
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(views, { recursive: true });
  if (!fs.existsSync(path.join(dir, "README.md"))) fs.writeFileSync(path.join(dir, "README.md"), README);
  const file = path.join(dir, HANDED);
  // 記録がない置き場は、記録を持つ前の版が作ったもの。そのときは作ったときに bars だけを配っている
  const handed = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : fresh ? [] : ["bars"];
  const trashed = new Set(listTrash(dir).map((t) => t.name));
  const added = [], before = handed.length;
  for (const name of SAMPLES) {
    if (handed.includes(name)) continue;
    handed.push(name);
    const to = path.join(views, `${name}.js`);
    if (fs.existsSync(to) || trashed.has(name)) continue;
    try { fs.writeFileSync(to, sampleSource(name)); added.push(name); } catch {}
  }
  if (handed.length !== before || !fs.existsSync(file)) fs.writeFileSync(file, handed.join("\n") + "\n");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    try {
      const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=dyve", "-c", "user.email=dyve@localhost", "commit", "-q", "-m", "パネル置き場をつくる");
    } catch {}
  } else if (handed.length !== before) {
    record(dir, added.length ? `見本の view を足す：${added.join("・")}` : "配った見本の記録", [HANDED, ...added.map((n) => `views/${n}.js`)]);
  }
  return dir;
}

// 置いてある view の名前と、頭のコメント（データの形の説明）。エージェントが view を選ぶときに読む
export function describeViews(dir) {
  return listViews(dir).map(({ name }) => {
    const src = readView(dir, name) || "";
    const head = [];
    for (const line of src.split("\n")) {
      const m = /^\s*\/\/\s?(.*)$/.exec(line);
      if (!m) break;
      head.push(m[1]);
    }
    const about = head.join("\n").trim();
    return { name, about: about.length > 800 ? `${about.slice(0, 800)}…` : about };
  });
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

// 管理の一覧：本体・置き場の view と、ボードで使われているのに描き方のないもの。here：このボードの枚数、all：全ボードの枚数、samples：絵に使う見本のデータ
export function catalog(dir, { here = {}, all = {}, samples = {} } = {}) {
  const { views } = readSettings(dir);
  const files = listViews(dir);
  const hash = Object.fromEntries(files.map((v) => [v.name, v.hash]));
  const user = files.map((v) => v.name).filter((n) => !BUILTIN.includes(n)).sort();
  const known = new Set([...BUILTIN, ...user]);
  const missing = [...new Set([...Object.keys(here), ...Object.keys(all)])].filter((n) => !known.has(n)).sort();
  const row = (name, kind) => ({ name, kind, off: !!views[name]?.off, w: views[name]?.w ?? null, h: views[name]?.h ?? null, sizable: !NO_SIZE.has(name), here: here[name] || 0, all: all[name] || 0, sample: samples[name] ?? null, hash: kind === "user" ? hash[name] : null });
  return {
    views: [...user.map((n) => row(n, "user")), ...missing.map((n) => row(n, "missing")), ...BUILTIN.map((n) => row(n, "builtin"))],
    trash: listTrash(dir),
  };
}
