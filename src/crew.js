// 配役：役割（タスクエージェントの得意なこと・起きる場所・モデル・指示の一組）と、清書係・マネージャの指示を、利用者が自分好みに変える。
//   ~/.dyve/config.json：個人の設定（serve のオプション、清書係・マネージャ・役割、入っているチーム）
//   <チームのリポジトリ>/.dyve/config.json：チームの設定（チームで育てる役割と指示）
//   ~/.dyve/agents/<名前>.md：個人の指示の本文（scribe.md・manager.md・役割の名前.md）
// 役割は人ではない。一つの役割で何本でも行が並んで動く
// 依存を持たないので、設定は JSON（JSON.parse）、指示はただの Markdown。
// どれが勝つか：コマンド > 個人 > チーム > 既定。チームの設定はほかの人が書くので、書ける項目と場所を絞る
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 既定の役割：設定の team も --names もないときの一つだけ
export const DEFAULT = "backroom";
export const NAMES = [DEFAULT];
const CALLS = { [DEFAULT]: "控室" };
const INITIALS = { [DEFAULT]: "控" };
// 役割の名前に使えないもの（ボードの立場の名前）
export const RESERVED = new Set(["human", "scribe", "manager", "board"]);
const TEAM_NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;

// 書ける項目と型。path は ~ と config.json からの相対パスをほどく
// prompt：指示として読ませるファイル（育てている CLAUDE.md など）。一つでも配列でも
const PERSONAL = {
  top: { port: "number", data: "path", room: "path", claude: "string", browser: "string", slots: "number", agents: "path", task: "object", scribe: "object", manager: "object", team: "array", teams: "array" },
  task: { model: "string", prompt: "paths" },
  staff: { model: "string", pause: "number", cwd: "path", mode: "mode", prompt: "paths" },
  member: { name: "string", description: "string", initial: "string", model: "string", room: "path", mode: "mode", prompt: "paths" },
};
// チーム：自分のエージェントへの指示と、チームのリポジトリの中の場所だけ。コマンドや置き場、指示の差し替えは書けない
const TEAM = {
  top: { name: "string", room: "path", task: "object", scribe: "object", manager: "object", team: "array" },
  task: { model: "string", prompt: "paths" },
  staff: { prompt: "paths" },
  member: { name: "string", description: "string", initial: "string", model: "string", room: "path", prompt: "paths" },
};
const JOIN = { path: "string", rename: "object", model: "string" };

const where = (p, dir) => path.resolve(dir, p.replace(/^~(?=$|\/)/, os.homedir()));
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (p, root) => {
  const r = path.relative(real(root), real(p));
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

// ctx：{ dir（相対パスの基準）, root（チームなら、パスはこの中だけ）}
function take(obj, keys, at, ctx) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${at || "設定"} はオブジェクト（{ … }）で書く`);
  const out = {};
  const place = (x, key) => {
    const f = where(x, ctx.dir);
    if (ctx.root && !inside(f, ctx.root)) throw new Error(`${key} はチームのリポジトリ（${ctx.root}）の中だけ：${f}`);
    return f;
  };
  for (const [k, v] of Object.entries(obj)) {
    const t = keys[k];
    const key = at ? `${at}.${k}` : k;
    if (!t) throw new Error(`知らない項目 ${key}（書けるのは ${Object.keys(keys).join("・")}）`);
    if (t === "number" && !(typeof v === "number" && v >= 0)) throw new Error(`${key} は 0 以上の数`);
    if ((t === "string" || t === "path") && !(typeof v === "string" && v.trim())) throw new Error(`${key} は空でない文字列`);
    if (t === "mode" && v !== "append" && v !== "replace") throw new Error(`${key} は "append" か "replace"`);
    if (t === "array" && !Array.isArray(v)) throw new Error(`${key} は配列（[ … ]）で書く`);
    if (t === "object" && (!v || typeof v !== "object" || Array.isArray(v))) throw new Error(`${key} はオブジェクト（{ … }）で書く`);
    if (t === "paths") {
      const list = typeof v === "string" ? [v] : v;
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x.trim())) throw new Error(`${key} はファイルのパスか、その配列`);
      out[k] = list.map((x) => {
        const f = place(x, key);
        if (!fs.existsSync(f)) throw new Error(`${key} のファイルがない：${f}`);
        return f;
      });
      continue;
    }
    out[k] = t === "path" ? place(v, key) : v;
  }
  return out;
}

export function checkName(name, at = "名前") {
  if (!/^[^\s,、/\\@]{1,40}$/u.test(name)) throw new Error(`${at}「${name}」は空白・カンマ・/・@ を含まない 40 文字まで`);
  if (RESERVED.has(name)) throw new Error(`${at}「${name}」はボードの立場の名前なので使えない`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} が JSON として読めない（${e.message}）`);
  }
}

