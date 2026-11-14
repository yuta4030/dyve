import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { loadRoles } from "../src/roles.js";
import { Sessions } from "../src/sessions.js";
import { Words } from "../src/words.js";
import { SaidMouth, Kakari, Conv, saidPrompt, readDef, SAID_SCHEMA } from "../src/kakari.js";
import { symbolOf, replay } from "../src/state.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();

// 偽の係の会話：渡された一通を並べ、こちらから答えを返す
function fakeConv() {
  const asks = [];
  return {
    asks,
    send: (text) => new Promise((resolve) => asks.push({ text, reply: (json) => resolve({ ok: true, json }), fail: (error) => resolve({ ok: false, error }) })),
    kill() {},
  };
}
// 偽のセッション：起こされても何もしない（係がセッションを待たないことを見る）
const idle = () => ({ done: new Promise(() => {}), kill() {} });

function setup({ words = null } = {}) {
  const log = new Log();
  log.records = [];
  log.on((r) => log.records.push(r));
  const jobs = [];
  const sessions = new Sessions({ log, roles, room: "/tmp/room", spawn: (job) => { jobs.push(job); return idle(); } }).start();
  const conv = fakeConv();
  const mouth = new SaidMouth({ log, sessions, roles, words, conv });
  const kakari = new Kakari([mouth]).start();
  const say = (text) => log.add("say", { text }).record.seq;
  return { log, sessions, conv, mouth, kakari, jobs, say };
}

test("係の定義は役割だけ。決まった形の JSON で返させる", () => {
  const def = readDef("said");
  assert.match(def, /清書/);
  assert.match(def, /迷ったら届けるほうに倒します/);
  assert.match(def, /意味は変えない。足さない。要約しない/);
  assert.deepEqual(SAID_SCHEMA.properties.says.items.properties.to.enum, ["session", "new", "none"]);
});

test("係に渡す一通：選べる役割・辞書・いまのセッション・直前の発言・新しい発言", async () => {
  const words = new Words();
  words.add({ by: "人", heard: "だいぶ", write: "dyve", when: "dyve の話のとき" });
  const t = setup({ words });
  const a = t.say("競合の値段を調べて");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "競合の値段を調べて", to: "new", role: "調べもの", name: "競合の値段" }] });
  await tick();
  const b = t.say("えーと、ねんばらいも");
  await tick();
  const p = t.conv.asks[1].text;
  assert.match(p, /選べる役割：\n- 調べもの：頼まれたことを/);
  assert.doesNotMatch(p, /- 開発：|- パネル：/, "起きる場所がまだない役割は選ばせない");
  assert.match(p, /辞書：\n- だいぶ → dyve（dyve の話のとき）/);
  assert.match(p, /いまのセッション：\n- A「競合の値段」調べもの・実行中。頼んだこと：競合の値段を調べて/);
  assert.match(p, new RegExp(`直前の発言：\\n- ${a}（→ A）：競合の値段を調べて`));
  assert.match(p, new RegExp(`新しい発言：\\n- ${b}：えーと、ねんばらいも$`));
});

