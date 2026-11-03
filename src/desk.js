// 机：ボード（操作ログのファイル）を切り替える。同じディレクトリの *.jsonl が一枚ずつのボード。
// 新しいボードにしても前のログは消さない（落とさない）。起こし係は一度に一枚ぶんだけ動かす
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";

const NAME = /^[\w.-]{1,80}$/;

export class Desk {
  // file：はじめに開くボード。wake(store)：そのボードの起こし係を作る（なければ null）
  constructor({ file, wake = () => null, now = () => new Date() }) {
    this.dir = path.dirname(path.resolve(file));
    this.wake = wake;
    this.now = now;
    this.cur = null;
    this._open(path.resolve(file));
  }

  get store() { return this.cur.store; }
  get waker() { return this.cur.waker; }

  current() {
    return path.basename(this.cur.store.file, ".jsonl");
  }

  list() {
    fs.mkdirSync(this.dir, { recursive: true });
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return { name: f.slice(0, -6), bytes: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  open(name) {
    if (!NAME.test(name)) throw new Error("ボードの名前が正しくない");
    const file = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`そのボードはない：${name}`);
    if (file === this.cur.store.file) return this.cur;
    return this._open(file);
  }

  create() {
    const stamp = this.now().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    let name = `board-${stamp}`;
    for (let i = 2; fs.existsSync(path.join(this.dir, `${name}.jsonl`)); i++) name = `board-${stamp}-${i}`;
    const file = path.join(this.dir, `${name}.jsonl`);
    fs.writeFileSync(file, "");
    return this._open(file);
  }

  _open(file) {
    this.cur?.waker?.stop();
    const store = new Store(file);
    const waker = this.wake(store);
    this.cur = { store, waker };
    waker?.start();
    return this.cur;
  }

  stop() {
    this.cur?.waker?.stop();
  }
}
