// セッション：一つの仕事を受け持つ Claude Code の会話。セッションごとに Claude Code を起こしっぱなしにし（-p と stream-json の入出力）、
// 発言は届いたらすぐ流し込む。動いている途中に届いた発言も、Claude Code が道具の合間に読む（差し込み）。
// しばらく使わなければ閉じ、次に話しかけられたら --resume で同じ会話を起こし直す。同時に動いている（答えている途中の）セッションは slots まで
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cancelable, shown } from "./state.js";
import { withUser } from "./user.js";

const PROMPT = fileURLToPath(new URL("../prompts/セッション.md", import.meta.url));
// 答え終えてから、この間だれも話しかけなければ閉じる（ミリ秒）
const IDLE = 10 * 60 * 1000;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 起こすときの引数。発言は標準入力に stream-json で一通ずつ流す
// 道具は絞らない。人に聞かずに進め、危ない操作だけを Claude Code の判定（auto）が止める
// mcp：dyve が貸す道具の口の URL（あれば --mcp-config で足し、その道具だけは聞かずに使えるようにする）
export function claudeArgs({ prompt, resume = null, model = null, mcp = null }) {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    ...(resume ? ["--resume", resume] : []),
    "--append-system-prompt", prompt,
    ...(model ? ["--model", model] : []),
    "--permission-mode", "auto",
    ...(mcp ? ["--mcp-config", JSON.stringify({ mcpServers: { dyve: { type: "http", url: mcp } } }), "--allowedTools", "mcp__dyve__ask", "mcp__dyve__state"] : []),
  ];
}

// 本物の起こし方：job { args, cwd } と、出来事（stream-json の一行ずつ）を受ける emit
// 返すもの：{ done: Promise<{ code, stderr }>, write(text)（発言を一通流す）, end()（閉じる）, kill() }
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
    });
    return {
      done,
      write: (text) => child?.stdin.writable && child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"),
      end: () => child?.stdin.end(),
      kill: () => child?.kill("SIGTERM"),
    };
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

// ほかのセッションの一覧（一行）。一覧に出ているものだけ、新しいほうから 8 つ
export function rosterOf(state, self) {
  const others = shown(state).filter((x) => x.id !== self).slice(-8).reverse();
  if (!others.length) return "ほかのセッションはない";
  const last = (x) => clip(oneLine(x.last).replace(/[［］]/g, ""), 60);
  return `ほかのセッション：${others.map((x) => `${x.sym}「${x.name}」${x.last ? `（最後：${last(x)}）` : ""}`).join("／")}`;
}

// 道具を使ったことの一行（「Read README.md」など）
export function toolLine(name, input = {}) {
  const arg = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.command ?? input.description ?? "";
  return clip(oneLine(`${name} ${typeof arg === "string" ? arg : ""}`), 120);
}

// 発言の文（清書したものがあればそれ）。「それ」が指すものがあれば、元の文のまま添える
export function withPointed(state, q) {
  if (!q) return "";
  const text = q.fair ?? q.text;
  const refs = (q.ref ?? []).map((id) => state.said.find((r) => r.id === id)).filter((r) => r && !r.canceled);
  const from = q.quote ? state.sessions.find((x) => x.id === q.from) : null;
  if (!refs.length && !from) return text;
  return [
    text, "",
    "［dyve：この発言が指しているもの（人の言葉と、ほかのセッションの答えをそのまま写したもの）］",
    ...refs.map((r) => `人の前の発言：${r.fair ?? r.text}`),
    ...(from ? [`${from.sym}「${from.name}」の最後の答え：`, q.quote] : []),
  ].join("\n");
}

export class Sessions {
  // user：利用者の書き足し（用語.md とセッション.md）を置くフォルダ。起こすたびに読み直す
  // mcpUrl(session)：そのセッションに貸す道具の口の URL（サーバーが待ちはじめてから決まる）
  constructor({ log, spawn, room, model = null, slots = 3, prompt = null, idle = IDLE, user = null, mcpUrl = null }) {
    Object.assign(this, { log, spawn, room, model, slots, idle, user, mcpUrl });
    this.prompt = prompt ?? fs.readFileSync(PROMPT, "utf8").trim();
    this.pending = new Map(); // セッション -> 空きを待っている発言（動いているセッションが slots に達しているとき）
    this.procs = new Map(); // セッション -> 起きている Claude Code { h, busy, says（いまのターンで渡した発言）, stopped, quiet, timer }
  }

  // 新しいセッション。返すのはその番号
  open(name) {
    const id = Math.max(0, ...this.log.state.sessions.map((x) => x.id)) + 1;
    this.log.add("open", { session: id, name });
    return id;
  }

  busy() {
    return [...this.procs.values()].filter((p) => p.busy).length;
  }

