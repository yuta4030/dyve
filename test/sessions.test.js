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
