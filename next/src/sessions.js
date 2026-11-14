// セッション：役割の定義で Claude Code を起こし、続きを頼み、出来事を記録に置く。
// 一ターンが一つのプロセス（-p と stream-json）。続きは --resume で前の会話を引き継ぐ。
// 走らせ方の決まり：同じセッションを同時に二つ走らせない（動いているあいだに届いた発言は、終わってからまとめて渡す）。
// 同時に走るのは slots まで。ほかは空くまで待つ
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { NEVER } from "./roles.js";

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

// 人がカードの伺いを受け入れて始めるターンの文（セッションには、これだけを渡す）
export const ACCEPTED = "人が受け入れました。聞いた範囲で進めてかまいません。";

// 起こすときの引数。頼む文は標準入力で渡す（- で始まる文が引数と取り違えられないように）。
// lift：人がカードの伺いを受け入れたターンだけ、外に届くことの禁止（NEVER）を外す（危ない操作は auto の判定に任せる）
export function claudeArgs(role, { resume = null, lift = false } = {}) {
  const deny = lift ? role.deny.filter((t) => !NEVER.includes(t)) : role.deny;
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    ...(resume ? ["--resume", resume] : []),
    "--append-system-prompt", role.prompt,
    ...(role.model ? ["--model", role.model] : []),
    // 機械ごとの前置き（cwd・git status など）を前置きから外し、前置きのキャッシュが外れないようにする
    "--exclude-dynamic-system-prompt-sections",
    "--permission-mode", "auto",
    ...(role.tools.length ? ["--allowedTools", ...role.tools] : []),
    ...(deny.length ? ["--disallowedTools", ...deny] : []),
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
  return [
    `Claude Code（${cmd}）が動きません${r.error ? `（${r.error.code || r.error.message}）` : ""}。`,
    "セッションは Claude Code で動きます。入れてログインしてから立て直してください：https://docs.claude.com/en/docs/claude-code/setup",
    "このままでもチャットは使えますが、セッションは結果を出さずに終わります。",
  ].join("\n");
}

// 結果（result の出来事）から、使った量
export function usageOf(r) {
  const u = r?.usage || {};
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, costUsd: r?.total_cost_usd || 0 };
}

// 落ちた理由：結果の文か errors があればそれ、なければ stderr の最後の行
export function exitError(code, result, stderr = "") {
  const said = (typeof result?.result === "string" && result.result.trim()) || (Array.isArray(result?.errors) ? result.errors.join(" / ") : "") || (result?.is_error ? String(result.subtype ?? "") : "");
  const why = said || String(stderr).trim().split("\n").at(-1) || "";
  return `終了コード ${code}${why ? `：${clip(oneLine(why), 200)}` : ""}`;
}

// 道具を使ったことを一行で：道具の名前と、いちばん手がかりになる引数
const KEYS = ["command", "file_path", "pattern", "path", "url", "query", "description"];
export function toolLine({ name, input }) {
  const v = KEYS.map((k) => input?.[k]).find((x) => typeof x === "string" && x.trim());
  return clip(`${name}${v ? ` ${oneLine(v)}` : ""}`, 120);
}

const fail = (code, message) => ({ ok: false, code, message });

export class Sessions {
  // roles：loadRoles の結果。room：place が room の役割が起きる場所。panels：place が panels の役割が起きる場所（パネル置き場）。
  // spawn：claudeSpawn か、テストの偽物
  // works：開発の作業場（work.js の Works。place が worktree の役割はここで起きる）
  constructor({ log, roles, room, panels = null, works = null, spawn, slots = 3 }) {
    this.log = log;
    this.roles = roles;
    this.works = works;
    this.places = { room, panels, worktree: works?.place() ?? null };
    this.spawn = spawn;
    this.slots = Math.max(1, slots);
    this.running = new Map(); // セッションの id -> { kill, claude }
    this.quota = null; // 利用枠：いちばん新しい rate_limit_event の rate_limit_info
    this.stopped = false;
  }

