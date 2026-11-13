// 行の中：行のセッションを流れる形で起こし、流れてくる記録から行の中の動きを導き、言葉を押し込み、終わったら担当の一覧を行に残す
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { Waker } from "../src/waker.js";
import { hasAiAnswer, isRecord, RECORD } from "../src/board.js";
import { insideStep, claudeArgs, claudeSpawner, helpersOf } from "../src/agents.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyve-inside-"));
const sample = (name) => fs.readFileSync(here(`./fixtures/stream/${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reduce = (events) => events.reduce(insideStep, []);

// ── 行の中を導く ──

test("行の中：呼ばれたものが始まり、進み、報告して終わる。result が何度来ても変わらない", () => {
  const evs = sample("background");
  assert.ok(evs.filter((e) => e.type === "result").length > 1, "見本は result を何度も流す");
  let list = [];
  const seen = [];
  for (const e of evs) {
    const next = insideStep(list, e);
    if (e.type !== "system") assert.equal(next, list, "関係のない記録では同じ配列を返す");
    list = next;
    seen.push(list);
  }
  assert.deepEqual(seen[2].map((t) => [t.id, t.state]), [["t1", "running"], ["t2", "running"]]);
  assert.equal(list.length, 2);
  const [a, b] = list;
  assert.deepEqual([a.type, a.what, a.depth, a.parent, a.state, a.tools, a.ms], ["general-purpose", "Tooling test A", 1, null, "done", 6, 19656]);
  assert.match(a.report, /^t1 の報告/);
  assert.deepEqual([b.state, b.last], ["done", "SubagentHandback"]);
  // 進むあいだの last と tools
  const mid = reduce(evs.slice(0, 6));
  assert.deepEqual([mid[0].state, mid[0].tools, mid[0].last], ["running", 2, "Write"]);
  assert.equal(mid[0].what, "Tooling test A", "頼まれたことは進み具合の言い方で書き換えない");
});

test("行の中：入れ子（深さ 2）は呼んだものを parent に持つ", () => {
  const list = reduce(sample("nested"));
  assert.deepEqual(list.map((t) => [t.id, t.depth, t.parent, t.state]), [["t1", 1, null, "done"], ["t2", 2, "t1", "done"]]);
});

test("行の中：止まったものは failed。シェルの裏の仕事は数えない。報告は短く切る", () => {
  const start = (id, extra = {}) => ({ type: "system", subtype: "task_started", task_id: id, description: "調べる", subagent_type: "調べ係", spawn_depth: 1, task_type: "local_agent", ...extra });
  let list = reduce([start("a"), start("b"), { type: "system", subtype: "task_started", task_id: "sh", description: "sleep 1", task_type: "local_bash" }]);
  assert.deepEqual(list.map((t) => t.id), ["a", "b"]);
  list = insideStep(list, { type: "system", subtype: "task_notification", task_id: "a", status: "failed", summary: "落ちた" });
  list = insideStep(list, { type: "system", subtype: "task_updated", task_id: "b", patch: { status: "killed" } });
  assert.deepEqual(list.map((t) => [t.state, t.report]), [["failed", "落ちた"], ["failed", null]]);
  const long = insideStep(reduce([start("c")]), { type: "system", subtype: "task_notification", task_id: "c", status: "completed", handback_report: { text: "あ".repeat(2000) } });
  assert.ok(long[0].report.length < 600);
  assert.equal(insideStep(list, { type: "system", subtype: "task_progress", task_id: "zz", usage: {} }), list, "知らない id は無視する");
});

// ── 役割を渡す ──

function crewOf(members) {
  return { members: members.map((m) => ({ call: m.id, team: null, mode: "append", body: "", ...m })), teams: [], common: "", own: {} };
}

test("役割を渡す：説明があり、この行と同じ場所で働く役割だけを --agents に。なければ付けない", () => {
  const crew = crewOf([
    { id: "マイ", description: "文書を書く", room: "/r/docs", body: "文書の流儀" },
    { id: "ケン", description: "バグを調べる", model: "haiku" },
    { id: "ジョー" },
    { id: "リン@algr", call: "リン", description: "algr の調べもの", room: "/r/x" },
  ]);
  const names = crew.members.map((m) => m.id);
  const agentsOf = (a) => (a.includes("--agents") ? JSON.parse(a[a.indexOf("--agents") + 1]) : null);
  const ken = agentsOf(claudeArgs({ role: "task", name: "ケン", taskId: "p3", prompt: "x" }, "http://x", {}, { room: "/r/x", crew, names }));
  assert.deepEqual(Object.keys(ken), ["ケン", "リン@algr"], "別の場所（/r/docs）のマイと、説明のないジョーは渡さない");
  assert.deepEqual(ken["ケン"], { description: "バグを調べる", prompt: "あなたは役割「ケン」です。得意なこと：バグを調べる", model: "haiku" });
  const mai = helpersOf({ role: "dev", name: "マイ" }, { room: "/r/x", crew, names });
  assert.deepEqual(mai, { "マイ": { description: "文書を書く", prompt: "文書の流儀" } });
  // 説明のある役割がなければ付けない。マネージャには付けない
  assert.equal(agentsOf(claudeArgs({ role: "task", name: "backroom", taskId: "p1", prompt: "x" }, "http://x", {}, { room: "/r/x" })), null);
  assert.equal(agentsOf(claudeArgs({ role: "manager", name: "manager", prompt: "x" }, "http://x", {}, { room: "/r/x", crew, names })), null);
  // 深さ・並べる数を決める引数は付けない
  const a = claudeArgs({ role: "task", name: "ケン", taskId: "p3", prompt: "x" }, "http://x", {}, { room: "/r/x", crew, names });
  assert.ok(!a.some((x) => /depth|concurren|parallel/i.test(x)));
  // MCP の口には行の id も付ける
  const mcp = JSON.parse(a[a.indexOf("--mcp-config") + 1]);
  assert.equal(mcp.mcpServers.board.url, `http://x/mcp?as=${encodeURIComponent("ケン")}&row=p3`);
});

