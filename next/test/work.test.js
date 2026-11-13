// 開発の作業場：本物の git で一時のリポジトリを作って試す（外にはつながない。git の名前はテストの中で渡す）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Log } from "../src/log.js";
import { loadRoles, NEVER } from "../src/roles.js";
import { Sessions, ACCEPTED } from "../src/sessions.js";
import { Works } from "../src/work.js";
import { saidPrompt } from "../src/kakari.js";
import { stageOf } from "../src/state.js";

// 機械の git の設定（コミットの署名など）に頼らない。ここで決めた環境は、起こした子のプロセスにも引き継がれる
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();

function repo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-work-"));
  const room = path.join(top, "room");
  fs.mkdirSync(room);
  git(room, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(room, "a.txt"), "a\n");
  git(room, "add", ".");
  git(room, ...ID, "commit", "-q", "-m", "はじめ");
  return { top, room, dir: path.join(top, "work") };
}

// 偽の spawn：起こされた仕事を並べ、一ターンを終わらせられる
function fakeSpawn() {
  const jobs = [];
  const spawn = (job, emit) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    jobs.push({
      ...job,
      end: async (text = "はい", id = "c-1") => {
        emit({ type: "system", subtype: "init", session_id: id });
        emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
        emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: id, usage: {} });
        finish({ code: 0, stderr: "" });
        await tick();
      },
    });
    return { done, kill: () => finish({ code: null, stderr: "" }) };
  };
  return { jobs, spawn };
}

function setup(r = repo()) {
  const log = new Log();
  const works = new Works({ log, room: r.room, dir: r.dir }).start();
  const f = fakeSpawn();
  const sessions = new Sessions({ log, roles, room: r.room, works, spawn: f.spawn }).start();
  const ask = (text, to = { role: "開発", name: "直す" }) => sessions.ask(log.add("say", { text }).record.seq, to);
  return { ...r, log, works, sessions, f, ask, x: () => log.state.sessions[0] };
}
const commitIn = (dir, file, body) => {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, "add", ".");
  git(dir, ...ID, "commit", "-q", "-m", `${file} を書く`);
};

test("開発のセッションは、部屋のいまの HEAD から切り出した、セッションごとの作業場とブランチで起きる。道具は役割の決まりのまま", async () => {
  const t = setup();
  const r = t.ask("README に一行足して");
  assert.equal(r.ok, true);
  const x = t.x(), job = t.f.jobs[0];
  assert.equal(path.dirname(x.cwd), t.dir);
  assert.match(path.basename(x.cwd), new RegExp(`^s${x.id}-[0-9a-f]{6}$`));
  assert.equal(job.cwd, x.cwd);
  assert.ok(fs.existsSync(path.join(x.cwd, "a.txt")));
  assert.equal(git(x.cwd, "rev-parse", "--abbrev-ref", "HEAD"), `dyve/${path.basename(x.cwd)}`);
  const deny = job.args.slice(job.args.indexOf("--disallowedTools") + 1);
  for (const n of NEVER) assert.ok(deny.includes(n), n);
  assert.ok(job.args.includes("Bash(git commit:*)"));
  assert.equal(job.prompt, "README に一行足して", "作業場の説明を頼む文に足さない");
  // 続きは同じ作業場で
  commitIn(x.cwd, "b.txt", "b\n");
  await job.end();
  t.ask("もう一行", { session: x.id });
  assert.equal(t.f.jobs[1].cwd, x.cwd);
  assert.equal(git(x.cwd, "rev-list", "--count", "main..HEAD"), "1", "作業場を作り直していない");
});

test("ターンが終わると作業場のありさまを記録に置く（係を呼ばない）", async () => {
  const t = setup();
  t.ask("直して");
  const x = t.x();
  commitIn(x.cwd, "b.txt", "b\n");
  fs.writeFileSync(path.join(x.cwd, "c.txt"), "まだ");
  await t.f.jobs[0].end();
  assert.deepEqual(t.x().work, { branch: `dyve/${path.basename(x.cwd)}`, base: "main", ahead: 1, dirty: true, files: 1, gone: false });
});

