// 机：ボード（操作ログのファイル）を切り替える。同じディレクトリの *.jsonl が一枚ずつのボード。
// 新しいボードにしても前のログは消さない（落とさない）。起こし係は一度に一枚ぶんだけ動かす
// 名前（ファイル名）は id なので変えない。人が付ける呼び名は boards.json に持つ。しまったボードは archive/ へ移すだけで、戻せる
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";

const NAME = /^[\w.-]{1,80}$/;
const ARCHIVE = "archive";

const textOf = (d) => (typeof d === "string" ? d : typeof d?.text === "string" ? d.text : "");

// 管理の絵に使う見本：view ごとのいちばん新しいデータ。大きすぎるものは使わない
const SAMPLE_MAX = 20000;
export const fitsSample = (d) => d != null && JSON.stringify(d).length <= SAMPLE_MAX;
export function samplesOf(board) {
  const out = {};
  for (const p of board.list()) if (p.view !== "layout" && fitsSample(p.data)) out[p.view] = p.data;
  return out;
}

// 一覧で見分けるための中身の様子。ボードのログから導く
export function summarize(board) {
  const ps = board.list();
  const views = {};
  for (const p of ps) if (p.view !== "layout") views[p.view] = (views[p.view] || 0) + 1;
  const sum = ps.filter((p) => p.view === "summary").at(-1);
  return {
    panels: ps.filter((p) => p.view !== "layout").length,
    first: textOf(ps.find((p) => p.view === "say")?.data).slice(0, 80),
    topics: ps.filter((p) => p.view === "topic").map((p) => (typeof p.data === "string" ? p.data : p.data?.title)).filter(Boolean).slice(-6).reverse(),
    points: (Array.isArray(sum?.data?.points) ? sum.data.points : []).map(textOf).filter(Boolean).slice(0, 3),
    tasks: ps.filter((p) => p.state === "task").length,
    waiting: ps.filter((p) => p.state === "proposal").length,
    views,
    samples: samplesOf(board),
    last: board.log.at(-1)?.at ?? null,
  };
}

export class Desk {
  // file：はじめに開くボード。wake(store)：そのボードの起こし係を作る（なければ null）。feed(store)：流し込み係（なければ null）
  constructor({ file, wake = () => null, feed = () => null, now = () => new Date() }) {
    this.dir = path.dirname(path.resolve(file));
    this.wake = wake;
    this.feed = feed;
    this.now = now;
    this.cur = null;
    this.seen = new Map(); // ファイル -> { key, summary }（変わっていないログは読み直さない）
    this._open(path.resolve(file));
  }

  get store() { return this.cur.store; }
  get waker() { return this.cur.waker; }
  get feeds() { return this.cur.feeds; }

  current() {
    return path.basename(this.cur.store.file, ".jsonl");
  }

  list() {
    return this._scan(this.dir);
  }

  archived() {
    return this._scan(path.join(this.dir, ARCHIVE));
  }

  _scan(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const titles = this._titles();
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = path.join(dir, f), st = fs.statSync(file), name = f.slice(0, -6);
        const { last, ...sum } = this._summary(file, st);
        return { name, title: titles[name] ?? null, bytes: st.size, at: last ?? st.mtime.toISOString(), ...sum };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  _summary(file, st) {
    const key = `${st.size}-${st.mtimeMs}`, hit = this.seen.get(file);
    if (hit?.key === key) return hit.summary;
    let summary;
    try {
      summary = summarize(new Store(file).board);
    } catch {
      summary = { panels: 0, first: "", topics: [], points: [], tasks: 0, waiting: 0, views: {}, samples: {}, last: null, broken: true };
    }
    this.seen.set(file, { key, summary });
    return summary;
  }

  _titlesFile() {
    return path.join(this.dir, "boards.json");
  }

  _titles() {
    try {
      return JSON.parse(fs.readFileSync(this._titlesFile(), "utf8")).titles ?? {};
    } catch {
      return {};
    }
  }

  titleOf(name) {
    return this._titles()[name] ?? null;
  }

  // 呼び名を付ける（空なら外す）。しまったボードにも付けられる
  setTitle(name, title) {
    this._check(name);
    if (![this.dir, path.join(this.dir, ARCHIVE)].some((d) => fs.existsSync(path.join(d, `${name}.jsonl`)))) throw new Error(`そのボードはない：${name}`);
    const t = String(title ?? "").trim();
    if (t.length > 80) throw new Error("呼び名は 80 字まで");
    const titles = this._titles();
    if (t) titles[name] = t; else delete titles[name];
    fs.writeFileSync(this._titlesFile(), JSON.stringify({ titles }, null, 2) + "\n");
  }

  // しまう：archive/ へ移すだけ（ログは消さない）。いま開いているボードはしまえない
  archive(name) {
    this._check(name);
    if (name === this.current()) throw new Error("いま開いているボードはしまえない");
    const file = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`そのボードはない：${name}`);
    fs.mkdirSync(path.join(this.dir, ARCHIVE), { recursive: true });
    const to = path.join(this.dir, ARCHIVE, `${name}.jsonl`);
    if (fs.existsSync(to)) throw new Error(`しまった中に同じ名前のボードがある：${name}`);
    fs.renameSync(file, to);
  }

  restore(name) {
    this._check(name);
    const from = path.join(this.dir, ARCHIVE, `${name}.jsonl`);
    if (!fs.existsSync(from)) throw new Error(`しまったボードにない：${name}`);
    const to = path.join(this.dir, `${name}.jsonl`);
    if (fs.existsSync(to)) throw new Error(`同じ名前のボードがある：${name}`);
    fs.renameSync(from, to);
  }

  _check(name) {
    if (!NAME.test(name)) throw new Error("ボードの名前が正しくない");
  }

  open(name) {
    this._check(name);
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
    this.stop();
    const store = new Store(file);
    fs.appendFileSync(file, ""); // まだ何も書かれていないボードも一覧に出す
    const waker = this.wake(store), feeds = this.feed(store);
    this.cur = { store, waker, feeds };
    waker?.start();
    feeds?.start();
    return this.cur;
  }

  stop() {
    this.cur?.waker?.stop();
    this.cur?.feeds?.stop();
  }
}
