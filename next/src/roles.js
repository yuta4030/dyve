// 役割：セッションを起こすときの定義。dyve の定義（next/roles/<名前>.md）に、利用者の置き場の定義を重ねる。
//   <置き場>/config.json：役割ごとの model・mode・tools・deny（JSON。YAML は使わない）
//   <置き場>/roles/<名前>.md：役割の指示。dyve と同じ名前なら後ろに足し（mode が "replace" なら差し替え）、新しい名前なら役割が増える
// 許す道具は、dyve の役割はこのファイルに、利用者の役割は config.json に書く。定義（Markdown）には役割の指示だけを書く
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, NAME } from "./config.js";

const BUILTIN_DIR = fileURLToPath(new URL("../roles/", import.meta.url));

const READ = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];
const COMMIT = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"];
// 外に届くこと・取り消せないこと。どの役割にも禁じ、利用者の設定でも外せない（Claude Code では禁止が許可に勝つ）
export const NEVER = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(git reset:*)", "Bash(rm:*)"];

// place：起きる場所。room は serve の --room、panels は利用者のパネル置き場、worktree はセッションごとに部屋から切り出す作業場（work.js）
const BUILTIN = {
  調べもの: { about: "頼まれたことを、リポジトリを読み、要るときは Web で調べて答える。ファイルは書き換えない", place: "room", tools: READ, deny: ["Edit", "Write", "NotebookEdit"] },
  開発: { about: "仕事ごとの作業場（git worktree とブランチ）でコードを書き、テストを走らせてコミットする", place: "worktree", tools: [...READ, "Edit", "Write", "Bash(node --test:*)", ...COMMIT], deny: ["Bash(git worktree:*)", "Bash(git checkout:*)"] },
  パネル: { about: "パネルの見せ方（view）そのものを作る・直す。「〜を棒で見たい」「こういうパネルがほしい」のような、見せ方の頼み。データを調べて答える頼みではない", place: "panels", tools: [...READ, "Edit", "Write", ...COMMIT], deny: [] },
};



function readBodies(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const name = f.slice(0, -3);
    if (!NAME.test(name)) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
    if (text) out[name] = text;
  }
  return out;
}

// 役割をそろえる。config：利用者の config.json。利用者の定義は、その隣の roles/ に置く
// 返すもの：名前 -> { name, about, place, prompt, model, tools, deny }
export function loadRoles({ config = null, builtin = BUILTIN_DIR } = {}) {
  const tune = readConfig(config).roles;
  const own = readBodies(config ? path.join(path.dirname(config), "roles") : null);
  const base = readBodies(builtin);
  const roles = {};
  for (const name of new Set([...Object.keys(BUILTIN), ...Object.keys(own), ...Object.keys(tune)])) {
    const b = BUILTIN[name], t = tune[name] ?? {};
    if (!b && !own[name]) throw new Error(`役割「${name}」の定義がない（${config ? path.join(path.dirname(config), "roles", `${name}.md`) : "roles/"} に書く）`);
    let prompt = b ? base[name] ?? "" : "";
    if (own[name]) prompt = t.mode === "replace" || !prompt ? own[name] : `${prompt}\n\n## 利用者からの指示\n${own[name]}`;
    roles[name] = {
      name,
      place: b?.place ?? "room",
      // 一行の説明（係が役割を選ぶときに読む）：dyve の役割はここに、利用者の役割は定義の頭の一行
      about: b?.about ?? own[name].split("\n").map((l) => l.replace(/^[#\s>*-]+/, "").trim()).find(Boolean) ?? name,
      prompt,
      model: t.model ?? null,
      // 許す道具：設定に書けば差し替え、なければ dyve の役割のもの（利用者の新しい役割は読むだけ）
      tools: t.tools ?? b?.tools ?? READ,
      // 禁じる道具：dyve の役割のもの・設定に書いたもの・外に届くこと。足すだけで、外せない
      deny: [...new Set([...(b?.deny ?? (t.tools ? [] : BUILTIN.調べもの.deny)), ...(t.deny ?? []), ...NEVER])],
    };
  }
  return roles;
}