function parse(raw, S, ctx) {
  const c = take(raw, S.top, "", ctx);
  if (c.task) c.task = take(c.task, S.task, "task", ctx);
  for (const role of ["scribe", "manager"]) if (c[role]) c[role] = take(c[role], S.staff, role, ctx);
  if (c.team) {
    c.team = c.team.map((m, i) => {
      const a = take(m, S.member, `team[${i}]`, ctx);
      if (!a.name) throw new Error(`team[${i}] に name がない`);
      checkName(a.name, `team[${i}].name`);
      return a;
    });
    const seen = new Set();
    for (const a of c.team) {
      if (seen.has(a.name)) throw new Error(`team に ${a.name} が二つある`);
      seen.add(a.name);
    }
  }
  return c;
}

// 個人の設定を読む。なければ空（既定のまま）
export function readConfig(file) {
  if (!file || !fs.existsSync(file)) return {};
  const dir = path.dirname(path.resolve(file));
  const c = parse(readJson(file), PERSONAL, { dir });
  if (c.teams) {
    c.teams = c.teams.map((t, i) => {
      const j = typeof t === "string" ? { path: t } : take(t, JOIN, `teams[${i}]`, { dir });
      if (typeof j.path !== "string" || !j.path.trim()) throw new Error(`teams[${i}] に path がない`);
      const rename = j.rename ?? {};
      for (const [from, to] of Object.entries(rename)) {
        if (typeof to !== "string") throw new Error(`teams[${i}].rename.${from} は文字列`);
        checkName(to, `teams[${i}].rename.${from}`);
      }
      return { path: where(j.path, dir), rename, model: j.model ?? null };
    });
  }
  return c;
}

// チームの設定：<リポジトリ>/.dyve/config.json。パスはその .dyve からの相対で、リポジトリの中だけ
export function readTeam(root) {
  const file = path.join(root, ".dyve", "config.json");
  if (!fs.existsSync(file)) throw new Error(`チームの設定がない：${file}`);
  let c;
  try {
    c = parse(readJson(file), TEAM, { dir: path.dirname(file), root });
  } catch (e) {
    throw new Error(e.message.startsWith(file) ? e.message : `${file}：${e.message}`);
  }
  const name = c.name ?? path.basename(root);
  if (!TEAM_NAME.test(name)) throw new Error(`${file}：チームの名前「${name}」は英数字・_・.・- の 40 文字まで（name で決められる）`);
  return { ...c, name, root, file };
}

// 個人の指示の本文：置き場の <名前>.md をそのまま
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

// 指示の本文：ファイルを順に、最後に手元の本文。立てるときに一度読む
const join = (files = [], ...own) => [...files.map((f) => fs.readFileSync(f, "utf8").trim()), ...own].filter(Boolean).join("\n\n");

