// 流し込み係：パネルの source（shell コマンド）を走らせ、結果をそのパネルのデータとして画面に渡す。
// 走らせるのは人が許可したもの（sourceApproved）だけ。結果は操作ログに積まない（動いて変わる外の様子なので、
// 定義＝source だけをログに持ち、中身はその都度とり直す）
// 送り出しも受け持つ：パネルの send（shell コマンド）に、人が送った入力を標準入力で渡す。入ってくる向きと出ていく向きで一対
import { exec as nodeExec } from "node:child_process";
import { sourceApproved, sendApproved } from "./board.js";

const LIMIT = 1024 * 1024;
export const SEND_LIMIT = 100 * 1024;

// 送る入力を標準入力の文字列にする：文字列はそのまま、ほかは JSON（dyve put の読み方と対）。
// 空でなければ改行で終える（shell の read や、ファイルへの追記でそのまま一行になるように）
export function asStdin(input) {
  const s = input == null ? "" : typeof input === "string" ? input : JSON.stringify(input);
  return s && !s.endsWith("\n") ? s + "\n" : s;
}

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
    this.sent = new Map(); // id -> { running, at, error, out }（送り出しのいちばん最近の結果）
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

  // 画面に渡す形：{ id: { data?, at?, error?, running, approved, send? } }
  // approved は source の許可。send は送り出しのあるパネルだけ：{ approved, running?, at?, error?, out? }
  view() {
    const v = {};
    for (const p of this.store.board.list()) {
      if (!p.source && !p.send) continue;
      v[p.id] = { ...(p.source ? this.out.get(p.id) || {} : {}), approved: !!p.source && sourceApproved(this.store.board, p.id) };
      if (p.send) v[p.id].send = { ...(this.sent.get(p.id) || {}), approved: sendApproved(this.store.board, p.id) };
    }
    return v;
  }

  // 送れないなら理由を返す（送れるなら null）
  cantSend(id, input) {
    const p = this.store.board.get(id);
    if (!p?.send) return "そのパネルに送り出しがない";
    if (!sendApproved(this.store.board, id)) return "許可されたコマンドがない";
    if (this.offView(p.view)) return `view ${p.view} は「使わない」にしている`;
    if (this.sent.get(id)?.running) return "前に送ったものがまだ走っている";
    if (asStdin(input).length > SEND_LIMIT) return "送るものが大きすぎる";
    return null;
  }

  // 人が送った入力を、許可されたコマンドの標準入力に渡す。入力はコマンドの文字列に混ぜない。
  // 結果は操作ログに積まず画面に渡す（out は標準出力の最後の行）。うまくいったら、同じパネルの source を取り直す
  send(id, input) {
    if (this.cantSend(id, input)) return false;
    const p = this.store.board.get(id);
    this.sent.set(id, { running: true });
    this._changed(id);
    const child = this.exec(p.send.shell, { cwd: this.room, timeout: this.timeout, maxBuffer: LIMIT, shell: "/bin/sh", env: { ...process.env, DYVE_PANEL: id } }, (err, stdout, stderr) => {
      const at = new Date().toISOString();
      const last = (s) => String(s || "").trim().split("\n").at(-1).slice(0, 300);
      if (err) this.sent.set(id, { running: false, at, error: last(stderr) || last(err.message) || `終了コード ${err.code}` });
      else this.sent.set(id, { running: false, at, out: last(stdout) });
      this._changed(id);
      if (!err) this.run(id);
    });
    child?.stdin?.on?.("error", () => {}); // 標準入力を読まずに終わるコマンドでも落ちない
    child?.stdin?.end(asStdin(input));
    return true;
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
