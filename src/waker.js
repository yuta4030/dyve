// 起こし係：発言が来たら清書係に渡し、間があいたらマネージャを起こし、仕事が置かれたら控室のエージェントを起こす。
// 同じ仕事を同時に二つ走らせない。清書係は一度に一人。マネージャは、前の整理が済むのを待たずに次の発言を読めるよう、
// 読む発言を分けて二本（lanes）まで並べる。同じ発言を二本で読むことはない
import path from "node:path";
import { isPerson, hasAiAnswer, STAFF, turnOf, layoutOf } from "./board.js";
import { changeLayout, layoutPanel } from "./view.js";
import { NAMES } from "./crew.js";
import { wordLine } from "./words.js";
import { Focus } from "./focus.js";

// 起こしっぱなしの会話を起こし直す目安：流し込んだ数と、あいた時間（キャッシュの持ちは 1 時間）。
// 毎回起こし直すと前置きの一部（約 7 千トークン）が毎回キャッシュに書き直しになるので、清書係もマネージャも会話を続ける。
// 会話は伸びるので、目安を超えたら起こし直す。マネージャの引き継ぎは話題の表（行・帰った一行・話題の note）が持つ
const TURNS = { scribe: 50, manager: 20 };
const IDLE = 55 * 60 * 1000;
const CONTEXT = 5;
const NEAR = 3;

export { NAMES };