test("取り込む：進んだ・コミットしていない変更・取り込むものがない・ぶつかる。取り込んだら片付け、続きは同じ場所で切り出し直す", async () => {
  const t = setup();
  t.ask("直して");
  const x = t.x();
  await t.f.jobs[0].end();
  assert.equal(t.works.integrate(x.id).result, "nothing");
  fs.writeFileSync(path.join(x.cwd, "b.txt"), "b\n");
  await tick();
  assert.equal(t.works.integrate(x.id).result, "dirty");
  git(x.cwd, "add", ".");
  git(x.cwd, ...ID, "commit", "-q", "-m", "b を足す");
  const m = t.works.integrate(x.id);
  assert.equal(m.result, "merged");
  assert.equal(m.into, "main");
  assert.equal(git(t.room, "log", "-1", "--format=%P").split(" ").length, 2, "マージコミットで取り込む（戻せる）");
  assert.ok(fs.existsSync(path.join(t.room, "b.txt")));
  assert.ok(!fs.existsSync(x.cwd), "取り込んだら作業場を片付ける");
  assert.equal(t.x().work.gone, true);
  assert.deepEqual(t.log.state.backs.filter((b) => b.kind === "merge").map((b) => b.result), ["nothing", "dirty", "merged"]);
  // 続きは同じ場所に、部屋のいまの HEAD から切り出し直す
  t.ask("続き", { session: x.id });
  assert.equal(t.f.jobs[1].cwd, x.cwd);
  assert.ok(fs.existsSync(path.join(x.cwd, "b.txt")));
  // ぶつかる：部屋と作業場が同じところを変えた
  commitIn(x.cwd, "a.txt", "作業場\n");
  commitIn(t.room, "a.txt", "部屋\n");
  await t.f.jobs[1].end();
  const head = git(t.room, "rev-parse", "HEAD");
  const c = t.works.integrate(x.id);
  assert.equal(c.result, "conflict");
  assert.equal(git(t.room, "rev-parse", "HEAD"), head, "ぶつかったら元に戻す");
  assert.equal(git(t.room, "status", "--porcelain"), "");
  assert.ok(fs.existsSync(x.cwd), "取り込めなかったブランチと作業場は消さない");
});

test("ぶつかっていないのに取り込めなかったとき（コミットを作れないなど）は、ぶつかったとは言わず、理由を残して元に戻す", async () => {
  const t = setup();
  t.ask("直して");
  const x = t.x();
  commitIn(x.cwd, "b.txt", "b\n");
  await t.f.jobs[0].end();
  // マージコミットを作る手前で断る hook を部屋に置く
  const hook = path.join(t.room, ".git", "hooks", "pre-merge-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho 断る >&2\nexit 1\n", { mode: 0o755 });
  const head = git(t.room, "rev-parse", "HEAD");
  const r = t.works.integrate(x.id);
  assert.equal(r.result, "failed");
  assert.ok(r.reason);
  assert.equal(git(t.room, "rev-parse", "HEAD"), head, "元に戻す");
  assert.equal(git(t.room, "status", "--porcelain"), "");
  assert.ok(fs.existsSync(x.cwd), "取り込めなかったブランチと作業場は消さない");
});

test("取り込めないとき：動いている・作業場のないセッション", () => {
  const t = setup();
  t.ask("直して");
  assert.equal(t.works.integrate(t.x().id).code, "conflict");
  t.ask("調べて", { role: "調べもの", name: "x" });
  assert.equal(t.works.integrate(t.log.state.sessions[1].id).code, "not_found");
});

