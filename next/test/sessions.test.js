import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { loadRoles, NEVER } from "../src/roles.js";
import { Sessions, claudeArgs, claudeMissing, exitError, usageOf, toolLine } from "../src/sessions.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();
const ROOM = "/tmp/room";

// 偽の spawn：起こされた仕事を並べ、出来事（本物の stream-json と同じ形）を流して終わらせられる
function fakeSpawn() {
  const jobs = [];
  const spawn = (job, emit) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    const j = {
      ...job, emit, killed: false,
      init: (id) => emit({ type: "system", subtype: "init", cwd: job.cwd, session_id: id }),
      say: (text) => emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null }),
      tool: (name, input) => emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] }, parent_tool_use_id: null }),
      result: (id, text, extra = {}) => emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: id, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 }, ...extra }),
      finish: (code = 0, stderr = "") => finish({ code, stderr }),
      // 一ターンを最後まで：init → 言う → 結果 → 終わる
      turn: async (id, text) => { j.init(id); j.say(text); j.result(id, text); j.finish(0); await tick(); },
    };
    jobs.push(j);
    return { done, kill: () => { j.killed = true; finish({ code: null, stderr: "" }); } };
  };
  return { jobs, spawn };
}

const kinds = (log, from = 0) => log.records.filter((r) => r.seq > from).map((r) => r.kind);
// 記録を手元に残す Log（テストで並びを見る）
function recLog(file = null) {
  const log = new Log(file);
  log.records = [];
  log.on((r) => log.records.push(r));
  return log;
}
const say = (log, text) => log.add("say", { text }).record.seq;

test("起こす引数：stream-json・前置き・auto・役割ごとの道具。続きは --resume", () => {
  const r = roles.調べもの;
  const a = claudeArgs(r);
  assert.deepEqual(a.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(!a.includes("--resume"));
  assert.equal(a[a.indexOf("--append-system-prompt") + 1], r.prompt);
  assert.match(r.prompt, /調べもの/);
  assert.equal(a[a.indexOf("--permission-mode") + 1], "auto");
  const allow = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
  const deny = a.slice(a.indexOf("--disallowedTools") + 1);
  assert.deepEqual(allow, ["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
  for (const t of ["Edit", "Write", "NotebookEdit", ...NEVER]) assert.ok(deny.includes(t), t);
  assert.ok(!a.includes("--model"));
  assert.ok(!a.some((x) => /mcp/i.test(x)), "MCP の口はない");
  const b = claudeArgs({ ...r, model: "sonnet" }, { resume: "abc" });
  assert.equal(b[b.indexOf("--resume") + 1], "abc");
  assert.equal(b[b.indexOf("--model") + 1], "sonnet");
});

test("dyve の役割は調べもの・開発・パネル。どれも外に届くことを禁じる", () => {
  assert.deepEqual(Object.keys(roles).sort(), ["パネル", "開発", "調べもの"].sort());
  for (const r of Object.values(roles)) {
    for (const t of NEVER) assert.ok(r.deny.includes(t), `${r.name} ${t}`);
    assert.ok(r.prompt.length > 0);
    assert.doesNotMatch(r.prompt, /カード|パネルを置|画面|オーバービュー|チャット/, `${r.name} の定義に画面のための指示を書かない`);
  }
  assert.equal(roles.調べもの.place, "room");
  assert.equal(roles.開発.place, "worktree");
  assert.equal(roles.パネル.place, "panels");
  assert.ok(roles.開発.tools.includes("Edit"));
});

test("発言を新しいセッションへ：できた・渡した・始まった・言った・道具・終わった、の順に記録に置く", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const a = say(log, "package.json の版は？");
  const r = s.ask(a, { role: "調べもの" });
  assert.equal(r.ok, true);
  assert.equal(f.jobs.length, 1);
  const j = f.jobs[0];
  assert.equal(j.prompt, "package.json の版は？");
  assert.equal(j.cwd, ROOM);
  assert.ok(!j.args.includes("--resume"));
  j.init("c-1");
  j.tool("Grep", { pattern: '"version"', path: "/tmp/room/package.json" });
  j.say("0.9.0 です。");
  j.result("c-1", "0.9.0 です。");
  j.finish(0);
  await tick();
  assert.deepEqual(kinds(log, a), ["open", "pass", "start", "tool", "talk", "end"]);
  const x = log.state.sessions[0];
  assert.equal(x.id, r.session);
  assert.deepEqual([x.role, x.cwd, x.claude, x.running, x.last, x.failed], ["調べもの", ROOM, "c-1", false, "0.9.0 です。", null]);
  assert.deepEqual(x.usage, { input: 3, output: 5, cacheWrite: 7, cacheRead: 11, costUsd: 0.01 });
  // やりとりは、発言とセッションの言葉が順に取り出せる
  assert.deepEqual(x.flow.map((e) => e.said ?? e.tool ?? e.talk), [a, 'Grep "version"', "0.9.0 です。"]);
  assert.equal(log.state.said[0].session, x.id);
});

test("動いているあいだはステートが実行中。終わると止まっている", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  s.ask(say(log, "a"), { role: "調べもの" });
  assert.equal(log.state.sessions[0].running, true);
  await f.jobs[0].turn("c-1", "ok");
  assert.equal(log.state.sessions[0].running, false);
});

test("続きは前の会話を引き継ぐ（--resume）", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const { session } = s.ask(say(log, "一つめ"), { role: "調べもの" });
  await f.jobs[0].turn("c-1", "はい");
  s.ask(say(log, "続き"), { session });
  const j = f.jobs[1];
  assert.equal(j.args[j.args.indexOf("--resume") + 1], "c-1");
  assert.equal(j.prompt, "続き");
  assert.equal(log.records.findLast((r) => r.kind === "start").resume, "c-1");
});