export class Waker {
  // session：清書係の会話を開く関数（なければ清書係を置かない）
  // integrate：開発の提案を人が受け入れたら呼ぶ（{ board, taskId } -> { branch, into, commit, cleaned }）
  constructor({ store, spawn, session = null, integrate = null, pause = 4000, scribePause = 1000, slots = 3, lanes = 2, names = NAMES, initials = {}, calls = {}, teams = {}, words = null, now = () => Date.now() }) {
    this.store = store;
    this.words = words; // 辞書（全部のボードで共通）
    this.focus = new Focus(); // 人のいま（画面が知らせてくる。これで誰かを起こすことはしない）
    this.wordsSeen = 0;
    this.integrate = integrate;
    this.board = store.file ? path.basename(store.file, ".jsonl") : "board";
    this.spawn = spawn;
    this.session = session;
    this.pause = pause;
    this.scribePause = scribePause;
    this.convs = {}; // role -> { s, turns, lastAt }
    this.scribeBusy = false;
    this.scribeAgain = false;
    this.scribeTimer = null;
    this.afterScribe = false;
    this.quota = null; // 利用枠の残り（起こしっぱなしの会話が拾ったもの）
    this.usage = { runs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
    this.slots = slots;
    this.names = names;
    this.initials = initials; // 名前 -> 画面のアイコンの頭文字
    this.calls = calls; // 名前（ログに残る id）-> 呼び名（画面と声）。なければ名前のまま
    this.teams = teams; // 名前 -> チーム（個人の控室の人は null）
    this.lanes = Math.max(1, lanes);
    this.managers = []; // 走っているマネージャ：{ lane, since, upto, startedAt, handle }
    this.now = now;
    this.waitTimer = null;
    this.again = false;
    this.timer = null;
    this.running = new Map(); // taskId -> { name, startedAt, handle }
    this.tried = new Map(); // taskId -> 起こしたときの rev（同じ形の仕事で二度起こさない）
    this.direct = new Map(); // 名前 -> { says: [発言の id], timer }（人がアイコンで宛てた発言。間があくか、相手の仕事が終わったら渡す）
    this.listeners = new Set();
    this.turns = new Map(); // 行の id -> 前に見た番（決まった面を閉じるため）
    const last = (by) => store.board.log.filter((op) => op.by === by).at(-1)?.seq ?? 0;
    this.cutoff = last("manager");
    this.scribeCutoff = Math.max(last("scribe"), this.cutoff);
  }

  start() {
    this.off = this.store.onOp((op) => this._onOp(op));
    if (this.session && this._says(this.scribeCutoff).length) this._scheduleScribe();
    if (this._unreadSays()) this._schedule();
    for (const p of this.store.board.list()) if (p.view === "task") this.turns.set(p.id, turnOf(this.store.board, p));
    this._fill();
    this._waits();
    return this;
  }

  stop() {
    this.off?.();
    clearTimeout(this.timer);
    clearTimeout(this.scribeTimer);
    clearTimeout(this.waitTimer);
    for (const d of this.direct.values()) clearTimeout(d.timer);
    for (const c of Object.values(this.convs)) c.s.kill();
    for (const m of this.managers) m.handle.kill();
    for (const r of this.running.values()) r.handle.kill();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // いちばん前から走っているマネージャ（なければ null）
  get manager() {
    return this.managers[0] ?? null;
  }

  status() {
    const m = this.manager;
    return {
      scribe: this.scribeBusy,
      manager: m ? { since: m.since, startedAt: m.startedAt } : null,
      managers: this.managers.map((x) => ({ lane: x.lane, since: x.since, upto: x.upto, startedAt: x.startedAt })),
      waitingManager: !!this.timer || this.afterScribe,
      // マネージャが読み終えたところ（走っているあいだは、読みはじめる前の位置）。画面は、これより後の発言を「まだ」と見せる
      read: m ? m.since : this.cutoff,
      usage: { ...this.usage },
      quota: this.quota,
      agents: [...this.running].map(([task, r]) => ({ name: r.name, task, startedAt: r.startedAt })),
    };
  }

  runningTasks() {
    return [...this.running.keys()];
  }

  _changed() {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }

  _count(res) {
    const u = res?.usage;
    if (!u) return;
    this.usage.runs++;
    for (const k of ["input", "output", "cacheWrite", "cacheRead", "costUsd"]) this.usage[k] += u[k] || 0;
  }

  _onOp(op) {
    // 受け入れ：人が押したか、人が声で受け入れたのをマネージャが書いたか（from）
    if ((isPerson(op.by) || (op.by === "manager" && op.from)) && op.type === "edit" && op.panel.state === "done") this._accepted(op.panel.id);
    if (op.type === "add" && op.panel.view === "say" && isPerson(op.by)) {
      if (this.session) this._scheduleScribe();
      this._schedule();
      if (this.names.includes(op.panel.to)) this._queueDirect(op.panel.to, op.panel.id);
    }
    const r = this.running.get(op.panel.id);
    if (r && op.by !== r.name && (op.type === "drop" || (op.type === "edit" && "state" in op.panel && op.panel.state !== "task"))) {
      r.handle.kill(); // 人かマネージャが仕事を取り下げた
    }
    this._fill();
    if (op.panel.id !== layoutPanel(this.store.board)?.id) {
      this._closeDecided();
      this._waits();
    }
  }

  // 決まった行・待ちになった行の面は、行に畳む（閉じた面は行からいつでも開き直せる）
  _closeDecided() {
    const board = this.store.board, lp = layoutPanel(board);
    const open = new Set(lp ? layoutOf(lp.data, board.panels).out || [] : []);
    const close = [];
    for (const p of board.list()) {
      if (p.view !== "task") continue;
      const was = this.turns.get(p.id), now = turnOf(board, p);
      this.turns.set(p.id, now);
      if (was !== now && (now === "ok" || now === "wait") && open.has(p.id)) close.push(p.id);
    }
    if (close.length) changeLayout(this.store, "board", { out: Object.fromEntries(close.map((id) => [id, false])) }, "決まった行の面を、行に畳む");
  }

  // 条件つきの待ち：日時が来たか、先に済ませる行が済んだら、人の番で帰す
  _waits() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const board = this.store.board, now = this.now();
    let next = Infinity;
    for (const p of board.list()) {
      if (p.view !== "task" || !p.wait) continue;
      const w = p.wait, after = w.after ? board.get(w.after) : null;
      const until = w.until ? Date.parse(w.until) : null;
      const met = (until != null && until <= now) || (w.after && (!after || after.state === "done" || turnOf(board, after) === "ok"));
      if (met) {
        this.store.apply({ by: "board", type: "edit", panel: { id: p.id, wait: null, state: "done", line: `待ちが明けた：${w.text}` }, reason: "条件つきの待ちの条件が満たされたので、人の番で帰す" });
        return; // 書いた操作でまた呼ばれる
      }
      if (until != null) next = Math.min(next, until);
    }
    if (next < Infinity) this.waitTimer = setTimeout(() => this._waits(), Math.min(Math.max(next - now, 1000), 3600_000));
  }

  // 人が提案を受け入れた。開発の仕事の提案なら、ブランチを取り込む。それ以外は、提案を置いた人に、提案のとおりに進めてもらう
  _accepted(id) {
    const board = this.store.board;
    const prev = board.history(id).slice(0, -1).reverse().find((o) => "state" in o.panel)?.panel.state;
    if (prev !== "proposal") return;
    let t = board.get(id);
    while (t && !(t.view === "task" && t.data?.write === true)) t = t.about ? board.get(t.about) : null;
    if (!t) return this._act(id);
    if (!this.integrate) return;
    const note = (data) => this.store.apply({ by: "board", type: "add", panel: { view: "text", about: id, data }, reason: "受け入れられた開発の提案を取り込んだ結果" });
    Promise.resolve()
      .then(() => this.integrate({ board: this.board, taskId: t.id }))
      .then((r) => note(`取り込みました：${r.branch} → ${r.into}（${r.commit}）。使っている dyve に反映するには、dyve 設定の「更新して再起動」${r.cleaned ? "" : "。作業場は片付けられなかったので残っています"}`))
      .catch((e) => note(`取り込めませんでした：${e.message}`));
  }

  _says(since) {
    return this.store.board.list().filter((p) => p.view === "say" && isPerson(p.by) && p.seq > since);
  }

  // ── 清書係：発言が来て短い間があいたら、起こしっぱなしの会話に流し込む ──
  _scheduleScribe() {
    if (this.scribeBusy) {
      this.scribeAgain = true;
      return;
    }
    clearTimeout(this.scribeTimer);
    this.scribeTimer = setTimeout(() => this._wakeScribe(), this.scribePause);
  }

  async _wakeScribe() {
    this.scribeTimer = null;
    const since = this.scribeCutoff;
    this.scribeCutoff = this.store.board.seq;
    // 人が手を入れた発言は直さない。「これにする」を押して置かれた発言は、画面が書いた文なので直すところがない
    const fresh = this._says(since).filter((p) => p.rev === p.seq && !p.pinned && !p.into && p.point?.how !== "pick").slice(-10);
    if (!fresh.length) return this._scribeDone();
    const { c, first } = this._conv("scribe");
    // 直前の発言はいつも渡す（一つの考えならつなげるので、いまの文と rev が要る）
    const before = this.store.board.list().filter((p) => p.view === "say" && isPerson(p.by) && p.seq <= since && !p.into).slice(first ? -CONTEXT : -NEAR);
    const words = this._wordsFor(first);
    const screen = this._screenFor(c, first);
    this.scribeBusy = true;
    this._changed();
    const res = await c.s.send(scribePrompt(fresh, before, words, { screen, board: this.store.board }));
    this._count(res);
    if (c.s.quota) this.quota = c.s.quota;
    c.turns += fresh.length;
    c.lastAt = Date.now();
    this.scribeBusy = false;
    this._scribeDone();
  }

  // 辞書：会話の頭では全部、あとは変わった分だけ（前置きに入れるとキャッシュが外れる）
  _wordsFor(first) {
    if (!this.words) return [];
    const from = first ? 0 : this.wordsSeen;
    this.wordsSeen = this.words.seq;
    if (first) return this.words.list().map(wordLine);
    return this.words.log.slice(from).map((o) => (o.type === "add" ? wordLine(o) : `- ${o.heard} は直さなくなった`));
  }

  // 画面の言葉：人がいま見ている表の行・面の見出し。辞書と同じく、会話の頭では全部、あとは前に送っていない行だけ
  _screenFor(c, first) {
    if (first || !c.screen) c.screen = new Set();
    const out = screenWords(this.store.board).filter((l) => !c.screen.has(l));
    for (const l of out) c.screen.add(l);
    return out;
  }

  // 役ごとの会話。死んでいたり、伸びすぎたり、あきすぎたりしたら起こし直す
  _conv(role, key = role) {
    const now = Date.now();
    const c = this.convs[key];
    if (c && c.s.alive && c.turns < TURNS[role] && now - c.lastAt <= IDLE) return { c, first: false };
    c?.s.kill();
    this.convs[key] = { s: this.session({ role, name: role }), turns: 0, lastAt: now };
    return { c: this.convs[key], first: true };
  }

  _scribeDone() {
    if (this.scribeAgain) {
      this.scribeAgain = false;
      this._scheduleScribe();
    }
    if (this.afterScribe && !this.scribeBusy && !this.scribeTimer) {
      this.afterScribe = false;
      if (this.managers.length < this.lanes) this._wakeManager();
    }
    this._changed();
  }

  _unreadSays() {
    return this.store.board.list().some((p) => p.view === "say" && isPerson(p.by) && p.seq > this.cutoff);
  }

  // 間があいたら起こす。空いている本がなければ、どれかが終わったあとにまとめて読ませる
  _schedule() {
    if (this.managers.length >= this.lanes) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._wakeManager(), this.pause);
    this._changed();
  }

