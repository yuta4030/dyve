// 行と面：話題は表、中の仕事は行。結果は行に帰り、行の状態は誰の番かで導く
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { Board, turnOf, hasAiAnswer, layoutOf } from "../src/board.js";
import { Waker, managerPrompt, taskPrompt, arrivals } from "../src/waker.js";
import { handleRpc, TOOLS } from "../src/mcp.js";
import { toMarkdown } from "../src/export.js";

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
// 朝会の表：話題と行
// store を渡すと store を通して積む（起こし係に届く）
function morning(t = new Board()) {
  const b = t.board ?? t;
  const ap = (o) => { const r = t.apply(o); assert.ok(r.ok, JSON.stringify(r)); return r.op.panel.id; };
  const say = ap({ by: "human", type: "add", panel: { view: "say", data: "朝会やろう" } });
  const topic = ap({ by: "manager", type: "add", panel: { view: "topic", data: { title: "朝会" } }, reason: "朝会" });
  const row = (title) => ap({ by: "manager", type: "add", panel: { view: "task", state: "task", about: topic, data: { title, text: `${title}を見る`, from: [say] } }, reason: "行" });
  return { b, ap, say, topic, row };
}

test("行の記号はボードが振る：話題の中は A, B, …、行の中の行は F1, F2。当て直しても同じ", () => {
  const { b, row, ap, topic } = morning();
  const ids = ["ログイン", "料金", "リリースノート", "依存", "返信", "CSV"].map(row);
  assert.deepEqual(ids.map((id) => b.get(id).key), ["A", "B", "C", "D", "E", "F"]);
  const sub = ap({ by: "manager", type: "add", panel: { view: "task", state: "task", about: ids[5], data: { text: "件数の上限" } }, reason: "面の中の呼び出し" });
  assert.equal(b.get(sub).key, "F1");
  // 外した行の記号は、ほかの行と重ならなければ空いたまま。話題の外へ出た仕事には付かない
  ap({ by: "manager", type: "edit", panel: { id: ids[1], about: null }, reason: "外へ" });
  assert.equal(b.get(ids[1]).key, undefined);
  const g = ap({ by: "manager", type: "add", panel: { view: "task", state: "task", about: topic, data: { text: "新しい" } }, reason: "行" });
  assert.equal(b.get(g).key, "B");
  // AI も人も記号は付けられない（ボードが導く）
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: g, key: "Z" }, reason: "x" }).code, "invalid");
  const again = new Board(b.log);
  assert.deepEqual(again.list().map((p) => p.key ?? null), b.list().map((p) => p.key ?? null));
});

test("誰の番か：投げて返っていない（ai）→ 一行が帰る（back）→ 決める（ok）→ 実行に移すとまた ai。同じ行で何往復もする", () => {
  const { b, row } = morning();
  const a = row("ログイン");
  assert.equal(turnOf(b, b.get(a)), "ai");
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: a, line: "原因はセッションの期限", state: "done" }, reason: "結果" }).ok, true);
  assert.equal(turnOf(b, b.get(a)), "back", "投げた仕事が帰った行は読むだけ");
  assert.equal(hasAiAnswer(b, a), true);
  b.apply({ by: "manager", type: "edit", panel: { id: a, decided: "今日やる" }, reason: "人が今日やると言った" });
  assert.equal(turnOf(b, b.get(a)), "ok");
  // 実行に移す：AI の番に戻り、前の答えは数えない（控室がまた起こす）
  b.apply({ by: "manager", type: "edit", panel: { id: a, state: "task", data: { title: "ログイン", text: "直して取り込む" } }, reason: "取り込んで" });
  assert.equal(turnOf(b, b.get(a)), "ai");
  assert.equal(hasAiAnswer(b, a), false);
  b.apply({ by: "アリス", type: "edit", panel: { id: a, line: "取り込んだ", state: "done" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(a)), "back", "決めたあとに実行に移して帰った一行は、また帰った");
  // 提案が付いた行は、受け入れるまで人の番
  const c = row("返信");
  b.apply({ by: "ボブ", type: "add", panel: { view: "text", about: c, state: "proposal", data: "下書きを送る" }, reason: "提案" });
  b.apply({ by: "ボブ", type: "edit", panel: { id: c, state: "done", line: "下書きができた。送ってよいか" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(c)), "you");
  // 一行の形
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: a, line: "x".repeat(201) }, reason: "x" }).code, "invalid");
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: a, line: "" }, reason: "x" }).code, "invalid");
});

