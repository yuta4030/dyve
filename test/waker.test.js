import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Waker, managerPrompt, taskPrompt } from "../src/waker.js";
import { hasAiAnswer } from "../src/board.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeSpawn() {
  const jobs = [];
  const spawn = (job) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    const j = { ...job, finish: (res = { code: 0 }) => finish(res), killed: false };
    j.handle = { done, kill: () => { j.killed = true; finish({ code: 143 }); } };
    jobs.push(j);
    return j.handle;
  };
  return { jobs, spawn };
}

test("発言のあと間があいたらマネージャを一人だけ起こし、走っているあいだの発言は終わってから読ませる", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 10 }).start();
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "a" } });
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "b" } });
  await tick(30);
  assert.equal(f.jobs.filter((j) => j.role === "manager").length, 1);
  assert.match(f.jobs[0].prompt, /since: 0/);
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "c" } });
  await tick(30);
  assert.equal(f.jobs.filter((j) => j.role === "manager").length, 1);
  f.jobs[0].finish();
  await tick(30);
  const m = f.jobs.filter((j) => j.role === "manager");
  assert.equal(m.length, 2);
  assert.match(m[1].prompt, /since: 2/);
  w.stop();
});

test("仕事が置かれたら名前のあるエージェントを起こし、同じ仕事を二つ走らせない", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const s = store.apply({ by: "human", type: "add", panel: { view: "say", data: "検索の遅さを調べて" } }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: s, data: { text: "遅さを調べる" } }, reason: "取り次ぎ" }).op.panel.id;
  store.apply({ by: "manager", type: "edit", panel: { id: s, data: "検索の遅さを調べて。" }, reason: "清書" });
  const tasks = () => f.jobs.filter((j) => j.role === "task");
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].name, "アリス");
  assert.equal(tasks()[0].taskId, t);
  assert.match(tasks()[0].prompt, /遅さを調べる/);
  assert.deepEqual(w.status().agents.map((a) => a.name), ["アリス"]);
  store.apply({ by: "アリス", type: "add", panel: { view: "text", about: t, data: "索引がない" }, reason: "結果" });
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done" }, reason: "終わった" });
  assert.equal(tasks()[0].killed, false);
  tasks()[0].finish();
  await tick();
  assert.equal(tasks().length, 1);
  assert.equal(w.status().agents.length, 0);
  w.stop();
});

test("名前を呼ばれた仕事はその相手に。働いていれば空くまで待つ", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const add = (data) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data }, reason: "取り次ぎ" }).op.panel.id;
  add({ text: "一つ目", to: "ボブ" });
  add({ text: "二つ目", to: "ボブ" });
  add({ text: "三つ目" });
  const tasks = () => f.jobs.filter((j) => j.role === "task");
  assert.deepEqual(tasks().map((j) => j.name), ["ボブ", "アリス"]);
  tasks()[0].finish();
  await tick();
  assert.deepEqual(tasks().map((j) => j.name), ["ボブ", "アリス", "ボブ"]);
  w.stop();
});

test("取り下げられたら止め、結果を置かずに終わったらそれとわかるように残す", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const add = (text) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text } }, reason: "取り次ぎ" }).op.panel.id;
  const a = add("やめるもの");
  const b = add("落ちるもの");
  store.apply({ by: "manager", type: "edit", panel: { id: a, state: "done" }, reason: "アリス、それもういい" });
  assert.equal(f.jobs[0].killed, true);
  f.jobs[1].finish({ code: 1, error: "終了コード 1" });
  await tick();
  const note = store.board.list().find((p) => p.about === b);
  assert.equal(note.by, "board");
  assert.match(note.data, /結果を置かずに終わりました/);
  // 同じ形の仕事で起こし直さない
  assert.equal(f.jobs.filter((j) => j.taskId === b).length, 1);
  w.stop();
});

test("data.write が付いた仕事は開発として起こす", () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "直す", write: true } }, reason: "x" });
  store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる" } }, reason: "x" });
  assert.deepEqual(f.jobs.map((j) => j.role), ["dev", "task"]);
  w.stop();
});

test("一度に起こすのは slots まで", () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6, slots: 2 }).start();
  for (const t of ["a", "b", "c"]) store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: t } }, reason: "x" });
  assert.equal(f.jobs.length, 2);
  w.stop();
});