  _wakeManager() {
    this.timer = null;
    // 清書が済んでから整理する
    if (this.scribeBusy || this.scribeTimer) {
      this.afterScribe = true;
      this._changed();
      return;
    }
    if (this.managers.length >= this.lanes || !this._unreadSays()) return;
    const since = this.cutoff;
    this.cutoff = this.store.board.seq;
    const busy = new Set(this.managers.map((m) => m.lane));
    let lane = 0;
    while (busy.has(lane)) lane++;
    // ほかの本がいま読んでいる発言（取り次ぎを二重にしない）
    const others = this.managers.flatMap((m) => this._says(m.since).filter((p) => p.seq <= m.upto && !p.into).map((p) => p.id));
    const prompt = managerPrompt(since, this.store.board, this.runningTasks(), this.focus, others);
    let handle;
    if (this.session) {
      const { c } = this._conv("manager", lane ? `manager#${lane + 1}` : "manager");
      c.turns++;
      handle = { done: c.s.send(prompt).finally(() => { c.lastAt = Date.now(); if (c.s.quota) this.quota = c.s.quota; }), kill: () => c.s.kill() };
    } else {
      handle = this.spawn({ role: "manager", name: "manager", prompt });
    }
    const m = { lane, since, upto: this.cutoff, startedAt: new Date().toISOString(), handle };
    this.managers.push(m);
    this._changed();
    handle.done.then((res) => this._count(res)).finally(() => {
      this.managers = this.managers.filter((x) => x !== m);
      if (this.again || this._unreadSays()) {
        this.again = false;
        this._schedule();
      }
      this._changed();
    });
  }