  // 立て直し：前に dyve が止まったとき動いていたセッションは、途切れたことを置く。待たせていた発言はここから渡す
  start() {
    for (const x of this.log.state.sessions) {
      if (x.running) this.log.add("fail", { session: x.id, reason: "dyve が止まったので途切れた", claude: x.claude });
    }
    this._fill();
    return this;
  }

  // 止める：動いているセッションは、途切れたことを置いてから止める
  stop() {
    this.stopped = true;
    for (const [id, r] of this.running) {
      this.log.add("fail", { session: id, reason: "dyve を止めたので途切れた", claude: r.claude ?? this._session(id)?.claude ?? null });
      r.kill();
    }
    this.running.clear();
  }

  // 発言を、セッションへ渡す。to は { session: id }（続き）か { role: 名前, name? }（この役割で新しく起こす。name はセッションの名前）。
  // to.body があれば、発言の文の代わりにそれを渡す
  // 返すもの：{ ok: true, session } か { ok: false, code, message }
  ask(said, to = {}) {
    const st = this.log.state;
    const p = st.said.find((s) => s.id === said);
    if (!p) return fail("not_found", `発言 ${said} がない`);
    if (p.session != null) return fail("conflict", `発言 ${said} はもうセッション ${p.session} に渡した`);
    let session;
    if (to.session != null) {
      if (!this._session(to.session)) return fail("not_found", `セッション ${to.session} がない`);
      session = to.session;
    } else if (to.role != null) {
      const role = this.roles[to.role];
      if (!role) return fail("not_found", `役割「${to.role}」がない`);
      let cwd = this.placeOf(role);
      if (!cwd) return fail("unavailable", `役割「${to.role}」の起きる場所（${role.place}）が用意できていない`);
      // 開発はセッションごとの作業場で（切り出すのは、ターンを始めるとき）
      if (role.place === "worktree") cwd = this.works.cwdFor(this.log.state.seq + 1);
      session = this.log.add("open", { role: to.role, cwd, name: typeof to.name === "string" && to.name.trim() ? to.name.trim() : null }).record.seq;
    } else {
      return fail("invalid", "to には session か role を書く");
    }
    this.log.add("pass", { session, said, ...(typeof to.body === "string" && to.body.trim() ? { text: to.body.trim() } : {}) });
    this._fill();
    return { ok: true, session };
  }

  // 役割が起きる場所（用意できていなければ null）
  placeOf(role) {
    return (role && Object.hasOwn(this.places, role.place) && this.places[role.place]) || null;
  }

  _session(id) {
    return this.log.state.sessions.find((x) => x.id === id);
  }

  // 待っている発言のあるセッションを、空いているぶんだけ起こす。古い発言を待たせているものから
  _fill() {
    if (this.stopped) return;
    const waiting = this.log.state.sessions
      .filter((x) => x.pending.length && !this.running.has(x.id))
      .sort((a, b) => Math.min(...a.pending) - Math.min(...b.pending));
    for (const x of waiting) {
      if (this.running.size >= this.slots) break;
      this._turn(x.id);
    }
  }

  // 一ターン。fresh：前の会話を引き継げなかったので、まっさらで起こし直す（それまでに渡した発言を全部渡し直す）
  // 人がカードの伺いを受け入れた（画面で押したときだけ）。いちばん新しいカードの、まだ受け入れていない伺いだけ。
  // 受け入れたことを置き、そのセッションの次のターンを ACCEPTED で始める。そのターンだけ NEVER を外す
  accept(id, card) {
    const x = this._session(id);
    if (!x) return fail("not_found", `セッション ${id} がない`);
    if (x.running || this.running.has(id) || x.pending.length) return fail("conflict", "動いているあいだは受け入れられない");
    if (!x.card || x.card.seq !== card || x.card.turn !== x.turn) return fail("conflict", "いちばん新しいカードの伺いではない");
    if (!x.card.ask?.outward) return fail("invalid", "そのカードに、受け入れる伺いはない");
    if (x.accepted === card) return fail("conflict", "その伺いはもう受け入れた");
    this.log.add("accept", { session: id, card });
    this._turn(id, { accept: card });
    return { ok: true, session: id };
  }