test("返った JSON から：清書（変わったときだけ）、新しく起こす、続き、届けない、を記録に置く", async () => {
  const t = setup();
  const a = t.say("競合の値段を調べて"), b = t.say("あ、ねんばらいの割引も"), c = t.say("うーん、どうしようかな"), d = t.say("リリースノートの下書きをかいて");
  await tick();
  assert.equal(t.conv.asks.length, 1, "一度にまとめて読む");
  t.conv.asks[0].reply({ says: [
    { id: a, text: "競合の値段を調べて", to: "new", role: "調べもの", name: "競合の値段" },
    { id: b, text: "あ、年払いの割引も。", to: "new", role: "調べもの", name: "競合の値段" },
    { id: c, text: "うーん、どうしようかな", to: "none" },
    { id: d, text: "リリースノートの下書きを書いて", to: "new", role: "調べもの", name: "リリースノート" },
  ] });
  await tick();
  const s = t.log.state;
  assert.equal(s.sessions.length, 2, "同じ回の同じ名前の new は一つにまとまる");
  const [A, B] = s.sessions;
  assert.deepEqual([A.sym, A.name, A.asked], ["A", "競合の値段", [a, b]]);
  assert.deepEqual([B.sym, B.name, B.asked], ["B", "リリースノート", [d]]);
  assert.equal(s.said.find((p) => p.id === a).fair, null, "変わらなければ清書を置かない");
  assert.equal(s.said.find((p) => p.id === b).fair, "あ、年払いの割引も。");
  assert.equal(s.said.find((p) => p.id === b).text, "あ、ねんばらいの割引も", "元の文は残る");
  assert.equal(s.said.find((p) => p.id === c).aside, true);
  assert.equal(s.said.find((p) => p.id === c).session, null);
  // セッションに渡るのは清書した文
  assert.equal(t.jobs[0].prompt, "競合の値段を調べて");
  assert.equal(t.jobs[1].prompt, "リリースノートの下書きを書いて");
  assert.deepEqual(t.log.records.filter((r) => r.kind === "fair").map((r) => r.said), [b, d]);
  // あとで記号で呼ぶ
  const e = t.say("エーは甲社だけでいい");
  await tick();
  t.conv.asks[1].reply({ says: [{ id: e, text: "A は甲社だけでいい", to: "session", session: "A" }] });
  await tick();
  assert.equal(t.log.state.said.find((p) => p.id === e).session, A.id);
  assert.deepEqual(t.log.state.sessions[0].pending, [b, e], "動いているセッションへの続きは待つ");
});

test("読んでいるあいだに来た発言は、次の回にまとめて読み、同じ発言を二度読ませない", async () => {
  const t = setup();
  const a = t.say("a");
  await tick();
  const b = t.say("b"), c = t.say("c");
  await tick();
  assert.equal(t.conv.asks.length, 1, "読んでいるあいだは次を起こさない");
  t.conv.asks[0].reply({ says: [{ id: a, text: "a", to: "none" }] });
  await tick(5);
  assert.equal(t.conv.asks.length, 2);
  assert.match(t.conv.asks[1].text, new RegExp(`新しい発言：\\n- ${b}：b\\n- ${c}：c$`));
  assert.doesNotMatch(t.conv.asks[1].text.split("新しい発言：")[1], new RegExp(`- ${a}：a$`, "m"));
});

test("係が失敗しても発言は残り、未定とわかる。自動ではやり直さず、次の発言のときに読み直す", async () => {
  const t = setup();
  const a = t.say("競合の値段");
  await tick();
  t.conv.asks[0].fail("係の会話が終わった（終了コード 1）");
  await tick(20);
  assert.equal(t.conv.asks.length, 1, "すぐにはやり直さない");
  const p = t.log.state.said[0];
  assert.equal(p.session, null);
  assert.match(p.miss, /係が読めなかった：係の会話が終わった/);
  const b = t.say("調べて");
  await tick();
  assert.match(t.conv.asks[1].text, new RegExp(`- ${a}：競合の値段\\n- ${b}：調べて$`));
  t.conv.asks[1].reply({ says: [{ id: a, text: "競合の値段", to: "new", role: "調べもの", name: "競合" }, { id: b, text: "調べて", to: "new", role: "調べもの", name: "競合" }] });
  await tick();
  assert.equal(t.log.state.said[0].miss, null, "届いたら印は消える");
  assert.equal(t.log.state.sessions.length, 1);
});