  _fill() {
    const board = this.store.board;
    let changed = false;
    for (const t of board.list()) {
      if (this.running.size >= this.slots) break;
      if (t.state !== "task" || this.running.has(t.id)) continue;
      if (this.tried.get(t.id) === t.rev || hasAiAnswer(board, t.id)) continue;
      const name = this._pickName(t.data?.to, t.data?.team);
      if (!name) continue;
      this.tried.set(t.id, t.rev);
      // data.write が付いた仕事：true は開発（仕事ごとの worktree の中で）、"panels" はパネルの仕事（利用者のパネル置き場で）
      // data.accepted が付いた仕事は、人が受け入れた提案（部屋で、提案の範囲なら外に届くこともする）
      const role = t.data?.accepted ? "act" : t.data?.write === true ? "dev" : t.data?.write === "panels" ? "panels" : "task";
      const handle = this.spawn({ role, name, taskId: t.id, board: this.board, prompt: taskPrompt(board, t, name, this.call(name), this.focus) });
      this.running.set(t.id, { name, startedAt: new Date().toISOString(), handle });
      changed = true;
      handle.done.then((res) => {
        this._count(res);
        this.running.delete(t.id);
        if (this.direct.get(name)?.says.length) this._flushDirect(name);
        const cur = this.store.board.get(t.id);
        // 途中経過を置いたあとで落ちた仕事も、待っているように見えたままにしない
        const answered = hasAiAnswer(this.store.board, t.id);
        if (cur && cur.state === "task" && (res?.error || !answered)) {
          // 止まったことは行に帰す（人の番：止まったのを知る）。行を書き換えられなければ、仕事について置く
          const text = `${this.call(name)} は${answered ? "途中で止まりました" : "結果を置かずに終わりました"}${res?.error ? `（${res.error}）` : ""}`;
          const back = this.store.apply({ by: "board", type: "edit", panel: { id: t.id, state: "done", line: text.slice(0, 200) }, reason: "仕事が落ちたままにならないように、止まったことを行に帰す" });
          if (!back.ok) this.store.apply({ by: "board", type: "add", panel: { view: "text", about: t.id, data: text }, reason: "仕事が落ちたままにならないように" });
        }
        this._fill();
        this._changed();
      });
    }
    if (changed) this._changed();
  }

  // 受け入れた提案を仕事にする（data.accepted）。宛先は提案を置いた人（控室の人でなければ、空いている人）。
  // 頼むのは受け入れたときの提案の文そのもの。元の仕事（after）を付けて、その人が前に置いたものを読めるようにする
  _act(id) {
    const board = this.store.board, p = board.get(id);
    if (!p) return;
    let task = p.about ? board.get(p.about) : null;
    while (task && task.view !== "task") task = task.about ? board.get(task.about) : null;
    const name = this.resolve(p.by);
    const from = Array.isArray(task?.data?.from) ? task.data.from : null;
    this.store.apply({
      by: "board",
      type: "add",
      panel: { view: "task", state: "task", about: id, data: { title: titleOf(p.data), text: plainOf(p.data), accepted: id, ...(name ? { to: name } : {}), ...(task ? { after: task.id } : {}), ...(from ? { from } : {}) } },
      reason: `人が提案 ${id} を受け入れたので、${name ? this.call(name) : "控室"}に提案のとおり進めてもらう`,
    });
  }

  // 人がアイコンで宛てた発言：続けて話したぶんは一つにまとめる。相手が働いているあいだは、終わるまで待たせる
  _queueDirect(name, id) {
    const d = this.direct.get(name) || { says: [], timer: null };
    this.direct.set(name, d);
    d.says.push(id);
    clearTimeout(d.timer);
    d.timer = setTimeout(() => this._flushDirect(name), this.pause);
  }

