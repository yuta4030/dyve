import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { Sessions, claudeArgs, toolLine } from "../src/sessions.js";

// 偽の起こし方：起こされた job を覚え、finish(i) で i 番目を終わらせる
function fakeSpawn() {
  const jobs = [];
  const spawn = (job, emit) => {
    let end;
    const done = new Promise((r) => (end = r));
    jobs.push({ job, emit, end, killed: false });
    return { done, kill: () => { jobs.find((j) => j.job === job).killed = true; end({ code: 143, stderr: "" }); } };
  };
  const finish = async (i, text = "答え", sid = `c${i}`) => {
    const j = jobs[i];
    j.emit({ type: "system", subtype: "init", session_id: sid });
    j.emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "price" } }, { type: "text", text }] } });
    j.emit({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "中の話" }] } });
    j.emit({ type: "result", is_error: false, result: text, session_id: sid });
    j.end({ code: 0, stderr: "" });
    await new Promise((r) => setImmediate(r));
  };
  return { spawn, jobs, finish };
}
const setup = (slots = 3) => {
  const log = new Log(), f = fakeSpawn();
  const sessions = new Sessions({ log, spawn: f.spawn, room: "/room", slots, prompt: "P" });
  const say = (text, session) => { const r = log.add("say", { text }); log.add("route", { say: r.seq, session }); sessions.send(session, r.seq); return r.seq; };
  return { log, sessions, say, ...f };
};

test("道具を絞らず、聞かずに進める形で起こす。続きは --resume", () => {
  const a = claudeArgs({ prompt: "P" });
  assert.equal(a[a.indexOf("--permission-mode") + 1], "auto");
  assert.ok(!a.includes("--allowedTools") && !a.includes("--disallowedTools"));
  assert.ok(!a.includes("--resume"));
  const b = claudeArgs({ prompt: "P", resume: "c1", model: "sonnet" });
  assert.equal(b[b.indexOf("--resume") + 1], "c1");
  assert.equal(b[b.indexOf("--model") + 1], "sonnet");
});

test("一ターン：出来事を記録し、結果で帰る。中で呼ばれたものは出さない", async () => {
  const { log, sessions, say, jobs, finish } = setup();
  const id = sessions.open("料金");
  say("料金を調べて", id);
  assert.equal(jobs[0].job.prompt, "料金を調べて");
  assert.equal(jobs[0].job.cwd, "/room");
  assert.equal(log.state.sessions[0].status, "run");
  await finish(0, "月 20 ドル");
  const x = log.state.sessions[0];
  assert.equal(x.status, "wait");
  assert.equal(x.claude, "c0");
  assert.equal(x.last, "月 20 ドル");
  assert.deepEqual(x.flow.map((f) => f.text), ["料金を調べて", "Grep price", "月 20 ドル"]);
});

test("動いているあいだの発言は、終わってからまとめて同じ会話に渡す", async () => {
  const { sessions, say, jobs, finish } = setup();
  const id = sessions.open("料金");
  say("料金を調べて", id);
  say("年払いも", id);
  say("あと税込みで", id);
  assert.equal(jobs.length, 1);
  await finish(0);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].job.prompt, "年払いも\n\nあと税込みで");
  assert.equal(jobs[1].job.args[jobs[1].job.args.indexOf("--resume") + 1], "c0");
});

test("同時に走るのは slots まで。空いたら次が動く", async () => {
  const { sessions, say, jobs, finish } = setup(1);
  const a = sessions.open("a"), b = sessions.open("b");
  say("一つめ", a);
  say("二つめ", b);
  assert.equal(jobs.length, 1);
  await finish(0);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].job.prompt, "二つめ");
});

test("結果を出さずに終わったら失敗として残す", async () => {
  const { log, sessions, say, jobs } = setup();
  const id = sessions.open("x");
  say("やって", id);
  jobs[0].end({ code: 1, stderr: "warn\nError: ログインしていない\n" });
  await new Promise((r) => setImmediate(r));
  const x = log.state.sessions[0];
  assert.equal(x.status, "fail");
  assert.equal(x.last, "Error: ログインしていない");
});

test("道具の一行", () => {
  assert.equal(toolLine("Read", { file_path: "a.md" }), "Read a.md");
  assert.equal(toolLine("mcp__slack__search", { query: "料金" }), "mcp__slack__search 料金");
  assert.equal(toolLine("Task", {}), "Task");
});

