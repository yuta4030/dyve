import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Waker, managerPrompt, taskPrompt, screenWords, scribePrompt } from "../src/waker.js";
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

test("発言のあと間があいたらマネージャを一人だけ起こし、走っているあいだの発言は終わってから読ませる（一本のとき）", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 10, lanes: 1 }).start();
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

test("マネージャは二本まで：前の整理が済むのを待たずに、次の発言を別の本で読む。同じ発言は二本で読まない", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 10 }).start();
  const a = store.apply({ by: "human", type: "add", panel: { view: "say", data: "a" } }).op.panel.id;
  await tick(30);
  const m = () => f.jobs.filter((j) => j.role === "manager");
  assert.equal(m().length, 1);
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "b" } });
  await tick(30);
  assert.equal(m().length, 2, "一本目が走っていても、二本目が読む");
  assert.match(m()[1].prompt, /since: 1/);
  assert.match(m()[1].prompt, new RegExp(`${a} は、もう一本のマネージャがいま読んでいます`));
  assert.equal(w.status().managers.length, 2);
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "c" } });
  await tick(30);
  assert.equal(m().length, 2, "三本目は立てない");
  m()[0].finish();
  await tick(30);
  assert.equal(m().length, 3);
  assert.match(m()[2].prompt, /since: 2/);
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

test("終わった仕事に置かれた伝言（to 付きの text）：行を AI の番に戻して、宛てた人を起こし直す。答えは同じ行に帰る", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const topic = store.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "画面" } }, reason: "x" }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: topic, data: { title: "ポインター", text: "マウスのポインターを入れる" } }, reason: "取り次ぎ" }).op.panel.id;
  const jobs = () => f.jobs.filter((j) => j.taskId === t);
  assert.equal(jobs()[0].name, "アリス");
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "入れた" }, reason: "結果" });
  jobs()[0].finish();
  await tick();
  // to のない補いは誰も起こさない
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { text: "補い" } }, reason: "補う" });
  assert.equal(store.board.get(t).state, "done");
  assert.equal(jobs().length, 1);
  // ほかの人が空いていても、宛てた人を起こす
  const m = store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "アリス", text: "どう動くかも具体的に書いて" } }, reason: "人の確認を A 担当に伝える" }).op.panel.id;
  const back = store.board.history(t).at(-1);
  assert.equal(back.by, "board");
  assert.ok(back.reason);
  assert.equal(store.board.get(t).state, "task");
  assert.equal(store.board.get(t).data.to, "アリス");
  assert.equal(store.board.get(t).data.text, "マウスのポインターを入れる", "頼んだことはそのまま");
  assert.equal(jobs().length, 2);
  assert.equal(jobs()[1].name, "アリス");
  assert.match(jobs()[1].prompt, new RegExp(`${m}.*どう動くかも具体的に書いて`));
  assert.doesNotMatch(jobs()[1].prompt, /補い/);
  // 答えは同じ行に。帰ったあとは、同じ伝言で起こし直さない
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "動きを書いた" }, reason: "結果" });
  jobs()[1].finish();
  await tick();
  assert.equal(store.board.get(t).line, "動きを書いた");
  assert.equal(jobs().length, 2);
  assert.equal(store.board.list().filter((p) => p.view === "task").length, 1, "新しい行を足さない");
  w.stop();
});

test("伝言：動いている仕事なら起こさない（相手が途中で拾う）。帰したあと終わるまでのあいだに置かれたら、終わってから起こし直す", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる" } }, reason: "x" }).op.panel.id;
  const jobs = () => f.jobs.filter((j) => j.taskId === t);
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "アリス", text: "途中の言葉" } }, reason: "伝える" });
  assert.equal(jobs().length, 1, "二重に走らせない");
  // 行を帰したが、まだ終わっていない（1 秒の行き違い）
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "済んだ" }, reason: "結果" });
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "アリス", text: "もう一つ" } }, reason: "伝える" });
  assert.equal(store.board.get(t).state, "done");
  assert.equal(jobs().length, 1);
  jobs()[0].finish();
  await tick();
  assert.equal(store.board.get(t).state, "task");
  assert.equal(jobs().length, 2);
  assert.match(jobs()[1].prompt, /もう一つ/);
  assert.doesNotMatch(jobs()[1].prompt, /途中の言葉/, "前に拾った言葉は渡し直さない");
  w.stop();
});