  _turn(id, { fresh = false, accept = null } = {}) {
    const x = this._session(id), role = this.roles[x.role];
    // 渡すのは清書した文（なければ元の文）
    const text = (s) => { const p = this.log.state.said.find((q) => q.id === s); return p?.body ?? p?.fair ?? p?.text ?? ""; };
    let says, prompt;
    if (fresh) {
      const now = this._lastStart(id) ?? [];
      const before = x.flow.filter((f) => f.said && !now.includes(f.said)).map((f) => f.said);
      says = [...before, ...now];
      prompt = before.length ? [`（前の会話を引き継げなかったので、これまでに頼んだことを並べます）`, ...before.map((s) => `- ${oneLine(text(s))}`), "", "いまの頼み：", ...now.map(text)].join("\n") : now.map(text).join("\n\n");
    } else if (accept != null) {
      says = [];
      prompt = ACCEPTED;
    } else {
      says = [...x.pending];
      prompt = says.map(text).join("\n\n");
    }
    const resume = fresh ? null : x.claude;
    if (!role) {
      this.log.add("start", { session: id, says, resume });
      this.log.add("fail", { session: id, reason: `役割「${x.role}」がもうない（定義を消したか、名前を変えた）`, claude: x.claude });
      return;
    }
    this.log.add("start", { session: id, says, resume, ...(accept != null ? { accept } : {}) });
    // 開発の作業場がなければ切り出す（片付けたあとの続きも、同じ場所で）。切り出せなければ結果なしで終わる
    if (this.works?.mine(x)) {
      try {
        this.works.ensure(x);
      } catch (e) {
        this.log.add("fail", { session: id, reason: e.message, claude: x.claude });
        return;
      }
    }
    const r = { claude: null, inited: false, result: null, killed: false };
    const h = this.spawn({ args: claudeArgs(role, { resume, lift: accept != null }), cwd: x.cwd, prompt }, (j) => this._event(id, r, j));
    r.kill = () => { r.killed = true; h.kill(); };
    this.running.set(id, r);
    h.done.then(({ code, stderr }) => {
      if (this.stopped) return;
      this.running.delete(id);
      // 引き継ぎが始まらずに終わった（init が来ない）：まっさらで起こし直す
      if (resume && !r.inited && !r.killed) {
        this.log.add("fail", { session: id, reason: `前の会話を引き継げなかったので、まっさらで起こし直す（${exitError(code, r.result, stderr)}）`, claude: null, retry: true });
        this._turn(id, { fresh: true });
        return;
      }
      if (r.result && !r.result.is_error && r.claude) {
        this.log.add("end", { session: id, claude: r.claude, last: typeof r.result.result === "string" ? r.result.result : null, usage: usageOf(r.result) });
      } else {
        this.log.add("fail", { session: id, reason: r.result || code ? exitError(code, r.result, stderr) : "結果を返さずに終わった", claude: r.claude, ...(r.result ? { usage: usageOf(r.result) } : {}) });
      }
      this._fill();
    });
  }

  // いちばん新しいターンで渡した発言
  _lastStart(id) {
    const x = this._session(id);
    const seq = Math.max(...x.flow.filter((f) => f.said).map((f) => f.seq));
    return x.flow.filter((f) => f.said && f.seq === seq).map((f) => f.said);
  }

  // stream-json の出来事を一つ読む。サブエージェントの言葉（parent_tool_use_id が付く）は積まない
  _event(id, r, j) {
    if (this.stopped) return;
    if (j.type === "system" && j.subtype === "init") {
      r.inited = true;
      r.claude = j.session_id ?? r.claude;
      if (r.claude && r.claude !== this._session(id)?.claude) this.log.add("bind", { session: id, claude: r.claude });
    } else if (j.type === "assistant" && !j.parent_tool_use_id) {
      for (const b of j.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) this.log.add("talk", { session: id, text: b.text });
        if (b.type === "tool_use") this.log.add("tool", { session: id, line: toolLine(b) });
      }
    } else if (j.type === "rate_limit_event") {
      this.quota = j.rate_limit_info ?? null;
    } else if (j.type === "result") {
      r.result = j;
      r.claude = j.session_id ?? r.claude;
    }
  }
}