// 配役をそろえる。
// members：役割一つずつ { id, name, call, description, team, initial, model, room, mode, body }
//   id はログ・MCP に残る名前で、変えない（チームの人は「名前@チーム」）。call は画面と声で呼ぶ名前
// teams：{ name, root, room, manager（マネージャに渡すチームの指示）}
// scribe・manager：{ model, pause, cwd, mode, body }（どれもなければ null）
// warnings：立てるときに端末に出すこと（名前がぶつかった、など）
// agents：コマンドで渡した置き場（設定より強い）。fallback：どちらもないときの置き場
export function loadCrew({ config = null, agents = null, fallback = null } = {}) {
  const c = readConfig(config);
  const dir = agents ?? c.agents ?? fallback;
  const own = readBodies(dir);
  const { scribe, manager, team, teams: joins, ...settings } = c;
  const teams = (joins ?? []).map((j) => ({ ...readTeam(j.path), join: j }));
  const seenTeam = new Set();
  for (const t of teams) {
    if (seenTeam.has(t.name)) throw new Error(`チームの名前 ${t.name} が二つある（${t.file}）。チームの設定の name で分ける`);
    seenTeam.add(t.name);
  }
  const common = settings.task?.prompt ?? [];
  const warnings = [];

  const members = [];
  for (const m of team ?? []) {
    members.push({ id: m.name, name: m.name, description: m.description ?? null, team: null, initial: m.initial ?? null, model: m.model ?? null, room: m.room ?? null, mode: m.mode ?? "append", body: join([...common, ...(m.prompt ?? [])], own[m.name]) });
  }
  for (const t of teams) {
    if (!t.team?.length) warnings.push(`チーム ${t.name} には役割がない（${t.file} の team）`);
    for (const m of t.team ?? []) {
      const id = `${m.name}@${t.name}`;
      members.push({
        id,
        name: t.join.rename[m.name] ?? m.name,
        description: m.description ?? null,
        team: t.name,
        initial: m.initial ?? null,
        model: t.join.model ?? m.model ?? t.task?.model ?? null,
        room: m.room ?? t.room ?? t.root,
        mode: "append",
        // チームの指示、そのあとに個人の指示（個人が後ろ＝強い）
        body: join([...(t.task?.prompt ?? []), ...(m.prompt ?? []), ...common], own[id]),
      });
    }
    for (const from of Object.keys(t.join.rename)) if (!t.team?.some((m) => m.name === from)) warnings.push(`teams の ${t.name} の rename：${from} はそのチームにない`);
  }
  // 呼び名：ぶつからなければ名前のまま。ぶつかったら、チームの人だけ「チーム の 名前」と呼び分ける
  const count = new Map();
  for (const m of members) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  for (const [name, n] of count) {
    if (n < 2) continue;
    const who = members.filter((m) => m.name === name);
    warnings.push(`${who.map((m) => m.team ?? "自分の設定").join(" と ")} の両方に ${name} がある。${who.map((m) => (m.team ? `${m.team} の ${name}` : name)).join("・")} と呼び分ける（消すには、個人の設定の teams の rename で呼び名を変える）`);
  }
  for (const m of members) {
    const clash = count.get(m.name) > 1 && m.team;
    m.call = clash ? `${m.team} の ${m.name}` : m.name;
    const base = m.initial || INITIALS[m.name] || [...m.name][0];
    m.initial = clash ? `${[...m.team][0].toLowerCase()}${base}` : base;
  }

  // 清書係はチームの指示（用語の言い換えなど）も足す。マネージャのチームの指示は、チームごとの節に入れる（systemPrompt）
  const staff = (role, fromTeams) => {
    const tb = fromTeams ? teams.map((t) => join(t[role]?.prompt)).filter(Boolean) : [];
    // チームの指示、そのあとに個人の指示（個人が後ろ＝強い）
    const body = join([], ...tb, join(c[role]?.prompt), own[role]);
    return c[role] || own[role] || tb.length ? { mode: "append", ...c[role], body } : null;
  };
  return {
    settings,
    agents: dir,
    scribe: staff("scribe", true),
    manager: staff("manager", false),
    members,
    teams: teams.map((t) => ({ name: t.name, root: t.root, room: t.room ?? t.root, manager: join(t.manager?.prompt) })),
    common: join(common),
    own: Object.fromEntries(Object.entries(own).filter(([k]) => k !== "scribe" && k !== "manager")),
    warnings,
  };
}

// 役割の名前（id）：--names があればそれ、なければ設定の役割、どちらもなければ既定の役割（backroom）。最初のものが既定
export function namesOf(crew, cli = null) {
  if (cli?.length) return cli;
  return crew?.members?.length ? crew.members.map((m) => m.id) : NAMES;
}

// 役割（id で）。設定になければ（既定の役割や --names）、個人の task.prompt と置き場の <名前>.md だけを持つもの（どちらもなければ null）
export function agentOf(crew, id) {
  const m = crew?.members?.find((x) => x.id === id);
  if (m) return m;
  const body = [crew?.common, crew?.own?.[id]].filter(Boolean).join("\n\n");
  return body ? { id, name: id, call: CALLS[id] ?? id, team: null, mode: "append", body } : null;
}

export const callOf = (crew, id) => agentOf(crew, id)?.call ?? CALLS[id] ?? id;
export const callsOf = (crew, names) => Object.fromEntries(names.map((n) => [n, callOf(crew, n)]));
export const teamsOf = (crew, names) => Object.fromEntries(names.map((n) => [n, agentOf(crew, n)?.team ?? null]));

// 頭文字：設定の initial、既定の役割の頭文字、なければ名前の一文字目（呼び分けるときはチームの一文字を添える）
export function initialsOf(crew, names) {
  return Object.fromEntries(names.map((n) => [n, agentOf(crew, n)?.initial || INITIALS[n] || [...n][0]]));
}