const tick = () => new Promise((r) => setImmediate(r));

test("止める：動いているターンを止め、待たせていた発言も渡さない。チャットには返さない", async () => {
  const { log, sessions, say, jobs } = setup();
  const id = sessions.open("料金");
  say("料金を調べて", id);
  say("年払いも", id);
  assert.ok(sessions.stop(id));
  await tick();
  assert.ok(jobs[0].killed);
  assert.equal(jobs.length, 1);
  const x = log.state.sessions[0];
  assert.equal(x.status, "stop");
  assert.equal(log.state.chat.filter((c) => c.reply).length, 0);
  // 止めたあとも、続きを話せば同じ会話で動く
  say("やっぱり続けて", id);
  assert.equal(jobs.length, 2);
});

test("取り消す：順番待ちなら渡さず、答えているところなら止める。答え終えたものは取り消せない", async () => {
  const { log, sessions, say, jobs, finish } = setup();
  const id = sessions.open("料金");
  const a = say("料金を調べて", id);
  const b = say("年払いも", id);
  assert.ok(sessions.cancel(b));
  await finish(0);
  assert.equal(jobs.length, 1);
  assert.equal(log.state.said.find((p) => p.id === b).canceled, true);
  assert.equal(sessions.cancel(a), false);
  const c = say("税込みも", id);
  assert.ok(sessions.cancel(c));
  await tick();
  assert.ok(jobs[1].killed);
  assert.equal(log.state.sessions[0].status, "stop");
});

test("取り消して発言が一つもなくなったセッションは、一覧から外す", async () => {
  const { log, sessions, say } = setup();
  const id = sessions.open("間違い");
  const a = say("独り言", id);
  sessions.cancel(a);
  await tick();
  assert.equal(log.state.sessions[0].hidden, true);
});

test("届け先を変える：前のセッションで動いていれば止め、新しい先へ渡す。間違って起きたセッションは外す", async () => {
  const { log, sessions, say, jobs, finish } = setup();
  const a = sessions.open("料金");
  say("料金を調べて", a);
  await finish(0);
  const wrong = sessions.open("年払い");
  const s = say("年払いも", wrong);
  assert.ok(sessions.move(s, a));
  await tick();
  assert.ok(jobs[1].killed);
  assert.equal(jobs[2].job.prompt, "年払いも");
  assert.equal(jobs[2].job.args[jobs[2].job.args.indexOf("--resume") + 1], "c0");
  const st = log.state;
  assert.equal(st.said.find((p) => p.id === s).session, a);
  assert.equal(st.sessions.find((x) => x.id === wrong).hidden, true);
  // 新しく起こす先へ
  await finish(2);
  assert.ok(sessions.move(s, "new"));
  assert.equal(log.state.sessions.at(-1).name, "年払いも");
  assert.equal(jobs.length, 4);
  // 料金のセッションには料金の発言が残るので外さない
  assert.ok(!log.state.sessions.find((x) => x.id === a).hidden);
});

test("清書したものがあれば、セッションにはそれを渡す", () => {
  const { log, sessions, jobs } = setup();
  const id = sessions.open("a");
  const s = log.add("say", { text: "えー料金を" }).seq;
  log.add("route", { say: s, session: id, fair: "料金を" });
  sessions.send(id, s);
  assert.equal(jobs[0].job.prompt, "料金を");
});

test("利用枠：rate_limit_event を、変わったときだけ記録に置く", async () => {
  const { log, sessions, say, jobs } = setup();
  const id = sessions.open("a");
  say("x", id);
  const ev = (u) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: u, resetsAt: 100 }, seven_day: { utilization: 0.394, resetsAt: 200 } } } });
  jobs[0].emit(ev(0.21));
  jobs[0].emit(ev(0.2101));
  jobs[0].emit(ev(0.3));
  const quotas = [];
  for (const k of ["five", "week"]) quotas.push(log.state.quota[k]);
  assert.deepEqual(quotas, [0.3, 0.39]);
  assert.equal(log.state.quota.fiveAt, 100);
  assert.equal(log.state.seq, 2 + 1 + 1 + 2, "open・say・route・turn・利用枠 2 回");
});
