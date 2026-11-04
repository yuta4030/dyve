import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
// 画面は 1 枚の HTML なので、並べ方の関数だけを取り出して試す
const src = html.match(/^function shownParent\([\s\S]*?^}$/m)[0];
const shownParent = new Function(`${src}; return shownParent;`)();

const board = (...ps) => new Map(ps.map((p) => [p.id, p]));
const topic = { id: "t", view: "topic" };
const say = { id: "s", view: "say" };
const task = { id: "k", view: "task", about: "t" };

test("仕事の結果は仕事の子にせず、話題の直下に出す", () => {
  const res = { id: "r", view: "list", about: "k" };
  const b = board(topic, task, res);
  assert.equal(shownParent(task, b), "t");
  assert.equal(shownParent(res, b), "t");
  assert.equal(res.about, "k", "データの about は変えない");
});

test("話題のない仕事の結果は、元の発言の直下に出す", () => {
  const direct = { id: "k", view: "task", about: "s" };
  const res = { id: "r", view: "text", about: "k" };
  assert.equal(shownParent(res, board(say, direct, res)), "s");
});

test("仕事の下の仕事も、その結果も話題の直下に出す", () => {
  const sub = { id: "k2", view: "task", about: "k" };
  const res = { id: "r", view: "text", about: "k2" };
  const b = board(topic, task, sub, res);
  assert.equal(shownParent(sub, b), "t");
  assert.equal(shownParent(res, b), "t");
});

test("結果について置かれたものは、結果の下のまま", () => {
  const res = { id: "r", view: "list", about: "k" };
  const note = { id: "n", view: "text", about: "r" };
  assert.equal(shownParent(note, board(topic, task, res, note)), "r");
});

test("親のない仕事の結果は仕事の下のまま。about の先がなければ親なし", () => {
  const lone = { id: "k", view: "task" };
  const res = { id: "r", view: "text", about: "k" };
  assert.equal(shownParent(res, board(lone, res)), "k");
  const orphan = { id: "k", view: "task", about: "gone" };
  assert.equal(shownParent(res, board(orphan, res)), "k");
  assert.equal(shownParent({ id: "x", view: "text", about: "gone" }, board()), null);
  assert.equal(shownParent(topic, board(topic)), null);
});

test("使わない view のパネルは隠す。人の判断待ちと、下に何か付いているものは隠さない", () => {
  const code = html.match(/^function shownPanels\([\s\S]*?^}$/m)[0];
  const shownPanels = new Function(`${code}; return shownPanels;`)();
  const plain = { id: "a", view: "bars" }, waiting = { id: "b", view: "bars" }, parent = { id: "c", view: "bars" };
  const kid = { id: "d", view: "text", about: "c" }, other = { id: "e", view: "text" };
  const out = shownPanels([plain, waiting, parent, kid, other], { b: "waiting" }, new Set(["bars"]));
  assert.deepEqual(out.map((p) => p.id), ["b", "c", "d", "e"]);
});

test("管理のページも外のものを読まない", () => {
  const manage = fs.readFileSync(new URL("../src/manage.html", import.meta.url), "utf8");
  assert.doesNotMatch(manage, /(src|href)="https?:/);
  assert.doesNotMatch(html, /id="boards"|boardPick/);
  // 利用者の view はボードと同じ囲いで描く
  for (const m of manage.matchAll(/<iframe[^>]*>/g)) assert.match(m[0], /sandbox="allow-scripts"/);
});
