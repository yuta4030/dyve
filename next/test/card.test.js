import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { loadRoles } from "../src/roles.js";
import { Sessions } from "../src/sessions.js";
import { SaidMouth, SessionMouth, Kakari, sessionPrompt, cardOf, panelOf, readDef, CARD_SCHEMA } from "../src/kakari.js";
import { stageOf, nowOf } from "../src/state.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();

function fakeConv() {
  const asks = [];
  return {
    asks,
    send: (text) => new Promise((resolve) => asks.push({ text, reply: (json) => resolve({ ok: true, json }), fail: (error) => resolve({ ok: false, error }) })),
    kill() {},
  };
}

// 偽の spawn：一ターンを流して終わらせられる
function fakeSpawn() {
  const jobs = [];
  const spawn = (job, emit) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    jobs.push({
      ...job, emit,
      run: async ({ id = "c-1", tools = [], says = [], fail = false, init = true } = {}) => {
        if (init) emit({ type: "system", subtype: "init", session_id: id });
        for (const t of tools) emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: t } }] } });
        for (const t of says) emit({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
        if (!fail) emit({ type: "result", subtype: "success", is_error: false, result: says.at(-1) ?? "", session_id: id, total_cost_usd: 0.001, usage: {} });
        finish({ code: fail ? 1 : 0, stderr: fail ? "API Error: overloaded" : "" });
        await tick();
      },
    });
    return { done, kill: () => finish({ code: null, stderr: "" }) };
  };
  return { jobs, spawn };
}

function setup(file = null) {
  const log = new Log(file);
  log.records = [];
  log.on((r) => log.records.push(r));
  const f = fakeSpawn();
  const sessions = new Sessions({ log, roles, room: "/tmp/room", spawn: f.spawn }).start();
  const conv = fakeConv();
  const mouth = new SessionMouth({ log, conv }).start();
  // 発言を新しいセッションへ（発言を読む口の代わりに直接渡す）
  const ask = (text, to = { role: "調べもの", name: "料金の調査" }) => {
    const said = log.add("say", { text }).record.seq;
    return sessions.ask(said, to).session;
  };
  return { log, f, sessions, conv, mouth, ask, x: (n = 0) => log.state.sessions[n] };
}

const CARD = { line: "競合 3 社の月額が出た", back: "甲社 980 円・乙社 1,480 円・丙社 2,000 円", what: "競合の値段を調べる", steps: [{ text: "月額を集める", state: "done" }], panels: [] };

test("係の定義：一瞬でわかるパネル、言っていないことを足さない、問いは聞いたことだけ", () => {
  const def = readDef("session");
  assert.match(def, /一瞬で/);
  assert.match(def, /セッションが言っていないことを足しません/);
  assert.match(def, /人への問いは、セッションが実際に聞いたことだけ/);
  assert.equal(CARD_SCHEMA.properties.panels.items.properties.view.type, "string", "置き場の view の名前も書けるよう、名前は絞らない");
  assert.match(def, /置き場の view/);
});

test("止まったら係に渡す：セッション・頼んだこと・前のカード・やりとり（通し番号つき）・最後の言葉", async () => {
  const t = setup();
  t.ask("競合の値段を調べて");
  assert.equal(stageOf(t.x()).stage, "run");
  await t.f.jobs[0].run({ tools: ["/tmp/room/a.md"], says: ["甲社は 980 円でした。"] });
  assert.equal(t.conv.asks.length, 1);
  assert.equal(stageOf(t.x()).stage, "run", "係が読むまでは実行中のまま");
  const p = t.conv.asks[0].text;
  const x = t.x();
  const talk = x.flow.find((f) => f.talk), tool = x.flow.find((f) => f.tool);
  assert.match(p, /^セッション：A「料金の調査」（役割：調べもの）/);
  assert.match(p, new RegExp(`頼んだこと：\\n- ${x.asked[0]}：競合の値段を調べて`));
  assert.match(p, /前のカード：なし/);
  assert.match(p, new RegExp(`- ${x.asked[0]} 人：競合の値段を調べて\\n- ${tool.seq} 道具：Read /tmp/room/a.md\\n- ${talk.seq} セッション：甲社は 980 円でした。`));
  assert.match(p, /最後の言葉：\n甲社は 980 円でした。$/);
});