  _flushDirect(name) {
    const d = this.direct.get(name);
    if (!d?.says.length) return;
    clearTimeout(d.timer);
    d.timer = null;
    if ([...this.running.values()].some((r) => r.name === name)) return; // 終わったら渡す
    const board = this.store.board;
    const says = d.says.map((id) => board.get(id)).filter(Boolean);
    d.says = [];
    if (!says.length) return;
    const after = lastTaskOf(board, name);
    this.store.apply({
      by: "board",
      type: "add",
      panel: { view: "task", state: "task", about: says.at(-1).id, data: { text: says.map((p) => textOf(p.data)).join("\n"), to: name, direct: true, from: says.map((p) => p.id), ...(after ? { after: after.id } : {}) } },
      reason: `人が${this.call(name)}に宛てて話したことを、そのまま${this.call(name)}に渡す`,
    });
  }

  call(name) {
    return this.calls[name] ?? name;
  }

  // data.to はふつう名前（id）。呼び名や「@チーム」を省いた名前で書かれても、一人に決まればその人にする
  resolve(to) {
    if (!to) return null;
    if (this.names.includes(to)) return to;
    const hit = this.names.filter((n) => this.call(n) === to);
    if (hit.length === 1) return hit[0];
    const bare = this.names.filter((n) => n.split("@")[0] === to);
    return bare.length === 1 ? bare[0] : null;
  }

  // team：data.team。そのチームの空いている人に渡す（そのチームの人がいなければ、誰でも）
  _pickName(wanted, team = null) {
    const busy = new Set([...this.running.values()].map((r) => r.name));
    // 名前を呼ばれた相手が働いているなら、空くまで待つ
    const who = this.resolve(wanted);
    if (who) return busy.has(who) ? null : who;
    const mates = team ? this.names.filter((n) => this.teams[n] === team) : [];
    return (mates.length ? mates : this.names).find((n) => !busy.has(n));
  }
}

const textOf = (d) => (typeof d === "string" ? d : d?.text ?? JSON.stringify(d));
// 提案の中身を、頼む文に：箇条書きは一行ずつ、ほかは文のまま（JSON の文字列にしない）
function plainOf(d) {
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => `- ${typeof x === "string" ? x : textOf(x)}`).join("\n");
  return typeof d?.text === "string" ? d.text : JSON.stringify(d);
}
// 行に出す短い名前：提案の一行目の頭
const titleOf = (d) => clip(plainOf(d).split("\n").map((x) => x.replace(/^\s*[-・*]\s*/, "").trim()).find(Boolean) ?? "", 20);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// パネルの中身の頭の一行
function headOf(p) {
  const d = p?.data;
  const t = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => textOf(x)).find((x) => typeof x === "string") : d?.title ?? d?.text;
  return typeof t === "string" ? t.split("\n").map((x) => x.trim()).find(Boolean) ?? "" : "";
}
// パネルを一行で呼ぶ（行なら記号、id と中身の頭）
function label(board, id) {
  const p = board.get(id);
  const line = headOf(p);
  const name = p?.key ? `${p.key}（${id}）` : id;
  return line ? `${name}「${clip(line, 30)}」` : p ? `${name}（${p.view}）` : `${id}（もうない）`;
}
// 人がその発言をしたときに指していたパネル（合流した発言のぶんも）。押して選んだものは決定、ほかは手がかり
const HOW = { pick: "を押して選んだ", hover: "を指して", view: "を見ながら" };
function pointNotes(board, says) {
  const out = [];
  for (const p of says) {
    const note = p?.point && HOW[p.point.how] ? `${label(board, p.point.id)}${HOW[p.point.how]}` : "";
    if (note && !out.includes(note)) out.push(note);
  }
  return out;
}

// その人がいちばん最近受け持った仕事：宛てられた仕事か、結果を置いた仕事
function lastTaskOf(board, name) {
  let best = null;
  for (const p of board.list()) {
    const t = p.view === "task" && p.data?.to === name ? p : p.by === name && p.about ? board.get(p.about) : null;
    if (t?.view === "task" && (!best || t.seq > best.seq)) best = t;
  }
  return best;
}