test("帰った（back）と人の番（you）：仕事が帰った行は読むだけ。問いの行・提案・下の問い・ボードが帰した行は人の番", () => {
  const { b, row, ap, topic } = morning();
  // 帰った：投げた仕事に一行が帰った
  const a = row("ログイン");
  b.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "原因はセッションの期限" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(a)), "back");
  // 問いの行：マネージャがはじめから done と line で置いたもの（一度も仕事になっていない）は人の番
  const q = ap({ by: "manager", type: "add", panel: { view: "task", state: "done", about: topic, line: "今日リリースするか", data: { title: "リリース" } }, reason: "問い" });
  assert.equal(turnOf(b, b.get(q)), "you");
  // 帰った行でも、行に提案が置かれれば人の番。受け入れれば帰った
  const pr = ap({ by: "アリス", type: "add", panel: { view: "text", about: a, state: "proposal", data: "期限を延ばす" }, reason: "提案" });
  assert.equal(turnOf(b, b.get(a)), "you");
  const yes = ap({ by: "human", type: "add", panel: { view: "say", data: "それでいい" } });
  b.apply({ by: "manager", type: "edit", panel: { id: pr, state: "done" }, from: [yes], reason: "声で受け入れた" });
  assert.equal(turnOf(b, b.get(a)), "back");
  // 下（行の中の行）に問いがあれば人の番。行の中の行が帰っただけなら帰った
  const sub = ap({ by: "manager", type: "add", panel: { view: "task", state: "task", about: a, data: { text: "影響の範囲" } }, reason: "面の中の呼び出し" });
  assert.equal(turnOf(b, b.get(a)), "back");
  b.apply({ by: "ボブ", type: "edit", panel: { id: sub, state: "done", line: "ログイン画面だけ" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(sub)), "back");
  assert.equal(turnOf(b, b.get(a)), "back");
  const ask = ap({ by: "manager", type: "add", panel: { view: "task", state: "done", about: a, line: "期限は何日にするか", data: { text: "期限" } }, reason: "問い" });
  assert.equal(b.get(ask).key, "A2");
  assert.equal(turnOf(b, b.get(a)), "you", "下に問いの行があれば人の番");
  // 下の問いを決めれば、帰ったに戻る。人が行を決めれば決まった
  b.apply({ by: "manager", type: "edit", panel: { id: ask, decided: "7 日" }, reason: "決めた" });
  assert.equal(turnOf(b, b.get(a)), "back");
  b.apply({ by: "manager", type: "edit", panel: { id: a, decided: "今日やる" }, reason: "決めた" });
  assert.equal(turnOf(b, b.get(a)), "ok");
  // 仕事に戻して、また帰れば帰った
  b.apply({ by: "manager", type: "edit", panel: { id: a, state: "task" }, reason: "実行に移す" });
  assert.equal(turnOf(b, b.get(a)), "ai");
  b.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "直した" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(a)), "back");
  // 問いの行を決めて仕事にすれば、帰ったあとは帰った
  b.apply({ by: "manager", type: "edit", panel: { id: q, decided: "する", state: "task" }, reason: "実行に移す" });
  b.apply({ by: "アリス", type: "edit", panel: { id: q, state: "done", line: "出した" }, reason: "結果" });
  assert.equal(turnOf(b, b.get(q)), "back");
  // データには持たず導く：当て直しても同じ
  const again = new Board(b.log);
  assert.deepEqual(again.list().map((p) => turnOf(again, p)), b.list().map((p) => turnOf(b, p)));
  assert.ok(b.log.every((op) => !("taskSeq" in op.panel) && !("lineBy" in op.panel)), "ログの形は変えない");
  // 外から導いた項目を書くことはできない（知らない項目は捨てる）
  b.apply({ by: "アリス", type: "edit", panel: { id: q, taskSeq: 0, lineBy: "board" }, reason: "x" });
  assert.equal(turnOf(b, b.get(q)), "back");
});

test("待ち：wait { text, until?, after? }。待っているあいだは誰の番でもない", () => {
  const { b, row } = morning();
  const a = row("A"), bb = row("B");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: a, state: "done", wait: { text: "B のあと", after: bb } }, reason: "B のあとで" }).ok, true);
  assert.equal(turnOf(b, b.get(a)), "wait");
  assert.deepEqual(b.get(a).wait, { text: "B のあと", after: bb });
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: a, wait: { text: "x", after: "nai" } }, reason: "x" }).code, "not_found");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: a, wait: { text: "x", until: "あした" } }, reason: "x" }).code, "invalid");
});