test("ありもしないセッション・選べない役割・返さなかった発言・読めない形は miss にして未定のまま", async () => {
  const t = setup();
  const a = t.say("a"), b = t.say("b"), c = t.say("c"), d = t.say("d");
  await tick();
  t.conv.asks[0].reply({ says: [
    { id: a, text: "a", to: "session", session: "Q" },
    { id: b, text: "b", to: "new", role: "開発", name: "x" },
    { id: c, text: "c", to: "where" },
    { id: 999, text: "知らない id", to: "none" },
  ] });
  await tick();
  const s = t.log.state;
  assert.equal(s.sessions.length, 0);
  assert.match(s.said[0].miss, /ありもしないセッション「Q」/);
  assert.match(s.said[1].miss, /選べない役割「開発」/);
  assert.match(s.said[2].miss, /届け先「where」/);
  assert.match(s.said[3].miss, /返さなかった/);
  assert.ok(s.said.every((p) => p.session == null && !p.aside));
  t.say("e");
  await tick();
  t.conv.asks[1].reply({ nope: 1 });
  await tick();
  assert.equal(t.log.state.said.at(-1).miss, "係が返さなかった");
});

test("係はセッションを待たない：セッションが動いていても、次の発言を読む", async () => {
  const t = setup();
  const a = t.say("a");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "a", to: "new", role: "調べもの", name: "x" }] });
  await tick();
  assert.equal(t.log.state.sessions[0].running, true);
  t.say("b");
  await tick();
  assert.equal(t.conv.asks.length, 2);
});

test("立て直したら、未定の発言を読む", async () => {
  const log = new Log();
  log.add("say", { text: "前に置いた" });
  const conv = fakeConv();
  const sessions = new Sessions({ log, roles, room: "/tmp", spawn: idle }).start();
  new SaidMouth({ log, sessions, roles, conv }).start();
  await tick();
  assert.equal(conv.asks.length, 1);
});

test("辞書：係が足せる。人が書いた言葉は書き換えない。ファイルに残り、読み直せる", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-")), "words.jsonl");
  const words = new Words(file);
  words.add({ by: "人", heard: "ケツダウン", write: "k2down" });
  const t = setup({ words });
  const a = t.say("やめるじゃなくてyml");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "やめるじゃなくて yml", to: "none" }], words: [{ heard: "やめる", write: "yml", when: "ファイルの話のとき" }, { heard: "ケツダウン", write: "ケツ" }, { heard: "", write: "x" }] });
  await tick();
  const again = new Words(file);
  assert.deepEqual(again.list().map((w) => [w.heard, w.write, w.by]), [["ケツダウン", "k2down", "人"], ["やめる", "yml", "係"]]);
  assert.equal(again.list()[1].when, "ファイルの話のとき");
});

test("記号：空いているいちばん若い字を、できたときに振り、変えない。Z のあとは AA", () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(symbolOf), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  const at = "2026-11-13T00:00:00.000Z";
  const recs = Array.from({ length: 28 }, (_, i) => ({ seq: i + 1, at, kind: "open", role: "調べもの", cwd: "/", name: null }));
  const s = replay(recs);
  assert.deepEqual(s.sessions.map((x) => x.sym).slice(24), ["Y", "Z", "AA", "AB"]);
  assert.equal(new Set(s.sessions.map((x) => x.sym)).size, 28);
});

test("会話の起こし直し：死んだら・伸びたら・あいたら・返らなかったら", async () => {
  let opened = 0, now = 0;
  const make = (hang = false) => ({ alive: true, send: () => (hang ? new Promise(() => {}) : Promise.resolve({ ok: true, json: {} })), kill() { this.alive = false; } });
  let hang = false;
  const c = new Conv({ open: () => { opened++; return make(hang); }, turns: 2, idle: 100, timeout: 20, now: () => now });
  await c.send("a");
  await c.send("b");
  assert.equal(opened, 1);
  await c.send("c");
  assert.equal(opened, 2, "伸びたら起こし直す");
  now = 1000;
  await c.send("d");
  assert.equal(opened, 3, "あいたら起こし直す");
  c.c.alive = false;
  await c.send("e");
  assert.equal(opened, 4, "死んでいたら起こし直す");
  hang = true;
  c.c.alive = false;
  const r = await c.send("f");
  assert.equal(r.ok, false);
  assert.match(r.error, /返らなかった/);
  assert.equal(c.c.alive, false, "返らなかった会話は止める");
});