// 画面の言葉：人がいま目の前にしている表（話題・行の記号・行の名前・帰った一行）と、開いている面の見出し。
// 人は画面を見ながら喋るので、聞き違いはここにある言葉に寄せられる（「プリクラ」→ 行の「PR #16 マージ」）
export function screenWords(board) {
  const all = board.list();
  const lp = all.find((p) => p.view === "layout");
  const open = new Set(lp ? layoutOf(lp.data, board.panels).out || [] : []);
  const rowName = (r) => clip(String(r.data?.title ?? headOf(r) ?? ""), 40);
  const out = [];
  const rows = (parent, depth) => {
    for (const r of all.filter((q) => q.about === parent.id && q.view === "task")) {
      out.push(`${"  ".repeat(depth)}- ${r.key ?? r.id} ${rowName(r)}${r.line ? ` → ${clip(r.line, 60)}` : ""}${r.decided ? `（決まった：${clip(r.decided, 30)}）` : ""}`);
      if (!open.has(r.id)) continue;
      // 開いている面：中の行と、置かれたものの見出し（表なら列と一列目）
      for (const q of all.filter((x) => x.about === r.id && x.view !== "task")) {
        const d = q.data;
        const head = q.view === "table" && d && Array.isArray(d.columns)
          ? [d.columns.join("・"), ...(Array.isArray(d.rows) ? d.rows.map((row) => (Array.isArray(row) ? row[0] : null)).filter((x) => typeof x === "string") : [])].map((x) => clip(String(x), 30)).join("／")
          : clip(headOf(q), 60);
        if (head) out.push(`${"  ".repeat(depth + 1)}- ${r.key ?? r.id} の面：${head}`);
      }
      rows(r, depth + 1);
    }
  };
  for (const t of all.filter((p) => p.view === "topic" && p.state !== "done")) {
    out.push(`- 話題「${clip(String(t.data?.title ?? headOf(t)), 40)}」`);
    rows(t, 1);
  }
  return out;
}

// 人が手で直した発言か（清書係は触らない）
const byHand = (board, p) => board.history(p.id).some((o) => o.type === "edit" && isPerson(o.by) && "data" in o.panel);

// 清書係への一通。新しい発言を直させ、直前の発言は文脈として渡す（新しい発言で言葉の正体がわかれば、文脈の発言も直せる）。
// screen：画面の言葉（前に送っていない行だけ）。board があれば、発言のとき指していたものの名前を添える
export function scribePrompt(fresh, before = [], words = [], { screen = [], board = null } = {}) {
  const pointed = (p) => (board ? pointNotes(board, [p]) : []).map((n) => `、${n}`).join("");
  const ctx = (p) => (p.pinned ? `- ${p.id}（ピン留め。触らない）：` : board && byHand(board, p) ? `- ${p.id}（人が直した。触らない）：` : `- ${p.id}（rev ${p.rev}${pointed(p)}）：`) + textOf(p.data);
  return [
    words.length ? "辞書（よく聞き違える言葉。左のように聞こえたら右の書き方に）：" : "",
    ...words,
    screen.length ? "画面の言葉（人がいま見ている表の行と面。音が近ければここに寄せる。前に送ったものに足す分）：" : "",
    ...screen,
    before.length ? "文脈（前の発言。一つの考えならここへつなげる。新しい発言で言葉の正体がわかれば、ここも直す）：" : "",
    ...before.map(ctx),
    "新しい発言（直すものだけ panel_edit。rev を付ける）：",
    ...fresh.map((p) => `- ${p.id}（rev ${p.rev}${pointed(p)}）：${textOf(p.data)}`),
  ].filter(Boolean).join("\n");
}

// マネージャへの指示。読むものをはじめから渡して、board_read の往復を減らす
const TURN_WORD = { ai: "AI の番", you: "人の番", ok: "決まった", wait: "待ち" };
// 行を一行で：記号・番・頼んだこと → 帰った一行（決まったこと・待ち）
export function rowLine(board, t, busy = new Set()) {
  const turn = turnOf(board, t);
  const tail = [t.line ? `→ ${t.line}` : "", t.decided ? `決まった：${t.decided}` : "", t.wait ? `待ち：${t.wait.text}` : ""].filter(Boolean).join("　");
  return `- ${t.key ? `${t.key}（${t.id}）` : t.id}［${TURN_WORD[turn] ?? t.state ?? "—"}${busy.has(t.id) ? "・動いている" : ""}${t.state === "proposal" ? "・提案" : ""}］${t.data?.to ? `${t.data.to}：` : ""}${clip(textOf(t.data), 80)}${tail ? `　${tail}` : ""}`;
}
// 届いたばかりのもの：AI かボードが行に一行を帰した・提案を置いた、新しい順。「それ」はまずここを指す
export function arrivals(board, n = 4) {
  const out = [];
  for (let i = board.log.length - 1; i >= 0 && out.length < n; i--) {
    const op = board.log[i];
    if (isPerson(op.by) || op.by === "scribe") continue;
    const id = op.type === "edit" && op.panel.line != null ? op.panel.id : op.type === "add" && op.panel.state === "proposal" ? op.panel.about ?? op.panel.id : null;
    const p = id && board.get(id);
    if (p && !out.some((x) => x.p.id === p.id)) out.push({ p, seq: op.seq, at: op.at });
  }
  return out;
}

