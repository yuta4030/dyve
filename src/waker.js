// 起こし係：発言が来たら清書係に渡し、間があいたらマネージャを起こし、仕事が置かれたら控室のエージェントを起こす。
// 同じ仕事を同時に二つ走らせない。清書係もマネージャも一度に一人だけ。
import path from "node:path";
import { isPerson, hasAiAnswer, STAFF } from "./board.js";

// 起こしっぱなしの会話を起こし直す目安：流し込んだ数と、あいた時間（キャッシュの持ちは 1 時間）。
// 毎回起こし直すと前置きの一部（約 7 千トークン）が毎回キャッシュに書き直しになるので、清書係もマネージャも会話を続ける。
// 会話は伸びるので、目安を超えたら起こし直す。マネージャの引き継ぎは「いまの要点」パネルが持つ
const TURNS = { scribe: 50, manager: 20 };
const IDLE = 55 * 60 * 1000;
const CONTEXT = 5;
const SUMMARY_MAX = 15;

export const NAMES = ["アリス", "ボブ", "キャロル", "デイブ", "エレン", "フランク"];

export class Waker {
  // session：清書係の会話を開く関数（なければ清書係を置かない）
  // integrate：開発の提案を人が受け入れたら呼ぶ（{ board, taskId } -> { branch, into, commit, cleaned }）
  constructor({ store, spawn, session = null, integrate = null, pause = 4000, scribePause = 1000, slots = 3, names = NAMES }) {
    this.store = store;
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
    this.manager = null; // { since, startedAt, handle }
    this.again = false;
    this.timer = null;
    this.running = new Map(); // taskId -> { name, startedAt, handle }
    this.tried = new Map(); // taskId -> 起こしたときの rev（同じ形の仕事で二度起こさない）
    this.direct = new Map(); // 名前 -> { says: [発言の id], timer }（人がアイコンで宛てた発言。間があくか、相手の仕事が終わったら渡す）
    this.listeners = new Set();
    const last = (by) => store.board.log.filter((op) => op.by === by).at(-1)?.seq ?? 0;
    this.cutoff = last("manager");
    this.scribeCutoff = Math.max(last("scribe"), this.cutoff);
  }

  start() {
    this.off = this.store.onOp((op) => this._onOp(op));
    if (this.session && this._says(this.scribeCutoff).length) this._scheduleScribe();
    if (this._unreadSays()) this._schedule();
    this._fill();
    return this;
  }

