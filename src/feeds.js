// 流し込み係：パネルの source（shell コマンド）を走らせ、結果をそのパネルのデータとして画面に渡す。
// 走らせるのは人が許可したもの（sourceApproved）だけ。結果は操作ログに積まない（動いて変わる外の様子なので、
// 定義＝source だけをログに持ち、中身はその都度とり直す）
import { exec as nodeExec } from "node:child_process";
import { sourceApproved } from "./board.js";

const LIMIT = 1024 * 1024;

// 標準出力を JSON として読めればその形で、読めなければ文字列で
export function parseOutput(out) {
  const text = String(out).trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class Feeds {
  // exec(cmd, opts, cb)：差し替えられる（テストでは偽物）
  // offView(view)：人が「使わない」にした view のコマンドは走らせない
  constructor({ store, room = process.cwd(), exec = nodeExec, timeout = 20000, offView = () => false }) {
    this.store = store;
    this.offView = offView;
    this.room = room;
    this.exec = exec;
    this.timeout = timeout;
    this.out = new Map(); // id -> { data, at, error, running }
    this.timers = new Map(); // id -> { key, timer }
    this.listeners = new Set();
  }

  start() {
    this.off = this.store.onOp(() => this.sync());
    this.sync();
    return this;
  }

  stop() {
    this.off?.();
    for (const t of this.timers.values()) clearInterval(t.timer);
    this.timers.clear();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed(id) {
    for (const fn of this.listeners) fn({ id, ...this.view()[id] });
  }

  // 画面に渡す形：{ id: { data?, at?, error?, running, approved } }
  view() {
    const v = {};
    for (const p of this.store.board.list()) {
      if (!p.source) continue;
      const o = this.out.get(p.id) || {};
      v[p.id] = { ...o, approved: sourceApproved(this.store.board, p.id) };
    }
    return v;
  }

  // 許可されたコマンドの見張りを、ボードの今に合わせる。コマンドか間隔が変わったら走らせ直す
  sync() {
    const want = new Map();
    for (const p of this.store.board.list()) {
      if (p.source && sourceApproved(this.store.board, p.id) && !this.offView(p.view)) want.set(p.id, JSON.stringify(p.source));
    }
    for (const [id, t] of this.timers) {
      if (want.get(id) !== t.key) {
        clearInterval(t.timer);
        this.timers.delete(id);
      }
    }
    for (const [id, key] of want) {
      if (this.timers.has(id)) continue;
      const { every } = JSON.parse(key);
      this.timers.set(id, { key, timer: every ? setInterval(() => this.run(id), every * 1000) : null });
      this.run(id);
    }
  }

  // 一度走らせる（人が「今すぐ更新」を押したときも）
  run(id) {
    const p = this.store.board.get(id);
    if (!p?.source || !sourceApproved(this.store.board, id) || this.offView(p.view)) return false;
    const prev = this.out.get(id) || {};
    if (prev.running) return true;
    this.out.set(id, { ...prev, running: true });
    this._changed(id);
    this.exec(p.source.shell, { cwd: this.room, timeout: this.timeout, maxBuffer: LIMIT, shell: "/bin/sh" }, (err, stdout, stderr) => {
      const at = new Date().toISOString();
      if (err) {
        const why = String(stderr || err.message).trim().split("\n").at(-1) || `終了コード ${err.code}`;
        this.out.set(id, { ...prev, running: false, at, error: why });
      } else {
        this.out.set(id, { data: parseOutput(stdout), running: false, at });
      }
      this._changed(id);
    });
    return true;
  }
}
