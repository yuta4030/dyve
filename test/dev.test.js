import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeArgs, claudeSpawner, updateApp, workspace, integrate, isAppOf, claudeMissing } from "../src/agents.js";
import { Store } from "../src/store.js";
import { Waker } from "../src/waker.js";

// 外にはつながず、手元に作った git リポジトリで試す
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-dev-"));
  const room = path.join(dir, "room");
  fs.mkdirSync(room);
  const git = (...a) => execFileSync("git", ["-C", room, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(room, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, room, git };
}

test("開発の道具：書けるが push はできない。控室は auto で動き、調べものはファイルを書き換えない", () => {
  const d = claudeArgs({ role: "dev", name: "アリス", prompt: "直して" }, "http://x", { task: "opus" });
  const allowed = d.slice(d.indexOf("--allowedTools") + 1);
  assert.ok(allowed.includes("Edit") && allowed.includes("Bash(node --test:*)") && allowed.includes("Bash(git commit:*)"));
  assert.ok(!allowed.some((t) => /push|Bash\)$|^Bash$/.test(t)));
  assert.ok(d.slice(d.indexOf("--disallowedTools") + 1).includes("Bash(git push:*)"));
  assert.equal(d[d.indexOf("--model") + 1], "opus");
  assert.equal(d[d.indexOf("--permission-mode") + 1], "auto");
  const t = claudeArgs({ role: "task", name: "ボブ", prompt: "調べて" }, "http://x");
  assert.equal(t[t.indexOf("--permission-mode") + 1], "auto");
  const denied = t.slice(t.indexOf("--disallowedTools") + 1, t.indexOf("--allowedTools"));
  assert.ok(denied.includes("Edit") && denied.includes("Write") && denied.includes("Bash(git push:*)"));
  assert.ok(!t.slice(t.indexOf("--allowedTools") + 1).includes("Edit"));
  const m = claudeArgs({ role: "manager", name: "manager", prompt: "整えて" }, "http://x");
  assert.ok(!m.includes("--permission-mode"));
});

test("開発の仕事は、仕事ごとの worktree とブランチで起こし、同じ仕事なら同じ作業場を使う", async () => {
  const { dir, room } = repo();
  const workDir = path.join(dir, "work");
  const ws = workspace({ room, workDir, taskId: "p7", now: new Date("2026-11-03T01:02:00Z") });
  assert.equal(ws.branch, "dyve/board-p7-20261103-0102");
  assert.equal(ws.base, "main");
  assert.ok(fs.existsSync(path.join(ws.dir, "a.txt")));
  assert.equal(workspace({ room, workDir, taskId: "p7" }).dir, ws.dir);
  assert.notEqual(workspace({ room, workDir, taskId: "p70" }).dir, ws.dir);
  // claude の代わりに true を起こし、作業場で起きたことと、指示に作業場が書かれたことを見る
  const logDir = path.join(dir, "logs");
  const spawn = claudeSpawner({ cmd: "true", room, staff: path.join(dir, "staff"), workDir, boardUrl: "http://x", logDir });
  const r = await spawn({ role: "dev", name: "アリス", taskId: "p7", prompt: "直して" }).done;
  assert.equal(r.code, 0);
  const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), "utf8");
  assert.match(log, new RegExp(`in ${ws.dir}`));
  assert.match(log, /ブランチ：dyve\/board-p7-/);
  // ボードが違えば、同じ id でも別の作業場
  assert.notEqual(workspace({ room, workDir, taskId: "p7", board: "other" }).dir, ws.dir);
  // git でない部屋なら、作業場を作れなかったと返す（落ちたままにしない）
  const bad = claudeSpawner({ cmd: "true", room: dir, staff: path.join(dir, "staff"), workDir, boardUrl: "http://x" });
  const e = await bad({ role: "dev", name: "ボブ", taskId: "p9", prompt: "x" }).done;
  assert.match(e.error, /作業場を作れませんでした/);
});