test("伝言：宛てた人が別の仕事で働いていたら、行を戻して空くまで待たせる", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const add = (data) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data }, reason: "x" }).op.panel.id;
  const a = add({ text: "一つ目", to: "アリス" });
  store.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "済んだ" }, reason: "結果" });
  f.jobs[0].finish();
  await tick();
  const b = add({ text: "二つ目", to: "アリス" });
  assert.equal(f.jobs.at(-1).taskId, b);
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: a, data: { to: "アリス", text: "一つ目の続き" } }, reason: "伝える" });
  assert.equal(store.board.get(a).state, "task", "行は AI の番に戻る");
  assert.equal(f.jobs.filter((j) => j.taskId === a).length, 1, "アリスが空くまで待つ（ほかの人に回さない）");
  f.jobs.at(-1).finish();
  await tick();
  const again = f.jobs.filter((j) => j.taskId === a);
  assert.equal(again.length, 2);
  assert.equal(again[1].name, "アリス");
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
  // 止まったことは行に帰す（人の番）
  const back = store.board.get(b);
  assert.equal(store.board.history(b).at(-1).by, "board");
  assert.match(back.line, /結果を置かずに終わりました/);
  assert.equal(back.state, "done");
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
  assert.doesNotMatch(p, /いまの要点/, "要点はもう渡さない");
  assert.match(p, new RegExp(`${t}［task・動いている］ボブ：遅さを調べる`));
  assert.match(p, /新しい発言[\s\S]*索引かな/);
  assert.doesNotMatch(p, /：検索が遅い/);
  assert.match(p, /新しく置かれたもの[\s\S]*ボブ[\s\S]*索引がない/);
  // 前の版が要点の open に置いた問いは、行にするように渡す（落とさない）
  store.apply({ by: "manager", type: "add", panel: { view: "summary", data: { points: ["x"], open: ["「良い」の基準を決める", { text: "要点を真ん中へ", from: [say] }] } }, reason: "要点" });
  assert.match(managerPrompt(since, store.board, []), /いまの要点に残っている問い[\s\S]*「良い」の基準を決める\n- 要点を真ん中へ/);
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
  assert.match(m, new RegExp(`## 話題\\n- ${tp}（rev \\d+）：パネルの整理（行 1）　いまどこまで：`));
  assert.match(m, new RegExp(`A（${t.id}）［AI の番］diff の view を作る`));
  const p = taskPrompt(store.board, store.board.get(t.id), "アリス");
  assert.match(p, /話題（.+）：パネルの整理/);
  assert.match(p, new RegExp(`元の発言（${s1}）：diff も欲しい`));
});

test("途中経過を置いたあとで落ちた仕事にも止まったことを残す。ふつうに終わったら残さない", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6, slots: 2 }).start();
  const add = (text) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text } }, reason: "取り次ぎ" }).op.panel.id;
  const note = (id, text) => store.apply({ by: "キャロル", type: "add", panel: { view: "text", about: id, data: text }, reason: "途中経過" });
  const a = add("落ちるもの"), b = add("終わるもの");
  note(a, "待ちます");
  note(b, "結果");
  const job = (id) => f.jobs.find((j) => j.taskId === id);
  job(a).finish({ code: 1, error: "終了コード 1：You've hit your 5-hour limit" });
  job(b).finish({ code: 0 });
  await tick();
  assert.match(store.board.get(a).line, /途中で止まりました（終了コード 1：You've hit your 5-hour limit）/);
  assert.equal(store.board.history(b).some((o) => o.by === "board"), false);
  w.stop();
});