  // 発言を渡す。答えている途中なら、そのまま差し込む。空きがなければ待たせる
  send(session, say) {
    if (!this.log.state.sessions.some((x) => x.id === session)) return false;
    if (this.procs.get(session)?.busy || this.busy() < this.slots) this.deliver(session, [say]);
    else {
      if (!this.pending.has(session)) this.pending.set(session, []);
      this.pending.get(session).push(say);
    }
    return true;
  }

  pump() {
    for (const [session, says] of this.pending) {
      if (this.busy() >= this.slots) return;
      this.pending.delete(session);
      this.deliver(session, says);
    }
  }

  deliver(session, says) {
    const x = this.log.state.sessions.find((y) => y.id === session);
    const p = this.procs.get(session) ?? this.wake(session);
    clearTimeout(p.timer);
    // 清書したものがあればそれを渡す
    const text = says.map((id) => withPointed(this.log.state, this.log.state.said.find((r) => r.id === id))).filter(Boolean).join("\n\n");
    p.busy = true;
    p.says.push(...says);
    this.log.add("turn", { session, says });
    // セッションは dyve のことを知らないので、毎回一行で添える：自分の記号と名前、ほかのセッションの記号・名前・最後の一行
    // （「C の続き」「B のやつ」と呼ばれても通じるように）
    const head = `［dyve：このセッションは ${x.sym}「${x.name}」。${rosterOf(this.log.state, session)}］`;
    p.h.write(`${head}\n\n${text}`);
  }

  // Claude Code を起こす（前の会話があれば --resume で引き継ぐ）
  wake(session) {
    const x = this.log.state.sessions.find((y) => y.id === session);
    const p = { busy: false, says: [], stopped: false, quiet: false, timer: null, claude: x.claude };
    const emit = (ev) => {
      if (ev.session_id && ev.session_id !== p.claude) {
        p.claude = ev.session_id;
        this.log.add("bind", { session, claude: p.claude });
      }
      // 行の中で呼ばれたもの（サブエージェント）の出来事は出さない
      if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        // 答え終えたあとに、差し込まれた発言でまた動きだしたら、動いていることにする
        if (!p.busy) { p.busy = true; this.log.add("turn", { session, says: [] }); }
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
      // ターンの終わり。プロセスは起こしたまま、次の発言を待つ
      if (ev.type === "result" && !p.stopped) {
        p.busy = false;
        p.says = [];
        this.log.add("end", ev.is_error
          ? { session, claude: p.claude, error: oneLine(ev.result || ev.subtype || "失敗した") }
          : { session, claude: p.claude, result: String(ev.result ?? "").trim() });
        this.rest(session, p);
        this.pump();
      }
    };
    p.h = this.spawn({ args: claudeArgs({ prompt: withUser(this.prompt, this.user, "セッション"), resume: x.claude, model: this.model, mcp: this.mcpUrl?.(session) ?? null }), cwd: this.room }, emit);
    this.procs.set(session, p);
    p.h.done.then(({ code, stderr }) => {
      clearTimeout(p.timer);
      if (this.procs.get(session) === p) this.procs.delete(session);
      if (p.stopped) this.log.add("end", { session, claude: p.claude, stopped: true });
      // 答えている途中で落ちたら、そうとわかるように終わらせる（しばらく使わなくて閉じたときは何も書かない）
      else if (p.busy && !p.quiet) this.log.add("end", { session, claude: p.claude, error: stderr?.trim() ? clip(oneLine(stderr.trim().split("\n").at(-1)), 200) : `結果を出さずに終わった（終了コード ${code}）` });
      this.pump();
    });
    return p;
  }

  // 答え終えたら、しばらく待って閉じる（次に話しかけられたら起こし直す）
  rest(session, p) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { if (!p.busy) { p.quiet = true; p.h.end(); } }, this.idle);
    p.timer.unref?.();
  }

  // 人が止める：答えている途中なら止め、待たせていた発言も渡さない。続きを話せば --resume で起き直す
  stop(session) {
    this.pending.delete(session);
    const p = this.procs.get(session);
    if (p?.busy) {
      p.stopped = true;
      p.h.kill();
      return true;
    }
    const x = this.log.state.sessions.find((y) => y.id === session);
    if (x?.status === "idle") this.log.add("end", { session, stopped: true });
    return !!x;
  }

  // 発言をセッションから引き上げる：空きを待っているなら外し、いま答えているところなら止める
  withdraw(say) {
    for (const [session, q] of this.pending) {
      const i = q.indexOf(say);
      if (i < 0) continue;
      q.splice(i, 1);
      if (!q.length) this.pending.delete(session);
      return;
    }
    for (const [session, p] of this.procs) if (p.busy && p.says.includes(say)) return void this.stop(session);
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
    for (const p of this.procs.values()) { p.quiet = true; p.h.kill(); }
  }
}