test("届けていない発言を、声で届け直す：新しく起こす。指示の発言はセッションに渡さず、届け直したと残る", async () => {
  const t = setup();
  const a = t.say("競合ってどれくらい取ってるんだろうな");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "競合ってどれくらい取ってるんだろうな", to: "none" }] });
  await tick();
  assert.equal(t.log.state.said[0].aside, true);
  const b = t.say("それは新しく調べて");
  await tick();
  assert.match(t.conv.asks[1].text, new RegExp(`届けていない発言（届け直せる）：\\n- ${a}：競合ってどれくらい取ってるんだろうな`));
  t.conv.asks[1].reply({ says: [
    { id: a, text: "競合ってどれくらい取ってるんだろうな", to: "new", role: "調べもの", name: "競合の料金" },
    { id: b, text: "それは新しく調べて", to: "none", resend: [a] },
  ] });
  await tick();
  const s = t.log.state;
  const [pa, pb] = s.said;
  assert.equal(pa.session, s.sessions[0].id);
  assert.equal(pa.aside, false);
  assert.deepEqual([pb.session, pb.aside, pb.resent], [null, true, [a]]);
  assert.deepEqual(s.sessions[0].asked, [a], "指示の発言はセッションに渡さない");
  assert.equal(t.jobs[0].prompt, "競合ってどれくらい取ってるんだろうな");
  const kinds = t.log.records.map((r) => r.kind);
  assert.deepEqual(kinds.slice(kinds.indexOf("aside")), ["aside", "say", "open", "pass", "start", "aside", "resend"]);
});

test("届け直しの指示に頼みの中身が足されていたら、中身だけを同じセッションに渡す", async () => {
  const t = setup();
  const a = t.say("競合の値段を調べて");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "競合の値段を調べて", to: "new", role: "調べもの", name: "競合の値段" }] });
  await tick();
  const b = t.say("甲社のはけっこう高いらしい");
  await tick();
  t.conv.asks[1].reply({ says: [{ id: b, text: "甲社のはけっこう高いらしい", to: "none" }] });
  await tick();
  const c = t.say("さっきのは A に送って、あと年払いも見ておいて");
  await tick();
  t.conv.asks[2].reply({ says: [
    { id: b, text: "甲社のはけっこう高いらしい", to: "session", session: "A" },
    { id: c, text: "さっきのは A に送って。あと年払いも見ておいて。", to: "session", session: "A", body: "年払いも見ておいて。", resend: [b] },
  ] });
  await tick();
  const s = t.log.state;
  assert.deepEqual(s.sessions[0].pending, [b, c]);
  assert.equal(s.said.find((p) => p.id === c).body, "年払いも見ておいて。");
  assert.deepEqual(s.said.find((p) => p.id === c).resent, [b]);
  assert.equal(t.log.records.find((r) => r.kind === "pass" && r.said === c).text, "年払いも見ておいて。");
});

test("届け直し：resend を書かなくても、この回のいちばん新しい発言が言ったことにする。言われていないものは届けないまま", async () => {
  const t = setup();
  const a = t.say("ひとりごと一"), b = t.say("ひとりごと二");
  await tick();
  t.conv.asks[0].reply({ says: [{ id: a, text: "ひとりごと一", to: "none" }, { id: b, text: "ひとりごと二", to: "none" }] });
  await tick();
  const c = t.say("一つめのは調べて");
  await tick();
  t.conv.asks[1].reply({ says: [{ id: a, text: "ひとりごと一", to: "new", role: "調べもの", name: "一" }, { id: b, text: "ひとりごと二", to: "none" }, { id: c, text: "一つめのは調べて", to: "none" }] });
  await tick();
  const s = t.log.state;
  assert.deepEqual(s.said.map((p) => [p.session != null, p.aside]), [[true, false], [false, true], [false, true]]);
  assert.deepEqual(s.said[2].resent, [a]);
  // 届けた発言の付け替えは作らない
  const d = t.say("一つめのは開発に回して");
  await tick();
  assert.doesNotMatch(t.conv.asks[2].text, new RegExp(`- ${a}：ひとりごと一\\n`), "届けたものは届け直せる一覧に出さない");
});