test("声で受け入れる：マネージャが、提案のあとの人の発言を from に付けたときだけ。from は操作ログに残る", () => {
  const { b, ap, row } = morning();
  const e = row("返信");
  const pr = ap({ by: "ボブ", type: "add", panel: { view: "text", about: e, state: "proposal", data: "送る" }, reason: "提案" });
  const before = ap({ by: "human", type: "add", panel: { view: "say", data: "（提案の前の発言）" } });
  // 提案を書き換えた後の発言でないと受け入れにならない
  b.apply({ by: "ボブ", type: "edit", panel: { id: pr, state: "proposal", data: "送る（直した）" }, reason: "直した" });
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: pr, state: "done" }, reason: "x" }).code, "forbidden", "from がなければ人だけ");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: pr, state: "done" }, from: [before], reason: "x" }).code, "forbidden", "提案より前の発言では受け入れない");
  const yes = ap({ by: "human", type: "add", panel: { view: "say", data: "それでいいよ" } });
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: pr, state: "done" }, from: [yes], reason: "x" }).code, "forbidden", "マネージャだけ");
  const r = b.apply({ by: "manager", type: "edit", panel: { id: pr, state: "done" }, from: [yes], reason: "人が「それでいいよ」と言った" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.op.from, [yes]);
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: pr, data: "x" }, from: "p1", reason: "x" }).code, "invalid");
});

test("起こし係：声で受け入れた提案は、提案を置いた人に仕事として戻る", async (t) => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  t.after(() => w.stop());
  const { ap, row } = morning(store);
  const apply = (o) => { const r = store.apply(o); assert.ok(r.ok, JSON.stringify(r)); return r.op.panel.id; };
  const e = row("返信");
  const pr = apply({ by: "ボブ", type: "add", panel: { view: "text", about: e, state: "proposal", data: "下書きを送る" }, reason: "提案" });
  const yes = apply({ by: "human", type: "add", panel: { view: "say", data: "それでいいよ" } });
  apply({ by: "manager", type: "edit", panel: { id: pr, state: "done" }, from: [yes], reason: "声で受け入れた" });
  const act = store.board.list().find((p) => p.data?.accepted === pr);
  assert.ok(act, "受け入れた提案の仕事");
  assert.equal(act.data.to, "ボブ");
  assert.equal(act.data.title, "下書きを送る");
  // 箇条書きの提案は、JSON の文字列でなく一行ずつの文で頼む
  const pr2 = apply({ by: "ボブ", type: "add", panel: { view: "list", about: e, state: "proposal", data: ["PR #16 をマージする（gh pr merge 16 --merge）", "タグは CI が作る"] }, reason: "提案" });
  const yes2 = apply({ by: "human", type: "add", panel: { view: "say", data: "マージしていいよ" } });
  apply({ by: "manager", type: "edit", panel: { id: pr2, state: "done" }, from: [yes2], reason: "声で受け入れた" });
  const act2 = store.board.list().find((p) => p.data?.accepted === pr2);
  assert.equal(act2.data.text, "- PR #16 をマージする（gh pr merge 16 --merge）\n- タグは CI が作る");
  assert.equal(act2.data.title, "PR #16 をマージする（gh pr …");
  void ap;
  w.stop();
});

test("起こし係：待ちは、先の行が済むか日時が来たら、人の番で帰す", async () => {
  let now = Date.parse("2026-11-10T09:00:00Z");
  const store = new Store();
  const w = new Waker({ store, spawn: fakeSpawn().spawn, pause: 1e6, slots: 0, now: () => now }).start();
  const { row } = morning(store);
  const a = row("A"), bb = row("B"), c = row("C");
  store.apply({ by: "manager", type: "edit", panel: { id: a, state: "done", wait: { text: "B のあと", after: bb } }, reason: "B のあとで" });
  store.apply({ by: "manager", type: "edit", panel: { id: c, state: "done", wait: { text: "明日まで", until: "2026-11-11T00:00:00Z" } }, reason: "明日まで" });
  assert.equal(turnOf(store.board, store.board.get(a)), "wait");
  store.apply({ by: "ボブ", type: "edit", panel: { id: bb, state: "done", line: "済んだ" }, reason: "結果" });
  assert.equal(turnOf(store.board, store.board.get(a)), "you");
  assert.match(store.board.get(a).line, /待ちが明けた：B のあと/);
  assert.equal(store.board.history(a).at(-1).by, "board");
  assert.equal(turnOf(store.board, store.board.get(c)), "wait");
  now = Date.parse("2026-11-11T00:00:01Z");
  w._waits();
  assert.equal(turnOf(store.board, store.board.get(c)), "you");
  w.stop();
});