test("返ったカードを記録に置き、状態に出す。問いがなければ帰った、あれば人待ち", async () => {
  const t = setup();
  t.ask("競合の値段を調べて");
  await t.f.jobs[0].run({ says: ["3 社の月額が出ました。"] });
  t.conv.asks[0].reply(CARD);
  await tick();
  const x = t.x();
  assert.equal(x.card.line, "競合 3 社の月額が出た");
  assert.equal(x.card.turn, x.turn);
  assert.deepEqual(stageOf(x), { stage: "back", none: null });
  assert.equal(nowOf(x), "競合 3 社の月額が出た");
  assert.deepEqual(t.log.state.backs.map((b) => [b.kind, b.session, b.text]), [["card", x.id, "甲社 980 円・乙社 1,480 円・丙社 2,000 円"]]);
  // 次のターンは聞いてきて止まる
  t.ask("年払いも", { session: x.id });
  assert.equal(stageOf(t.x()).stage, "run");
  await t.f.jobs[1].run({ says: ["年払いは月払いと比べますか、総額で比べますか。"] });
  const q = t.x().flow.findLast((f) => f.talk);
  t.conv.asks[1].reply({ line: "年払いの比べ方を決めてほしい", back: "月払いと比べるか、総額で比べるか決めてほしい", ask: { text: "月払いと比べるか、総額で比べるか", ref: q.seq } });
  await tick();
  assert.equal(stageOf(t.x()).stage, "wait");
  assert.deepEqual(t.x().card.ask, { text: "月払いと比べるか、総額で比べるか", ref: q.seq, outward: false });
  assert.equal(t.x().card.what, "競合の値段を調べる", "何のセッションかは、返さなければ前のまま");
  // 二枚目は、前のカードのあとのやりとりだけを渡す
  const p = t.conv.asks[1].text;
  assert.match(p, /前のカード：\{"line":"競合 3 社の月額が出た"/);
  assert.doesNotMatch(p, /3 社の月額が出ました。/);
  assert.match(p, /人：年払いも/);
});

test("結果を出さずに終わったら係を呼ばない。帰った・結果なしとわかり、チャットにも出る", async () => {
  const t = setup();
  t.ask("a");
  await t.f.jobs[0].run({ fail: true });
  await tick();
  assert.equal(t.conv.asks.length, 0);
  const x = t.x();
  assert.deepEqual(stageOf(x), { stage: "back", none: "終了コード 1：API Error: overloaded" });
  assert.deepEqual(t.log.state.backs.map((b) => b.kind), ["fail"]);
});

test("引き継げずにまっさらで起こし直すときの fail は、チャットに返さない", async () => {
  const t = setup();
  const s = t.ask("a");
  await t.f.jobs[0].run({ says: ["はい"] });
  t.conv.asks[0].reply(CARD);
  await tick();
  t.ask("b", { session: s });
  t.f.jobs[1].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found"] });
  await t.f.jobs[1].run({ fail: true, init: false });
  await tick();
  assert.ok(t.log.records.some((r) => r.kind === "fail" && r.retry));
  assert.deepEqual(t.log.state.backs.map((b) => b.kind), ["card"]);
});

test("係が読めなかったら、それとわかる記録を置き、帰ったに倒す。チャットには最後の言葉の頭。やり直さない", async () => {
  const t = setup();
  t.ask("a");
  await t.f.jobs[0].run({ says: ["結論：甲社がいちばん安い。\n詳しくは…"] });
  t.conv.asks[0].fail("30 秒で返らなかった");
  await tick(20);
  const x = t.x();
  assert.equal(t.log.records.at(-1).kind, "nocard");
  assert.deepEqual(stageOf(x), { stage: "back", none: null });
  assert.deepEqual(t.log.state.backs.map((b) => [b.kind, b.text]), [["nocard", "結論：甲社がいちばん安い。"]]);
  assert.equal(t.conv.asks.length, 1);
  // 読めない形が返ったときも同じ
  t.ask("b", { session: x.id });
  await t.f.jobs[1].run({ says: ["はい"] });
  t.conv.asks[1].reply({ nope: true });
  await tick();
  assert.equal(t.log.records.at(-1).reason, "係の返したカードが読めない");
});

test("同じターンを二度読まない。続けて止まった二つのセッションは、順に一つずつ読む", async () => {
  const t = setup();
  t.ask("a", { role: "調べもの", name: "一" });
  t.ask("b", { role: "調べもの", name: "二" });
  await t.f.jobs[0].run({ says: ["一つめ"] });
  await t.f.jobs[1].run({ says: ["二つめ"] });
  assert.equal(t.conv.asks.length, 1, "一つ読んでいるあいだは次を渡さない");
  assert.match(t.conv.asks[0].text, /「一」/);
  t.conv.asks[0].reply(CARD);
  await tick();
  assert.equal(t.conv.asks.length, 2);
  assert.match(t.conv.asks[1].text, /「二」/);
  t.conv.asks[1].reply(CARD);
  await tick();
  t.mouth.kick();
  await tick();
  assert.equal(t.conv.asks.length, 2, "読んだターンは読まない");
});

test("待たせていた発言ですぐ次のターンが始まったら、そのターンは読まず、次に止まったときにまとめて読む", async () => {
  const t = setup();
  const s = t.ask("a");
  t.ask("b", { session: s });
  await t.f.jobs[0].run({ says: ["一つめの答え"] });
  assert.equal(t.x().running, true, "すぐ次のターン");
  assert.equal(t.conv.asks.length, 0);
  await t.f.jobs[1].run({ says: ["二つめの答え"] });
  assert.equal(t.conv.asks.length, 1);
  assert.match(t.conv.asks[0].text, /一つめの答え[\s\S]*二つめの答え/);
});

test("立て直したとき、止まっているのにまだ読んでいないターンを読む", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-")), "record.jsonl");
  const t = setup(file);
  t.ask("a");
  await t.f.jobs[0].run({ says: ["答え"] });
  t.mouth.stop(); // 読んでいる途中で落ちた
  const log = new Log(file), conv = fakeConv();
  new SessionMouth({ log, conv }).start();
  await tick();
  assert.equal(conv.asks.length, 1);
  assert.equal(stageOf(log.state.sessions[0]).stage, "run");
});

