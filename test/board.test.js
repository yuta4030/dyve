import { test } from "node:test";
import assert from "node:assert/strict";
import { Board, marks } from "../src/board.js";

const say = (b, text) => b.apply({ by: "human", type: "add", panel: { view: "say", data: text } });

test("操作ログを当て直すと同じボードになる", () => {
  const b = new Board();
  const a = say(b, "えーと、検索を速くしたい");
  b.apply({ by: "manager", type: "edit", panel: { id: a.op.panel.id, data: "検索を速くしたい" }, reason: "言いよどみを整えた" });
  b.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: a.op.panel.id, data: { text: "遅い原因を調べる" } }, reason: "調べもの" });
  const again = new Board(b.log);
  assert.deepEqual(again.list(), b.list());
  assert.equal(again.get(a.op.panel.id).data, "検索を速くしたい");
  assert.equal(again.history(a.op.panel.id)[0].panel.data, "えーと、検索を速くしたい");
});

test("id は一度振ったら変わらない", () => {
  const b = new Board();
  const ids = [say(b, "1"), say(b, "2")].map((r) => r.op.panel.id);
  b.apply({ by: "human", type: "drop", panel: { id: ids[0] } });
  const c = say(b, "3").op.panel.id;
  assert.equal(new Set([...ids, c]).size, 3);
});

test("AI の操作は reason を持つ", () => {
  const b = new Board();
  const r = b.apply({ by: "manager", type: "add", panel: { view: "text", data: "x" } });
  assert.equal(r.code, "invalid");
});

test("ピン留めされたパネルを AI は書き換えられない", () => {
  const b = new Board();
  const id = say(b, "これは大事").op.panel.id;
  b.apply({ by: "human", type: "edit", panel: { id, pinned: true } });
  const r = b.apply({ by: "manager", type: "edit", panel: { id, data: "x" }, reason: "清書" });
  assert.equal(r.code, "pinned");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id, pinned: false }, reason: "x" }).code, "pinned");
});

test("ピン留めと受け入れは人だけ", () => {
  const b = new Board();
  const p = b.apply({ by: "アリス", type: "add", panel: { view: "text", state: "proposal", data: "push する" }, reason: "提案" }).op.panel.id;
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: p, state: "done" }, reason: "受け入れ" }).code, "forbidden");
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: p, pinned: true }, reason: "x" }).code, "forbidden");
  assert.equal(b.apply({ by: "アリス", type: "add", panel: { view: "text", pinned: true }, reason: "x" }).code, "forbidden");
  assert.ok(b.apply({ by: "human", type: "edit", panel: { id: p, state: "done" } }).ok);
});

test("人が置いたパネルを AI は外せない（落とさない）", () => {
  const b = new Board();
  const id = say(b, "a").op.panel.id;
  assert.equal(b.apply({ by: "manager", type: "drop", panel: { id }, reason: "重複" }).code, "forbidden");
  const t = b.apply({ by: "manager", type: "add", panel: { view: "text", data: "まとめ" }, reason: "まとめ" }).op.panel.id;
  assert.ok(b.apply({ by: "manager", type: "drop", panel: { id: t }, reason: "古い" }).ok);
});

test("rev が合わなければ conflict", () => {
  const b = new Board();
  const r = say(b, "a");
  b.apply({ by: "human", type: "edit", panel: { id: r.op.panel.id, data: "b" } });
  const x = b.apply({ by: "manager", type: "edit", panel: { id: r.op.panel.id, rev: r.op.seq, data: "c" }, reason: "清書" });
  assert.equal(x.code, "conflict");
});

test("形の正しくない操作は invalid・not_found", () => {
  const b = new Board();
  assert.equal(b.apply({ by: "human", type: "move", panel: {} }).code, "invalid");
  assert.equal(b.apply({ by: "human", type: "add", panel: { data: 1 } }).code, "invalid");
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "text", about: "nope" } }).code, "not_found");
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "text", state: "maybe" } }).code, "invalid");
  assert.equal(b.apply({ by: "human", type: "edit", panel: { id: "nope", data: 1 } }).code, "not_found");
  const a = say(b, "a").op.panel.id;
  const c = b.apply({ by: "human", type: "add", panel: { view: "text", about: a } }).op.panel.id;
  assert.equal(b.apply({ by: "human", type: "edit", panel: { id: a, about: c } }).code, "invalid");
});