test("起こし係：決まった行の面は、ボードが行に畳む。返ってきた結果だけでは開かない", async () => {
  const store = new Store();
  const w = new Waker({ store, spawn: fakeSpawn().spawn, pause: 1e6, slots: 0 }).start();
  const { row } = morning(store);
  const a = row("A"), f = row("F");
  const lp = store.apply({ by: "human", type: "add", panel: { view: "layout", data: { v: 3, pos: {}, zoom: {}, fold: {}, out: [f], pinned: [], inner: { tpos: {}, sizes: {} } } } }).op.panel.id;
  store.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "返った" }, reason: "結果" });
  assert.deepEqual(layoutOf(store.board.get(lp).data).out, [f], "返っただけでは面は開かない");
  store.apply({ by: "アリス", type: "edit", panel: { id: f, state: "done", line: "案が三つ" }, reason: "結果" });
  assert.deepEqual(layoutOf(store.board.get(lp).data).out, [f], "人の番になっても開いたまま");
  store.apply({ by: "manager", type: "edit", panel: { id: f, decided: "案 1" }, reason: "決まった" });
  assert.deepEqual(layoutOf(store.board.get(lp).data).out, [], "決まったら閉じる（画面がつながっていないので、人が離れるのを待たない）");
  assert.equal(store.board.history(lp).at(-1).by, "board");
  w.stop();
});

test("止まった仕事は行に帰す（人の番：止まったのを知る）", async () => {
  const store = new Store();
  const f = fakeSpawn();
  const w = new Waker({ store, spawn: f.spawn, pause: 1e6 }).start();
  const { row } = morning(store);
  const a = row("A");
  f.jobs.find((j) => j.taskId === a).finish({ code: 1, error: "終了コード 1" });
  await tick();
  assert.equal(turnOf(store.board, store.board.get(a)), "you");
  assert.match(store.board.get(a).line, /結果を置かずに終わりました（終了コード 1）/);
  w.stop();
});

test("マネージャへの文：表（記号・番・帰った一行）、届いたばかり（「それ」）、開いている面", () => {
  const { b, row, ap } = morning();
  const a = row("ログイン"), bb = row("料金");
  b.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "原因はセッションの期限" }, reason: "結果" });
  const since = b.seq;
  b.apply({ by: "ボブ", type: "edit", panel: { id: bb, state: "done", line: "半分まで" }, reason: "結果" });
  ap({ by: "human", type: "add", panel: { view: "layout", data: { v: 3, pos: {}, out: [bb] } } });
  ap({ by: "human", type: "add", panel: { view: "say", data: "それは今日やる" } });
  const m = managerPrompt(since, b);
  assert.match(m, new RegExp(`A（${a}）［帰った（読むだけ）］ログイン ?を見る`));
  assert.match(m, /→ 原因はセッションの期限/);
  assert.match(m, /## 届いたばかり[^\n]*\n- B（[^)]+）［前に起きてから］：半分まで\n- A/);
  assert.match(m, new RegExp(`## 開いている面\\n- B（${bb}）`));
  assert.deepEqual(arrivals(b).map((x) => x.p.id), [bb, a]);
  // 控室への文：結果は行に帰す
  const t = taskPrompt(b, b.get(a), "アリス");
  assert.match(t, /表の行 A です/);
  assert.match(t, /line（答えの一行/);
  assert.match(t, /新しいパネルは足しません/);
});

test("MCP：line・decided・wait と、panel_edit の from。board_read は行の番（turns）を返す", () => {
  const tools = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.properties]));
  for (const k of ["line", "decided", "wait"]) { assert.ok(k in tools.panel_add, k); assert.ok(k in tools.panel_edit, k); }
  assert.ok("from" in tools.panel_edit);
  const store = new Store();
  const { row } = morning(store);
  const a = row("A");
  const call = (as, name, args) => JSON.parse(handleRpc(store, null, as, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).result.content[0].text);
  assert.equal(call("アリス", "panel_edit", { id: a, line: "返った", state: "done", reason: "結果" }).ok, true);
  const read = call("アリス", "board_read", {});
  assert.equal(read.turns[a], "back");
  const yes = store.apply({ by: "human", type: "add", panel: { view: "say", data: "今日やる" } }).op.panel.id;
  assert.equal(call("manager", "panel_edit", { id: a, decided: "今日やる", from: [yes], reason: "決めた" }).ok, true);
  assert.deepEqual(store.board.log.at(-1).from, [yes]);
  assert.equal(call("アリス", "board_read", {}).turns[a], "ok");
});