test("二つの口は互いに待たせない", async () => {
  const t = setup();
  const saidConv = fakeConv();
  new Kakari([new SaidMouth({ log: t.log, sessions: t.sessions, roles, conv: saidConv })]).start();
  t.ask("a");
  await t.f.jobs[0].run({ says: ["答え"] });
  assert.equal(t.conv.asks.length, 1, "セッションを読む口は読みはじめた");
  t.log.add("say", { text: "次の話" });
  await tick();
  assert.equal(saidConv.asks.length, 1, "発言を読む口も、待たずに読む");
});

test("カードを確かめる：ありもしない ref は外し、知らない view は落とし、中身のないパネルは捨てる", () => {
  const x = { asked: [1], flow: [{ seq: 4, said: 1 }, { seq: 5, tool: "Read a" }, { seq: 6, talk: "x" }], card: { what: "前の what" } };
  const c = cardOf({
    line: "  一行  ", back: "",
    steps: [{ text: "a", state: "now" }, { text: "b", state: "?" }, { text: "" }],
    ask: { text: "どちらにしますか", ref: 99 },
    panels: [
      { view: "table", title: "月額", data: { columns: ["会社", "月額"], rows: [{ cells: ["甲社", 980], ref: 6 }, { cells: ["乙社"], ref: 77 }, ["丙社", "2,000 円"]] } },
      { view: "list", data: ["a", { text: "b", value: "落ちる", ref: 5 }, { text: "" }] },
      { view: "bars", data: "棒グラフのつもり" },
      { view: "summary", data: [{ label: "テスト", value: 14, ref: 1 }] },
    ],
  }, x);
  assert.equal(c.line, "一行");
  assert.equal(c.back, "一行", "チャットの一行がなければ、カードの一行");
  assert.equal(c.what, "前の what");
  assert.deepEqual(c.steps, [{ text: "a", state: "now" }, { text: "b", state: "todo" }]);
  assert.deepEqual(c.ask, { text: "どちらにしますか", ref: null, outward: false });
  assert.equal(c.panels.length, 3, "三枚まで");
  assert.deepEqual(c.panels[0], { view: "table", title: "月額", data: { columns: ["会社", "月額"], rows: [{ cells: ["甲社", "980"], ref: 6 }, { cells: ["乙社", ""] }, { cells: ["丙社", "2,000 円"] }] } });
  assert.deepEqual(c.panels[1].data, [{ text: "a" }, { text: "b", value: "落ちる", ref: 5 }]);
  assert.deepEqual(c.panels[2], { view: "text", data: "棒グラフのつもり" });
  assert.deepEqual(panelOf({ view: "summary", data: [{ label: "テスト", value: 14, ref: 1 }] }, new Set([1])), { view: "summary", data: [{ label: "テスト", value: "14", ref: 1 }] });
  assert.equal(panelOf({ view: "list", data: [] }, new Set()), null);
  assert.equal(panelOf({ view: "table", data: { columns: [], rows: [] } }, new Set()), null);
  assert.equal(cardOf({ line: "", back: "" }, x), null, "一行がなければ読めなかったことにする");
});

test("チャットに並ぶ順：発言と帰った一行が通し番号の順に", async () => {
  const t = setup();
  const s = t.ask("a");
  await t.f.jobs[0].run({ says: ["答え"] });
  t.log.add("say", { text: "その間に別の話" });
  t.conv.asks[0].reply(CARD);
  await tick();
  const st = t.log.state;
  const items = [...st.said.map((p) => [p.id, p.text]), ...st.backs.map((b) => [b.seq, b.text])].sort((a, b) => a[0] - b[0]).map((i) => i[1]);
  assert.deepEqual(items, ["a", "その間に別の話", CARD.back]);
  assert.equal(st.backs[0].session, s);
});
