import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { replay, KINDS } from "../src/state.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-")), "sub", "record.jsonl");
const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("発言を足すと、通し番号と時刻が付いて一行ずつ追記される", () => {
  const file = tmp();
  const log = new Log(file);
  const a = log.add("say", { text: "ログインのあとすぐ切れるやつ、直しておいて" });
  const b = log.add("say", { text: "料金ページも" });
  assert.equal(a.ok, true);
  assert.deepEqual([a.record.seq, b.record.seq], [1, 2]);
  assert.ok(!Number.isNaN(Date.parse(a.record.at)));
  assert.deepEqual(lines(file), [a.record, b.record]);
  assert.deepEqual(Object.keys(a.record), ["seq", "at", "kind", "text"]);
});

test("状態は記録を頭から当て直して作る。発言の id は記録の通し番号", () => {
  const log = new Log();
  log.add("say", { text: "一つめ" });
  log.add("say", { text: "二つめ" });
  assert.deepEqual(log.state.said.map((s) => [s.id, s.text]), [[1, "一つめ"], [2, "二つめ"]]);
  assert.equal(log.state.seq, 2);
});

test("立ち上げ直しても同じ状態になる。通し番号は続きから振る", () => {
  const file = tmp();
  const log = new Log(file);
  log.add("say", { text: "一つめ" });
  log.add("say", { text: "  元の文は  そのまま残す  " });
  const again = new Log(file);
  assert.deepEqual(again.state, log.state);
  assert.deepEqual(again.state, replay(lines(file)));
  assert.equal(again.add("say", { text: "三つめ" }).record.seq, 3);
  assert.equal(again.state.said[1].text, "  元の文は  そのまま残す  ");
});

test("書きかけの行があっても、読めるところまでで立ち上がる。次の一件は新しい行に書く", () => {
  const file = tmp();
  const log = new Log(file);
  log.add("say", { text: "一つめ" });
  fs.appendFileSync(file, '{"seq":2,"at":"2026-11-13T00:00:00.000Z","kind":"say","te');
  const again = new Log(file);
  assert.equal(again.skipped, 1);
  assert.deepEqual(again.state.said.map((s) => s.text), ["一つめ"]);
  const r = again.add("say", { text: "二つめ" });
  assert.equal(r.record.seq, 2);
  // 書きかけは消さずに残し、そのうえで読み直しても同じ
  assert.match(fs.readFileSync(file, "utf8"), /"te\n/);
  const third = new Log(file);
  assert.deepEqual(third.state, again.state);
  assert.equal(third.skipped, 1);
});

test("途中の壊れた行や、通し番号が戻る行は飛ばして読む", () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = "2026-11-13T00:00:00.000Z";
  fs.writeFileSync(file, [
    JSON.stringify({ seq: 1, at, kind: "say", text: "a" }),
    "こわれた",
    JSON.stringify({ seq: 1, at, kind: "say", text: "同じ番号" }),
    JSON.stringify({ at, kind: "say", text: "番号がない" }),
    JSON.stringify({ seq: 2, at, kind: "say", text: "b" }),
  ].join("\n") + "\n");
  const log = new Log(file);
  assert.equal(log.skipped, 3);
  assert.deepEqual(log.state.said.map((s) => s.text), ["a", "b"]);
});

test("知らない種類の記録は、状態には当てず、通し番号だけ進める", () => {
  const at = "2026-11-13T00:00:00.000Z";
  const s = replay([{ seq: 1, at, kind: "say", text: "a" }, { seq: 2, at, kind: "mada", x: 1 }]);
  assert.equal(s.seq, 2);
  assert.deepEqual(s.said.map((x) => x.text), ["a"]);
});

test("中身のない発言や、知らない種類は足さない", () => {
  const file = tmp();
  const log = new Log(file);
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 3 }]) {
    const r = log.add("say", body);
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid");
  }
  assert.equal(log.add("mada", {}).code, "invalid");
  assert.equal(log.add("toString", {}).code, "invalid");
  assert.equal(log.state.seq, 0);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "");
});

test("記録に書くのは種類が決めた中身だけ", () => {
  const log = new Log();
  const r = log.add("say", { text: "a", seq: 99, kind: "x", extra: 1 });
  assert.deepEqual(r.record, { seq: 1, at: r.record.at, kind: "say", text: "a" });
});

test("足すたびに聞き手へ知らせる。外せば知らせない", () => {
  const log = new Log();
  const got = [];
  const off = log.on((r) => got.push(r.seq));
  log.add("say", { text: "a" });
  off();
  log.add("say", { text: "b" });
  assert.deepEqual(got, [1]);
});

test("種類はどれも make と apply を持つ", () => {
  for (const [k, v] of Object.entries(KINDS)) {
    assert.equal(typeof v.make, "function", k);
    assert.equal(typeof v.apply, "function", k);
  }
});
