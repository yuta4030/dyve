// セッション：一つの仕事を受け持つ Claude Code の会話。一ターンが一つのプロセス（-p と stream-json）で、続きは --resume
// 同じセッションを同時に二つ走らせない（動いているあいだに届いた発言は、終わってからまとめて渡す）。同時に走るのは slots まで
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PROMPT = fileURLToPath(new URL("../prompts/セッション.md", import.meta.url));

// 許す道具：読むだけ。ほかは --allow で足す（Slack の MCP など）。許していない道具は聞かずに断られる（dontAsk）
export const READ = ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(ls:*)"];

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 起こすときの引数。頼む文は標準入力で渡す（- で始まる文が引数と取り違えられないように）
export function claudeArgs({ prompt, resume = null, model = null, allow = [] }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    ...(resume ? ["--resume", resume] : []),
    "--append-system-prompt", prompt,
    ...(model ? ["--model", model] : []),
    "--permission-mode", "dontAsk",
    // 道具の一覧は可変長なので最後に置く
    "--allowedTools", ...READ, ...allow,
  ];
}

// 本物の起こし方：job { args, cwd, prompt } と、出来事（stream-json の一行ずつ）を受ける emit
// 返すもの：{ done: Promise<{ code, stderr }>, kill() }
export function claudeSpawn(cmd = "claude") {
  return (job, emit) => {
    let child = null;
    const done = new Promise((resolve) => {
      let buf = "", tail = "";
      const lines = (flush) => {
        let i;
        while ((i = buf.indexOf("\n")) >= 0 || (flush && buf)) {
          const line = i >= 0 ? buf.slice(0, i) : buf;
          buf = i >= 0 ? buf.slice(i + 1) : "";
          try {
            emit(JSON.parse(line));
          } catch {}
        }
      };
      try {
        child = nodeSpawn(cmd, job.args, { cwd: job.cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        return resolve({ code: -1, stderr: e.message });
      }
      child.on("error", (e) => resolve({ code: -1, stderr: e.message }));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => { buf += c; lines(false); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => { tail = (tail + c).slice(-2000); });
      child.on("close", (code) => { lines(true); resolve({ code, stderr: tail }); });
      child.stdin.on("error", () => {});
      child.stdin.end(job.prompt);
    });
    return { done, kill: () => child?.kill("SIGTERM") };
  };
}

// claude が動くかを確かめる。動かなければ、どうすればよいかを返す（動けば null）
export function claudeMissing(cmd, run = spawnSync) {
  const r = run(cmd, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!r.error && r.status === 0) return null;
  return `Claude Code（${cmd}）が動きません${r.error ? `（${r.error.code || r.error.message}）` : ""}。入れてログインしてから立て直してください：https://docs.claude.com/en/docs/claude-code/setup`;
}

// 道具を使ったことの一行（「Read README.md」など）
export function toolLine(name, input = {}) {
  const arg = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.command ?? input.description ?? "";
  return clip(oneLine(`${name} ${typeof arg === "string" ? arg : ""}`), 120);
}

export class Sessions {
  constructor({ log, spawn, room, allow = [], model = null, slots = 3, prompt = null }) {
    Object.assign(this, { log, spawn, room, allow, model, slots });
    this.prompt = prompt ?? fs.readFileSync(PROMPT, "utf8").trim();
    this.pending = new Map(); // セッション -> まだ渡していない発言
    this.running = new Map(); // セッション -> { kill }
  }

  // 新しいセッション。返すのはその番号
  open(name) {
    const id = Math.max(0, ...this.log.state.sessions.map((x) => x.id)) + 1;
    this.log.add("open", { session: id, name });
    return id;
  }

  send(session, say) {
    if (!this.log.state.sessions.some((x) => x.id === session)) return false;
    if (!this.pending.has(session)) this.pending.set(session, []);
    this.pending.get(session).push(say);
    this.pump();
    return true;
  }

  pump() {
    for (const [session, says] of this.pending) {
      if (this.running.size >= this.slots) return;
      if (this.running.has(session) || !says.length) continue;
      this.pending.delete(session);
      this.start(session, says);
    }
  }

  start(session, says) {
    const x = this.log.state.sessions.find((y) => y.id === session);
    const text = says.map((id) => this.log.state.said.find((p) => p.id === id)?.text).filter(Boolean).join("\n\n");
    this.log.add("turn", { session, says });
    let claude = x.claude, result = null, failed = null;
    const emit = (ev) => {
      if (ev.session_id) claude = ev.session_id;
      // 行の中で呼ばれたもの（サブエージェント）の出来事は出さない
      if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text.trim()) this.log.add("step", { session, what: "text", text: c.text.trim() });
          if (c.type === "tool_use") this.log.add("step", { session, what: "tool", text: toolLine(c.name, c.input) });
        }
      }
      if (ev.type === "result") {
        if (ev.is_error) failed = oneLine(ev.result || ev.subtype || "失敗した");
        else result = String(ev.result ?? "").trim();
      }
    };
    const job = { args: claudeArgs({ prompt: this.prompt, resume: x.claude, model: this.model, allow: this.allow }), cwd: this.room, prompt: text };
    const h = this.spawn(job, emit);
    this.running.set(session, h);
    h.done.then(({ code, stderr }) => {
      this.running.delete(session);
      if (result == null && !failed) failed = stderr?.trim() ? clip(oneLine(stderr.trim().split("\n").at(-1)), 200) : `結果を出さずに終わった（終了コード ${code}）`;
      this.log.add("end", { session, claude, result, error: failed });
      this.pump();
    });
  }

  stop() {
    this.pending.clear();
    for (const h of this.running.values()) h.kill();
  }
}
