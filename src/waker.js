// 起こし係：発言が来て間があいたらマネージャを起こし、仕事が置かれたら控室のエージェントを起こす。
// 同じ仕事を同時に二つ走らせない。マネージャも一度に一人だけ。
import { isPerson, hasAiAnswer } from "./board.js";

export const NAMES = ["アリス", "ボブ", "キャロル", "デイブ", "エレン", "フランク"];

export class Waker {
  constructor({ store, spawn, pause = 4000, slots = 3, names = NAMES }) {
    this.store = store;
    this.spawn = spawn;
    this.pause = pause;
    this.slots = slots;
    this.names = names;
    this.manager = null; // { since, startedAt, handle }
    this.again = false;
    this.timer = null;
    this.running = new Map(); // taskId -> { name, startedAt, handle }
    this.tried = new Map(); // taskId -> 起こしたときの rev（同じ形の仕事で二度起こさない）
    this.listeners = new Set();
    const mine = store.board.log.filter((op) => op.by === "manager");
    this.cutoff = mine.length ? mine.at(-1).seq : 0;
  }

  start() {
    this.off = this.store.onOp((op) => this._onOp(op));
    if (this._unreadSays()) this._schedule();
    this._fill();
    return this;
  }

  stop() {
    this.off?.();
    clearTimeout(this.timer);
    this.manager?.handle.kill();
    for (const r of this.running.values()) r.handle.kill();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status() {
    return {
      manager: this.manager ? { since: this.manager.since, startedAt: this.manager.startedAt } : null,
      waitingManager: !!this.timer,
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

  _onOp(op) {
    if (op.type === "add" && op.panel.view === "say" && isPerson(op.by)) this._schedule();
    const r = this.running.get(op.panel.id);
    if (r && op.by !== r.name && (op.type === "drop" || (op.type === "edit" && "state" in op.panel && op.panel.state !== "task"))) {
      r.handle.kill(); // 人かマネージャが仕事を取り下げた
    }
    this._fill();
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
    const since = this.cutoff;
    this.cutoff = this.store.board.seq;
    const prompt = managerPrompt(since);
    const handle = this.spawn({ role: "manager", name: "manager", prompt });
    this.manager = { since, startedAt: new Date().toISOString(), handle };
    this._changed();
    handle.done.finally(() => {
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
      const handle = this.spawn({ role: "task", name, taskId: t.id, prompt: taskPrompt(board, t, name) });
      this.running.set(t.id, { name, startedAt: new Date().toISOString(), handle });
      changed = true;
      handle.done.then((res) => {
        this.running.delete(t.id);
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

  _pickName(wanted) {
    const busy = new Set([...this.running.values()].map((r) => r.name));
    // 名前を呼ばれた相手が働いているなら、空くまで待つ
    if (wanted && this.names.includes(wanted)) return busy.has(wanted) ? null : wanted;
    return this.names.find((n) => !busy.has(n));
  }
}

export function managerPrompt(since) {
  return [
    `ボードに新しい発言があります（seq ${since} より後）。`,
    `board_read を since: ${since} で呼んで読み、あなたの定義どおりに整えてください。`,
    "終わったら何も言わずに終えてください。人への返事はボードに置くものだけです。",
  ].join("\n");
}

export function taskPrompt(board, task, name) {
  const src = task.about ? board.get(task.about) : null;
  const text = typeof task.data === "string" ? task.data : task.data?.text ?? JSON.stringify(task.data);
  return [
    `あなたは控室のタスクエージェント「${name}」です。ボードの仕事 ${task.id} を受け持ちました。`,
    `仕事：${text}`,
    src ? `元の発言（${src.id}）：${typeof src.data === "string" ? src.data : JSON.stringify(src.data)}` : "",
    `結果は about: "${task.id}" でボードに置き、終わったら仕事 ${task.id} の state を done にしてください。`,
  ].filter(Boolean).join("\n");
}
