// 配役：エージェントの名前・起きる場所・モデル・指示を、利用者が自分好みに変える。
//   ~/.dyve/config.json：設定（serve のオプションと、清書係・マネージャ・控室の一人ずつ）
//   ~/.dyve/agents/<名前>.md：指示の本文（scribe.md・manager.md・控室の名前.md）。なければ既定の指示だけ
// 依存を持たないので、設定は JSON（JSON.parse）、指示はただの Markdown
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NAMES = ["アリス", "ボブ", "キャロル", "デイブ", "エレン", "フランク"];
const INITIALS = { "アリス": "A", "ボブ": "B", "キャロル": "C", "デイブ": "D", "エレン": "E", "フランク": "F" };
// 控室の名前に使えないもの（ボードの立場の名前）
export const RESERVED = new Set(["human", "scribe", "manager", "board"]);

// 書ける項目と型。path は ~ と config.json からの相対パスをほどく
const TOP = { port: "number", data: "path", room: "path", claude: "string", slots: "number", agents: "path", task: "object", scribe: "object", manager: "object", team: "array" };
// prompt：指示として読ませるファイル（育てている CLAUDE.md など）。一つでも配列でも
const TASK = { model: "string", prompt: "paths" };
const STAFF = { model: "string", pause: "number", cwd: "path", mode: "mode", prompt: "paths" };
const MEMBER = { name: "string", initial: "string", model: "string", room: "path", mode: "mode", prompt: "paths" };

const where = (p, dir) => path.resolve(dir, p.replace(/^~(?=$|\/)/, os.homedir()));

function take(obj, keys, at, dir) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${at} はオブジェクト（{ … }）で書く`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const t = keys[k];
    const key = at ? `${at}.${k}` : k;
    if (!t) throw new Error(`知らない項目 ${key}（書けるのは ${Object.keys(keys).join("・")}）`);
    if (t === "number" && !(typeof v === "number" && v >= 0)) throw new Error(`${key} は 0 以上の数`);
    if ((t === "string" || t === "path") && !(typeof v === "string" && v.trim())) throw new Error(`${key} は空でない文字列`);
    if (t === "mode" && v !== "append" && v !== "replace") throw new Error(`${key} は "append" か "replace"`);
    if (t === "array" && !Array.isArray(v)) throw new Error(`${key} は配列（[ … ]）で書く`);
    if (t === "paths") {
      const list = typeof v === "string" ? [v] : v;
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x.trim())) throw new Error(`${key} はファイルのパスか、その配列`);
      out[k] = list.map((x) => {
        const f = where(x, dir);
        if (!fs.existsSync(f)) throw new Error(`${key} のファイルがない：${f}`);
        return f;
      });
      continue;
    }
    out[k] = t === "path" ? where(v, dir) : v;
  }
  return out;
}

// 設定を読む。なければ空（既定のまま）
export function readConfig(file) {
  if (!file || !fs.existsSync(file)) return {};
  const dir = path.dirname(path.resolve(file));
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} が JSON として読めない（${e.message}）`);
  }
  const c = take(raw, TOP, "", dir);
  if (c.task) c.task = take(c.task, TASK, "task", dir);
  for (const role of ["scribe", "manager"]) if (c[role]) c[role] = take(c[role], STAFF, role, dir);
  if (c.team) {
    c.team = c.team.map((m, i) => {
      const a = take(m, MEMBER, `team[${i}]`, dir);
      if (!a.name) throw new Error(`team[${i}] に name がない`);
      checkName(a.name, `team[${i}].name`);
      return a;
    });
    const seen = new Set();
    for (const a of c.team) {
      if (seen.has(a.name)) throw new Error(`team に ${a.name} が二人いる`);
      seen.add(a.name);
    }
  }
  return c;
}

export function checkName(name, at = "名前") {
  if (!/^[^\s,、/\\]{1,40}$/u.test(name)) throw new Error(`${at}「${name}」は空白・カンマ・/ を含まない 40 文字まで`);
  if (RESERVED.has(name)) throw new Error(`${at}「${name}」はボードの立場の名前なので使えない`);
}

// 指示の本文：置き場の <名前>.md をそのまま
function readBodies(dir) {
  const bodies = {};
  if (!dir || !fs.existsSync(dir)) return bodies;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
    if (text) bodies[f.slice(0, -3)] = text;
  }
  return bodies;
}

// 指示の本文：prompt のファイルを順に、最後に置き場の <名前>.md。立てるときに一度読む
const join = (files = [], own) => [...files.map((f) => fs.readFileSync(f, "utf8").trim()), own].filter(Boolean).join("\n\n");

