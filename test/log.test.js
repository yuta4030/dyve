import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { symOf } from "../src/state.js";

test("記号は A〜Z、そのあと AA", () => {
  assert.equal(symOf(0), "A");
  assert.equal(symOf(25), "Z");
  assert.equal(symOf(26), "AA");
  assert.equal(symOf(27), "AB");
});

test("追記して、立て直すと同じ状態に戻る。読めない行は飛ばす", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-log-")), "r.jsonl");
  const a = new Log(file);
  a.add("say", { text: "これ調べて" });
  a.add("open", { session: 1, name: "調べもの" });
  a.add("route", { say: 1, session: 1 });
  a.add("turn", { session: 1, says: [1] });
  a.add("step", { session: 1, what: "tool", text: "Read README.md" });
  a.add("end", { session: 1, claude: "c1", result: "答えは 42" });
  fs.appendFileSync(file, '{"seq":99,"kin');
  const b = new Log(file);
  assert.equal(b.skipped, 1);
  assert.deepEqual(b.state, a.state);
  const x = b.state.sessions[0];
  assert.equal(x.sym, "A");
  assert.equal(x.status, "wait");
  assert.equal(x.claude, "c1");
  assert.deepEqual(x.flow.map((f) => f.who), ["human", "tool"]);
  assert.deepEqual(b.state.chat, [{ say: 1 }, { reply: 1, text: "答えは 42", error: false }]);
  // 書きかけの行のあとにも足せる
  b.add("say", { text: "次" });
  assert.equal(new Log(file).state.said.length, 2);
});

test("足りない記録は断る", () => {
  const log = new Log();
  assert.throws(() => log.add("say", { text: "  " }));
  assert.throws(() => log.add("nope", {}));
});

test("失敗したターンは失敗として残り、チャットにも帰る", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "x" });
  log.add("end", { session: 1, error: "止まった" });
  assert.equal(log.state.sessions[0].status, "fail");
  assert.equal(log.state.chat.at(-1).error, true);
});

test("リセット：チャットを空にし、動いていないセッションを外す。記号は空いたものから振り直す", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "済んだ" });
  log.add("end", { session: 1, result: "答え" });
  log.add("open", { session: 2, name: "動いている" });
  log.add("turn", { session: 2, says: [] });
  log.add("say", { text: "前の話" });
  log.add("reset");
  const s = log.state;
  assert.deepEqual(s.chat, []);
  assert.deepEqual(s.sessions.map((x) => !!x.hidden), [true, false]);
  log.add("open", { session: 3, name: "新しい" });
  assert.deepEqual(s.sessions.map((x) => x.sym), ["A", "B", "A"]);
});

test("リセットは、次に話すまで戻せる。そのあいだに帰った結果も残る", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "a" });
  log.add("end", { session: 1, result: "答え" });
  log.add("open", { session: 2, name: "b" });
  log.add("turn", { session: 2, says: [] });
  log.add("reset");
  log.add("end", { session: 2, result: "帰った" });
  log.add("undo");
  assert.equal(log.state.sessions[0].hidden, false);
  assert.deepEqual(log.state.chat.map((c) => c.reply), [1, 2]);
  assert.equal(log.state.since, 0);
  log.add("reset");
  log.add("say", { text: "次" });
  assert.equal(log.state.undo, null);
});
