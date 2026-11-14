// パネル置き場：利用者の view を置くところ。git で履歴を持つ。view を足すだけでパネルが増え、役割「パネル」のセッションがここで書く。
// 画面は view を sandbox の iframe で描くので、view は dyve の口にも外のサーバーにも触れない
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// view の名前：英小文字・数字・-。本体が描く view（summary・list・table・text・json）と同じ名前なら、本体のほうを使う
const VIEW_NAME = /^[a-z][a-z0-9-]{0,40}$/;

const README = `# パネル置き場

dyve のカードに出るパネルは、view（描き方）の名前とデータでできている。
本体が描く view（summary・list・table・text・json）のほかに、ここに置いた view が使える。

## view の書き方

\`views/<名前>.js\` を一つ置くと、その名前の view になる（名前は英小文字・数字・-）。書き換えると、次に描くときから新しいものになる。

\`\`\`js
// 数を横棒で比べる
// data: [{ "label": "名前", "value": 数, "ref": やりとりの番号（なくてよい） }]
dyve.view((el, data, ctx) => {
  el.innerHTML = data.map((r) => \`<div>\${r.label} \${r.value}</div>\`).join("");
});
\`\`\`

- **頭のコメント**：一行目に、何を描く view かを一行で書く。二行目から、受け取るデータの形を書く。係は view を選ぶときにここだけを読む
- \`dyve.view(fn)\` を一度呼ぶ。\`fn(el, data, ctx)\` が描く
  - \`el\`：描く場所（空の div）
  - \`data\`：パネルのデータ（頭のコメントに書いた形）
  - \`ctx.theme\`：\`"light"\` か \`"dark"\`
  - \`ctx.light(ref)\`：行のもとのやりとりを光らせるよう頼む（\`ref\` はデータに付いてきた番号）
- できるのはこれだけ。描く場所は囲い（sandbox の iframe）の中で、dyve の口にも外のサーバーにも触れない（fetch・外の絵・フォント・スクリプトは通らない）。絵は SVG を中に書くか \`data:\` で埋め込む
- 高さは中身に合わせて決まる（カードの中では上限がある）
- 色は CSS 変数で：\`--bg\` \`--surface\` \`--sunk\` \`--ink\` \`--muted\` \`--line\` \`--accent\` \`--accent-soft\`
- 描けなかったとき（view が投げた・読み込めない）は、データがそのまま JSON で出る

## 履歴

この置き場は git で履歴を持つ。書いたらコミットする。push はしない。
`;

const SAMPLE = `// 数を横棒で比べる
// data: [{ "label": "名前", "value": 数, "ref": やりとりの番号（なくてよい） }]
dyve.view((el, data, ctx) => {
  const rows = Array.isArray(data) ? data : [];
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  el.innerHTML = \`<style>
    .r { display: grid; grid-template-columns: minmax(0, 7em) minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 2px 4px; border-radius: 6px; }
    .r[data-ref] { cursor: pointer; } .r[data-ref]:hover { background: var(--sunk); }
    .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .b { height: 10px; border-radius: 3px; background: var(--accent); min-width: 2px; }
    .v { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }
  </style>\` + rows.map((r) => \`<div class="r"\${r.ref != null ? \` data-ref="\${Number(r.ref)}"\` : ""}><span class="l">\${esc(r.label)}</span><span><span class="b" style="display:block;width:\${((Number(r.value) || 0) / max) * 100}%"></span></span><span class="v">\${esc(r.value)}</span></div>\`).join("");
  for (const r of el.querySelectorAll("[data-ref]")) r.onclick = () => ctx.light(Number(r.dataset.ref));
});
`;

// 置き場がなければ作る（git init・README・見本の view を一つ）。あれば何も上書きしない。
// git が使えなければ、履歴なしで作り、そのことを返す（warn）。置き場は使える
export function ensurePanels(dir) {
  if (fs.existsSync(dir)) return { dir, created: false, warn: null };
  fs.mkdirSync(path.join(dir, "views"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), README);
  fs.writeFileSync(path.join(dir, "views", "bars.js"), SAMPLE);
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=dyve", "-c", "user.email=dyve@localhost", "commit", "-q", "-m", "パネル置き場をつくる");
    return { dir, created: true, warn: null };
  } catch (e) {
    return { dir, created: true, warn: `git が使えないので、パネル置き場に履歴がない（${e.code ?? e.message}）` };
  }
}

// view の中身。名前で絞り、置き場の views の外は読ませない。なければ null
export function readView(dir, name) {
  if (!dir || !VIEW_NAME.test(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, "views", `${name}.js`), "utf8");
  } catch {
    return null;
  }
}

// 置いてある view：名前・一行の説明（頭のコメントの一行目）・データの形（二行目からのコメント）
export function listViews(dir) {
  let files = [];
  try {
    files = fs.readdirSync(path.join(dir, "views"));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".js") && VIEW_NAME.test(f.slice(0, -3)))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3), head = [];
      for (const line of (readView(dir, name) ?? "").split("\n")) {
        const m = /^\s*\/\/\s?(.*)$/.exec(line);
        if (!m) break;
        head.push(m[1].trim());
      }
      const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
      return { name, about: clip(head[0] ?? "", 120), shape: clip(head.slice(1).join("\n").trim(), 600) };
    });
}
