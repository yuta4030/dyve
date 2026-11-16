import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { loadRoles } from "../src/roles.js";
import { Sessions } from "../src/sessions.js";
import { toFold, Folder, SaidMouth, saidPrompt } from "../src/kakari.js";
import { stageOf, callOf } from "../src/state.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();
const CARD = { line: "答え", back: "答え", steps: [], panels: [] };

// 記録を手で積んで、セッションを帰った・人待ちにする
function board() {
  const log = new Log();
  const say = (text) => log.add("say", { text }).record.seq;
  const open = (name) => log.add("open", { role: "調べもの", cwd: "/", name }).record.seq;
  const pass = (session, said) => log.add("pass", { session, said }).record;
  const run = (session) => log.add("start", { session, says: log.state.sessions.find((x) => x.id === session).pending });
  const back = (session, ask = null) => {
    run(session);
    const end = log.add("end", { session, claude: `c-${session}`, last: "答え", usage: {} }).record.seq;
    return log.add("card", { session, turn: end, ...CARD, ask }).record.seq;
  };
  return { log, say, open, pass, run, back, x: (id) => log.state.sessions.find((s) => s.id === id) };
}

test("畳む決まり：帰ったあとに置かれた発言が、別のセッションに届いたら畳む", () => {
  const b = board();
  const a = b.open("一");
  b.pass(a, b.say("一つめ"));
  b.back(a);
  const c = b.open("二");
  const r = b.pass(c, b.say("別の話"));
  assert.deepEqual(toFold(b.log.state, r).map((x) => x.id), [a]);
  // 同じセッションへの続きでは畳まない
  assert.deepEqual(toFold(b.log.state, { said: r.said, session: a }), []);
});

test("畳まない：帰る前に置かれた発言・人待ち・実行中・待たせている発言・届け直された前の発言", () => {
  const b = board();
  const a = b.open("一");
  b.pass(a, b.say("一つめ"));
  const early = b.say("帰る前に言った別の話");
  b.back(a);
  const c = b.open("二");
  assert.deepEqual(toFold(b.log.state, b.pass(c, early)), [], "帰る前に置かれた発言");

  const w = b.open("人待ち");
  b.pass(w, b.say("選ばせて"));
  b.back(w, { text: "どちら？", ref: null });
  assert.equal(stageOf(b.x(w)).stage, "wait");
  const run = b.open("実行中");
  b.pass(run, b.say("調べて"));
  b.run(run);
  const p = b.say("また別の話");
  const r = b.pass(c, p);
  assert.deepEqual(toFold(b.log.state, r).map((x) => x.id), [a], "人待ち・実行中は畳まない");

  // 待たせている発言があるものは畳まない
  b.pass(a, b.say("一の続き"));
  assert.deepEqual(toFold(b.log.state, b.pass(c, b.say("さらに別の話"))), []);

  // 届け直された前の発言は、帰ったあとに届いても畳まない
  const d = board();
  const s1 = d.open("一");
  d.pass(s1, d.say("一つめ"));
  d.back(s1);
  const old = d.say("ひとりごと");
  d.log.add("aside", { said: old });
  const s2 = d.open("二");
  assert.deepEqual(toFold(d.log.state, d.pass(s2, old)), []);
});

test("結果を出さずに終わったものも畳む。済みは記号を空け、ステートは済み（結果なしとわかる）", () => {
  const b = board();
  const a = b.open("一");
  b.pass(a, b.say("一つめ"));
  b.run(a);
  b.log.add("fail", { session: a, reason: "終了コード 1" });
  const c = b.open("二");
  const r = b.pass(c, b.say("別の話"));
  assert.deepEqual(toFold(b.log.state, r).map((x) => x.id), [a]);
  b.log.add("fold", { session: a, by: r.said });
  assert.deepEqual(stageOf(b.x(a)), { stage: "done", none: "終了コード 1" });
  assert.equal(b.x(a).sym, null);
  assert.equal(callOf(b.x(a)), `#${a}`);
  assert.deepEqual(toFold(b.log.state, b.pass(c, b.say("もっと別の話"))), [], "済みのものはもう畳まない");
});

