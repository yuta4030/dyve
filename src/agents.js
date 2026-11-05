// エージェントの実体は外の Claude Code。どのディレクトリで、どの定義を読んで起きるかだけが違う
import { spawn as nodeSpawn, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES, agentOf, callOf } from "./crew.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFS = {
  scribe: path.join(ROOT, "agents", "scribe.md"),
  manager: path.join(ROOT, "agents", "manager.md"),
  task: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  dev: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  panels: path.join(ROOT, "skills", "backroom", "SKILL.md"),
};

// 取り消せないことは人が決める。清書係は発言の書き換えと辞書への追記だけ、マネージャはボードだけ。
// 控室は Claude Code の auto で動く（危ない操作は auto の判定が止める）。調べもの（task）はファイルを書き換えない。
// 開発（dev）は仕事ごとの git worktree の中で書き、取り込むかは人が決める。push など外に届くことは DENY で止める
const READ = ["mcp__board", "Read", "Grep", "Glob", "WebSearch", "WebFetch"];
const TOOLS = {
  scribe: ["mcp__board__panel_edit", "mcp__board__word_add"],
  manager: ["mcp__board"],
  task: READ,
  dev: [...READ, "Edit", "Write", "Bash(node --test:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
  // パネルの仕事：控室のエージェントが利用者のパネル置き場（~/.dyve/panels）で view を書く。書けるのはその中だけ
  panels: [...READ, "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
};
const OUTWARD = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(git reset:*)", "Bash(rm:*)"];
const DENY = { task: [...OUTWARD, "Edit", "Write", "NotebookEdit"], panels: OUTWARD, dev: [...OUTWARD, "Bash(git worktree:*)", "Bash(git checkout:*)"] };

// 控室だけが部屋（リポジトリ）で働く（開発は部屋から切り出した worktree で）。清書係とマネージャは空の作業場で起こし、前置きを小さく変わらないものにする
export const inRoom = (role) => role === "task" || role === "dev" || role === "panels";

// 控室（調べもの・開発・パネル）は --task-model、なければその人の model（チームの task.model を含む）、なければ個人の task.model。
// 清書係とマネージャは models に決まったものが入っている
const modelOf = (models, role, crew = null, name = null) => inRoom(role) ? models.task ?? agentOf(crew, name)?.model ?? crew?.settings?.task?.model ?? undefined : models[role];
// 起きる場所：控室はその人の room（なければ部屋）、清書係とマネージャは置き場の cwd（なければ作業場）
const roomOf = (crew, name, room) => agentOf(crew, name)?.room ?? room;
const staffOf = (crew, role, staff) => crew?.[role]?.cwd ?? staff;

export function readDef(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

// 前置き：dyve の定義に、利用者の指示（個人の置き場・設定の prompt・チームの指示）を足す（mode: replace なら差し替える）。
// {{names}} は控室の呼び名の並びに置き換える。起動中は変わらないので、前置きのキャッシュは外れない
// names：控室の名前（id。チームの人は「名前@チーム」）
export function systemPrompt(role, name, { room = null, crew = null, names = NAMES } = {}) {
  const fill = (s) => s.replaceAll("{{names}}", names.map((n) => callOf(crew, n)).join("、"));
  const tune = inRoom(role) ? agentOf(crew, name) : crew?.[role];
  let text = fill(readDef(DEFS[role]));
  if (tune?.body) text = tune.mode === "replace" ? fill(tune.body) : `${text}\n\n## 利用者からの指示\n${fill(tune.body)}`;
  if (role === "manager") text += roster(names, room, crew);
  return text;
}

// マネージャに渡す控室の顔ぶれ：呼び名と data.to に書く名前、働く場所、チームごとの指示
function roster(names, room, crew) {
  const people = names.map((n) => agentOf(crew, n) ?? { id: n, call: n, team: null, room: null });
  const teams = crew?.teams ?? [];
  const lines = [];
  if (room) lines.push(`控室のエージェントはふだんリポジトリ ${room} で働きます。依頼にファイルの場所を書くときはここを基準にします。`);
  const plain = people.every((m) => !m.team && m.call === m.id && (!m.room || m.room === room));
  if (!plain) {
    const line = (m, base) => `- ${m.call} → data.to: "${m.id}"${m.room && m.room !== base ? `（${m.room} で働く）` : ""}`;
    lines.push("人が呼ぶ名前（呼び名）と、仕事の data.to に書く名前は次のとおりです。data.to には右の名前をそのまま書きます。");
    const mine = people.filter((m) => !m.team);
    if (mine.length) lines.push(...mine.map((m) => line(m, room)));
    for (const t of teams) {
      lines.push("", `### チーム ${t.name}（リポジトリ ${t.room}）`);
      if (t.manager) lines.push(t.manager, "");
      const who = people.filter((m) => m.team === t.name);
      lines.push(...(who.length ? who.map((m) => line(m, t.room)) : ["- （控室の人はいない）"]));
      lines.push(`このチームの仕事で、誰でもよいときは data.team に "${t.name}" を入れます（そのチームの空いている人が受けます）。依頼にファイルの場所を書くときは、このリポジトリを基準にします。`);
    }
    if (teams.length) {
      lines.push(
        "",
        "どのチームの仕事かは、話題・リポジトリ・チームの言葉から見分けます。決められないときは data.team を付けずに取り次ぎます。",
        "同じ名前の人が二人いて、チームを言わずに名前だけで呼ばれ、話の流れからも決められないときは、取り次がずに、その発言に about して「どちらの〇〇か決まっていません」と短い text を置きます。",
      );
    }
  }
  return lines.length ? `\n\n## 控室の顔ぶれ\n${lines.join("\n")}` : "";
}

// 前置き（system prompt・道具）は役ごとに固定し、変わるもの（名前・seq・発言）は指示の側に置く。キャッシュを効かせるため
// models：役割ごとのモデル（{ scribe, manager, task }）。指定がなければ claude の既定
// room：控室が働くディレクトリ。マネージャは空の作業場で起きるので、依頼に書けるよう前置きで教える（起動中は変わらないのでキャッシュは外れない）
// crew・names：利用者の置き場から読んだ配役と、控室の名前の並び
export function claudeArgs(job, boardUrl, models = {}, { stream = false, room = null, crew = null, names = NAMES } = {}) {
  const mcp = { mcpServers: { board: { type: "http", url: `${boardUrl}/mcp?as=${encodeURIComponent(job.name)}` } } };
  return [
    ...(stream ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["-p", job.prompt, "--output-format", "json"]),
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
    "--append-system-prompt", systemPrompt(job.role, job.name, { room, crew, names }),
    ...(modelOf(models, job.role, crew, job.name) ? ["--model", modelOf(models, job.role, crew, job.name)] : []),
    // 部屋の git status などを前置きから外し、リポジトリを触っても前置きのキャッシュが外れないようにする
    ...(inRoom(job.role) ? ["--exclude-dynamic-system-prompt-sections", "--permission-mode", "auto"] : []),
    ...(DENY[job.role] ? ["--disallowedTools", ...DENY[job.role]] : []),
    "--allowedTools", ...TOOLS[job.role],
  ];
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
// rooms：控室のエージェントが別の部屋（置き場の room）で働くとき、その部屋も探す。見つかった部屋に取り込む
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

// job: { role, name, prompt } -> { done: Promise<{code, error?, usage?}>, kill() }
// staff：清書係とマネージャが起きる作業場
// workDir：開発の worktree を置くところ。panels：利用者のパネル置き場
export function claudeSpawner({ cmd = "claude", room = process.cwd(), staff = room, workDir = path.join(staff, "..", "work"), panels = path.join(staff, "..", "panels"), boardUrl, logDir = null, models = {}, crew = null, names = NAMES }) {
  return (job) => {
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
        return { done: Promise.resolve({ code: -1, error: `作業場を作れませんでした：${String(e.stderr || e.message).trim().split("\n").at(-1)}` }), kill: () => {} };
      }
    }
    const args = claudeArgs(job, boardUrl, models, { room, crew, names });
    fs.mkdirSync(cwd, { recursive: true });
    const out = logStream(logDir, job, cmd, cwd, modelOf(models, job.role, crew, job.name));
    let child;
    const done = new Promise((resolve) => {
      try {
        child = nodeSpawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ code: -1, error: e.message });
        return;
      }
      let stdout = "", tail = "";
      child.stdout.on("data", (b) => { out?.write(b); stdout += b; });
      child.stderr.on("data", (b) => { out?.write(b); tail = (tail + b).slice(-400); });
      child.on("error", (e) => resolve({ code: -1, error: e.message }));
      child.on("close", (code) => {
        let r = null;
        try { r = JSON.parse(stdout); } catch {}
        const usage = r ? usageOf(r) : null;
        const last = (tail || stdout).trim().split("\n").at(-1);
        const res = code === 0 ? { code, usage } : { code, usage, error: `終了コード ${code}${last ? `：${last.slice(0, 200)}` : ""}` };
        // ログを書き切ってから終わったことにする（書き込みは非同期なので、先に知らせるとログが空のまま読まれる）
        if (out) out.end(() => resolve(res)); else resolve(res);
      });
    });
    return { done, kill: () => child?.kill("SIGTERM") };
  };
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
      child = nodeSpawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
