// エージェントの実体は外の Claude Code。どのディレクトリで、どの定義を読んで起きるかだけが違う
import { spawn as nodeSpawn, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES, DEFAULT, agentOf, callOf } from "./crew.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFS = {
  scribe: path.join(ROOT, "agents", "scribe.md"),
  manager: path.join(ROOT, "agents", "manager.md"),
  task: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  dev: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  panels: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  act: path.join(ROOT, "skills", "backroom", "SKILL.md"),
};

// 取り消せないことは人が決める。清書係は発言の書き換えと辞書への追記だけ、マネージャはボードだけ。
// 控室は Claude Code の auto で動く（危ない操作は auto の判定が止める）。調べもの（task）には Edit・Write を渡さない（シェルでの書き込みは auto の判定に任せる）。
// 開発（dev）は仕事ごとの git worktree の中で書き、取り込むかは人が決める。push など外に届くことは DENY で止める。
// 人が受け入れた提案（act）だけは、提案の範囲で外に届くこともしてよいので DENY を付けず、危ない操作は auto の判定に任せる
const READ = ["mcp__board", "Read", "Grep", "Glob", "WebSearch", "WebFetch"];
const TOOLS = {
  scribe: ["mcp__board__panel_edit", "mcp__board__word_add"],
  manager: ["mcp__board"],
  task: READ,
  dev: [...READ, "Edit", "Write", "Bash(node --test:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
  // パネルの仕事：控室のエージェントが利用者のパネル置き場（~/.dyve/panels）で view を書く。書けるのはその中だけ
  panels: [...READ, "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
  act: [...READ, "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"],
};
const OUTWARD = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(git reset:*)", "Bash(rm:*)"];
const DENY = { task: [...OUTWARD, "Edit", "Write", "NotebookEdit"], panels: OUTWARD, dev: [...OUTWARD, "Bash(git worktree:*)", "Bash(git checkout:*)"] };

// 控室だけが部屋（リポジトリ）で働く（開発は部屋から切り出した worktree で）。清書係とマネージャは空の作業場で起こし、前置きを小さく変わらないものにする
export const inRoom = (role) => role === "task" || role === "dev" || role === "panels" || role === "act";

// 控室（調べもの・開発・パネル）は --task-model、なければその役割の model（チームの task.model を含む）、なければ個人の task.model。
// 清書係とマネージャは models に決まったものが入っている
const modelOf = (models, role, crew = null, name = null) => inRoom(role) ? models.task ?? agentOf(crew, name)?.model ?? crew?.settings?.task?.model ?? undefined : models[role];
// 起きる場所：控室はその役割の room（なければ部屋）、清書係とマネージャは置き場の cwd（なければ作業場）
const roomOf = (crew, name, room) => agentOf(crew, name)?.room ?? room;
const staffOf = (crew, role, staff) => crew?.[role]?.cwd ?? staff;

export function readDef(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

// 前置き：dyve の定義に、利用者の指示（個人の置き場・設定の prompt・チームの指示）を足す（mode: replace なら差し替える）。
// {{names}} は役割の呼び名の並びに置き換える。起動中は変わらないので、前置きのキャッシュは外れない
// names：役割の名前（id。チームの役割は「名前@チーム」）。最初のものが既定
export function systemPrompt(role, name, { room = null, crew = null, names = NAMES } = {}) {
  const fill = (s) => s.replaceAll("{{names}}", names.map((n) => callOf(crew, n)).join("、"));
  const tune = inRoom(role) ? agentOf(crew, name) : crew?.[role];
  let text = fill(readDef(DEFS[role]));
  if (tune?.body) text = tune.mode === "replace" ? fill(tune.body) : `${text}\n\n## 利用者からの指示\n${fill(tune.body)}`;
  if (role === "manager") text += roster(names, room, crew);
  return text;
}

// マネージャに渡す役割の一覧：呼び名と data.to に書く名前、得意なこと、働く場所、チームごとの指示。
// どれも既定のまま（説明・チーム・別の場所がなく、呼び名が名前のまま）なら一覧は出さない
function roster(names, room, crew) {
  const all = names.map((n) => agentOf(crew, n) ?? { id: n, call: callOf(crew, n), team: null, room: null });
  const teams = crew?.teams ?? [];
  const lines = [];
  if (room) lines.push(`タスクエージェントはふだんリポジトリ ${room} で働きます。依頼にファイルの場所を書くときはここを基準にします。`);
  const bare = (m) => !m.team && !m.description && (m.call === m.id || (m.id === DEFAULT && m.call === callOf(null, DEFAULT))) && (!m.room || m.room === room);
  if (!all.every(bare)) {
    const first = all[0];
    const line = (m, base) => {
      const notes = [m === first ? "既定" : "", m.room && m.room !== base ? `${m.room} で働く` : ""].filter(Boolean);
      return `- ${m.call} → data.to: "${m.id}"${notes.length ? `（${notes.join("。")}）` : ""}${m.description ? `：${m.description}` : ""}`;
    };
    lines.push(
      "行をどの役割で受け持つかは、説明を読んで選び、data.to に右の名前をそのまま書きます。どれでもよいとき・合うものがないときは data.to を付けません（既定の役割が受けます）。",
      "一つの役割で何本でも行が並んで動くので、空いているかは確かめません。",
    );
    const mine = all.filter((m) => !m.team);
    if (mine.length) lines.push(...mine.map((m) => line(m, room)));
    for (const t of teams) {
      lines.push("", `### チーム ${t.name}（リポジトリ ${t.room}）`);
      if (t.manager) lines.push(t.manager, "");
      const who = all.filter((m) => m.team === t.name);
      lines.push(...(who.length ? who.map((m) => line(m, t.room)) : ["- （役割がない）"]));
      lines.push(`このチームの仕事で、どの役割でもよいときは data.team に "${t.name}" を入れます（そのチームの最初の役割が受けます）。依頼にファイルの場所を書くときは、このリポジトリを基準にします。`);
    }
    if (teams.length) {
      lines.push(
        "",
        "どのチームの仕事かは、話題・リポジトリ・チームの言葉から見分けます。決められないときは data.team を付けずに取り次ぎます。",
        "同じ名前の役割が二つあって、チームを言わずに名前だけで呼ばれ、話の流れからも決められないときは、取り次がずに、その発言に about して「どちらの〇〇か決まっていません」と短い text を置きます。",
      );
    }
  }
  return lines.length ? `\n\n## 役割\n${lines.join("\n")}` : "";
}

// 前置き（system prompt・道具）は役ごとに固定し、変わるもの（名前・seq・発言）は指示の側に置く。キャッシュを効かせるため
// models：清書係・マネージャ・タスクエージェントのモデル（{ scribe, manager, task }）。指定がなければ claude の既定
// room：控室が働くディレクトリ。マネージャは空の作業場で起きるので、依頼に書けるよう前置きで教える（起動中は変わらないのでキャッシュは外れない）
// crew・names：利用者の置き場から読んだ配役と、役割の名前の並び
// 行のセッション（控室）は流れる形（stream-json）で起こし、指示は標準入力の最初の一通で渡す。動いているあいだ、行への言葉を押し込める。
// MCP の口には行の id も付ける（?as=<役割>&row=<仕事の id>）。行の中で呼ばれたものも同じ口でつながるので、その行のセッションとして数える
export function claudeArgs(job, boardUrl, models = {}, { stream = false, room = null, crew = null, names = NAMES } = {}) {
  const row = inRoom(job.role);
  const q = `as=${encodeURIComponent(job.name)}${row && job.taskId ? `&row=${encodeURIComponent(job.taskId)}` : ""}`;
  const mcp = { mcpServers: { board: { type: "http", url: `${boardUrl}/mcp?${q}` } } };
  const helpers = row ? helpersOf(job, { room, crew, names }) : null;
  return [
    ...(stream || row ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["-p", job.prompt, "--output-format", "json"]),
    // 同じ行の頼み直し：前にその行を受け持ったセッションを引き継ぐ（job.resume はセッション id）
    ...(row && typeof job.resume === "string" ? ["--resume", job.resume] : []),
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
    "--append-system-prompt", systemPrompt(job.role, job.name, { room, crew, names }),
    ...(modelOf(models, job.role, crew, job.name) ? ["--model", modelOf(models, job.role, crew, job.name)] : []),
    // 部屋の git status などを前置きから外し、リポジトリを触っても前置きのキャッシュが外れないようにする
    ...(inRoom(job.role) ? ["--exclude-dynamic-system-prompt-sections", "--permission-mode", "auto"] : []),
    // 行の中で呼べる相手（役割の一覧）。深さと並べる数は Claude Code の設定のままにし、dyve は決めない
    ...(helpers ? ["--agents", JSON.stringify(helpers)] : []),
    ...(DENY[job.role] ? ["--disallowedTools", ...DENY[job.role]] : []),
    "--allowedTools", ...TOOLS[job.role],
  ];
}

// 行の中で呼べる相手：説明のある役割のうち、この行のセッションと同じ場所で働くもの（場所をまたぐ呼び出しはまだ決めていない）。
// 一つずつ { description, prompt（その役割の指示。なければ何者かの一文）, model? }。合うものがなければ null（--agents を付けない）
export function helpersOf(job, { room = null, crew = null, names = NAMES } = {}) {
  const at = (id) => {
    const r = roomOf(crew, id, room);
    return r ? real(r) : null;
  };
  const here = at(job.name);
  const out = {};
  for (const id of names) {
    const m = agentOf(crew, id);
    if (!m?.description || at(id) !== here) continue;
    out[id] = { description: m.description, prompt: m.body || `あなたは役割「${m.call ?? id}」です。得意なこと：${m.description}`, ...(m.model ? { model: m.model } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

// 起こしたエージェントに、誰として・どのボードから起こされたかを環境変数で渡す。エージェントの中で打った dyve put・dyve add は、
// これを見て、そのボードへ人として書くのを断る（人が許可した source・send のコマンドはサーバーが走らせるので、付かない）
export const agentEnv = (job, boardUrl, env = process.env) => ({ ...env, DYVE_AGENT: job.name, DYVE_BOARD: boardUrl });
// いまのプロセスが、そのポートのボードから起こされたエージェントの中にいるなら、その名前（いなければ null）
export function agentOn(port, env = process.env) {
  if (!env.DYVE_AGENT) return null;
  let own = null;
  try { own = new URL(env.DYVE_BOARD).port; } catch {}
  // どのボードかわからないときは、同じボードとみなす（人として書かせない方に倒す）
  return own == null || own === String(port) ? env.DYVE_AGENT : null;
}

// 開発の仕事の作業場：部屋（git リポジトリ）のいまの HEAD から、仕事ごとのブランチと worktree を切り出す。
// 名前は「ボード名-仕事の id-時刻」（id はボードごとに p1 から振られるので、ボード名で分ける）。
// 同じ仕事でもう一度起こされたら、同じ作業場を使い続ける
const gitIn = (dir) => (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// 実パスで比べる。git はシンボリックリンクをたどった先を返す（Mac の /var → /private/var など）
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
function findWorkspace(room, workDir, board, taskId) {
  const git = gitIn(room);
  const known = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const dir = known.find((p) => path.basename(p).startsWith(`${board}-${taskId}-`) && real(path.dirname(p)) === real(workDir));
  return dir ? { dir, branch: gitIn(dir)("rev-parse", "--abbrev-ref", "HEAD") } : null;
}
export function workspace({ room, workDir, taskId, board = "board", now = new Date() }) {
  const git = gitIn(room);
  const top = git("rev-parse", "--show-toplevel");
  const mine = findWorkspace(room, workDir, board, taskId);
  if (mine) return { ...mine, base: null, top };
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const name = `${board}-${taskId}-${stamp}`;
  const dir = path.join(path.resolve(workDir), name);
  const branch = `dyve/${name}`;
  const base = git("rev-parse", "--abbrev-ref", "HEAD");
  fs.mkdirSync(path.resolve(workDir), { recursive: true });
  git("worktree", "add", "-b", branch, dir, "HEAD");
  return { dir: real(dir), branch, base, top };
}

// 取り込む：人が開発の提案を受け入れたら、その仕事のブランチを部屋のいまのブランチにマージコミットで取り込む
// （git revert -m 1 で戻せる）。ぶつかったら取りやめて元に戻す。取り込めたら作業場とブランチを片付ける
// rooms：役割が別の部屋（設定の room）で働くとき、その部屋も探す。見つかった部屋に取り込む
export function integrate({ room, rooms = [room], workDir, board = "board", taskId }) {
  let ws = null;
  for (const r of new Set([room, ...rooms])) {
    try {
      ws = findWorkspace(r, workDir, board, taskId);
    } catch {
      continue; // git でない部屋（調べもの用）は飛ばす
    }
    if (ws) {
      room = r;
      break;
    }
  }
  if (!ws) throw new Error(`仕事 ${taskId} の作業場が見つからない`);
  const git = gitIn(room);
  if (gitIn(ws.dir)("status", "--porcelain")) throw new Error(`作業場にコミットしていない変更が残っている（${ws.dir}）`);
  if (git("rev-list", "--count", `HEAD..${ws.branch}`) === "0") throw new Error(`${ws.branch} に取り込むものがない`);
  const into = git("rev-parse", "--abbrev-ref", "HEAD");
  try {
    git("merge", "--no-ff", "-m", `取り込み：${ws.branch}`, ws.branch);
  } catch (e) {
    try { git("merge", "--abort"); } catch {}
    throw new Error(`${ws.branch} を ${into} に取り込めなかった（ぶつかったか、手元の変更と重なった）。元に戻した`);
  }
  const commit = git("rev-parse", "--short", "HEAD");
  let cleaned = true;
  try {
    git("worktree", "remove", ws.dir);
    git("branch", "-d", ws.branch);
  } catch {
    cleaned = false;
  }
  return { branch: ws.branch, into, commit, cleaned };
}

// 動いている dyve の情報（dyve 設定のポップアップ）。behind：起動のあとに部屋へ入ったコミットの数（再起動で反映される）
export function runningMeta({ room, startCommit, startedAt, browser = null }) {
  const count = (from) => { try { return Number(gitIn(room)("rev-list", "--count", `${from}..HEAD`)); } catch { return null; } };
  const same = real(ROOT) === real(room);
  return {
    version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
    commit: startCommit?.slice(0, 7) ?? null,
    head: commitOf(room)?.slice(0, 7) ?? null,
    behind: startCommit ? count(startCommit) : null,
    source: same ? "room" : isAppOf({ room, app: ROOT }) ? "app" : "installed",
    running: ROOT, room, startedAt, browser,
  };
}
export const commitOf = (dir) => { try { return gitIn(dir)("rev-parse", "HEAD"); } catch { return null; } };

// 使う dyve：作る側（部屋）とは別の置き場に、ある時点のコミットを切り出して動かす。
// 取り込んだ変更が壊れていても、使っているボードは落ちない。更新は人が決めたときだけ
export function updateApp({ room, app, ref = "HEAD" }) {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git("-C", room, "rev-parse", "--verify", `${ref}^{commit}`);
  if (!fs.existsSync(app)) {
    fs.mkdirSync(path.dirname(path.resolve(app)), { recursive: true });
    git("-C", room, "worktree", "add", "--detach", path.resolve(app), commit);
    return { commit, created: true };
  }
  if (git("-C", app, "status", "--porcelain")) throw new Error(`${app} に手を入れた跡がある。片付けてから更新してください`);
  git("-C", app, "checkout", "--detach", commit);
  return { commit, created: false };
}

// 使う dyve（app）が部屋から切り出したもの（同じリポジトリの worktree）か。
// npm などで入れた dyve は部屋と関係ないので、部屋のコミットで上書きしない
export function isAppOf({ room, app }) {
  const common = (dir) => {
    try {
      const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return fs.realpathSync(out);
    } catch {
      return null;
    }
  };
  const a = common(app);
  return a != null && a === common(room);
}

// claude が動くかを確かめる。動かなければ、どうすればよいかを返す（動けば null）
export function claudeMissing(cmd, run = spawnSync) {
  const r = run(cmd, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!r.error && r.status === 0) return null;
  return [
    `Claude Code（${cmd}）が動きません${r.error ? `（${r.error.code || r.error.message}）` : ""}。`,
    "エージェントは Claude Code で動きます。入れてログインしてから立て直してください：https://docs.claude.com/en/docs/claude-code/setup",
    "画面だけ試すなら --no-agents を付けます。",
  ].join("\n");
}

export function panelsNote(dir) {
  return [
    "",
    "## パネルの仕事",
    `- 働く場所：${dir}（利用者のパネル置き場。ここだけを書き換えます）`,
    "- まず README.md を読み、view の書き方に従います。view は views/<名前>.js に一つずつ置きます",
    "- 書いたら `git add` と `git commit` でコミットします（履歴があるので戻せます）。push はしません",
    "- 書き終えたら、その view を使うパネルをボードに置くか、頼まれたパネルの view を書き換えて、すぐ見えるようにします",
    "- 押したら詳細を出すような読むだけの見せ方は、選ぶ view と詳しく描く view を別のパネルにして、同じものに about して並べます。選ぶ側は `ctx.select(値)` を呼び、描く側は `ctx.selected`（{ from, value }）を読みます（見本の days と detail）。送り出し（send）は使いません",
    "- shell コマンドでデータを流し込むなら、パネルの source に { shell, every } を書きます。走らせてよいかは人が決めるので、人が「実行を許可」を押すまで走りません",
    "- 結果は仕事に about して短く置き（何を作ったか、view の名前、どのパネルか）、仕事を done にします。すぐ見えて話して直せるので、提案にはしません",
  ].join("\n");
}

export function devNote(ws) {
  return [
    "",
    "## 開発の作業場",
    `- 作業場：${ws.dir}（ここだけを書き換えます。部屋 ${ws.top} の本体には触りません）`,
    `- ブランチ：${ws.branch}${ws.base ? `（${ws.base} から切り出し）` : ""}`,
    "- 書き終えたら `node --test` を走らせ、通ったら `git add` と `git commit` でこのブランチにコミットします。push はしません。",
    "- 結果は state `proposal` のパネルとして置きます。変えたことの要約、変えたファイル、テストの結果、ブランチ名を入れます。取り込むかは人が決めます。置いたら仕事を done にします。",
  ].join("\n");
}

// claude の結果（json の result）から、使った量を取り出す
export function usageOf(r) {
  const u = r?.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    costUsd: r?.total_cost_usd || 0,
  };
}

function logStream(logDir, job, cmd, cwd, model) {
  if (!logDir) return null;
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = fs.createWriteStream(path.join(logDir, `${stamp}-${job.role}-${job.taskId || "board"}.log`));
  out.write(`$ ${cmd} (${job.role} ${job.name} ${model || "既定"}) in ${cwd}\n${job.prompt || ""}\n\n`);
  return out;
}

// 行の中：行のセッションが呼んだもの（Claude Code のサブエージェント）の一覧を、流れてくる記録（system の task_*）から導く。
// 一つずつ { id, type, what, depth, parent, state: running | done | failed, tools, ms, last, report }。
// depth は 1 が行のセッションに呼ばれたもの、2 がその中で呼ばれたもの。parent は呼んだものの id（行のセッションなら null）。
// 純粋な関数：変わらなければ同じ配列を返す。シェルの裏の仕事（local_bash）は数えない
const REPORT = 500;
const clipText = (s, n) => (typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : null);
const ended = (status) => (status === "completed" ? "done" : status === "running" || status === "pending" || status == null ? null : "failed");
export function insideStep(list, ev) {
  if (ev?.type !== "system" || typeof ev.task_id !== "string") return list;
  const i = list.findIndex((t) => t.id === ev.task_id);
  if (ev.subtype === "task_started") {
    if (i >= 0 || !(ev.subagent_type || ev.task_type === "local_agent")) return list;
    const depth = Number.isInteger(ev.spawn_depth) ? ev.spawn_depth : 1;
    return [...list, { id: ev.task_id, type: ev.subagent_type || "general-purpose", what: clipText(ev.description ?? "", 200), depth, parent: depth > 1 && typeof ev.parent_task_id === "string" ? ev.parent_task_id : null, state: "running", tools: 0, ms: 0, last: null, report: null }];
  }
  if (i < 0) return list;
  const t = list[i], u = ev.usage ?? {};
  const used = { tools: Number.isFinite(u.tool_uses) ? u.tool_uses : t.tools, ms: Number.isFinite(u.duration_ms) ? u.duration_ms : t.ms };
  let next = t;
  if (ev.subtype === "task_progress") next = { ...t, ...used, last: typeof ev.last_tool_name === "string" ? ev.last_tool_name : t.last };
  else if (ev.subtype === "task_notification") next = { ...t, ...used, state: ended(ev.status) ?? "done", report: clipText(ev.handback_report?.text ?? ev.summary, REPORT) ?? t.report };
  else if (ev.subtype === "task_updated") next = { ...t, state: ended(ev.patch?.status) ?? t.state };
  if (JSON.stringify(next) === JSON.stringify(t)) return list;
  return list.map((x, k) => (k === i ? next : x));
}

// 行の中の動きを起こし係に知らせる間（一つの行で、だいたい一秒に二度まで）
const GAP = 500;
const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

// job: { role, name, prompt, taskId?, resume?, onInside? } -> { done: Promise<{code, error?, usage?, session, cwd, resumed, inside?}>, kill(), say?(text) -> bool }
// resume：同じ行の頼み直しで、前の回を引き継ぐときの手がかり（{ session, cwd, prompt }。prompt は引き継いだ相手に渡す短い文）。
// セッションは起きた場所ごとに持たれるので、今回の起きる場所が前の回と同じときだけ引き継ぐ。違えばまっさらで起こす。
// 引き継ぎが始まらずに終わったら（セッションが見つからないなど、claude が結果を返さなかった）、まっさらで起こし直す
// 返す session：claude の結果にあったセッション id（取れなければ null）。cwd：起きた場所
// 行のセッション（控室）は流れる形で起こす：say(text) で動いているセッションに言葉を押し込み（渡せなければ false）、
// onInside(一覧) で行の中の動きを知らせ、done の inside に終わったときの一覧を返す
// staff：清書係とマネージャが起きる作業場
// workDir：開発の worktree を置くところ。panels：利用者のパネル置き場
export function claudeSpawner({ cmd = "claude", room = process.cwd(), staff = room, workDir = path.join(staff, "..", "work"), panels = path.join(staff, "..", "panels"), boardUrl, logDir = null, models = {}, crew = null, names = NAMES }) {
  const runJson = (job, cwd, args, out) => {
    let child;
    const done = new Promise((resolve) => {
      try {
        child = nodeSpawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentEnv(job, boardUrl) });
      } catch (e) {
        resolve({ code: -1, error: e.message, session: null, cwd });
        return;
      }
      let stdout = "", tail = "";
      child.stdout.on("data", (b) => { out?.write(b); stdout += b; });
      child.stderr.on("data", (b) => { out?.write(b); tail = (tail + b).slice(-400); });
      child.on("error", (e) => resolve({ code: -1, error: e.message, session: null, cwd }));
      child.on("close", (code) => {
        let r = null;
        try { r = JSON.parse(stdout); } catch {}
        const usage = r ? usageOf(r) : null;
        const session = typeof r?.session_id === "string" ? r.session_id : null;
        const res = code === 0 ? { code, usage, session, cwd } : { code, usage, session, cwd, error: exitError(code, r, tail, stdout) };
        // ログを書き切ってから終わったことにする（書き込みは非同期なので、先に知らせるとログが空のまま読まれる）
        if (out) out.end(() => resolve(res)); else resolve(res);
      });
    });
    return { done, kill: () => child?.kill("SIGTERM") };
  };
  // 行のセッション：標準入力は動いているあいだ開けておく。閉じるのは、結果（result）が来て、行の中で動いているものがなく、
  // 押し込んだ言葉にまだ結果が来ていないのでもないとき（行の中のものが裏で動いていると result は何度も来る）。終わりはプロセスが終わったとき
  const runStream = (job, cwd, args, out) => {
    let child, open = false, seen = false, owed = false, inside = [], last = null, buf = "", tail = "", timer = null, toldAt = 0;
    const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const tell = () => { timer = null; toldAt = Date.now(); job.onInside?.(inside); };
    const changed = () => {
      if (!job.onInside || timer) return;
      const wait = toldAt + GAP - Date.now();
      if (wait <= 0) tell(); else timer = setTimeout(tell, wait);
    };
    const close = () => {
      if (!open) return;
      open = false;
      try { child.stdin.end(); } catch {}
    };
    const settle = () => { if (seen && !owed && !inside.some((t) => t.state === "running")) close(); };
    const say = (text) => {
      if (!open || !child?.stdin?.writable) return false;
      try {
        child.stdin.write(user(text));
      } catch {
        return false;
      }
      owed = true;
      out?.write(`\n>>> ${text}\n`);
      return true;
    };
    const done = new Promise((resolve) => {
      try {
        child = nodeSpawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: agentEnv(job, boardUrl) });
      } catch (e) {
        resolve({ code: -1, error: e.message, session: null, cwd });
        return;
      }
      open = true;
      child.stdin.on("error", () => { open = false; });
      child.stdout.on("data", (b) => {
        out?.write(b);
        buf += b;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          const next = insideStep(inside, j);
          if (next !== inside) {
            inside = next;
            changed();
          }
          if (j.type === "result") {
            last = j;
            const u = usageOf(j);
            for (const k of Object.keys(sum)) sum[k] += u[k];
            seen = true;
            owed = false;
          }
          settle();
        }
      });
      child.stderr.on("data", (b) => { out?.write(b); tail = (tail + b).slice(-400); });
      child.on("error", (e) => resolve({ code: -1, error: e.message, session: null, cwd, inside }));
      child.on("close", (code) => {
        open = false;
        clearTimeout(timer);
        // トークンは回ごと、費用（total_cost_usd）は会話の通算なので、トークンは足し、費用はいちばん後の結果のもの
        const usage = last ? { ...sum, costUsd: last.total_cost_usd || 0 } : null;
        const session = typeof last?.session_id === "string" ? last.session_id : null;
        const res = code === 0 ? { code, usage, session, cwd, inside } : { code, usage, session, cwd, inside, error: exitError(code, last, tail) };
        if (out) out.end(() => resolve(res)); else resolve(res);
      });
      child.stdin.write(user(job.prompt));
    });
    return { done, kill: () => child?.kill("SIGTERM"), say };
  };
  const run = (job, cwd) => {
    const args = claudeArgs(job, boardUrl, models, { room, crew, names });
    fs.mkdirSync(cwd, { recursive: true });
    const out = logStream(logDir, job, cmd, cwd, modelOf(models, job.role, crew, job.name));
    return (inRoom(job.role) ? runStream : runJson)(job, cwd, args, out);
  };
  return (job) => {
    const { resume, ...fresh } = job;
    job = fresh;
    const mine = roomOf(crew, job.name, room);
    let cwd = inRoom(job.role) ? mine : staffOf(crew, job.role, staff);
    if (job.role === "panels") {
      cwd = panels;
      job = { ...job, prompt: job.prompt + "\n" + panelsNote(panels) };
    }
    if (job.role === "dev") {
      try {
        const ws = workspace({ room: mine, workDir, taskId: job.taskId, board: job.board });
        cwd = ws.dir;
        job = { ...job, prompt: job.prompt + "\n" + devNote(ws) };
      } catch (e) {
        return { done: Promise.resolve({ code: -1, error: `作業場を作れませんでした：${String(e.stderr || e.message).trim().split("\n").at(-1)}`, session: null }), kill: () => {}, say: () => false };
      }
    }
    const same = resume?.session && resume.cwd && inRoom(job.role) && real(resume.cwd) === real(cwd);
    if (!same) {
      const h = run(job, cwd);
      return { done: h.done.then((r) => ({ ...r, resumed: false })), kill: h.kill, say: (t) => h.say?.(t) ?? false };
    }
    let cur = run({ ...job, prompt: resume.prompt ?? job.prompt, resume: resume.session }, cwd), killed = false;
    const done = cur.done.then((r) => {
      // 結果を返したなら、引き継いだ会話は動いた。返さずに落ちたときだけ、まっさらで起こし直す
      if (killed || r.code === 0 || r.usage) return { ...r, resumed: true };
      cur = run(job, cwd);
      return cur.done.then((x) => ({ ...x, resumed: false }));
    });
    return { done, kill: () => { killed = true; cur.kill(); }, say: (t) => cur.say?.(t) ?? false };
  };
}

// 落ちた理由：claude の出力（JSON）に理由の文があればそれ（上限で止まったなど）、なければ stderr の最後の行。JSON の切れ端は出さない
export function exitError(code, result, tail = "", stdout = "") {
  const lastLine = (s) => String(s).trim().split("\n").at(-1);
  const said = typeof result?.result === "string" ? result.result.trim() : "";
  const why = said || lastLine(tail) || (result ? "" : lastLine(stdout));
  return `終了コード ${code}${why ? `：${why.slice(0, 200)}` : ""}`;
}

// 起こしっぱなしの会話（清書係）。一本のプロセスに発言を流し込み、前の発言は会話に残る
// job: { role, name } -> { send(text) -> Promise<{code, error?, usage?}>, kill(), alive, quota }
// quota：claude が流してくる利用枠（{ five_hour: { utilization, resetsAt }, seven_day: … }）のいちばん新しいもの
export function claudeSession({ cmd = "claude", room = process.cwd(), staff = room, boardUrl, logDir = null, models = {}, crew = null, names = NAMES }) {
  return (job) => {
    const args = claudeArgs(job, boardUrl, models, { stream: true, room, crew, names });
    const cwd = inRoom(job.role) ? roomOf(crew, job.name, room) : staffOf(crew, job.role, staff);
    fs.mkdirSync(cwd, { recursive: true });
    const out = logStream(logDir, job, cmd, cwd, modelOf(models, job.role, crew, job.name));
    const s = { alive: true };
    let pending = null, buf = "", cost = 0, child;
    const finish = (r) => { const p = pending; pending = null; p?.(r); };
    try {
      child = nodeSpawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: agentEnv(job, boardUrl) });
    } catch (e) {
      s.alive = false;
      s.send = async () => ({ code: -1, error: e.message });
      s.kill = () => {};
      return s;
    }
    child.stdout.on("data", (b) => {
      out?.write(b);
      buf += b;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === "rate_limit_event" && j.rate_limit_info?.unifiedWindows) s.quota = j.rate_limit_info.unifiedWindows;
        if (j.type !== "result") continue;
        // total_cost_usd は会話の通算なので、一回ぶんは差で出す
        const usage = usageOf(j);
        const total = usage.costUsd;
        usage.costUsd = Math.max(0, total - cost);
        cost = total;
        finish(j.is_error ? { code: 1, usage, error: String(j.result || j.subtype) } : { code: 0, usage });
      }
    });
    child.stderr.on("data", (b) => out?.write(b));
    const dead = (error) => { s.alive = false; out?.end(); finish({ code: -1, error }); };
    child.on("error", (e) => dead(e.message));
    child.on("close", (code) => dead(`終了コード ${code}`));
    child.stdin.on("error", () => {});
    s.send = (text) => new Promise((resolve) => {
      if (!s.alive) return resolve({ code: -1, error: "会話が終わっている" });
      pending = resolve;
      out?.write(`\n>>> ${text}\n`);
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
    s.kill = () => { s.alive = false; child.kill("SIGTERM"); };
    return s;
  };
}