test("指して喋る：マネージャと控室に、発言のとき指していたパネルを渡す。押して選んだ発言は清書係に渡さない", async () => {
  const store = new Store();
  const a = store.apply({ by: "manager", type: "add", panel: { view: "list", data: ["キャッシュ案"] }, reason: "r" }).op.panel.id;
  const s = store.apply({ by: "human", type: "add", panel: { view: "say", data: "これの手間は", point: { id: a, how: "hover" } } }).op.panel.id;
  const pk = store.apply({ by: "human", type: "add", panel: { view: "say", data: "これにする：キャッシュ案", point: { id: a, how: "pick" } } }).op.panel.id;
  const m = managerPrompt(0, store.board);
  assert.match(m, new RegExp(`${s}（マウスは ${a}「キャッシュ案」の上）`));
  assert.match(m, new RegExp(`${pk}（${a}「キャッシュ案」を押して選んだ）`));
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる", from: [s] } }, reason: "r" }).op.panel.id;
  assert.match(taskPrompt(store.board, store.board.get(t), "アリス"), /発言のとき、マウスは .*の上（手がかり/);
  // 清書係：押して選んだ発言は画面が書いた文なので渡さない
  const st = new Store(), g = fakeSession();
  const w = new Waker({ store: st, spawn: fakeSpawn().spawn, session: g.open, pause: 1e6, scribePause: 1 }).start();
  const s2 = st.apply({ by: "human", type: "add", panel: { view: "say", data: "これで", point: { id: "x", how: "view" } } }).op.panel.id;
  const pk2 = st.apply({ by: "human", type: "add", panel: { view: "say", data: "これにする：x", point: { id: "x", how: "pick" } } }).op.panel.id;
  await tick(20);
  assert.match(g.sessions[0].sent[0], new RegExp(`${s2}（rev`));
  assert.doesNotMatch(g.sessions[0].sent[0], new RegExp(`${pk2}（rev`));
  assert.equal(w.status().read, 0, "マネージャがまだ読んでいない");
  w.stop();
});

test("指したものの言い方：押して選んだものは決定として言い切り、マウスの下と見ていたまん中は画面のありさまとして弱く言う", () => {
  const store = new Store();
  const tp = store.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "版" } }, reason: "r" }).op.panel.id;
  const c = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "done", about: tp, line: "次の版は 0.9.0 でよいか", data: { title: "次の版の番号", text: "版" } }, reason: "r" }).op.panel.id;
  const say = (data, how) => store.apply({ by: "human", type: "add", panel: { view: "say", data, point: { id: c, how } } }).op.panel.id;
  const h = say("はい", "hover"), v = say("これで", "view"), pk = say("これにする：0.9.0", "pick");
  const m = managerPrompt(0, store.board);
  const row = `A（${c}）「次の版の番号」`;
  assert.ok(m.includes(`${h}（マウスは ${row}の上）：はい`), m);
  assert.ok(m.includes(`${v}（画面のまん中は ${row}）：これで`), m);
  assert.ok(m.includes(`${pk}（${row}を押して選んだ）`), m);
  assert.doesNotMatch(m, /を指して/, "hover を人が指したと言い切らない");
  // 控室：押して選んだものだけ手がかりの但し書きを付けない
  const task = (from) => store.board.get(store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる", from: [from] } }, reason: "r" }).op.panel.id);
  assert.match(taskPrompt(store.board, task(v), "アリス"), /発言のとき、画面のまん中は .*（手がかり/);
  const picked = taskPrompt(store.board, task(pk), "アリス");
  assert.match(picked, /人はそのとき .*を押して選んだ\n/);
  assert.doesNotMatch(picked, /手がかり/);
  // 清書係にも同じ言い方
  assert.match(scribePrompt([store.board.get(h)], [], [], { board: store.board }), new RegExp(`${h}（rev \\d+、マウスは A（${c}）「次の版の番号」の上）：はい`));
});

test("同じ行の結果は重ねない：控室への文に、その行に前に置かれた結果を出して書き換えさせる", () => {
  const store = new Store();
  const tp = store.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "t" } }, reason: "r" }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: tp, data: { title: "比べる", text: "比べて" } }, reason: "r" }).op.panel.id;
  assert.doesNotMatch(taskPrompt(store.board, store.board.get(t), "アリス"), /前に置いたもの/);
  const old = store.apply({ by: "アリス", type: "add", panel: { view: "list", about: t, data: ["案 A が速い", "案 B は安い"] }, reason: "r" }).op.panel.id;
  store.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: "補い" }, reason: "r" });
  const p = taskPrompt(store.board, store.board.get(t), "ボブ");
  assert.match(p, new RegExp(`前に置いたもの[\\s\\S]*- ${old}（list、アリス、rev \\d+）：`));
  assert.doesNotMatch(p, /補い/, "マネージャの補いは結果に数えない");
  assert.match(p, /面に置くものは数行まで/);
});

