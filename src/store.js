// 操作ログを JSON Lines で一行ずつ追記する。ボードは起動時にこれを当て直して作る。
// file を渡さなければメモリだけで持つ（テスト用）
import fs from "node:fs";
import path from "node:path";
import { Board } from "./board.js";

export class Store {
  constructor(file = null) {
    this.file = file;
    let log = [];
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        log = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      }
    }
    this.board = new Board(log);
    this.listeners = new Set();
  }

  // meta：操作に添えて聞き手に渡すもの（MCP のどの行のセッションから来たか、など）。操作ログには書かない
  apply(input, meta = {}) {
    const r = this.board.apply(input);
    if (r.ok) {
      if (this.file) fs.appendFileSync(this.file, JSON.stringify(r.op) + "\n");
      for (const fn of this.listeners) fn(r.op, meta);
    }
    return r;
  }

  onOp(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