test("使う dyve を別の置き場に切り出し、人が決めたときだけ更新する", () => {
  const { dir, room, git } = repo();
  const app = path.join(dir, "app");
  const first = updateApp({ room, app });
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "a\n");
  fs.writeFileSync(path.join(room, "a.txt"), "b\n");
  git("commit", "-qam", "b");
  // 作る側が進んでも、使う側は更新するまで変わらない
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "a\n");
  const next = updateApp({ room, app });
  assert.equal(next.created, false);
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "b\n");
  fs.writeFileSync(path.join(app, "a.txt"), "local\n");
  assert.throws(() => updateApp({ room, app }), /手を入れた跡/);
});

test("部屋から切り出した dyve だけを部屋のコミットで更新する（npm などで入れた dyve には当てない）", () => {
  const { dir, room } = repo();
  const app = path.join(dir, "app");
  updateApp({ room, app });
  assert.equal(isAppOf({ room, app }), true);
  // git でない置き場（npm で入れたときなど）
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  assert.equal(isAppOf({ room, app: plain }), false);
  // 別のリポジトリ
  const other = repo();
  assert.equal(isAppOf({ room: other.room, app }), false);
});

test("claude が動かなければ、どうすればよいかを返す", () => {
  assert.equal(claudeMissing("claude", () => ({ status: 0 })), null);
  const enoent = claudeMissing("claude", () => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }));
  assert.match(enoent, /Claude Code（claude）が動きません（ENOENT）/);
  assert.match(enoent, /--no-agents/);
  assert.match(claudeMissing("claude", () => ({ status: 1 })), /動きません。/);
});

test("取り込む：マージコミットで取り込み、作業場とブランチを片付ける。ぶつかったら元に戻す", () => {
  const { dir, room, git } = repo();
  const workDir = path.join(dir, "work");
  assert.throws(() => integrate({ room, workDir, taskId: "p1" }), /見つからない/);
  const a = workspace({ room, workDir, taskId: "p1" });
  assert.throws(() => integrate({ room, workDir, taskId: "p1" }), /取り込むものがない/);
  fs.writeFileSync(path.join(a.dir, "b.txt"), "b\n");
  execFileSync("git", ["-C", a.dir, "add", "."]);
  execFileSync("git", ["-C", a.dir, "commit", "-qm", "b を足す"]);
  const r = integrate({ room, workDir, taskId: "p1" });
  assert.equal(r.into, "main");
  assert.equal(r.cleaned, true);
  assert.ok(fs.existsSync(path.join(room, "b.txt")));
  assert.match(git("log", "-1", "--format=%s"), /取り込み：dyve\/board-p1-/);
  assert.equal(git("rev-list", "--count", "--merges", "HEAD").trim(), "1");
  assert.ok(!fs.existsSync(a.dir));
  // ぶつかる変更
  const c = workspace({ room, workDir, taskId: "p2" });
  fs.writeFileSync(path.join(c.dir, "a.txt"), "worktree\n");
  execFileSync("git", ["-C", c.dir, "commit", "-qam", "w"]);
  fs.writeFileSync(path.join(room, "a.txt"), "room\n");
  git("commit", "-qam", "r");
  assert.throws(() => integrate({ room, workDir, taskId: "p2" }), /取り込めなかった/);
  assert.equal(git("status", "--porcelain").trim(), "");
  assert.equal(fs.readFileSync(path.join(room, "a.txt"), "utf8"), "room\n");
});

