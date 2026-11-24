// 記録：追記だけのログ（JSON Lines）。一件は { seq, at, kind, ...中身 }
// 立てるときにファイルを頭から読み、当て直していまの状態を作る。file を渡さなければメモリだけで持つ（テスト用）
import fs from "node:fs";
import path from "node:path";
import { KINDS, empty, step } from "./state.js";

export class Log {
  constructor(file = null) {
    this.file = file;
    this.state = empty();
    this.skipped = 0; // 読めなかった行の数（書きかけなど）。消さずに残し、飛ばして読む
    this.listeners = new Set();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const r = parse(line);
      if (r && r.seq > this.state.seq) step(this.state, r);
      else this.skipped++;
    }
    // 書きかけの行で終わっていたら、次の一件がその続きにならないように改行だけ足す
    if (raw && !raw.endsWith("\n")) fs.appendFileSync(file, "\n");
  }

  // 一件足す。通し番号と時刻はここで振る。足りないものは例外にする（呼ぶのは dyve の中だけ）
  add(kind, body = {}) {
    if (!Object.hasOwn(KINDS, kind)) throw new Error(`知らない種類：${kind}`);
    const record = { seq: this.state.seq + 1, at: new Date().toISOString(), kind, ...KINDS[kind](body) };
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    step(this.state, record);
    for (const fn of this.listeners) fn(record);
    return record;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function parse(line) {
  try {
    const r = JSON.parse(line);
    return r && Number.isInteger(r.seq) && typeof r.kind === "string" && typeof r.at === "string" ? r : null;
  } catch {
    return null;
  }
}