test("印を導く：未着手・受け入れ待ち", () => {
  const b = new Board();
  const s = say(b, "調べて").op.panel.id;
  const t = b.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: s, data: { text: "調べる" } }, reason: "取り次ぎ" }).op.panel.id;
  assert.equal(marks(b)[t], "untouched");
  assert.equal(marks(b, { running: [t] })[t], undefined);
  // マネージャの書き込みは結果にならない
  b.apply({ by: "manager", type: "add", panel: { view: "text", about: t, data: { to: "アリス", text: "急いで" } }, reason: "伝言" });
  assert.equal(marks(b)[t], "untouched");
  b.apply({ by: "アリス", type: "add", panel: { view: "text", about: t, data: "分かった" }, reason: "結果" });
  assert.equal(marks(b)[t], undefined);
  const p = b.apply({ by: "アリス", type: "add", panel: { view: "text", state: "proposal", about: t, data: "直す" }, reason: "提案" }).op.panel.id;
  assert.equal(marks(b)[p], "waiting");
});

test("to：宛てた相手の名前だけを持てる", () => {
  const b = new Board();
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "say", data: "x", to: "ボブ" } }).op.panel.to, "ボブ");
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "say", data: "x", to: 3 } }).code, "invalid");
  b.apply({ by: "human", type: "edit", panel: { id: "p1", to: null } });
  assert.equal("to" in b.get("p1"), false);
});

test("rel：同じものについてのパネルどうしだけを比べる・順番の組にでき、null で外せる", () => {
  const b = new Board();
  const add = (panel) => b.apply({ by: "manager", type: "add", panel, reason: "試す" });
  const topic = add({ view: "topic", data: { title: "話題" } }).op.panel.id;
  const a = add({ view: "list", about: topic, data: ["案 A"] }).op.panel.id;
  const other = add({ view: "list", data: ["よそ"] }).op.panel.id;
  const c = add({ view: "list", about: topic, data: ["案 B"], rel: { kind: "compare", with: [a] } });
  assert.ok(c.ok);
  assert.deepEqual(b.get(c.op.panel.id).rel, { kind: "compare", with: [a] });
  assert.equal(add({ view: "list", about: topic, data: [], rel: { kind: "compare", with: [other] } }).code, "invalid", "about が違う");
  assert.equal(add({ view: "list", about: topic, data: [], rel: { kind: "compare", with: ["nope"] } }).code, "not_found");
  assert.equal(add({ view: "list", about: topic, data: [], rel: { kind: "near", with: [a] } }).code, "invalid");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: a, rel: { kind: "sequence", with: [a] } }, reason: "r" }).code, "not_found", "自分とは組めない");
  assert.ok(b.apply({ by: "manager", type: "edit", panel: { id: c.op.panel.id, rel: null }, reason: "外す" }).ok);
  assert.equal(b.get(c.op.panel.id).rel, undefined);
  assert.equal(new Board(b.log).get(c.op.panel.id).rel, undefined, "当て直しても同じ");
});

test("point：指したパネルを付けるのは人（画面）だけで、発言にだけ付く", () => {
  const b = new Board();
  const t = b.apply({ by: "manager", type: "add", panel: { view: "text", data: "案" }, reason: "r" }).op.panel.id;
  const s = b.apply({ by: "human", type: "add", panel: { view: "say", data: "これで", point: { id: t, how: "hover" } } });
  assert.deepEqual(s.op.panel.point, { id: t, how: "hover" });
  assert.equal(b.apply({ by: "manager", type: "add", panel: { view: "say", data: "x", point: { id: t, how: "pick" } }, reason: "r" }).code, "forbidden");
  assert.equal(b.apply({ by: "manager", type: "edit", panel: { id: s.op.panel.id, point: null }, reason: "r" }).code, "forbidden");
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "text", data: "x", point: { id: t, how: "hover" } } }).code, "invalid");
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "say", data: "x", point: { id: t, how: "stare" } } }).code, "invalid");
  // 指した先は確かめない（外されていても発言は落とさない）。人は外せる
  assert.equal(b.apply({ by: "human", type: "add", panel: { view: "say", data: "x", point: { id: "gone", how: "view" } } }).ok, true);
  b.apply({ by: "human", type: "edit", panel: { id: s.op.panel.id, point: null } });
  assert.equal("point" in b.get(s.op.panel.id), false);
  assert.deepEqual(new Board(b.log).list(), b.list());
});

test("dataAt：ある seq の時点での中身", () => {
  const b = new Board();
  const id = b.apply({ by: "manager", type: "add", panel: { view: "list", data: ["a"] }, reason: "r" }).op.panel.id;
  b.apply({ by: "manager", type: "edit", panel: { id, state: "task" }, reason: "r" });
  b.apply({ by: "manager", type: "edit", panel: { id, data: ["a", "b"] }, reason: "r" });
  assert.deepEqual(b.dataAt(id, 1), ["a"]);
  assert.deepEqual(b.dataAt(id, 2), ["a"]);
  assert.deepEqual(b.dataAt(id, 3), ["a", "b"]);
  assert.equal(b.dataAt(id, 0), undefined);
});
