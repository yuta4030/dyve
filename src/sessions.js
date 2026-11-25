// セッション：一つの仕事を受け持つ Claude Code の会話。一ターンが一つのプロセス（-p と stream-json）で、続きは --resume
// 同じセッションを同時に二つ走らせない（動いているあいだに届いた発言は、終わってからまとめて渡す）。同時に走るのは slots まで
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cancelable, shown } from "./state.js";

const PROMPT = fileURLToPath(new URL("../prompts/セッション.md", import.meta.url));


const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 起こすときの引数。頼む文は標準入力で渡す（- で始まる文が引数と取り違えられないように）
// 道具は絞らない。人に聞かずに進め、危ない操作だけを Claude Code の判定（auto）が止める
export function claudeArgs({ prompt, resume = null, model = null }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    ...(resume ? ["--resume", resume] : []),
    "--append-system-prompt", prompt,
    ...(model ? ["--model", model] : []),
    "--permission-mode", "auto",
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

// rate_limit_event の中身から、記録に置く利用枠（使った割合は 1% 刻みにまるめる）
export function quotaOf(info) {
  const w = info?.unifiedWindows ?? {};
  const pct = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  return { five: pct(w.five_hour?.utilization), fiveAt: w.five_hour?.resetsAt ?? null, week: pct(w.seven_day?.utilization), weekAt: w.seven_day?.resetsAt ?? null, status: info?.status ?? "allowed" };
}

// 道具を使ったことの一行（「Read README.md」など）
export function toolLine(name, input = {}) {
  const arg = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.command ?? input.description ?? "";
  return clip(oneLine(`${name} ${typeof arg === "string" ? arg : ""}`), 120);
}

export class Sessions {
  constructor({ log, spawn, room, model = null, slots = 3, prompt = null }) {
    Object.assign(this, { log, spawn, room, model, slots });
    this.prompt = prompt ?? fs.readFileSync(PROMPT, "utf8").trim();
    this.pending = new Map(); // セッション -> まだ渡していない発言
    this.running = new Map(); // セッション -> { kill, says, stopped }
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
    // 清書したものがあればそれを渡す
    const text = says.map((id) => { const p = this.log.state.said.find((q) => q.id === id); return p?.fair ?? p?.text; }).filter(Boolean).join("\n\n");
    this.log.add("turn", { session, says });
    let claude = x.claude, result = null, failed = null;
    const emit = (ev) => {
      if (ev.session_id && ev.session_id !== claude) {
        claude = ev.session_id;
        this.log.add("bind", { session, claude });
      }
      // 行の中で呼ばれたもの（サブエージェント）の出来事は出さない
      if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text.trim()) this.log.add("step", { session, what: "text", text: c.text.trim() });
          if (c.type === "tool_use") this.log.add("step", { session, what: "tool", text: toolLine(c.name, c.input) });
        }
      }
      // 利用枠は、変わったときだけ記録に置く
      if (ev.type === "rate_limit_event") {
        const q = quotaOf(ev.rate_limit_info), cur = this.log.state.quota;
        if (!cur || ["five", "fiveAt", "week", "weekAt", "status"].some((k) => cur[k] !== q[k])) this.log.add("quota", q);
      }
      if (ev.type === "result") {
        if (ev.is_error) failed = oneLine(ev.result || ev.subtype || "失敗した");
        else result = String(ev.result ?? "").trim();
      }
    };
    // セッションは自分の記号と名前を知らないので、毎ターン添える（「C の続き」と呼ばれても通じるように）
    const head = `［dyve：このセッションは ${x.sym}「${x.name}」。人は記号や名前でこのセッションを呼ぶことがある］`;
    const job = { args: claudeArgs({ prompt: this.prompt, resume: x.claude, model: this.model }), cwd: this.room, prompt: `${head}\n\n${text}` };
    const h = this.spawn(job, emit);
    const run = { kill: h.kill, says, stopped: false };
    this.running.set(session, run);
    h.done.then(({ code, stderr }) => {
      this.running.delete(session);
      if (run.stopped) this.log.add("end", { session, claude, stopped: true });
      else {
        if (result == null && !failed) failed = stderr?.trim() ? clip(oneLine(stderr.trim().split("\n").at(-1)), 200) : `結果を出さずに終わった（終了コード ${code}）`;
        this.log.add("end", { session, claude, result, error: failed });
      }
      this.pump();
    });
  }

  // 人が止める：待たせていた発言も渡さない。動いていなければ、まだ始まっていないものだけ止まったことにする
  stop(session) {
    this.pending.delete(session);
    const run = this.running.get(session);
    if (run) {
      run.stopped = true;
      run.kill();
      return true;
    }
    const x = this.log.state.sessions.find((y) => y.id === session);
    if (x?.status === "idle") this.log.add("end", { session, stopped: true });
    return !!x;
  }

  // 発言をセッションから引き上げる：順番待ちなら外し、いま答えているところなら止める
  withdraw(say) {
    for (const [session, q] of this.pending) {
      const i = q.indexOf(say);
      if (i < 0) continue;
      q.splice(i, 1);
      if (!q.length) this.pending.delete(session);
      return;
    }
    for (const [session, run] of this.running) if (run.says.includes(say)) return void this.stop(session);
  }

  // 取り消す：まだ答え終えていない発言だけ
  cancel(say) {
    const s = this.log.state.said.find((p) => p.id === say);
    if (!cancelable(s)) return false;
    this.withdraw(say);
    this.log.add("cancel", { say });
    return true;
  }

  // 届け先を付け替える。to はセッションの番号か "new"（発言から名前を付けて新しく起こす）
  move(say, to) {
    const s = this.log.state.said.find((p) => p.id === say);
    if (!s || s.canceled) return false;
    if (to !== "new" && !shown(this.log.state).some((x) => x.id === to)) return false;
    if (to === s.session) return true;
    if (s.session != null && !s.done) this.withdraw(say);
    const target = to === "new" ? this.open(clip(oneLine(s.text), 20)) : to;
    this.log.add("route", { say, session: target });
    this.send(target, say);
    return true;
  }

  stopAll() {
    this.pending.clear();
    for (const run of this.running.values()) { run.stopped = true; run.kill(); }
  }
}
