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

test("付け替えた発言は、前のセッションが止まっても答え終えたことにしない", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "a" });
  log.add("open", { session: 2, name: "b" });
  const s = log.add("say", { text: "x" }).seq;
  log.add("route", { say: s, session: 1 });
  log.add("turn", { session: 1, says: [s] });
  log.add("route", { say: s, session: 2 });
  log.add("end", { session: 1, stopped: true });
  assert.equal(log.state.said[0].done, false);
  assert.equal(log.state.sessions[0].hidden, true);
});

test("設定：決まった名前と値だけ変えられ、立て直しても残る", () => {
  const log = new Log();
  assert.deepEqual(log.state.settings, { send: "pause", pause: 2, fair: false, opener: "os" });
  log.add("set", { key: "fair", value: true });
  log.add("set", { key: "pause", value: 3 });
  assert.equal(log.state.settings.fair, true);
  assert.equal(log.state.settings.pause, 3);
  assert.throws(() => log.add("set", { key: "pause", value: 4 }));
  assert.throws(() => log.add("set", { key: "nope", value: 1 }));
});

test("清書した文は元の文と別に持ち、セッションには清書を渡す", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "a" });
  const s = log.add("say", { text: "えーと料金を、あの、調べて" }).seq;
  log.add("route", { say: s, session: 1, fair: "料金を調べて" });
  log.add("turn", { session: 1, says: [s] });
  assert.equal(log.state.said[0].text, "えーと料金を、あの、調べて");
  assert.equal(log.state.said[0].fair, "料金を調べて");
  assert.equal(log.state.sessions[0].flow[0].text, "料金を調べて");
});

test("リンクの決まり：読めない正規表現・空に当たるもの・http でない URL は断る", () => {
  const log = new Log();
  log.add("links", { rules: [{ pattern: "[A-Z]+-\\d+", url: "https://x.atlassian.net/browse/$0" }] });
  assert.equal(log.state.links.length, 1);
  assert.throws(() => log.add("links", { rules: [{ pattern: "(", url: "https://a" }] }));
  assert.throws(() => log.add("links", { rules: [{ pattern: "a*", url: "https://a" }] }));
  assert.throws(() => log.add("links", { rules: [{ pattern: "a", url: "javascript:alert(1)" }] }));
  assert.throws(() => log.add("links", { rules: [{ pattern: "a", url: 'https://a/"x' }] }));
});

test("畳む：止まっているカードだけ畳め、また動きだしたら広がる", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "a" });
  log.add("turn", { session: 1, says: [] });
  log.add("fold", { session: 1, on: true });
  assert.equal(log.state.sessions[0].folded, false, "動いているものは畳めない");
  log.add("end", { session: 1, result: "x" });
  log.add("fold", { session: 1, on: true });
  assert.equal(log.state.sessions[0].folded, true);
  log.add("fold", { session: 1, on: false });
  assert.equal(log.state.sessions[0].folded, false);
  log.add("fold", { session: 1, on: true });
  log.add("turn", { session: 1, says: [] });
  assert.equal(log.state.sessions[0].folded, false);
});

test("右上の情報：見たページと書いたファイルを、道具の一行から拾う", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "a" });
  for (const t of ["WebFetch https://claude.com/pricing", "Read README.md", "Edit src/a.js", "WebSearch 料金", "WebFetch https://claude.com/pricing", "Write docs/見積もり.md"]) log.add("step", { session: 1, what: "tool", text: t });
  assert.deepEqual(log.state.sessions[0].info, [{ kind: "file", ref: "src/a.js" }, { kind: "page", ref: "https://claude.com/pricing" }, { kind: "file", ref: "docs/見積もり.md" }]);
});