  stop() {
    this.off?.();
    clearTimeout(this.timer);
    clearTimeout(this.scribeTimer);
    for (const d of this.direct.values()) clearTimeout(d.timer);
    for (const c of Object.values(this.convs)) c.s.kill();
    this.manager?.handle.kill();
    for (const r of this.running.values()) r.handle.kill();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status() {
    return {
      scribe: this.scribeBusy,
      manager: this.manager ? { since: this.manager.since, startedAt: this.manager.startedAt } : null,
      waitingManager: !!this.timer || this.afterScribe,
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
    if (this.integrate && isPerson(op.by) && op.type === "edit" && op.panel.state === "done") this._accepted(op.panel.id);
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
  }

  // 人が提案を受け入れた。それが開発の仕事の提案なら、ブランチを取り込む
  _accepted(id) {
    const board = this.store.board;
    const prev = board.history(id).slice(0, -1).reverse().find((o) => "state" in o.panel)?.panel.state;
    if (prev !== "proposal") return;
    let t = board.get(id);
    while (t && !(t.view === "task" && t.data?.write === true)) t = t.about ? board.get(t.about) : null;
    if (!t) return;
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
    // 人が手を入れた発言は直さない
    const fresh = this._says(since).filter((p) => p.rev === p.seq && !p.pinned).slice(-10);
    if (!fresh.length) return this._scribeDone();
    const { c, first } = this._conv("scribe");
    const before = first ? this.store.board.list().filter((p) => p.view === "say" && isPerson(p.by) && p.seq <= since).slice(-CONTEXT) : [];
    this.scribeBusy = true;
    this._changed();
    const res = await c.s.send(scribePrompt(fresh, before));
    this._count(res);
    if (c.s.quota) this.quota = c.s.quota;
    c.turns += fresh.length;
    c.lastAt = Date.now();
    this.scribeBusy = false;
    this._scribeDone();
  }

  // 役ごとの会話。死んでいたり、伸びすぎたり、あきすぎたりしたら起こし直す
  _conv(role) {
    const now = Date.now();
    const c = this.convs[role];
    if (c && c.s.alive && c.turns < TURNS[role] && now - c.lastAt <= IDLE) return { c, first: false };
    c?.s.kill();
    this.convs[role] = { s: this.session({ role, name: role }), turns: 0, lastAt: now };
    return { c: this.convs[role], first: true };
  }

  _scribeDone() {
    if (this.scribeAgain) {
      this.scribeAgain = false;
      this._scheduleScribe();
    }
    if (this.afterScribe && !this.scribeBusy && !this.scribeTimer) {
      this.afterScribe = false;
      if (!this.manager) this._wakeManager();
    }
    this._changed();
  }

  _unreadSays() {
    return this.store.board.list().some((p) => p.view === "say" && isPerson(p.by) && p.seq > this.cutoff);
  }

  // 間があいたら起こす。走っているあいだに来た発言は、終わったあとにまとめて読ませる
  _schedule() {
    if (this.manager) {
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
    const since = this.cutoff;
    this.cutoff = this.store.board.seq;
    const prompt = managerPrompt(since, this.store.board, this.runningTasks());
    let handle;
    if (this.session) {
      const { c } = this._conv("manager");
      c.turns++;
      handle = { done: c.s.send(prompt).finally(() => { c.lastAt = Date.now(); if (c.s.quota) this.quota = c.s.quota; }), kill: () => c.s.kill() };
    } else {
      handle = this.spawn({ role: "manager", name: "manager", prompt });
    }
    this.manager = { since, startedAt: new Date().toISOString(), handle };
    this._changed();
    handle.done.then((res) => this._count(res)).finally(() => {
      this.manager = null;
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
      const name = this._pickName(t.data?.to);
      if (!name) continue;
      this.tried.set(t.id, t.rev);
      // data.write が付いた仕事：true は開発（仕事ごとの worktree の中で）、"panels" はパネルの仕事（利用者のパネル置き場で）
      const role = t.data?.write === true ? "dev" : t.data?.write === "panels" ? "panels" : "task";
      const handle = this.spawn({ role, name, taskId: t.id, board: this.board, prompt: taskPrompt(board, t, name) });
      this.running.set(t.id, { name, startedAt: new Date().toISOString(), handle });
      changed = true;
      handle.done.then((res) => {
        this._count(res);
        this.running.delete(t.id);
        if (this.direct.get(name)?.says.length) this._flushDirect(name);
        const cur = this.store.board.get(t.id);
        if (cur && cur.state === "task" && !hasAiAnswer(this.store.board, t.id)) {
          this.store.apply({
            by: "board",
            type: "add",
            panel: { view: "text", about: t.id, data: `${name} は結果を置かずに終わりました${res?.error ? `（${res.error}）` : ""}` },
            reason: "仕事が落ちたままにならないように",
          });
        }
        this._fill();
        this._changed();
      });
    }
    if (changed) this._changed();
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
      reason: `人が${name}に宛てて話したことを、そのまま${name}に渡す`,
    });
  }

  _pickName(wanted) {
    const busy = new Set([...this.running.values()].map((r) => r.name));
    // 名前を呼ばれた相手が働いているなら、空くまで待つ
    if (wanted && this.names.includes(wanted)) return busy.has(wanted) ? null : wanted;
    return this.names.find((n) => !busy.has(n));
  }
}

const textOf = (d) => (typeof d === "string" ? d : d?.text ?? JSON.stringify(d));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// その人がいちばん最近受け持った仕事：宛てられた仕事か、結果を置いた仕事
function lastTaskOf(board, name) {
  let best = null;
  for (const p of board.list()) {
    const t = p.view === "task" && p.data?.to === name ? p : p.by === name && p.about ? board.get(p.about) : null;
    if (t?.view === "task" && (!best || t.seq > best.seq)) best = t;
  }
  return best;
}

// 清書係への一通。新しい発言だけを直させ、直前の発言は文脈として渡す（会話の頭のときだけ）
export function scribePrompt(fresh, before = []) {
  return [
    before.length ? "文脈（前の発言。直さない）：" : "",
    ...before.map((p) => `- ${p.id}：${textOf(p.data)}`),
    "新しい発言（直すものだけ panel_edit。rev を付ける）：",
    ...fresh.map((p) => `- ${p.id}（rev ${p.rev}）：${textOf(p.data)}`),
  ].filter(Boolean).join("\n");
}

// マネージャへの指示。読むものをはじめから渡して、board_read の往復を減らす
export function managerPrompt(since, board = null, running = []) {
  const head = `ボードに新しい動きがあります（since: ${since}、seq ${since} より後）。読むものは下にそろえてあります。足りないときだけ board_read を使ってください。`;
  const tail = "終わったら何も言わずに終えてください。人への返事はボードに置くものだけです。";
  if (!board) return [head, tail].join("\n");
  const all = board.list();
  const summary = all.filter((p) => p.by === "manager" && p.view === "summary").at(-1);
  const busy = new Set(running);
  const tasks = all.filter((p) => p.state === "task" || (p.view === "task" && p.rev > since));
  const says = all.filter((p) => p.view === "say" && isPerson(p.by) && p.seq > since);
  const placed = all.filter((p) => p.rev > since && !isPerson(p.by) && !STAFF.has(p.by) && p.by !== "scribe");
  const lines = [head, ""];
  lines.push(summary ? `## いまの要点（${summary.id}、rev ${summary.rev}）` : "## いまの要点（まだない）");
  if (summary) {
    lines.push(JSON.stringify(summary.data));
    // 長くなりすぎたら、数えて知らせる（定義だけでは守られにくい）
    const n = ["points", "decided", "open"].reduce((a, k) => a + (Array.isArray(summary.data?.[k]) ? summary.data[k].length : 0), 0);
    if (n > SUMMARY_MAX) lines.push(`（いま ${n} 項目あります。今回の書き換えで ${SUMMARY_MAX} 項目までに減らしてください。済んだ話・言い換えの重複・細かい感想から消します）`);
  }
  const topics = all.filter((p) => p.view === "topic");
  lines.push("", "## 話題");
  if (!topics.length) lines.push("（まだない）");
  for (const t of topics) {
    const n = all.filter((p) => p.about === t.id && p.view === "task").length;
    lines.push(`- ${t.id}${t.state === "done" ? "［済み］" : ""}${t.pinned ? "［ピン留め］" : ""}：${clip(typeof t.data === "string" ? t.data : t.data?.title ?? textOf(t.data), 60)}（仕事 ${n}）`);
  }
  lines.push("", "## 仕事");
  if (!tasks.length) lines.push("（なし）");
  for (const t of tasks) lines.push(`- ${t.id}［${t.state}${busy.has(t.id) ? "・動いている" : ""}${board.get(t.about)?.view === "topic" ? `・話題 ${t.about}` : ""}］${t.data?.to ? `${t.data.to}：` : ""}${clip(textOf(t.data), 120)}`);
  lines.push("", "## 新しい発言（清書済み）");
  if (!says.length) lines.push("（なし）");
  for (const p of says) lines.push(`- ${p.id}${p.to ? `（${p.to}宛て。ボードがそのまま${p.to}に渡すので、取り次がない）` : ""}：${textOf(p.data)}`);
  if (placed.length) {
    lines.push("", "## 新しく置かれたもの");
    for (const p of placed) lines.push(`- ${p.id}（${p.by}${p.about ? `、${p.about} について` : ""}${p.state ? `、${p.state}` : ""}）：${clip(textOf(p.data), 300)}`);
  }
  lines.push("", tail);
  return lines.join("\n");
}

export function taskPrompt(board, task, name) {
  // 元の発言：data.from があればそれ、なければ about の先が発言のとき
  const from = Array.isArray(task.data?.from) ? task.data.from.map((id) => board.get(id)).filter(Boolean) : [];
  const above = task.about ? board.get(task.about) : null;
  const srcs = from.length ? from : above?.view === "say" ? [above] : [];
  const topic = above?.view === "topic" ? above : null;
  const text = typeof task.data === "string" ? task.data : task.data?.text ?? JSON.stringify(task.data);
  const prev = task.data?.after ? board.get(task.data.after) : null;
  const prevOut = prev ? board.list().filter((p) => p.about === prev.id && p.by === name).slice(-5) : [];
  return [
    `あなたは控室のタスクエージェント「${name}」です。ボードの仕事 ${task.id} を受け持ちました。`,
    task.data?.direct ? `人があなたに直接話しかけました。言われたことにそのまま応えてください。まず一、二行の短い返事を about: "${task.id}" の text（data は文字列）で置いてください。人のトークに返事として出ます。中身の結果は、そのあとに置きます。` : "",
    task.data?.direct ? `言われたこと：${text}` : `仕事：${text}`,
    prev ? `前にあなたが受け持った仕事（${prev.id}）：${clip(textOf(prev.data), 300)}` : "",
    ...prevOut.map((p) => `- そのときあなたが置いたもの（${p.id}）：${clip(textOf(p.data), 300)}`),
    topic ? `話題（${topic.id}）：${typeof topic.data === "string" ? topic.data : topic.data?.title ?? textOf(topic.data)}` : "",
    ...(task.data?.direct ? [] : srcs.map((p) => `元の発言（${p.id}）：${textOf(p.data)}`)),
    `結果は about: "${task.id}" でボードに置き、終わったら仕事 ${task.id} の state を done にしてください。`,
    "ほかにも、人が一瞬で状況をつかむのに役立つパネルは、about なしで自由に新しく置いてかまいません。",
  ].filter(Boolean).join("\n");
}
