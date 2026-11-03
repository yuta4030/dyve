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