const README = `# エージェントの置き場

dyve のエージェントの指示を自分好みにするところ。設定は ~/.dyve/config.json、指示の本文はここに置く。
どちらも置かなければ、dyve の既定のまま動く。変えたら dyve を立て直す（dyve 設定の「更新して再起動」でもよい）と効く。

## 指示（このディレクトリ）

- \`scribe.md\`：清書係、\`manager.md\`：マネージャ、\`<名前>.md\`：その役割で働くタスクエージェント（例：既定の役割は \`backroom.md\`、チームの役割は \`マイ@algr.md\`）
- config.json の \`prompt\` に、ほかの場所のファイル（育てている CLAUDE.md など）を書くと、その中身も指示になる。順は prompt のファイル、そのあとにここのファイル
- 中身はそのまま指示として、dyve の既定の指示の後ろに足される（config.json の mode が "replace" なら差し替える）
- \`{{names}}\` と書くと、役割の呼び名の並び（既定なら「控室」）に置き換わる

## 設定（~/.dyve/config.json）

\`\`\`json
{
  "room": "~/code/myrepo",
  "slots": 3,
  "task":    { "model": "opus", "prompt": "~/notes/research.md" },
  "scribe":  { "model": "haiku", "pause": 1000, "prompt": ["~/notes/CLAUDE.md", "~/notes/words.md"] },
  "manager": { "model": "sonnet", "pause": 4000, "cwd": "~/.dyve/staff" },
  "team": [
    { "name": "マイ", "description": "文書を書く・直す", "initial": "M", "model": "opus", "room": "~/code/docs" },
    { "name": "ケン" }
  ],
  "teams": ["~/code/algr", { "path": "~/code/k2down", "rename": { "マイ": "マイコ" } }]
}
\`\`\`

- 上の段：\`port\`・\`data\`・\`room\`・\`claude\`・\`slots\`・\`agents\`（この置き場）はコマンドのオプションと同じ。コマンドで渡したほうが勝つ
- \`task\`：どの役割にも。\`model\`、\`prompt\`（どの役割のタスクエージェントにも読ませるファイル）
- \`scribe\`・\`manager\`：\`model\`、\`pause\`（ミリ秒。清書係は発言から渡すまで、マネージャは最後の発言から起こすまで）、\`cwd\`（起きるディレクトリ）、\`mode\`（"append" か "replace"）、\`prompt\`
- \`team\`：自分の役割。最初のものが既定で、マネージャが役割を選ばなかった仕事を受ける。team も teams もなければ既定の役割 \`backroom\`（呼び名「控室」）一つ。一つの役割で何本でも並んで動き、同時に動く数は \`slots\` だけで決まる
  - \`name\`（要る）、\`description\`（得意なこと。マネージャはこれを読んで役割を選ぶ）、\`initial\`（アイコンの頭文字）、\`model\`、\`room\`（働くディレクトリ。開発の仕事はここから worktree を切り出す）、\`mode\`、\`prompt\`
- \`teams\`：入っているチームのリポジトリ。そのリポジトリの \`.dyve/config.json\` を取り込む
  - 文字列ならパスだけ。\`{ "path", "rename", "model" }\` で、呼び名を変えたり、そのチームの役割のモデルを決めたりできる
- パスの \`~\` はホーム、相対パスは config.json のあるところから

## チームの設定（<チームのリポジトリ>/.dyve/config.json）

チームで育てて、リポジトリに入れておく。

\`\`\`json
{
  "name": "algr",
  "task":    { "model": "sonnet", "prompt": "conventions.md" },
  "scribe":  { "prompt": "words.md" },
  "manager": { "prompt": "triage.md" },
  "team": [{ "name": "マイ", "description": "バグを調べる" }, { "name": "ケン", "model": "opus" }]
}
\`\`\`

- \`name\`：チームの名前（なければリポジトリのディレクトリ名）。ボードには \`マイ@algr\` のように残る。変えると過去のボードとつながらなくなる
- 書けるのは \`name\`・\`room\`・\`task\`・\`scribe\`（prompt だけ）・\`manager\`（prompt だけ）・\`team\`。パスは .dyve からの相対で、リポジトリの中だけ
- 清書係にはチームの指示を足し、マネージャにはチームごとの節（指示・役割・リポジトリ）を渡す。チームの役割で働くタスクエージェントは、チームの指示、そのあとに個人の指示を読む
- 名前がほかのチームや自分の役割とぶつかったら、立てるときに知らせ、チームの役割を「algr の マイ」のように呼び分ける
`;

// 置き場がなければ作り、README だけ置く
export function ensureCrew(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  return dir;
}
