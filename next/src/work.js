// 開発の作業場：役割「開発」のセッションは、部屋（git のリポジトリ）から切り出したセッションごとの worktree とブランチの中だけで書く。
// 取り込むかは人が決める（画面で「取り込む」を押す）。取り込みはマージコミットで、ぶつかったら取りやめて元に戻す
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const run = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lastLine = (e) => String(e.stderr || e.message).trim().split("\n").at(-1);
// 部屋に git の名前がなければ、マージコミットにだけ dyve の名前を使う（利用者の設定は書き換えない）
function who(room) {
  try {
    run(room, "config", "user.email");
    return [];
  } catch {
    return ["-c", "user.name=dyve", "-c", "user.email=dyve@localhost"];
  }
}

function isRepo(dir) {
  try {
    run(dir, "rev-parse", "--show-toplevel");
    return true;
  } catch {
    return false;
  }
}

export class Works {
  // room：部屋。dir：作業場を置くところ。部屋が git のリポジトリでなければ、開発は選べない（place が null）
  constructor({ log, room, dir }) {
    Object.assign(this, { log, room, dir });
    this.ok = isRepo(room);
  }

  place() {
    return this.ok ? this.dir : null;
  }

  // 新しいセッションの作業場の場所。名前は、そのセッションの id（これからできる記録の通し番号）と、取り違えないための乱数
  cwdFor(seq) {
    return path.join(this.dir, `s${seq}-${crypto.randomBytes(3).toString("hex")}`);
  }

  // 作業場のものか
  mine(x) {
    return !!x?.cwd && path.dirname(x.cwd) === path.resolve(this.dir);
  }

  branchOf(x) {
    return `dyve/${path.basename(x.cwd)}`;
  }

  // 作業場がなければ、部屋のいまの HEAD から切り出す（片付けたあとの続きも、同じ場所と同じ名前で切り出し直す。--resume は場所ごとなので）
  ensure(x) {
    if (fs.existsSync(path.join(x.cwd, ".git"))) return;
    const branch = this.branchOf(x);
    fs.mkdirSync(this.dir, { recursive: true });
    run(this.room, "worktree", "prune");
    let has = true;
    try { run(this.room, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); } catch { has = false; }
    try {
      if (has) run(this.room, "worktree", "add", x.cwd, branch);
      else run(this.room, "worktree", "add", "-b", branch, x.cwd, "HEAD");
    } catch (e) {
      throw new Error(`作業場を切り出せなかった：${lastLine(e)}`);
    }
  }

  // 作業場のありさま：部屋のいまのブランチより何コミット進んだか、コミットしていない変更があるか、変えたファイルの数。作業場がなければ gone
  status(x) {
    const branch = this.branchOf(x);
    let base = null;
    try { base = run(this.room, "rev-parse", "--abbrev-ref", "HEAD"); } catch {}
    let exists = true;
    try { run(this.room, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); } catch { exists = false; }
    if (!exists) return { branch, base, ahead: 0, dirty: false, files: 0, gone: true };
    const ahead = Number(run(this.room, "rev-list", "--count", `HEAD..${branch}`));
    const files = ahead ? run(this.room, "diff", "--name-only", `HEAD...${branch}`).split("\n").filter(Boolean).length : 0;
    const dirty = fs.existsSync(x.cwd) ? !!run(x.cwd, "status", "--porcelain") : false;
    return { branch, base, ahead, dirty, files, gone: !fs.existsSync(x.cwd) };
  }

  // ありさまを記録に置く（変わったときだけ）
  note(id) {
    const x = this.log.state.sessions.find((s) => s.id === id);
    if (!this.mine(x)) return;
    let w;
    try {
      w = this.status(x);
    } catch {
      return;
    }
    if (JSON.stringify(x.work) !== JSON.stringify(w)) this.log.add("work", { session: id, ...w });
  }

  // ターンが終わったら、ありさまを読む。済みに畳まれたとき、何も進んでいない作業場は片付ける（進んだものは消さない）
  start() {
    this.off = this.log.on((r) => {
      if (r.kind === "end" || r.kind === "fail") queueMicrotask(() => this.note(r.session));
      if (r.kind === "fold") queueMicrotask(() => this.tidy(r.session));
    });
    return this;
  }

  stop() {
    this.off?.();
  }

  tidy(id) {
    const x = this.log.state.sessions.find((s) => s.id === id);
    if (!this.mine(x) || x.running) return;
    try {
      const w = this.status(x);
      if (w.gone || w.ahead || w.dirty) return;
      this.remove(x);
    } catch {
      return;
    }
    this.note(id);
  }

  remove(x) {
    if (fs.existsSync(x.cwd)) run(this.room, "worktree", "remove", x.cwd);
    run(this.room, "branch", "-d", this.branchOf(x));
  }

  // 取り込む（画面の人が押したときだけ）。押されたときに、いまのありさまを確かめ直す。
  // 結果：merged（取り込んだ）・conflict（ぶつかったので元に戻した）・failed（ほかの理由で取り込めず、元に戻した）・dirty（コミットしていない変更が残っている）・nothing（取り込むものがない）
  integrate(id) {
    const x = this.log.state.sessions.find((s) => s.id === id);
    if (!this.mine(x)) return { ok: false, code: "not_found", message: "作業場のあるセッションではない" };
    if (x.running) return { ok: false, code: "conflict", message: "動いているあいだは取り込めない" };
    let w;
    try {
      w = this.status(x);
    } catch (e) {
      return { ok: false, code: "invalid", message: lastLine(e) };
    }
    const into = w.base;
    let out;
    if (w.dirty) out = { result: "dirty" };
    else if (!w.ahead) out = { result: "nothing" };
    else {
      try {
        run(this.room, ...who(this.room), "merge", "--no-ff", "-m", `取り込み：${w.branch}`, w.branch);
        out = { result: "merged", commit: run(this.room, "rev-parse", "--short", "HEAD") };
        try { this.remove(x); } catch {}
      } catch (e) {
        // ぶつかった（まとまらないファイルが残った）のか、ほかの理由で取り込めなかったのかを分ける。どちらも元に戻す
        let clash = false;
        try { clash = !!run(this.room, "diff", "--name-only", "--diff-filter=U"); } catch {}
        try { run(this.room, "merge", "--abort"); } catch {}
        out = { result: clash ? "conflict" : "failed", reason: lastLine(e) };
      }
    }
    const r = this.log.add("merge", { session: id, branch: w.branch, into, ...out });
    this.note(id);
    return { ok: true, ...r.record };
  }
}