test("動いているあいだに届いた続きは、二つ走らせず、終わってからまとめて一度で渡す", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const { session } = s.ask(say(log, "調べて"), { role: "調べもの" });
  const b = say(log, "ついでに年払いも"), c = say(log, "あと月額も");
  s.ask(b, { session });
  s.ask(c, { session });
  assert.equal(f.jobs.length, 1, "同じセッションを二つ走らせない");
  assert.deepEqual(log.state.sessions[0].pending, [b, c]);
  await f.jobs[0].turn("c-1", "調べた");
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[1].prompt, "ついでに年払いも\n\nあと月額も");
  assert.deepEqual(log.records.findLast((r) => r.kind === "start").says, [b, c]);
  assert.deepEqual(log.state.sessions[0].pending, []);
});

test("同時に走るのは slots まで。空いたら、古い発言を待たせているものから起こす", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn, slots: 2 }).start();
  for (const t of ["a", "b", "c", "d"]) s.ask(say(log, t), { role: "調べもの" });
  assert.equal(f.jobs.length, 2);
  assert.deepEqual(log.state.sessions.map((x) => x.running), [true, true, false, false]);
  await f.jobs[1].turn("c-2", "ok");
  assert.equal(f.jobs.length, 3);
  assert.equal(f.jobs[2].prompt, "c");
  await f.jobs[0].turn("c-1", "ok");
  assert.equal(f.jobs[3].prompt, "d");
});

test("引き継ぎが始まらずに落ちたら、まっさらで起こし直し、それまでの発言を渡し直す", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const { session } = s.ask(say(log, "競合の値段を調べて"), { role: "調べもの" });
  await f.jobs[0].turn("c-1", "調べた");
  const from = log.state.seq;
  s.ask(say(log, "年払いは？"), { session });
  // 本物は、会話が見つからないと init を出さずに結果のエラーだけを返す
  f.jobs[1].result("c-1", undefined, { subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: c-1"] });
  f.jobs[1].finish(1, "No conversation found with session ID: c-1");
  await tick();
  assert.equal(f.jobs.length, 3);
  const j = f.jobs[2];
  assert.ok(!j.args.includes("--resume"));
  assert.match(j.prompt, /引き継げなかった/);
  assert.match(j.prompt, /- 競合の値段を調べて/);
  assert.match(j.prompt, /いまの頼み：\n年払いは？$/);
  await j.turn("c-9", "年払いは 2 割引き");
  assert.deepEqual(kinds(log, from), ["say", "pass", "start", "fail", "start", "talk", "end"]);
  assert.match(log.records.find((r) => r.kind === "fail").reason, /No conversation found/);
  const x = log.state.sessions[0];
  assert.equal(x.claude, "c-9");
  assert.equal(x.failed, null);
  assert.equal(x.flow.filter((e) => e.said).length, 2, "やりとりに同じ発言を二度並べない");
});

test("結果を出さずに終わったら、理由を残し、止まっている・結果なしとわかる", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  s.ask(say(log, "a"), { role: "調べもの" });
  f.jobs[0].init("c-1");
  f.jobs[0].finish(1, "boom\nAPI Error: overloaded");
  await tick();
  const x = log.state.sessions[0];
  assert.equal(x.running, false);
  assert.equal(x.failed, "終了コード 1：API Error: overloaded");
  assert.equal(x.claude, "c-1", "途中まで動いた会話は、続きで引き継げる");
  // 結果がエラーのときは、その文を理由にする
  s.ask(say(log, "b"), { role: "調べもの" });
  f.jobs[1].init("c-2");
  f.jobs[1].result("c-2", "Reached max turns", { is_error: true, subtype: "error_max_turns" });
  f.jobs[1].finish(1);
  await tick();
  assert.equal(log.state.sessions[1].failed, "終了コード 1：Reached max turns");
  // 何も返さずに 0 で終わった
  s.ask(say(log, "c"), { role: "調べもの" });
  f.jobs[2].finish(0);
  await tick();
  assert.equal(log.state.sessions[2].failed, "結果を返さずに終わった");
});