// 配役をそろえる：{ settings, scribe, manager, team, bodies }
// scribe・manager は { model, pause, cwd, mode, body }（どれもなければ null）。team は設定の控室（なければ空）
// bodies：控室の名前 -> 指示の本文（task.prompt、その人の prompt、<名前>.md）
// agents：コマンドで渡した置き場（設定より強い）。fallback：どちらもないときの置き場
export function loadCrew({ config = null, agents = null, fallback = null } = {}) {
  const c = readConfig(config);
  const dir = agents ?? c.agents ?? fallback;
  const own = readBodies(dir);
  const staff = (role) => (c[role] || own[role] ? { mode: "append", ...c[role], body: join(c[role]?.prompt, own[role]) } : null);
  const { scribe, manager, team, ...settings } = c;
  const bodies = {};
  const common = settings.task?.prompt ?? [];
  for (const n of new Set([...(team ?? []).map((a) => a.name), ...Object.keys(own).filter((n) => n !== "scribe" && n !== "manager")])) {
    bodies[n] = join([...common, ...((team ?? []).find((a) => a.name === n)?.prompt ?? [])], own[n]);
  }
  return { settings, agents: dir, scribe: staff("scribe"), manager: staff("manager"), team: team ?? [], bodies, common: join(common) };
}

// 控室の名前：--names があればそれ、なければ設定の team、どちらもなければ既定の六人
export function namesOf(crew, cli = null) {
  if (cli?.length) return cli;
  return crew?.team?.length ? crew.team.map((a) => a.name) : NAMES;
}

// 控室の一人：設定の team のその人と、指示の本文（どちらもなければ null）。task.prompt は全員に効く
export function agentOf(crew, name) {
  const conf = crew?.team?.find((a) => a.name === name);
  const body = crew?.bodies?.[name] ?? crew?.common ?? "";
  return conf || body ? { mode: "append", ...conf, name, body } : null;
}

// 頭文字：設定の initial、既定の六人の頭文字、なければ名前の一文字目
export function initialsOf(crew, names) {
  return Object.fromEntries(names.map((n) => [n, agentOf(crew, n)?.initial || INITIALS[n] || [...n][0]]));
}

const README = `# エージェントの置き場

dyve のエージェントの指示を自分好みにするところ。設定は ~/.dyve/config.json、指示の本文はここに置く。
どちらも置かなければ、dyve の既定のまま動く。変えたら dyve を立て直す（dyve 設定の「更新して再起動」でもよい）と効く。

## 指示（このディレクトリ）

- \`scribe.md\`：清書係、\`manager.md\`：マネージャ、\`<名前>.md\`：控室のその人（例：\`アリス.md\`）
- config.json の \`prompt\` に、ほかの場所のファイル（育てている CLAUDE.md など）を書くと、その中身も指示になる。順は prompt のファイル、そのあとにここのファイル
- 中身はそのまま指示として、dyve の既定の指示の後ろに足される（config.json の mode が "replace" なら差し替える）
- \`{{names}}\` と書くと、控室のエージェントの名前の並び（アリス、ボブ…）に置き換わる

## 設定（~/.dyve/config.json）

\`\`\`json
{
  "room": "~/code/myrepo",
  "slots": 3,
  "task":    { "model": "opus", "prompt": "~/notes/research.md" },
  "scribe":  { "model": "haiku", "pause": 1000, "prompt": ["~/notes/CLAUDE.md", "~/notes/words.md"] },
  "manager": { "model": "sonnet", "pause": 4000, "cwd": "~/.dyve/staff" },
  "team": [
    { "name": "マイ", "initial": "M", "model": "opus", "room": "~/code/docs" },
    { "name": "ケン" }
  ]
}
\`\`\`

- 上の段：\`port\`・\`data\`・\`room\`・\`claude\`・\`slots\`・\`agents\`（この置き場）はコマンドのオプションと同じ。コマンドで渡したほうが勝つ
- \`task.model\`：控室の全員のモデル（\`--task-model\` と同じ）。\`task.prompt\`：控室の全員に読ませるファイル
- \`prompt\`（task・scribe・manager・team の一人ずつ）：指示として読ませるファイルのパス。一つなら文字列、いくつもなら配列
- \`scribe\`・\`manager\`：\`model\`、\`pause\`（ミリ秒。清書係は発言から渡すまで、マネージャは最後の発言から起こすまで）、\`cwd\`（起きるディレクトリ）、\`mode\`（"append" か "replace"）
- \`team\`：控室の顔ぶれ。並んだ順に仕事を受ける。書くと既定の六人の代わりになる
  - \`name\`（要る）、\`initial\`（アイコンの頭文字）、\`model\`（task.model より強い）、\`room\`（働くディレクトリ。開発の仕事はここから worktree を切り出す）、\`mode\`
- パスの \`~\` はホーム、相対パスは config.json のあるところから
`;

// 置き場がなければ作り、README だけ置く
export function ensureCrew(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  return dir;
}
