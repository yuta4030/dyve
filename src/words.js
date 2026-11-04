// 辞書：音声認識が聞き違える言葉と、その書き方。全部のボードで共通で、追記だけのログ（words.jsonl）を当て直して作る。
// 人も AI も足せる。AI は人が書いた項目を変えられず、人が消した言葉を足し直せない
import fs from "node:fs";
import path from "node:path";
import { isPerson } from "./board.js";

const refuse = (code, message) => ({ ok: false, code, message });
const clean = (s) => (typeof s === "string" ? s.trim() : "");

export class Words {
  constructor(file) {
    this.file = file;
    this.log = [];
    this.items = new Map(); // heard -> { heard, write, when?, by, seq }
    this.dropped = new Set(); // 人が消した言葉
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this._commit(JSON.parse(line));
        } catch {}
      }
    }
  }

  get seq() {
    return this.log.length;
  }

  list() {
    return [...this.items.values()];
  }

  since(seq) {
    return this.list().filter((w) => w.seq > seq);
  }

  add({ by, heard, write, when, reason }, now = new Date()) {
    heard = clean(heard);
    write = clean(write);
    if (!heard || !write || heard.length > 60 || write.length > 60) return refuse("invalid", "heard と write は 60 字までの言葉");
    if (heard === write) return refuse("invalid", "heard と write が同じ");
    if (when != null && (typeof when !== "string" || when.length > 200)) return refuse("invalid", "when は 200 字までの文");
    const person = isPerson(by);
    if (!person && !clean(reason)) return refuse("invalid", "AI の操作は reason を持つ");
    if (!person && isPerson(this.items.get(heard)?.by)) return refuse("forbidden", "人が書いた項目は人だけが変えられる");
    if (!person && this.dropped.has(heard)) return refuse("forbidden", "人が消した言葉は足し直せない");
    return this._write({ at: now.toISOString(), by, type: "add", heard, write, ...(clean(when) ? { when: clean(when) } : {}), ...(reason ? { reason } : {}) });
  }

  drop({ by, heard, reason }, now = new Date()) {
    heard = clean(heard);
    if (!this.items.has(heard)) return refuse("not_found", "その言葉はない");
    if (!isPerson(by)) return refuse("forbidden", "消すのは人だけ");
    return this._write({ at: now.toISOString(), by, type: "drop", heard, ...(reason ? { reason } : {}) });
  }

  _write(entry) {
    const op = { seq: this.seq + 1, ...entry };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(op) + "\n");
    }
    this._commit(op);
    return { ok: true, op };
  }

  _commit(op) {
    this.log.push(op);
    if (op.type === "add") {
      this.items.set(op.heard, { heard: op.heard, write: op.write, ...(op.when ? { when: op.when } : {}), by: op.by, seq: op.seq });
      if (isPerson(op.by)) this.dropped.delete(op.heard);
    } else if (op.type === "drop") {
      this.items.delete(op.heard);
      if (isPerson(op.by)) this.dropped.add(op.heard);
    }
  }
}

export const wordLine = (w) => `- ${w.heard} → ${w.write}${w.when ? `（${w.when}）` : ""}`;