test("戻す：済みに発言が届いたら戻り、空いているいちばん若い字を振り直し、後ろに並ぶ", () => {
  const b = board();
  const a = b.open("一"), c = b.open("二");
  assert.deepEqual([b.x(a).sym, b.x(c).sym], ["A", "B"]);
  b.pass(a, b.say("一つめ"));
  b.back(a);
  b.log.add("fold", { session: a, by: 1 });
  const d = b.open("三");
  assert.equal(b.x(d).sym, "A", "空いた字を次のセッションが使う");
  const p = b.pass(a, b.say("一の続き"));
  assert.equal(b.x(a).folded, null);
  assert.equal(b.x(a).sym, "C");
  assert.equal(b.x(a).shown, p.seq);
  assert.ok(b.x(a).shown > b.x(d).shown, "戻ったカードは後ろに並ぶ");
  assert.equal(stageOf(b.x(a)).stage, "back");
});

test("係の部品が、渡したあとに決まりどおり畳む（Claude Code を呼ばない）。記録は 渡した → 始まった → 畳んだ の順", async () => {
  const log = new Log();
  log.records = [];
  log.on((r) => log.records.push(r));
  const sessions = new Sessions({ log, roles, room: "/", spawn: () => ({ done: new Promise(() => {}), kill() {} }) }).start();
  new Folder({ log }).start();
  const s1 = sessions.ask(log.add("say", { text: "一" }).record.seq, { role: "調べもの", name: "一" }).session;
  const end = log.add("end", { session: s1, claude: "c", last: "x", usage: {} }).record.seq;
  log.add("card", { session: s1, turn: end, ...CARD });
  sessions.ask(log.add("say", { text: "二" }).record.seq, { role: "調べもの", name: "二" });
  await tick();
  assert.deepEqual(log.records.slice(-4).map((r) => r.kind), ["open", "pass", "start", "fold"]);
  assert.equal(stageOf(log.state.sessions[0]).stage, "done");
});

test("係に渡す文に済みのセッションが出る。#番号 で返されたら戻す。出ているものを # で指したら届けない", async () => {
  const log = new Log();
  const jobs = [];
  const sessions = new Sessions({ log, roles, room: "/", spawn: (j) => { jobs.push(j); return { done: new Promise(() => {}), kill() {} }; } }).start();
  const asks = [];
  const conv = { send: (text) => new Promise((resolve) => asks.push({ text, reply: (json) => resolve({ ok: true, json }) })), kill() {} };
  new SaidMouth({ log, sessions, roles, conv }).start();
  // 済みのセッションを一つ作る
  const a = log.add("say", { text: "依存を上げて" }).record.seq;
  log.add("aside", { said: a });
  const s1 = log.add("open", { role: "調べもの", cwd: "/", name: "依存の更新" }).record.seq;
  log.add("pass", { session: s1, said: a });
  log.add("start", { session: s1, says: [a] });
  const end = log.add("end", { session: s1, claude: "c-1", last: "3 件上げた", usage: {} }).record.seq;
  log.add("card", { session: s1, turn: end, line: "3 件上げて、テストは通った", back: "3 件", what: "古い依存を上げる", steps: [], panels: [] });
  log.add("fold", { session: s1, by: a });
  const b = log.add("say", { text: "依存の更新の件、もう一つ上げておいて" }).record.seq;
  await tick();
  const p = asks.at(-1).text;
  assert.match(p, new RegExp(`済みのセッション（[^）]*）：\\n- #${s1}「依存の更新」調べもの。古い依存を上げる。最後：3 件上げて、テストは通った`));
  assert.match(p, /いまのセッション：\n（なし）/, "済みはいまのセッションには出さない");
  asks.at(-1).reply({ says: [{ id: b, text: "依存の更新の件、もう一つ上げておいて", to: "session", session: `#${s1}` }] });
  await tick();
  const x = log.state.sessions[0];
  assert.equal(x.folded, null);
  assert.equal(x.sym, "A");
  assert.equal(jobs.at(-1).args[jobs.at(-1).args.indexOf("--resume") + 1], "c-1", "前の会話を引き継ぐ");
  // 出ているセッションを # で指すのはありもしない届け先
  const c = log.add("say", { text: "x" }).record.seq;
  await tick();
  asks.at(-1).reply({ says: [{ id: c, text: "x", to: "session", session: `#${s1}` }] });
  await tick();
  assert.match(log.state.said.at(-1).miss, /ありもしないセッション/);
  // 済みを覗いていた発言には #番号 が付く
  log.add("fold", { session: s1, by: c });
  log.add("say", { text: "それも", peek: s1 });
  await tick();
  assert.match(asks.at(-1).text, new RegExp(`（#${s1} を覗いていた）：それも`));
});