test("人が開発の提案を受け入れたら取り込み、結果をボードに置く。調べものの提案や AI の操作では取り込まない", async () => {
  const store = new Store();
  const calls = [];
  const integrate = async (x) => { calls.push(x); if (x.taskId === "bad") throw new Error("ぶつかった"); return { branch: "dyve/b", into: "main", commit: "abc1234", cleaned: true }; };
  const w = new Waker({ store, spawn: () => ({ done: new Promise(() => {}), kill() {} }), integrate, pause: 1e6, slots: 0 }).start();
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "直す", write: true } }, reason: "x" }).op.panel.id;
  const p = store.apply({ by: "アリス", type: "add", panel: { view: "list", state: "proposal", about: t, data: ["直した"] }, reason: "x" }).op.panel.id;
  const q = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる" } }, reason: "x" }).op.panel.id;
  const r = store.apply({ by: "ボブ", type: "add", panel: { view: "list", state: "proposal", about: q, data: ["案"] }, reason: "x" }).op.panel.id;
  store.apply({ by: "human", type: "edit", panel: { id: r, state: "done" } });
  store.apply({ by: "human", type: "edit", panel: { id: p, state: "done" } });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(calls, [{ board: "board", taskId: t }]);
  const note = store.board.list().find((x) => x.about === p && x.by === "board");
  assert.match(note.data, /取り込みました：dyve\/b → main（abc1234）/);
  // もう一度 done にしても取り込み直さない（前が proposal でないので）
  store.apply({ by: "human", type: "edit", panel: { id: p, state: "done" } });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(calls.length, 1);
  w.stop();
});

test("人が開発でない提案を受け入れたら、提案を置いた人に、提案のとおり進める仕事として渡す。部屋で auto のまま、外に届くことを止めない", async () => {
  const store = new Store();
  const jobs = [];
  const spawn = (job) => { let finish; const done = new Promise((r) => (finish = r)); jobs.push({ ...job, finish }); return { done, kill() {} }; };
  const w = new Waker({ store, spawn, pause: 1e6, names: ["アリス", "ボブ"] }).start();
  try {
  const say = store.apply({ by: "human", type: "add", panel: { view: "say", data: "PR にしておいて" } }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる", to: "ボブ", from: [say] } }, reason: "x" }).op.panel.id;
  await new Promise((ok) => setTimeout(ok, 10));
  const p = store.apply({ by: "ボブ", type: "add", panel: { view: "text", state: "proposal", about: t, data: "git push -u origin x && gh pr create --fill" }, reason: "x" }).op.panel.id;
  store.apply({ by: "ボブ", type: "edit", panel: { id: t, state: "done" }, reason: "x" });
  jobs.find((j) => j.taskId === t).finish({ code: 0 });
  await new Promise((ok) => setTimeout(ok, 10));
  // 人が見たあとで書き換えられた提案は受け入れられない
  const seen = store.board.get(p).rev;
  store.apply({ by: "ボブ", type: "edit", panel: { id: p, data: "git push --force" }, reason: "x" });
  assert.equal(store.apply({ by: "human", type: "edit", panel: { id: p, state: "done", rev: seen } }).code, "conflict");
  assert.ok(store.apply({ by: "human", type: "edit", panel: { id: p, state: "done", rev: store.board.get(p).rev } }).ok);
  await new Promise((ok) => setTimeout(ok, 10));
  const act = store.board.list().find((x) => x.data?.accepted === p);
  assert.deepEqual([act.view, act.state, act.about, act.data.to, act.data.after, act.data.from], ["task", "task", p, "ボブ", t, [say]]);
  assert.equal(act.data.text, "git push --force", "頼むのは受け入れたときの提案の文");
  const job = jobs.find((j) => j.taskId === act.id);
  assert.deepEqual([job.role, job.name], ["act", "ボブ"]);
  assert.match(job.prompt, /人が受け入れた提案（p\w+）です。[\s\S]*外に届くこと（push・送信・起票など）もしてかまいません[\s\S]*受け入れた提案：git push --force/);
  // もう一度 done にしても二つ目は作らない
  store.apply({ by: "human", type: "edit", panel: { id: p, state: "done" } });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(store.board.list().filter((x) => x.data?.accepted === p).length, 1);
  } finally {
    w.stop();
  }
  const a = claudeArgs({ role: "act", name: "ボブ", prompt: "x" }, "http://x", {});
  assert.ok(a.includes("--permission-mode") && a[a.indexOf("--permission-mode") + 1] === "auto");
  assert.ok(!a.includes("--disallowedTools"), "push などを止めない（危ない操作は auto の判定に任せる）");
  assert.ok(claudeArgs({ role: "task", name: "ボブ", prompt: "x" }, "http://x", {}).includes("Bash(git push:*)"), "ほかの仕事では今までどおり止める");
});
