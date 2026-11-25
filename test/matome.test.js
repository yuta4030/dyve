import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { Matome, briefPrompt } from "../src/matome.js";

const session = (log) => {
  log.add("open", { session: 1, name: "料金" });
  const s = log.add("say", { text: "料金を調べて" }).seq;
  log.add("route", { say: s, session: 1 });
  log.add("turn", { session: 1, says: [s] });
  log.add("step", { session: 1, what: "tool", text: "Read a.md" });
  log.add("step", { session: 1, what: "text", text: "月 20 ドルです。甲と乙のどちらにしますか？" });
};

test("まとめに渡す文：人の頼みと AI の言葉だけ（道具は省く）", () => {
  const log = new Log();
  session(log);
  const p = briefPrompt(log.state.sessions[0]);
  assert.match(p, /「料金」/);
  assert.match(p, /人：料金を調べて\n\nAI：月 20 ドル/);
  assert.doesNotMatch(p, /Read a\.md/);
});

test("ターンが終わると要約と選択肢を書く。止めたとき・失敗したときは書かない", async () => {
  const log = new Log(), asked = [];
  const m = new Matome({ log, ask: async (t) => { asked.push(t); return { ok: true, json: { summary: "- 月 20 ドル", choices: [{ label: "甲", say: "甲で" }, { label: "", say: "空は捨てる" }] } }; } }).start();
  session(log);
  log.add("end", { session: 1, result: "月 20 ドル" });
  await m.runs.get(1);
  const x = log.state.sessions[0];
  assert.equal(x.brief.summary, "- 月 20 ドル");
  assert.deepEqual(x.brief.choices, [{ label: "甲", say: "甲で" }]);
  log.add("turn", { session: 1, says: [] });
  assert.deepEqual(x.brief.choices, [], "次のターンが始まったら選択肢は古い");
  log.add("end", { session: 1, stopped: true });
  log.add("turn", { session: 1, says: [] });
  log.add("end", { session: 1, error: "落ちた" });
  assert.equal(asked.length, 1);
});

test("読んでいるあいだにまた終わったら、読み終えてからもう一度だけ読む", async () => {
  const log = new Log();
  let n = 0, release;
  const gate = new Promise((r) => (release = r));
  const m = new Matome({ log, ask: async () => { n++; if (n === 1) await gate; return { ok: true, json: { summary: `- ${n}`, choices: [] } }; } }).start();
  session(log);
  log.add("end", { session: 1, result: "x" });
  log.add("turn", { session: 1, says: [] });
  log.add("end", { session: 1, result: "y" });
  log.add("turn", { session: 1, says: [] });
  log.add("end", { session: 1, result: "z" });
  release();
  await m.runs.get(1);
  assert.equal(n, 2);
  assert.equal(log.state.sessions[0].brief.summary, "- 2");
});

test("待ちでないときに届いた選択肢は出さない", () => {
  const log = new Log();
  session(log);
  log.add("brief", { session: 1, summary: "- x", choices: [{ label: "甲", say: "甲で" }] });
  assert.deepEqual(log.state.sessions[0].brief.choices, []);
});