// ── 流れる形で起こす（偽の claude） ──

// 偽の claude：plan を順に進める。{ print: 記録 } は一行流す、{ read: true } は標準入力の次の一通を待つ、{ sleep: ms }、
// { probe: 名前 } はそのとき標準入力が閉じているかを書き残す。最後まで進んだら、標準入力が閉じるのを待って終わる。
// 書き残すもの（log）：受けた引数、届いた一通（in）、流した記録（out）、標準入力が閉じた（end）
function fakeStream(dir, plan) {
  const cmd = path.join(dir, `fake-${Math.random().toString(36).slice(2)}`);
  const log = cmd + ".log";
  fs.writeFileSync(cmd, `#!/usr/bin/env node
const fs = require("node:fs");
const plan = ${JSON.stringify(plan)};
const note = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + "\\n");
note({ args: process.argv.slice(2) });
let buf = "", got = 0, need = 0, ended = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) { note({ in: JSON.parse(buf.slice(0, i)).message.content }); buf = buf.slice(i + 1); got++; }
});
process.stdin.on("end", () => { ended = true; note({ end: true }); });
const until = (f) => new Promise((r) => { const c = () => (f() ? r() : setTimeout(c, 5)); c(); });
(async () => {
  for (const s of plan) {
    if (s.read) { need++; await until(() => got >= need || ended); }
    if (s.sleep) await new Promise((r) => setTimeout(r, s.sleep));
    if (s.probe) note({ probe: s.probe, ended });
    if (s.print) { process.stdout.write(JSON.stringify(s.print) + "\\n"); note({ out: s.print.subtype || s.print.type }); }
  }
  await until(() => ended);
  process.exit(0);
})();
`);
  fs.chmodSync(cmd, 0o755);
  const read = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { cmd, read };
}
const started = { type: "system", subtype: "task_started", task_id: "t1", description: "下調べ", subagent_type: "調べ係", spawn_depth: 1, is_backgrounded: true, task_type: "local_agent" };
const finished = { type: "system", subtype: "task_notification", task_id: "t1", status: "completed", usage: { tool_uses: 3, duration_ms: 4200 }, handback_report: { text: "見つけた" } };
const result = (session, input, cost) => ({ type: "result", subtype: "success", is_error: false, session_id: session, total_cost_usd: cost, usage: { input_tokens: input, output_tokens: 1 } });