test("済みに畳まれたとき、何も進んでいない作業場は片付け、進んだものは残す。立て直しても同じ作業場", async () => {
  const t = setup();
  t.ask("直して", { role: "開発", name: "一" });
  const a = t.x();
  await t.f.jobs[0].end();
  t.ask("こっちも", { role: "開発", name: "二" });
  const b = t.log.state.sessions[1];
  commitIn(b.cwd, "b.txt", "b\n");
  await t.f.jobs[1].end();
  t.log.add("fold", { session: a.id, by: 1 });
  t.log.add("fold", { session: b.id, by: 1 });
  await tick();
  assert.ok(!fs.existsSync(a.cwd), "何も進んでいないものは片付ける");
  assert.ok(fs.existsSync(b.cwd), "進んだものは残す（落とさない）");
  // 立て直し：同じ記録・同じ置き場で、済みのものも取り込める
  const works = new Works({ log: t.log, room: t.room, dir: t.dir });
  assert.equal(works.integrate(b.id).result, "merged");
});

test("部屋が git でなければ開発は選べない。切り出せなければ結果なしで終わり、理由がわかる", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-plain-"));
  const log = new Log();
  const works = new Works({ log, room: plain, dir: path.join(plain, "work") });
  const s = new Sessions({ log, roles, room: plain, works, spawn: fakeSpawn().spawn }).start();
  assert.equal(works.place(), null);
  const said = log.add("say", { text: "直して" }).record.seq;
  assert.equal(s.ask(said, { role: "開発" }).code, "unavailable");
  assert.doesNotMatch(saidPrompt({ state: log.state, batch: [log.state.said[0]], roles, can: (r) => !!s.placeOf(r) }), /- 開発：/);
  // 切り出せない：作業場の場所にファイルがある
  const t = setup();
  fs.mkdirSync(t.dir, { recursive: true });
  const cwd = t.works.cwdFor(t.log.state.seq + 2);
  t.works.cwdFor = () => cwd;
  fs.writeFileSync(cwd, "じゃま");
  t.ask("直して");
  assert.equal(t.f.jobs.length, 0);
  assert.equal(stageOf(t.x()).stage, "back");
  assert.match(t.x().failed, /作業場を切り出せなかった/);
});

test("外に届くことの伺いは、カードを押して受け入れる。そのターンだけ NEVER を外し、次は戻る。古い問い・二度目・動いているものは断る", async () => {
  const t = setup();
  t.ask("直して push もして");
  const x = t.x();
  await t.f.jobs[0].end("push してよいですか？");
  const end = t.log.state.sessions[0].turn;
  const card = (ask) => t.log.add("card", { session: x.id, turn: t.x().turn, line: "push の伺い", back: "push してよいか", ask, steps: [], panels: [] }).record.seq;
  // ふつうの問いには受け入れるがない
  const plain = card({ text: "どちらにしますか", ref: null, outward: false });
  assert.equal(t.sessions.accept(x.id, plain).code, "invalid");
  const old = plain;
  const c = card({ text: "push してよいですか？", ref: null, outward: true });
  assert.equal(stageOf(t.x()).stage, "wait");
  assert.equal(t.sessions.accept(x.id, old).code, "conflict", "いちばん新しいカードの伺いだけ");
  assert.equal(t.sessions.accept(x.id, c).ok, true);
  const job = t.f.jobs[1];
  assert.equal(job.prompt, ACCEPTED);
  const deny = job.args.slice(job.args.indexOf("--disallowedTools") + 1);
  for (const n of NEVER) assert.ok(!deny.includes(n), `受け入れたターンは ${n} を外す`);
  assert.ok(job.args.includes("--resume"));
  assert.equal(t.sessions.accept(x.id, c).code, "conflict", "動いているあいだ・二度目は断る");
  await job.end("push しました");
  assert.equal(t.sessions.accept(x.id, c).code, "conflict", "同じ問いを二度受け入れない");
  // チャットの「いいよ」はふつうの続き。NEVER は外れない
  t.ask("いいよ", { session: x.id });
  const next = t.f.jobs[2];
  assert.equal(next.prompt, "いいよ");
  const d2 = next.args.slice(next.args.indexOf("--disallowedTools") + 1);
  for (const n of NEVER) assert.ok(d2.includes(n), `次のターンは ${n} が戻る`);
  assert.ok(end);
  // やりとりに、受け入れたことが残る
  assert.ok(t.x().flow.some((f) => f.accept === c));
});
