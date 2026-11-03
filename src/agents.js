// エージェントの実体は外の Claude Code。どのディレクトリで、どの定義を読んで起きるかだけが違う
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFS = {
  scribe: path.join(ROOT, "agents", "scribe.md"),
  manager: path.join(ROOT, "agents", "manager.md"),
  task: path.join(ROOT, "skills", "backroom", "SKILL.md"),
  dev: path.join(ROOT, "skills", "backroom", "SKILL.md"),
};

// 取り消せないことはしない。清書係は発言の書き換えだけ、マネージャはボードだけ、控室は読むことと調べることだけ。
// 開発（dev）だけは書けるが、仕事ごとの git worktree の中だけ。取り込むかは人が決める（push や外に届くことはしない）
const READ = ["mcp__board", "Read", "Grep", "Glob", "WebSearch", "WebFetch"];
const TOOLS = {
  scribe: ["mcp__board__panel_edit"],
  manager: ["mcp__board"],
  task: READ,
  dev: [...READ, "Edit", "Write", "Bash(node --test:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
};
const DENY = { dev: ["Bash(git push:*)", "Bash(git remote:*)", "Bash(git worktree:*)", "Bash(git checkout:*)", "Bash(git reset:*)", "Bash(rm:*)"] };

// 控室だけが部屋（リポジトリ）で働く（開発は部屋から切り出した worktree で）。清書係とマネージャは空の作業場で起こし、前置きを小さく変わらないものにする
export const inRoom = (role) => role === "task" || role === "dev";

// 開発は控室と同じモデル（--task-model）で起こす
const modelOf = (models, role) => models[role] ?? (role === "dev" ? models.task : undefined);

export function readDef(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

// 前置き（system prompt・道具）は役ごとに固定し、変わるもの（名前・seq・発言）は指示の側に置く。キャッシュを効かせるため
// models：役割ごとのモデル（{ scribe, manager, task }）。指定がなければ claude の既定
// room：控室が働くディレクトリ。マネージャは空の作業場で起きるので、依頼に書けるよう前置きで教える（起動中は変わらないのでキャッシュは外れない）
export function claudeArgs(job, boardUrl, models = {}, { stream = false, room = null } = {}) {
  const mcp = { mcpServers: { board: { type: "http", url: `${boardUrl}/mcp?as=${encodeURIComponent(job.name)}` } } };
  return [
    ...(stream ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["-p", job.prompt, "--output-format", "json"]),
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
    "--append-system-prompt", readDef(DEFS[job.role]) + (job.role === "manager" && room ? `\n\n## 控室の部屋\n控室のエージェントはリポジトリ ${room} で働きます。依頼にファイルの場所を書くときはここを基準にします。` : ""),
    ...(modelOf(models, job.role) ? ["--model", modelOf(models, job.role)] : []),
    // 部屋の git status などを前置きから外し、リポジトリを触っても前置きのキャッシュが外れないようにする
    ...(inRoom(job.role) ? ["--exclude-dynamic-system-prompt-sections"] : []),
    ...(DENY[job.role] ? ["--disallowedTools", ...DENY[job.role]] : []),
    "--allowedTools", ...TOOLS[job.role],
  ];
}

// 開発の仕事の作業場：部屋（git リポジトリ）のいまの HEAD から、仕事ごとのブランチと worktree を切り出す。
// 同じ仕事でもう一度起こされたら、同じ作業場を使い続ける
export function workspace({ room, workDir, taskId, now = new Date() }) {
  const git = (...a) => execFileSync("git", ["-C", room, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const top = git("rev-parse", "--show-toplevel");
  const known = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const mine = known.find((p) => path.basename(p).startsWith(`${taskId}-`) && path.dirname(p) === path.resolve(workDir));
  if (mine) return { dir: mine, branch: git("-C", mine, "rev-parse", "--abbrev-ref", "HEAD"), base: null, top };
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const name = `${taskId}-${stamp}`;
  const dir = path.join(path.resolve(workDir), name);
  const branch = `dyve/${name}`;
  const base = git("rev-parse", "--abbrev-ref", "HEAD");
  fs.mkdirSync(path.resolve(workDir), { recursive: true });
  git("worktree", "add", "-b", branch, dir, "HEAD");
  return { dir, branch, base, top };
}

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

export function devNote(ws) {
  return [
    "",
    "## 開発の作業場",
    `- 作業場：${ws.dir}（ここだけを書き換えます。部屋 ${ws.top} の本体には触りません）`,
    `- ブランチ：${ws.branch}${ws.base ? `（${ws.base} から切り出し）` : ""}`,
    "- 書き終えたら `node --test` を走らせ、通ったら `git add` と `git commit` でこのブランチにコミットします。push はしません。",
    "- 結果は state `proposal` のパネルとして置きます。変えたことの要約、変えたファイル、テストの結果、ブランチ名を入れます。取り込むかは人が決めます。",
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
// workDir：開発の worktree を置くところ
export function claudeSpawner({ cmd = "claude", room = process.cwd(), staff = room, workDir = path.join(staff, "..", "work"), boardUrl, logDir = null, models = {} }) {
  return (job) => {
    let cwd = inRoom(job.role) ? room : staff;
    if (job.role === "dev") {
      try {
        const ws = workspace({ room, workDir, taskId: job.taskId });
        cwd = ws.dir;
        job = { ...job, prompt: job.prompt + "\n" + devNote(ws) };
      } catch (e) {
        return { done: Promise.resolve({ code: -1, error: `作業場を作れませんでした：${String(e.stderr || e.message).trim().split("\n").at(-1)}` }), kill: () => {} };
      }
    }
    const args = claudeArgs(job, boardUrl, models, { room });
    fs.mkdirSync(cwd, { recursive: true });
    const out = logStream(logDir, job, cmd, cwd, modelOf(models, job.role));
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
        out?.end();
        let r = null;
        try { r = JSON.parse(stdout); } catch {}
        const usage = r ? usageOf(r) : null;
        const last = (tail || stdout).trim().split("\n").at(-1);
        resolve(code === 0 ? { code, usage } : { code, usage, error: `終了コード ${code}${last ? `：${last.slice(0, 200)}` : ""}` });
      });
    });
    return { done, kill: () => child?.kill("SIGTERM") };
  };
}

// 起こしっぱなしの会話（清書係）。一本のプロセスに発言を流し込み、前の発言は会話に残る
// job: { role, name } -> { send(text) -> Promise<{code, error?, usage?}>, kill(), alive, quota }
// quota：claude が流してくる利用枠（{ five_hour: { utilization, resetsAt }, seven_day: … }）のいちばん新しいもの
export function claudeSession({ cmd = "claude", room = process.cwd(), staff = room, boardUrl, logDir = null, models = {} }) {
  return (job) => {
    const args = claudeArgs(job, boardUrl, models, { stream: true, room });
    const cwd = inRoom(job.role) ? room : staff;
    fs.mkdirSync(cwd, { recursive: true });
    const out = logStream(logDir, job, cmd, cwd, modelOf(models, job.role));
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
