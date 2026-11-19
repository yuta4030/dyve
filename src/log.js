// 記録：追記だけのログ（JSON Lines）。一件は { seq, at, kind, ...中身 }
// 立ち上げるときにファイルを頭から読み、当て直していまの状態を作る。file を渡さなければメモリだけで持つ（テスト用）
import fs from "node:fs";
import path from "node:path";
import { KINDS, empty, step } from "./state.js";

export class Log {
  constructor(file = null) {
    this.file = file;
    this.state = empty();
    this.skipped = 0; // 読めなかった行の数（書きかけなど）。消さずに残し、飛ばして読む
    this.listeners = new Set();
    this.anews = new Set();
    this.era = 0; // 新しく始めた回数（前の記録のために始めた仕事が、新しい記録に書かないように見分ける）
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

  // 一件足す。通し番号と時刻はここで振る
  add(kind, body = {}) {
    const k = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
    if (!k) return { ok: false, code: "invalid", message: `知らない種類：${kind}` };
    let fields;
    try {
      fields = k.make(body);
    } catch (e) {
      return { ok: false, code: "invalid", message: e.message };
    }
    const record = { seq: this.state.seq + 1, at: new Date().toISOString(), kind, ...fields };
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    step(this.state, record);
    for (const fn of this.listeners) fn(record);
    return { ok: true, record };
  }

  // 新しく始める：いまの記録を隣に退けて（消さない）、空の記録から始め直す。退けた先を返す（メモリだけなら null）。
  // 前の記録は読み直さない。onAnew で受けた部品は、前の記録のために持っていたものを捨てる
  anew(now = new Date()) {
    let moved = null;
    if (this.file && fs.existsSync(this.file)) {
      const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
      const ext = path.extname(this.file), base = this.file.slice(0, this.file.length - ext.length);
      moved = `${base}-${stamp}${ext}`;
      for (let i = 2; fs.existsSync(moved); i++) moved = `${base}-${stamp}-${i}${ext}`;
      fs.renameSync(this.file, moved);
    }
    this.state = empty();
    this.skipped = 0;
    this.era++;
    for (const fn of this.anews) fn(moved);
    return moved;
  }

  onAnew(fn) {
    this.anews.add(fn);
    return () => this.anews.delete(fn);
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