test("清書係に画面を見せる：表の行・開いている面の見出し・指した先を渡し、二通目からは変わった分だけ", async () => {
  const store = new Store();
  const mg = (panel) => store.apply({ by: "manager", type: "add", panel, reason: "r" }).op.panel.id;
  const topic = mg({ view: "topic", data: { title: "動作確認" } });
  const row = mg({ view: "task", state: "task", about: topic, data: { title: "見積もりを送る", text: "送る" } });
  store.apply({ by: "アリス", type: "edit", panel: { id: row, state: "done", line: "下書きできた" }, reason: "r" });
  store.apply({ by: "アリス", type: "add", panel: { view: "table", about: row, data: { columns: ["項目", "中身"], rows: [["宛先", "x"]] } }, reason: "r" });
  store.apply({ by: "human", type: "add", panel: { view: "layout", data: { v: 3, out: [row] } } });
  const words = screenWords(store.board);
  assert.deepEqual(words, ["- 話題「動作確認」", "  - A 見積もりを送る → 下書きできた", "    - A の面：項目・中身／宛先"]);
  const old = store.apply({ by: "human", type: "add", panel: { view: "say", data: "前の話" } }).op.panel.id;
  store.apply({ by: "human", type: "edit", panel: { id: old, data: "前の話（手で直した）" } });
  const g = fakeSession();
  const w = new Waker({ store, spawn: fakeSpawn().spawn, session: g.open, pause: 1e6, scribePause: 1 });
  w.cutoff = w.scribeCutoff = store.board.seq;
  w.start();
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "三森は送った", point: { id: row, how: "hover" } } });
  await tick(20);
  const first = g.sessions[0].sent[0];
  assert.match(first, /画面の言葉[\s\S]*A 見積もりを送る → 下書きできた[\s\S]*A の面：項目・中身/);
  assert.match(first, new RegExp(`（rev \\d+、マウスは A（${row}）「見積もりを送る」の上）：三森は送った`));
  assert.match(first, new RegExp(`${old}（人が直した。触らない）`), "人が直した文脈の発言は触らせない");
  g.sessions[0].reply();
  await tick(5);
  // 二通目：行の一行が変わったぶんだけ
  store.apply({ by: "アリス", type: "edit", panel: { id: row, line: "送った" }, reason: "r" });
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "次" } });
  await tick(20);
  const second = g.sessions[0].sent[1];
  assert.match(second, /A 見積もりを送る → 送った/);
  assert.doesNotMatch(second, /話題「動作確認」|A の面/);
  g.sessions[0].reply();
  await tick(5);
  store.apply({ by: "human", type: "add", panel: { view: "say", data: "次の次" } });
  await tick(20);
  assert.doesNotMatch(g.sessions[0].sent[2], /画面の言葉/, "変わっていなければ送らない");
  w.stop();
});

// 決まった行の面：人がその行にいるあいだは畳まず、離れたら畳む
function faceBoard() {
  const store = new Store();
  const w = new Waker({ store, spawn: fakeSpawn().spawn, pause: 1e6, slots: 0 }).start();
  const ap = (o) => { const r = store.apply(o); assert.ok(r.ok, JSON.stringify(r)); return r.op.panel.id; };
  const topic = ap({ by: "manager", type: "add", panel: { view: "topic", data: { title: "朝会" } }, reason: "r" });
  const row = (text) => ap({ by: "manager", type: "add", panel: { view: "task", state: "done", about: topic, line: "案が二つ", data: { text } }, reason: "r" });
  const a = row("point を直す"), b = row("料金を見る");
  const inner = ap({ by: "アリス", type: "add", panel: { view: "list", about: a, data: ["案 1", "案 2"] }, reason: "r" });
  const lp = ap({ by: "human", type: "add", panel: { view: "layout", data: { v: 3, pos: {}, zoom: {}, fold: {}, out: [], pinned: [], inner: { tpos: {}, sizes: {} } } } });
  const open = (id) => ap({ by: "manager", type: "edit", panel: { id: lp, data: { ...store.board.get(lp).data, out: [...store.board.get(lp).data.out, id] } }, reason: "人がその行の話を始めた" });
  const out = () => store.board.get(lp).data.out;
  const say = (text, point) => ap({ by: "human", type: "add", panel: { view: "say", data: text, ...(point ? { point: { id: point, how: "hover" } } : {}) } });
  const decide = (id) => ap({ by: "manager", type: "edit", panel: { id, decided: "案 1" }, reason: "決まった" });
  const look = (o = {}) => w.focus.set("tab", { presence: "here", viewing: [topic, a], inside: [inner], talking: [topic], ...o });
  return { store, w, topic, a, b, inner, lp, open, out, say, decide, look };
}