function spawner(dir, cmd) {
  return claudeSpawner({ cmd, room: path.join(dir, "room"), staff: path.join(dir, "staff"), workDir: path.join(dir, "work"), boardUrl: "http://x" });
}

test("流れる形：指示は最初の一通で渡す。標準入力は、結果が来て行の中で動いているものがなくなってから閉じる。終わりはプロセスが終わったとき", async () => {
  const dir = tmp();
  const f = fakeStream(dir, [
    { read: true },
    { print: started },
    { print: result("s-a", 3, 0.1) },
    { sleep: 150 },
    { probe: "result のあと、行の中が動いているあいだ" },
    { print: finished },
    { print: result("s-b", 2, 0.3) },
  ]);
  const h = spawner(dir, f.cmd)({ role: "task", name: "backroom", taskId: "p1", prompt: "調べて" });
  const r = await h.done;
  const log = f.read();
  assert.equal(log.find((x) => "in" in x).in, "調べて");
  assert.equal(log.find((x) => x.probe).ended, false, "result が来ても、行の中が動いていれば閉じない");
  assert.ok(log.findIndex((x) => x.end) > log.findIndex((x) => x.out === "task_notification"), "閉じるのは行の中が終わったあと");
  // セッション id は最後の結果、トークンは回ごとに足し、費用は通算（最後の結果）
  assert.deepEqual([r.code, r.session, r.usage.input, r.usage.output, r.usage.costUsd, r.resumed], [0, "s-b", 5, 2, 0.3, false]);
  assert.deepEqual(r.inside.map((t) => [t.id, t.type, t.what, t.state, t.report, t.ms]), [["t1", "調べ係", "下調べ", "done", "見つけた", 4200]]);
});

test("流れる形：動いているセッションに言葉を押し込める。押し込んだ言葉に結果が来るまで閉じない。終わったあとは渡せない", async () => {
  const dir = tmp();
  const f = fakeStream(dir, [
    { read: true },
    { print: started },
    { print: result("s-a", 1, 0.1) },
    { read: true },
    { print: finished },
    { sleep: 100 },
    { probe: "言葉に結果が来る前" },
    { print: result("s-a", 1, 0.2) },
  ]);
  const h = spawner(dir, f.cmd)({ role: "task", name: "backroom", taskId: "p1", prompt: "調べて" });
  await tick(150);
  assert.equal(h.say("行への言葉です"), true);
  const r = await h.done;
  const log = f.read();
  assert.deepEqual(log.filter((x) => "in" in x).map((x) => x.in), ["調べて", "行への言葉です"]);
  assert.equal(log.find((x) => x.probe).ended, false);
  assert.equal(r.code, 0);
  assert.equal(h.say("遅れた言葉"), false, "閉じたあとは渡せない（起こし直しに回す）");
});

test("流れる形：行の中の動きは、まとめて一秒に二度までしか知らせない", async () => {
  const dir = tmp();
  const progress = Array.from({ length: 40 }, (_, i) => ({ print: { type: "system", subtype: "task_progress", task_id: "t1", usage: { tool_uses: i + 1, duration_ms: i } } }));
  const f = fakeStream(dir, [{ read: true }, { print: started }, ...progress, { print: finished }, { print: result("s", 1, 0) }]);
  const calls = [];
  const r = await spawner(dir, f.cmd)({ role: "task", name: "backroom", taskId: "p1", prompt: "x", onInside: (l) => calls.push(l) }).done;
  assert.ok(calls.length >= 1 && calls.length <= 3, `知らせた数 ${calls.length}`);
  assert.equal(calls[0][0].state, "running");
  assert.equal(r.inside[0].tools, 3, "終わったときの一覧は done で返す");
});

test("流れる形：引き継ぐときは頼み直しの文を最初の一通にする", async () => {
  const dir = tmp();
  const f = fakeStream(dir, [{ read: true }, { print: result("s-old", 1, 0) }]);
  const spawn = spawner(dir, f.cmd);
  const cwd = path.join(dir, "room");
  fs.mkdirSync(cwd, { recursive: true });
  const r = await spawn({ role: "task", name: "backroom", taskId: "p1", prompt: "まっさら", resume: { session: "s-old", cwd, prompt: "続きから" } }).done;
  const log = f.read();
  assert.equal(r.resumed, true);
  assert.ok(log[0].args.includes("--resume"));
  assert.equal(log.find((x) => "in" in x).in, "続きから");
});

