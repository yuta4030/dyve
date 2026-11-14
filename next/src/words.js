// 辞書：音声入力が聞き違える言葉と、その書き方。利用者の置き場の words.jsonl に追記だけで持ち、当て直して作る。
// 一件は { seq, at, by, heard, write, when? }。by は "人"（ファイルに手で書いたもの）か "係"。同じ heard はあとのものが勝つ。
// 係は、人が書いた言葉を書き換えない
import fs from "node:fs";
import path from "node:path";

const clean = (s) => (typeof s === "string" ? s.trim() : "");

export class Words {
  constructor(file = null) {
    this.file = file;
    this.seq = 0;
    this.items = new Map(); // heard -> { heard, write, when?, by }
    if (!file || !fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this._take(JSON.parse(line));
      } catch {}
    }
  }

  list() {
    return [...this.items.values()];
  }

  add({ by = "係", heard, write, when }) {
    heard = clean(heard);
    write = clean(write);
    when = clean(when);
    if (!heard || !write || heard.length > 60 || write.length > 60) return { ok: false, code: "invalid", message: "heard と write は 60 字までの言葉" };
    if (heard === write) return { ok: false, code: "invalid", message: "heard と write が同じ" };
    if (when.length > 200) return { ok: false, code: "invalid", message: "when は 200 字まで" };
    if (by !== "人" && this.items.get(heard)?.by === "人") return { ok: false, code: "forbidden", message: "人が書いた言葉は書き換えない" };
    const w = { seq: this.seq + 1, at: new Date().toISOString(), by, heard, write, ...(when ? { when } : {}) };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(w) + "\n");
    }
    this._take(w);
    return { ok: true, word: w };
  }

  _take(w) {
    if (!clean(w?.heard) || !clean(w?.write)) return;
    this.seq = Math.max(this.seq, Number(w.seq) || 0);
    this.items.set(w.heard, { heard: w.heard, write: w.write, ...(w.when ? { when: w.when } : {}), by: w.by === "人" ? "人" : "係" });
  }
}

export const wordLine = (w) => `- ${w.heard} → ${w.write}${w.when ? `（${w.when}）` : ""}`;