function fakeSession() {
  const sessions = [];
  const open = (job) => {
    const ss = { job, alive: true, sent: [], waiting: [] };
    ss.send = (text) => new Promise((r) => { ss.sent.push(text); ss.waiting.push(r); });
    ss.quota = null;
    ss.reply = (res = { code: 0, usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 40, costUsd: 0.01 } }) => ss.waiting.shift()(res);
    ss.kill = () => { ss.alive = false; };
    sessions.push(ss);
    return ss;
  };
  return { sessions, open };
}

test("清書係：発言を起こしっぱなしの会話に流し込み、前の発言を文脈として渡す。マネージャは清書のあと", async () => {
  const store = new Store();
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "前の話" } });
  const f = fakeSpawn(), g = fakeSession();
  const w = new Waker({ store, spawn: f.spawn, session: g.open, pause: 5, scribePause: 5 });
  w.cutoff = w.scribeCutoff = store.board.seq;
  w.start();
  const a = store.apply({ by: "human", type: "add", panel: { view: "say", data: "あるご とつなぐ" } }).op.panel.id;
  await tick(30);
  assert.equal(g.sessions.length, 1);
  assert.equal(g.sessions[0].job.role, "scribe");
  assert.match(g.sessions[0].sent[0], /文脈[\s\S]*前の話/);
  assert.match(g.sessions[0].sent[0], new RegExp(`${a}（rev \\d+）：あるご とつなぐ`));
  assert.equal(w.status().scribe, true);
  g.sessions[0].quota = { five_hour: { utilization: 0.52, resetsAt: 1 } };
  // 清書が済むまでマネージャは起こさない
  const mgr = () => g.sessions.filter((x) => x.job.role === "manager");
  assert.equal(mgr().length, 0);
  store.apply({ by: "scribe", type: "edit", panel: { id: a, data: "algr とつなぐ" }, reason: "誤変換" });
  g.sessions[0].reply();
  await tick(30);
  assert.equal(w.status().quota.five_hour.utilization, 0.52);
  // マネージャも起こしっぱなしの会話。毎回起こし直さない
  assert.equal(mgr().length, 1);
  assert.match(mgr()[0].sent[0], /algr とつなぐ/);
  assert.equal(w.status().manager != null, true);
  mgr()[0].reply();
  await tick(10);
  assert.equal(w.status().usage.runs, 2);
  assert.equal(w.status().usage.cacheRead, 80);
  // 二通目は同じ会話に。直前の発言は合成に使うので rev 付きで渡す
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "次" } });
  await tick(30);
  assert.equal(g.sessions.filter((x) => x.job.role === "scribe").length, 1);
  assert.match(g.sessions[0].sent[1], /文脈[\s\S]*（rev \d+）/);
  g.sessions[0].reply();
  await tick(30);
  assert.equal(mgr().length, 1);
  assert.equal(mgr()[0].sent.length, 2);
  assert.equal(f.jobs.filter((j) => j.role === "manager").length, 0);
  w.stop();
});

test("清書係：人が手を入れた発言は渡さない。清書係の書き換えは結果に数えない", async () => {
  const store = new Store();
  const g = fakeSession();
  const w = new Waker({ store, spawn: fakeSpawn().spawn, session: g.open, pause: 1e6, scribePause: 5 }).start();
  const a = store.apply({ by: "human", type: "add", panel: { view: "say", data: "あ" } }).op.panel.id;
  store.apply({ by: "human", type: "edit", panel: { id: a, data: "あい" } });
  await tick(30);
  assert.equal(g.sessions.length, 0);
  store.apply({ by: "scribe", type: "edit", panel: { id: a, data: "愛" }, reason: "x" });
  assert.equal(hasAiAnswer(store.board, a), false);
  w.stop();
});