test("決まった行の面：人がその面の中を指して話しているあいだは畳まない。別の行の話を始めたら畳む", () => {
  const { store, w, a, b, inner, lp, open, out, say, decide, look } = faceBoard();
  open(a);
  look();
  say("案 1 でいこう", inner);
  decide(a);
  assert.deepEqual(out(), [a], "その面の中にいるあいだは畳まない");
  look({ talking: [] });
  assert.deepEqual(out(), [a], "人のいまが変わっても、まだその行にいる");
  say("料金の話", b);
  assert.deepEqual(out(), [], "別の行の話を始めたら畳む");
  assert.equal(store.board.history(lp).at(-1).by, "board");
  assert.match(store.board.history(lp).at(-1).reason, /離れた/);
  w.stop();
});

test("決まった行の面：面が画面から外れたら（人のいまが変わったら）畳む", () => {
  const { w, a, b, inner, open, out, say, decide, look } = faceBoard();
  open(a);
  look();
  say("案 1 でいこう", inner);
  decide(a);
  assert.deepEqual(out(), [a]);
  look({ viewing: [b], inside: [] });
  assert.deepEqual(out(), [], "面も表も見えなくなったら畳む");
  w.stop();
});

test("決まった行の面：人が離れている（away）ならすぐ畳む", () => {
  const { w, a, inner, open, out, say, decide, look } = faceBoard();
  open(a);
  look({ presence: "away" });
  say("案 1 でいこう", inner);
  decide(a);
  assert.deepEqual(out(), [], "離れているので待たない");
  w.stop();
});

test("決まった行の面：人のいまがわからない（画面がつながっていない）ときは、今までどおりすぐ畳む", () => {
  const { w, a, inner, open, out, say, decide } = faceBoard();
  open(a);
  say("案 1 でいこう", inner);
  decide(a);
  assert.deepEqual(out(), []);
  w.stop();
});

test("決まった行の面：決まったあとに開き直した面は畳まない。人の番の行の面も畳まない", () => {
  const { w, a, b, open, out, say, decide, look } = faceBoard();
  decide(a);
  open(b);
  open(a);
  look({ viewing: [], inside: [] });
  say("ほかの話");
  assert.deepEqual(out(), [b, a], "開き直したものと、まだ人の番のもの");
  w.stop();
});

// 同じ行の頼み直し：行を task に戻したら、前にその行を受け持った人のセッションを引き継いで起こす
async function reask(store, w, f, t, more) {
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "調べた" }, reason: "x" });
  f.jobs.filter((j) => j.taskId === t).at(-1).finish(more);
  await tick(10);
  const say = store.apply({ by: "human", type: "add", panel: { view: "say", data: "もうちょっと具体的に" } }).op.panel.id;
  const from = [...store.board.get(t).data.from, say];
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task", data: { ...store.board.get(t).data, from } }, reason: "頼み直し" });
  await tick(10);
  return say;
}