export function managerPrompt(since, board = null, running = [], focus = null, others = []) {
  const head = `ボードに新しい動きがあります（since: ${since}、seq ${since} より後）。読むものは下にそろえてあります。足りないときだけ board_read を使ってください。`;
  const tail = "終わったら何も言わずに終えてください。人への返事はボードに置くものだけです。";
  if (!board) return [head, tail].join("\n");
  const all = board.list();
  const summary = all.filter((p) => p.by === "manager" && p.view === "summary").at(-1);
  const busy = new Set(running);
  // 話題の表にない仕事（話題の外のもの）だけを、ここに並べる。表の行は「表」に出す
  const inTable = (p) => p.view === "task" && p.key;
  const tasks = all.filter((p) => !inTable(p) && (p.state === "task" || (p.view === "task" && p.rev > since)));
  // 合流した発言は先頭だけ読む。先頭が古くても、新しい発言が合流していれば読み直す
  const says = all.filter((p) => p.view === "say" && isPerson(p.by) && !p.into && (p.seq > since || all.some((q) => q.into === p.id && q.seq > since)));
  const placed = all.filter((p) => p.rev > since && p.view !== "layout" && !isPerson(p.by) && !STAFF.has(p.by) && p.by !== "scribe");
  const lines = [head, ""];
  // 前の版のマネージャが要点に置いた、まだ決まっていない問い。行になっていなければ行にする（落とさない）
  const open = Array.isArray(summary?.data?.open) ? summary.data.open.map((x) => (typeof x === "string" ? x : x?.text)).filter((x) => typeof x === "string" && x.trim()) : [];
  if (open.length) lines.push(`## いまの要点に残っている問い（${summary.id}。要点はもう書き換えない。まだ行になっていないものは、合う話題の行にする）`, ...open.map((x) => `- ${clip(x, 100)}`), "");
  const topics = all.filter((p) => p.view === "topic");
  lines.push("", "## 話題");
  if (!topics.length) lines.push("（まだない）");
  for (const t of topics) {
    const rows = all.filter((p) => p.about === t.id && p.view === "task");
    lines.push(`- ${t.id}（rev ${t.rev}）${t.state === "done" ? "［済み］" : ""}${t.pinned ? "［ピン留め］" : ""}：${clip(typeof t.data === "string" ? t.data : t.data?.title ?? textOf(t.data), 60)}（行 ${rows.length}）${t.data?.note ? `　いまどこまで：${clip(String(t.data.note), 80)}` : "　いまどこまで：（まだない）"}`);
    // 済んだ話題の表は、決まっていない行だけ
    const shown = t.state === "done" ? rows.filter((r) => !["ok", null].includes(turnOf(board, r))) : rows;
    const tree = (r, depth) => [`${"  ".repeat(depth + 1)}${rowLine(board, r, busy)}`, ...all.filter((q) => q.about === r.id && q.view === "task").flatMap((q) => tree(q, depth + 1))];
    for (const r of shown) lines.push(...tree(r, 0));
  }
  const back = arrivals(board).filter((a) => a.p.view === "task" || a.p.state === "proposal");
  if (back.length) {
    lines.push("", "## 届いたばかり（新しい順。「それ」「それでいい」は、指したものがなければまずいちばん上を指す）");
    for (const a of back) lines.push(`- ${a.p.key ? `${a.p.key}（${a.p.id}）` : a.p.id}${a.seq > since ? "［前に起きてから］" : ""}：${clip(a.p.line ?? textOf(a.p.data), 80)}`);
  }
  const lp = all.find((p) => p.view === "layout");
  const faces = lp ? (layoutOf(lp.data, board.panels).out || []).filter((id) => board.get(id)?.view === "task") : [];
  if (faces.length) lines.push("", "## 開いている面", ...faces.map((id) => `- ${board.get(id).key || id}（${id}）`));
  lines.push("", "## 仕事");
  if (!tasks.length) lines.push("（なし）");
  for (const t of tasks) lines.push(`- ${t.id}［${t.state}${busy.has(t.id) ? "・動いている" : ""}${board.get(t.about)?.view === "topic" ? `・話題 ${t.about}` : ""}］${t.data?.to ? `${t.data.to}：` : ""}${clip(textOf(t.data), 120)}`);
  lines.push("", "## 新しい発言（清書済み）");
  const skip = new Set(others);
  if (!says.length) lines.push("（なし）");
  if (others.length) lines.push(`（${others.join(" ")} は、もう一本のマネージャがいま読んでいます。取り次ぎや受け入れを二重にしないでください。要点の書き換えで conflict が返ったら、board_read で読み直してから足してください）`);
  for (const p of says.filter((x) => !skip.has(x.id))) {
    const notes = [p.to ? `${p.to}宛て。ボードがそのまま${p.to}に渡すので、取り次がない` : "", ...pointNotes(board, [p, ...all.filter((q) => q.into === p.id)])].filter(Boolean);
    lines.push(`- ${p.id}${notes.length ? `（${notes.join("、")}）` : ""}：${textOf(p.data)}`);
  }
  if (placed.length) {
    lines.push("", "## 新しく置かれたもの");
    for (const p of placed) lines.push(`- ${p.id}（${p.by}${p.about ? `、${p.about} について` : ""}${p.state ? `、${p.state}` : ""}）：${clip(textOf(p.data), 300)}`);
  }
  if (focus) lines.push("", "## 人のいま", ...focus.lines(board));
  lines.push("", tail);
  return lines.join("\n");
}