test("マネージャへの指示：要点・仕事・新しい発言・置かれたものをそろえて渡す", () => {
  const store = new Store();
  const say = store.apply({ by: "human", type: "add", panel: { view: "say", data: "検索が遅い" } }).op.panel.id;
  store.apply({ by: "manager", type: "add", panel: { view: "summary", data: { points: ["検索の話"] } }, reason: "要点" });
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: say, data: { text: "遅さを調べる", to: "ボブ" } }, reason: "x" }).op.panel.id;
  const since = store.board.seq;
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "索引かな" } });
  store.apply({ by: "ボブ", type: "add", panel: { view: "text", about: t, data: "索引がない" }, reason: "結果" });
  const p = managerPrompt(since, store.board, [t]);
  assert.match(p, /いまの要点（p2、rev 2）[\s\S]*検索の話/);
  assert.match(p, new RegExp(`${t}［task・動いている］ボブ：遅さを調べる`));
  assert.match(p, /新しい発言[\s\S]*索引かな/);
  assert.doesNotMatch(p, /：検索が遅い/);
  assert.match(p, /新しく置かれたもの[\s\S]*ボブ[\s\S]*索引がない/);
  assert.doesNotMatch(p, /項目までに減らして/);
  const long = store.apply({ by: "manager", type: "add", panel: { view: "summary", data: { points: Array(20).fill("x") } }, reason: "要点" });
  assert.ok(long.ok);
  assert.match(managerPrompt(since, store.board, []), /いま 20 項目あります。今回の書き換えで 15 項目までに減らして/);
});

test("アイコンで宛てた発言：続けて話したぶんをまとめてその相手に渡し、働いていれば終わってから続きとして渡す", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 10 }).start();
  const tasks = () => f.jobs.filter((j) => j.role === "task");
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "一覧を作る", to: "ボブ" } }, reason: "x" }).op.panel.id;
  assert.equal(tasks()[0].name, "ボブ");
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "丸アイコンにして", to: "ボブ" } });
  const s2 = store.apply({ by: "human", type: "add", panel: { view: "say", data: "色もつけて", to: "ボブ" } }).op.panel.id;
  await tick(30);
  assert.equal(tasks().length, 1); // ボブが働いているあいだは待つ
  assert.match(managerPrompt(0, store.board), /ボブ宛て。ボードがそのままボブに渡す/);
  store.apply({ by: "ボブ", type: "add", panel: { view: "list", about: t, data: ["一覧を置いた"] }, reason: "結果" });
  store.apply({ by: "ボブ", type: "edit", panel: { id: t, state: "done" }, reason: "済み" });
  tasks()[0].finish();
  await tick(30);
  assert.equal(tasks().length, 2);
  const next = tasks()[1];
  assert.equal(next.name, "ボブ");
  const p = store.board.get(next.taskId);
  assert.equal(p.by, "board");
  assert.equal(p.about, s2);
  assert.deepEqual(p.data, { text: "丸アイコンにして\n色もつけて", to: "ボブ", direct: true, from: [store.board.list().find((x) => x.data === "丸アイコンにして").id, s2], after: t });
  assert.match(next.prompt, /直接話しかけました/);
  assert.match(next.prompt, /短い返事を about: "p\w+" の text/);
  assert.match(next.prompt, /前にあなたが受け持った仕事（.+）：一覧を作る/);
  assert.match(next.prompt, /一覧を置いた/);

  // 空いている相手には、間があいたらすぐ渡す。宛先のない発言は渡さない
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "ありがとう" } });
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "キャロル、表にして", to: "キャロル" } });
  await tick(30);
  assert.equal(tasks().length, 3);
  assert.equal(tasks()[2].name, "キャロル");
  assert.equal(store.board.get(tasks()[2].taskId).data.after, undefined);
  w.stop();
});

test("話題：マネージャには話題の一覧を渡し、控室には話題と元の発言（data.from）を渡す", () => {
  const store = new Store();
  const s1 = store.apply({ by: "human", type: "add", panel: { view: "say", data: "diff も欲しい" } }).op.panel.id;
  const tp = store.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "パネルの整理" } }, reason: "話題" }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: tp, data: { text: "diff の view を作る", from: [s1] } }, reason: "x" }).op.panel;
  const m = managerPrompt(0, store.board);
  assert.match(m, new RegExp(`## 話題\\n- ${tp}：パネルの整理（仕事 1）`));
  assert.match(m, new RegExp(`${t.id}［task・話題 ${tp}］diff の view を作る`));
  const p = taskPrompt(store.board, store.board.get(t.id), "アリス");
  assert.match(p, /話題（.+）：パネルの整理/);
  assert.match(p, new RegExp(`元の発言（${s1}）：diff も欲しい`));
});