// ── 起こし係：行の中・担当の一覧・言葉を押し込む・行を見分ける ──

// 偽の起こし方：行のセッションには say を持たせる（渡せるかは deliver で決める）
function fakeSpawn({ deliver = true } = {}) {
  const jobs = [];
  const spawn = (job) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    const j = { ...job, said: [], killed: false, open: true };
    j.finish = (res = { code: 0 }) => { j.open = false; finish(res); };
    j.handle = { done, kill: () => { j.killed = true; j.finish({ code: 143 }); }, say: (t) => (deliver && j.open ? (j.said.push(t), true) : false) };
    jobs.push(j);
    return j.handle;
  };
  return { jobs, spawn };
}
const call = { id: "t1", type: "調べ係", what: "下調べ", depth: 1, parent: null, state: "done", tools: 3, ms: 4200, last: "Read", report: "見つけた。" + "く".repeat(400) };
const nested = { ...call, id: "t2", type: "読み係", what: "読む", depth: 2, parent: "t1", ms: 65_000, report: null };
const row = (store, extra = {}) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べて", ...extra } }, reason: "x" }).op.panel.id;

test("起こし係：行の中の動きを status().agents[].inside に出す（操作ログには積まない）", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = row(store);
  const seq = store.board.seq;
  const lives = [];
  w.onChange((s) => lives.push(s));
  assert.deepEqual(w.status().agents[0].inside, []);
  f.jobs[0].onInside([{ ...call, state: "running", report: null }]);
  const a = w.status().agents[0];
  assert.deepEqual([a.name, a.task, typeof a.startedAt, a.inside.map((x) => [x.id, x.state])], ["backroom", t, "string", [["t1", "running"]]]);
  assert.equal(lives.at(-1).agents[0].inside.length, 1, "変わったら知らせる");
  assert.equal(store.board.seq, seq);
  w.stop();
});

test("担当の一覧：行の中で呼ばれたものがあれば、終わったときに一枚だけ置く。次の回は同じ一枚に書き足し、立て直しても見つける。行の答えには数えない", async () => {
  const file = path.join(tmp(), "board.jsonl");
  let store = new Store(file);
  let f = fakeSpawn();
  let w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = row(store);
  f.jobs[0].finish({ code: 0, inside: [call, nested] });
  await tick(10);
  const recs = () => store.board.list().filter((p) => p.about === t && isRecord(p));
  assert.equal(recs().length, 1);
  const rec = recs()[0];
  assert.deepEqual([rec.by, rec.view, rec.data.record, RECORD], ["board", "table", "inside", "inside"]);
  assert.deepEqual(rec.data.columns, ["誰", "頼まれたこと", "返したこと", "かかった"]);
  assert.deepEqual(rec.data.rows.map((r) => [r[0], r[1], r[3]]), [["調べ係", "下調べ", "4秒"], ["↳ 読み係", "読む", "1分"]]);
  assert.ok(rec.data.rows[0][2].startsWith("見つけた。") && rec.data.rows[0][2].length <= 201, "返したことは 200 字ほどに切る");
  assert.equal(rec.data.rows[1][2], "（報告なし）");
  assert.ok(store.board.log.find((o) => o.panel.id === rec.id).reason);
  // 行の答えには数えない：答えを置かずに終わった行として帰る
  assert.equal(hasAiAnswer(store.board, t), false);
  assert.equal(store.board.get(t).line, "結果を置かずに終わりました");
  // 次の回：同じ一枚に書き足す
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task" }, reason: "もう一度" });
  await tick(10);
  assert.equal(f.jobs.length, 2);
  f.jobs[1].finish({ code: 0, inside: [{ ...call, id: "t3", what: "二回目" }] });
  await tick(10);
  assert.equal(recs().length, 1);
  assert.deepEqual(recs()[0].data.rows.map((r) => r[1]), ["下調べ", "読む", "二回目"]);
  // 行の中で何も呼ばなかった回は、何も足さない
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task" }, reason: "もう一度" });
  await tick(10);
  f.jobs[2].finish({ code: 0, inside: [] });
  await tick(10);
  assert.equal(recs()[0].data.rows.length, 3);
  w.stop();
  // 立て直し：ボードだけから同じ一枚を見つける
  store = new Store(file);
  f = fakeSpawn();
  w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task" }, reason: "もう一度" });
  await tick(10);
  f.jobs[0].finish({ code: 0, inside: [{ ...call, id: "t4", what: "立て直したあと" }] });
  await tick(10);
  assert.equal(recs().length, 1);
  assert.equal(recs()[0].data.rows.at(-1)[1], "立て直したあと");
  w.stop();
});