export function taskPrompt(board, task, name, call = name, focus = null) {
  // 元の発言：data.from があればそれ、なければ about の先が発言のとき
  const from = Array.isArray(task.data?.from) ? task.data.from.map((id) => board.get(id)).filter(Boolean) : [];
  const above = task.about ? board.get(task.about) : null;
  const srcs = from.length ? from : above?.view === "say" ? [above] : [];
  const topic = above?.view === "topic" ? above : null;
  const text = typeof task.data === "string" ? task.data : task.data?.text ?? JSON.stringify(task.data);
  const prev = task.data?.after ? board.get(task.data.after) : null;
  const parent = above?.view === "task" ? above : null;
  const prevOut = prev ? board.list().filter((p) => p.about === prev.id && p.by === name).slice(-5) : [];
  // この行について控室の人が前に置いた結果（面の中身）。同じ仕事の結果は書き換えて、古いものと新しいものを並べない
  const mine = board.list().filter((p) => p.about === task.id && p.view !== "task" && !isPerson(p.by) && !STAFF.has(p.by) && p.state !== "proposal").slice(-5);
  return [
    call === name
      ? `あなたは控室のタスクエージェント「${name}」です。ボードの仕事 ${task.id} を受け持ちました。`
      : `あなたは控室のタスクエージェント「${call}」（ボードの上の名前は ${name}）です。ボードの仕事 ${task.id} を受け持ちました。`,
    task.data?.direct ? `人があなたに直接話しかけました。言われたことにそのまま応えてください。まず一、二行の短い返事を about: "${task.id}" の text（data は文字列）で置いてください。人のトークに返事として出ます。中身の結果は、そのあとに置きます。` : "",
    task.data?.accepted ? `これは人が受け入れた提案（${task.data.accepted}）です。提案に書いたことを、そのとおりに進めてください。提案の範囲なら、外に届くこと（push・送信・起票など）もしてかまいません。提案にないことはしません。危ない操作は止められることがあります。止められたら別の手で済ませるか、そのことを結果に書きます。` : "",
    task.data?.direct ? `言われたこと：${text}` : task.data?.accepted ? `受け入れた提案：${text}` : `仕事：${text}`,
    prev ? `前にあなたが受け持った仕事（${prev.id}）：${clip(textOf(prev.data), 300)}` : "",
    ...prevOut.map((p) => `- そのときあなたが置いたもの（${p.id}）：${clip(textOf(p.data), 300)}`),
    topic ? `話題（${topic.id}）：${typeof topic.data === "string" ? topic.data : topic.data?.title ?? textOf(topic.data)}` : "",
    ...(task.data?.direct ? [] : srcs.map((p) => `元の発言（${p.id}）：${textOf(p.data)}`)),
    ...pointNotes(board, srcs.flatMap((p) => [p, ...board.list().filter((q) => q.into === p.id)])).map((n) => `人はそのとき ${n}${n.endsWith(HOW.pick) ? "" : "（手がかり。話が合わなければ無視する）"}`),
    task.key ? `この仕事は表の行 ${task.key} です。${parent?.view === "task" ? `行 ${parent.key || parent.id} の面の中から呼ばれました。` : ""}` : "",
    `結果は行に帰します：終わったら panel_edit で仕事 ${task.id} に line（答えの一行。60 字くらいまで）と state done を一度に渡してください。一行に収まるなら、それだけです。新しいパネルは足しません。`,
    `一行に収まらないとき（比べる案がある、人が先に決めることがある、出典を並べる）だけ、詳しいものを about: "${task.id}" で置き、line はその結論の一行にします。行から開ける面になります。人に決めてもらう問いも、そこに短く置きます。`,
    `時間がかかるときは、途中で line を「いまどこまで来たか」の一行に書き換えます（state は task のまま）。`,
    `面に置くものは数行まで（表なら列は 3〜4、セルは短く）。依頼に返す形が書いてあっても、読む人が一瞥で読める量に絞ります。`,
    ...(mine.length ? [`この行にはあなたたちが前に置いたものがあります。同じことの新しい結果なら、足さずに panel_edit でそれを書き換えます（view も変えてよい）。並べて残しません：`, ...mine.map((p) => `- ${p.id}（${p.view}、${p.by}、rev ${p.rev}）：${clip(textOf(p.data).split("\n")[0], 60)}`)] : []),
    ...(focus ? ["人のいま（受け持ったときのもの）：", ...focus.lines(board)] : []),
  ].filter(Boolean).join("\n");
}