test("同じ行の頼み直し：1 回目は引き継ぎなし。頼み直しは前の人のセッション id を付け、足された発言だけの短い文で起こす", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6, names: ["ボブ", "アリス"] }).start();
  // ボブが別の仕事で働いているので、この行はアリスが受ける
  const x = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "ほかの仕事" } }, reason: "x" }).op.panel.id;
  await tick(10);
  const s1 = store.apply({ by: "human", type: "add", panel: { view: "say", data: "変更履歴を調べて" } }).op.panel.id;
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "変更履歴を調べる", from: [s1] } }, reason: "x" }).op.panel.id;
  await tick(10);
  const first = f.jobs.find((j) => j.taskId === t);
  assert.deepEqual([first.name, first.resume], ["アリス", undefined], "1 回目はまっさら");
  // ボブが空いても、頼み直しは前に受け持ったアリスに
  store.apply({ by: "ボブ", type: "edit", panel: { id: x, state: "done", line: "済んだ" }, reason: "x" });
  f.jobs.find((j) => j.taskId === x).finish({ code: 0, session: "s-x", cwd: "/room" });
  await tick(10);
  const say = await reask(store, w, f, t, { code: 0, session: "s-1", cwd: "/room" });
  const again = f.jobs.filter((j) => j.taskId === t);
  assert.equal(again.length, 2);
  assert.equal(again[1].name, "アリス");
  assert.deepEqual([again[1].resume.session, again[1].resume.cwd], ["s-1", "/room"]);
  assert.match(again[1].resume.prompt, /頼み直されました[\s\S]*もうちょっと具体的に[\s\S]*panel_edit で仕事 p\d+ に line と state done/);
  assert.doesNotMatch(again[1].resume.prompt, /変更履歴を調べて/, "前の回に渡した発言は繰り返さない");
  assert.ok(again[1].resume.prompt.includes(say));
  assert.match(again[1].prompt, /元の発言/, "まっさらに戻るときの文は今のまま持つ");
  w.stop();
});

test("同じ行の頼み直し：前の人が働いていれば別の人にまっさらで、セッション id が取れなかった回のあとはまっさらで起こす", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6, names: ["アリス", "ボブ"] }).start();
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる", from: [] } }, reason: "x" }).op.panel.id;
  await tick(10);
  // アリスが別の仕事で働いているあいだに頼み直されたら、ボブがまっさらで受ける
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "調べた" }, reason: "x" });
  f.jobs.at(-1).finish({ code: 0, session: "s-1", cwd: "/room" });
  await tick(10);
  store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "ほかの仕事", to: "アリス" } }, reason: "x" });
  await tick(10);
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task" }, reason: "頼み直し" });
  await tick(10);
  const bob = f.jobs.filter((j) => j.taskId === t).at(-1);
  assert.deepEqual([bob.name, bob.resume], ["ボブ", undefined]);
  // ボブの回はセッション id が取れなかった。次の頼み直しはまっさら（アリスの古いセッションも使わない）
  await reask(store, w, f, t, { code: 0 });
  const third = f.jobs.filter((j) => j.taskId === t).at(-1);
  assert.equal(f.jobs.filter((j) => j.taskId === t).length, 3);
  assert.equal(third.resume, undefined);
  w.stop();
});

test("同じ行の頼み直し：役が変われば（調べもの → 開発）引き継がない。名前を呼ばれたらその人", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6, names: ["アリス", "ボブ"] }).start();
  const t = store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "調べる", from: [] } }, reason: "x" }).op.panel.id;
  await tick(10);
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "調べた" }, reason: "x" });
  f.jobs.at(-1).finish({ code: 0, session: "s-1", cwd: "/room" });
  await tick(10);
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task", data: { text: "直す", from: [], write: true } }, reason: "x" });
  await tick(10);
  const dev = f.jobs.filter((j) => j.taskId === t).at(-1);
  assert.deepEqual([dev.role, dev.resume], ["dev", undefined]);
  store.apply({ by: "アリス", type: "edit", panel: { id: t, state: "done", line: "直した" }, reason: "x" });
  dev.finish({ code: 0, session: "s-2", cwd: "/work/p1" });
  await tick(10);
  store.apply({ by: "manager", type: "edit", panel: { id: t, state: "task", data: { text: "直す", from: [], write: true, to: "ボブ" } }, reason: "x" });
  await tick(10);
  const bob = f.jobs.filter((j) => j.taskId === t).at(-1);
  assert.deepEqual([bob.name, bob.resume], ["ボブ", undefined], "宛て先は崩さず、人が違えばまっさら");
  w.stop();
});