test("担当の一覧：答えのある行は答えのまま帰り、一覧はそれとは別に残る", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = row(store);
  store.apply({ by: "backroom", type: "edit", panel: { id: t, line: "答え", state: "done" }, reason: "x" });
  f.jobs[0].finish({ code: 0, inside: [call] });
  await tick(10);
  assert.equal(store.board.get(t).line, "答え");
  assert.equal(store.board.list().filter((p) => isRecord(p)).length, 1);
  w.stop();
});

test("行への言葉：動いている行のセッションに押し込んだら、終わったあとそれで起こし直さない", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = row(store);
  const m = store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "backroom", text: "締め切りは金曜" } }, reason: "x" }).op.panel.id;
  assert.equal(f.jobs[0].said.length, 1);
  assert.match(f.jobs[0].said[0], new RegExp(`仕事 ${t}`));
  assert.match(f.jobs[0].said[0], new RegExp(`manager が置いたもの（${m}）`));
  assert.match(f.jobs[0].said[0], /締め切りは金曜\n/);
  assert.match(f.jobs[0].said[0], /答えはこの行に帰します/);
  store.apply({ by: "backroom", type: "edit", panel: { id: t, line: "金曜に合わせた", state: "done" }, reason: "x" });
  f.jobs[0].finish();
  await tick(10);
  assert.equal(f.jobs.length, 1, "渡した言葉では起こし直さない");
  assert.equal(store.board.get(t).state, "done");
  w.stop();
});

test("行への言葉：渡せなかったら（標準入力が閉じていた）、終わったあとに起こし直す", async () => {
  const store = new Store();
  const f = fakeSpawn({ deliver: false });
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = row(store);
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "backroom", text: "締め切りは金曜" } }, reason: "x" });
  store.apply({ by: "backroom", type: "edit", panel: { id: t, line: "調べた", state: "done" }, reason: "x" });
  f.jobs[0].finish();
  await tick(10);
  assert.equal(f.jobs.length, 2);
  assert.match(f.jobs[1].prompt, /締め切りは金曜/);
  w.stop();
});

test("行を見分ける：同じ役割の行が二本動いていても、どの行のセッションから来たか（row）で、自分の言葉と取り下げを見分ける", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const a = row(store), b = row(store);
  assert.deepEqual(f.jobs.map((j) => [j.taskId, j.name]), [[a, "backroom"], [b, "backroom"]]);
  const word = (about, from) => store.apply({ by: "backroom", type: "add", panel: { view: "text", about, data: { to: "backroom", text: `${from} から` } }, reason: "x" }, { row: from });
  // A のセッションが A に置いた言葉は自分のもの：押し込まず、起こし直さない
  word(a, a);
  assert.equal(f.jobs[0].said.length, 0);
  // B のセッションが A に置いた言葉は行への言葉：A に押し込む
  word(a, b);
  assert.equal(f.jobs[0].said.length, 1);
  assert.match(f.jobs[0].said[0], new RegExp(`${b} から`));
  // B のセッションが A を done にしたら、A を止める（取り下げ）。A のセッションが B ではなく自分を done にしても止めない
  store.apply({ by: "backroom", type: "edit", panel: { id: b, line: "済み", state: "done" }, reason: "x" }, { row: b });
  assert.equal(f.jobs[1].killed, false, "自分の行を終えるところは止めない");
  store.apply({ by: "backroom", type: "edit", panel: { id: a, state: "done" }, reason: "x" }, { row: b });
  assert.equal(f.jobs[0].killed, true, "ほかの行のセッションからの取り下げでは止める");
  w.stop();
});