test("書き出し：行の記号・番・帰った一行・決まったこと・待ちも落とさない", () => {
  const { b, row } = morning();
  const a = row("ログイン"), bb = row("料金");
  b.apply({ by: "アリス", type: "edit", panel: { id: a, state: "done", line: "原因はセッションの期限" }, reason: "結果" });
  b.apply({ by: "manager", type: "edit", panel: { id: a, decided: "今日やる" }, reason: "決めた" });
  b.apply({ by: "manager", type: "edit", panel: { id: bb, state: "done", wait: { text: "A のあと", after: a } }, reason: "待ち" });
  const md = toMarkdown(b, { now: new Date("2026-11-10T09:00:00Z") });
  assert.match(md, /- A\. manager：ログインを見る（決まった・済み）/);
  assert.match(md, /→ 原因はセッションの期限/);
  assert.match(md, /決まった：今日やる/);
  assert.match(md, /待ち：A のあと（A のあと）/);
});

test("約束：操作ログ。0.7.0 が書いたログを当て直せて、話題の中の仕事に行の記号が付く", () => {
  const board = new Store(fileURLToPath(new URL("./fixtures/board-0.7.0.jsonl", import.meta.url))).board;
  assert.equal(board.seq, 11);
  const tasks = board.list().filter((p) => p.view === "task");
  assert.deepEqual(tasks.map((t) => t.key), ["A", "B"]);
  // 0.7.0 の済んだ仕事は、行に一行を持たないので決まったものとして読む（古いボードが人の番で埋まらない）。まだの仕事は AI の番
  assert.deepEqual(tasks.map((t) => turnOf(board, t)), ["ok", "ai"]);
  assert.equal(board.list().find((p) => p.view === "say" && p.point).point.how, "hover");
  assert.deepEqual(layoutOf(board.list().find((p) => p.view === "layout").data).out, [tasks[0].id]);
  assert.equal(board.apply({ by: "アリス", type: "edit", panel: { id: tasks[1].id, line: "続き" }, reason: "x" }).ok, true);
});

test("発言を元にした書き換え：どの発言に何と応えたか（heard）をボードが導く。あとで書き換わっても、そのときの言葉を持つ", () => {
  const b = new Board();
  const say = (t) => b.apply({ by: "human", type: "add", panel: { view: "say", data: t } }).op.panel.id;
  const topic = b.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "朝会", note: "はじめた" } }, reason: "x" }).op.panel.id;
  const row = b.apply({ by: "manager", type: "add", panel: { view: "task", state: "done", about: topic, data: { text: "A" }, line: "どうする？" }, reason: "x" }).op.panel.id;
  const s1 = say("A は今日やる"), s2 = say("今日はここまで");
  const d = b.apply({ by: "manager", type: "edit", panel: { id: row, decided: "今日やる" }, from: [s1], reason: "決めた" });
  assert.deepEqual(b.get(row).heard, { from: [s1], seq: d.op.seq, by: "manager", text: "今日やる" });
  const n = b.apply({ by: "manager", type: "edit", panel: { id: topic, data: { title: "朝会", note: "A は今日。終わり" } }, from: [s2], reason: "締め" });
  assert.deepEqual(b.get(topic).heard, { from: [s2], seq: n.op.seq, by: "manager", text: "A は今日。終わり" });
  // from のない書き換えでは変わらない。言葉のない書き換え（state だけ）でも変わらない
  b.apply({ by: "manager", type: "edit", panel: { id: topic, data: { title: "朝会", note: "あとで直した" } }, reason: "直す" });
  b.apply({ by: "manager", type: "edit", panel: { id: row, wait: { text: "明日まで" } }, from: [s2], reason: "待ち" });
  assert.equal(b.get(topic).heard.text, "A は今日。終わり");
  assert.equal(b.get(row).heard.text, "今日やる");
  // 当て直しても同じ。操作ログの形は変わらない（from は操作に付く）
  assert.deepEqual(new Board(b.log).get(row).heard, b.get(row).heard);
  assert.deepEqual(Object.keys(d.op).sort(), ["at", "by", "from", "panel", "reason", "seq", "type"]);
});