test("立て直し：止まったとき動いていたセッションは途切れたと置き、待たせていた発言は落とさずに渡す", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-")), "record.jsonl");
  const log = recLog(file), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const { session } = s.ask(say(log, "一つめ"), { role: "調べもの" });
  await f.jobs[0].turn("c-1", "はい");
  s.ask(say(log, "二つめ"), { session });
  f.jobs[1].init("c-1");
  const late = say(log, "三つめ");
  s.ask(late, { session });
  // ここで dyve が落ちた（stop も呼ばれない）
  const again = recLog(file), g = fakeSpawn();
  assert.equal(again.state.sessions[0].running, true);
  new Sessions({ log: again, roles, room: ROOM, spawn: g.spawn }).start();
  const x = again.state.sessions[0];
  assert.equal(again.records[0].kind, "fail");
  assert.match(again.records[0].reason, /途切れた/);
  assert.equal(g.jobs.length, 1, "待たせていた発言を渡す");
  assert.equal(g.jobs[0].prompt, "三つめ");
  assert.equal(g.jobs[0].args[g.jobs[0].args.indexOf("--resume") + 1], "c-1");
  assert.equal(x.running, true);
});

test("止めるときは、動いているセッションに途切れたと置いてから止める", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  s.ask(say(log, "a"), { role: "調べもの" });
  f.jobs[0].init("c-1");
  s.stop();
  await tick();
  assert.equal(f.jobs[0].killed, true);
  const x = log.state.sessions[0];
  assert.equal(x.running, false);
  assert.match(x.failed, /止めた/);
  assert.equal(x.claude, "c-1");
  assert.equal(log.records.at(-1).kind, "fail", "止めたあとは何も置かない");
});

test("渡せないもの：ない発言・ないセッション・ない役割・二度目・まだ起きる場所のない役割", () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  const a = say(log, "a");
  assert.equal(s.ask(99, { role: "調べもの" }).code, "not_found");
  assert.equal(s.ask(a, { session: 99 }).code, "not_found");
  assert.equal(s.ask(a, { role: "占い" }).code, "not_found");
  assert.equal(s.ask(a, {}).code, "invalid");
  assert.equal(s.ask(a, { role: "開発" }).code, "unavailable");
  assert.equal(s.ask(a, { role: "パネル" }).code, "unavailable");
  assert.equal(log.state.sessions.length, 0, "起こせないときはセッションを作らない");
  assert.equal(s.ask(a, { role: "調べもの" }).ok, true);
  assert.equal(s.ask(a, { role: "調べもの" }).code, "conflict");
});

test("サブエージェントの言葉は積まない。利用枠はいちばん新しいものだけ持つ", async () => {
  const log = recLog(), f = fakeSpawn();
  const s = new Sessions({ log, roles, room: ROOM, spawn: f.spawn }).start();
  s.ask(say(log, "a"), { role: "調べもの" });
  const j = f.jobs[0];
  j.init("c-1");
  j.emit({ type: "assistant", message: { content: [{ type: "text", text: "下請けの言葉" }] }, parent_tool_use_id: "toolu_1" });
  j.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5 } } } });
  j.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.6 } } } });
  j.emit({ type: "stream_event", event: { type: "message_start" } });
  await j.turn("c-1", "おわり");
  assert.ok(!log.records.some((r) => r.kind === "talk" && r.text === "下請けの言葉"));
  assert.equal(s.quota.unifiedWindows.five_hour.utilization, 0.6);
  assert.ok(!log.records.some((r) => r.kind === "quota"), "利用枠は記録に積まない");
});

test("道具は一行、使った量、落ちた理由、claude が動くか", () => {
  assert.equal(toolLine({ name: "Bash", input: { command: "git log\n--oneline", description: "x" } }), "Bash git log --oneline");
  assert.equal(toolLine({ name: "Read", input: { file_path: "/a/b.js" } }), "Read /a/b.js");
  assert.equal(toolLine({ name: "TodoWrite", input: { todos: [] } }), "TodoWrite");
  assert.equal(toolLine({ name: "Bash", input: { command: "x".repeat(300) } }).length, 120);
  assert.deepEqual(usageOf({ total_cost_usd: 1, usage: { input_tokens: 2 } }), { input: 2, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 1 });
  assert.equal(exitError(1, null, "a\nb\n"), "終了コード 1：b");
  assert.equal(exitError(1, { errors: ["x", "y"] }), "終了コード 1：x / y");
  assert.equal(exitError(2, null, ""), "終了コード 2");
  assert.equal(claudeMissing("claude", () => ({ status: 0 })), null);
  assert.match(claudeMissing("nope", () => ({ error: { code: "ENOENT" } })), /nope.*ENOENT/);
});
