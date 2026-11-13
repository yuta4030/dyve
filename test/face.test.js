// 面を役割で並べる：頭＝番と結論、左＝やること（番ごとの札）、まん中＝主役、右＝残り
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const take = (re) => html.match(re)[0];
const src = [take(/^const RECORD = .*$/m), take(/^const isRecord = .*$/m), take(/^const REST_OPEN = .*$/m), take(/^function benchPlan\([\s\S]*?^}$/m), take(/^const BENCH_PX = .*$/m), take(/^function benchBands\([\s\S]*?^}$/m), take(/^const benchRank = .*$/m)].join("\n");
const { benchPlan, benchBands, benchRank } = new Function(`${src}; return { benchPlan, benchBands, benchRank };`)();

// 画面の上の子（tree と同じ：記号のない仕事について置かれたものは、記号のある親の下に出る）
const kidsOf = (panels) => (id) => panels.filter((p) => {
  let k = p.about;
  while (k) {
    const up = panels.find((x) => x.id === k);
    if (!up || up.view !== "task" || up.key || !up.about) return k === id;
    k = up.about;
  }
  return false;
});
const TURNS = { c1: "you", c2: "ai", c3: "ok", c4: "wait", c5: "back", prop: "you", job: "ai" };
const turn = (p) => TURNS[p.id] ?? null;
const ids = (a) => a.map((p) => p.id);

test("面：行の中の行と、行に置かれた提案・仕事は番ごとの札に。行の中の行の下の提案は、その札に出る", () => {
  const ps = [
    { id: "c", view: "task", key: "C", seq: 1 },
    { id: "c1", view: "task", key: "C1", about: "c", seq: 2 }, { id: "c2", view: "task", key: "C2", about: "c", seq: 3 },
    { id: "c3", view: "task", key: "C3", about: "c", seq: 4 }, { id: "c4", view: "task", key: "C4", about: "c", seq: 5 },
    { id: "c5", view: "task", key: "C5", about: "c", seq: 5.5 },
    { id: "prop", view: "text", state: "proposal", about: "c", by: "アリス", seq: 6 },
    { id: "job", view: "task", state: "task", about: "c", seq: 7 },
    { id: "deep", view: "text", state: "proposal", about: "c1", by: "アリス", seq: 8 },
  ];
  const plan = benchPlan(ps[0], ps, kidsOf(ps), turn);
  assert.deepEqual(ids(plan.lanes.you), ["c1", "prop"]);
  assert.deepEqual(ids(plan.lanes.ai), ["c2", "job"]);
  assert.deepEqual(ids(plan.lanes.ok), ["c3"]);
  assert.deepEqual(ids(plan.lanes.wait), ["c4"]);
  assert.deepEqual(ids(plan.lanes.back), ["c5"], "帰った行は人の番に数えない");
});

test("面：主役は AI が置いたいちばん新しい結果。残りは新しい順で、多いと古いものを畳む。行の中の行の結果は記号つき", () => {
  const ps = [
    { id: "c", view: "task", key: "C", seq: 1 },
    { id: "c1", view: "task", key: "C1", about: "c", seq: 2 },
    { id: "a", view: "list", about: "c", by: "アリス", seq: 3 },
    { id: "b", view: "text", about: "c", by: "human", seq: 9 },
    { id: "d", view: "table", about: "c", by: "manager", seq: 4 },
    { id: "e", view: "change", about: "c1", by: "ボブ", seq: 8 },
    { id: "f", view: "text", about: "c", by: "アリス", seq: 5 },
    { id: "g", view: "text", state: "proposal", about: "c", by: "アリス", seq: 10 },
    { id: "h", view: "text", about: "c", by: "アリス", seq: 2 },
  ];
  const plan = benchPlan(ps[0], ps, kidsOf(ps), turn, { marked: (id) => id === "a" });
  assert.equal(plan.main.p.id, "e", "提案や人の置いたものより、AI の結果を主役に");
  assert.equal(plan.main.ref, "C1");
  assert.deepEqual(plan.rest.map((x) => x.p.id), ["g", "b", "f", "d", "a", "h"]);
  assert.deepEqual([...plan.fold], ["d", "h"], "開いておくのは新しい 3 つ。印のあるものは畳まない");
  // 置き場所を決めたものはその場所が勝つ（帯には入れない）。行の中の行の結果の置き場所はその行の面のものなので、ここではいつも帯に
  const placed = benchPlan(ps[0], ps, kidsOf(ps), turn, { placed: (id) => id === "e" || id === "f" });
  assert.deepEqual(placed.placed.map((x) => x.p.id), ["f"]);
  assert.equal(placed.main.p.id, "e");
  // 結果がなければ主役もない
  assert.equal(benchPlan(ps[0], ps.slice(0, 2), kidsOf(ps.slice(0, 2)), turn).main, null);
});

test("面の帯：三つが入る幅なら左・まん中・右、狭ければ二つ、一つ。一列は あなたの番 → 主役 → 残り → ほかの番", () => {
  const all = { lanes: true, main: true, rest: true };
  const three = benchBands(1200, 24, all);
  assert.equal(three.one, false);
  assert.deepEqual([three.lanes.x, three.main.x, three.rest.x + three.rest.w], [1, three.lanes.w + 1, 25]);
  assert.ok(three.main.w > three.lanes.w && three.main.w > three.rest.w, "まん中をいちばん広く");
  assert.deepEqual(three.alt, three.main, "残りは、右とまん中の下の短い方へ");
  const two = benchBands(800, 24, all);
  assert.deepEqual(two.rest, two.main, "二つのときは、残りは主役の下（広い方）か、やることの下");
  assert.deepEqual(two.alt, two.lanes);
  assert.equal(two.main.x, two.lanes.w + 1);
  assert.equal(benchBands(500, 24, all).alt, null);
  assert.equal(benchBands(500, 24, all).one, true);
  assert.equal(benchBands(1200, 24, { lanes: true, main: false, rest: false }).one, true, "主役がなければ札を広く");
  const order = (one, roles) => roles.sort((a, b) => benchRank(a, one) - benchRank(b, one));
  assert.deepEqual(order(true, ["lanes", "rest", "main", "you"]), ["you", "main", "rest", "lanes"]);
  assert.deepEqual(order(false, ["rest", "main", "lanes", "you"]), ["you", "lanes", "main", "rest"]);
});

test("面の頭は番の一語。済み・知らせの印は並べない。受け入れるのは本体の札（人の操作）", () => {
  assert.match(html, /if \(mark && !face\) tags\.push/);
  assert.match(html, /if \(!face && p\.state === "done"\)/);
  assert.match(html, /function cardHtml\([\s\S]*?data-act="accept-row"/);
  // 結果が返ってきただけでは面を開かない（開くのは人とマネージャ）
  assert.doesNotMatch(take(/^function benchBox\([\s\S]*?^}$/m), /takeOut|LAYOUT\.out/);
});

test("面：行への言葉（data.to 付きの text）は主役にせず、残りの後ろに畳む", () => {
  const ps = [
    { id: "c", view: "task", key: "C", seq: 1 },
    { id: "cal", view: "days", about: "c", by: "アリス", seq: 2 },
    { id: "tbl", view: "table", about: "c", by: "アリス", seq: 3 },
    { id: "m1", view: "text", about: "c", by: "manager", data: { to: "アリス", text: "続きを作って" }, seq: 4 },
    { id: "m2", view: "text", about: "c", by: "manager", data: { to: "アリス", text: "まだ？" }, seq: 5 },
    { id: "h", view: "text", about: "c", by: "human", data: "送った入力", seq: 6 },
  ];
  // 印が付いていても、行への言葉は畳む（人が読むものではない。開けばいつでも読める）
  const plan = benchPlan(ps[0], ps, kidsOf(ps), turn, { marked: () => true });
  assert.equal(plan.main.p.id, "tbl", "いちばん新しくても、行への言葉は主役にしない");
  assert.deepEqual(plan.rest.map((x) => x.p.id), ["h", "cal", "m2", "m1"], "結果が先、行への言葉は後ろ");
  assert.deepEqual([...plan.fold], ["m2", "m1"]);
  // 行への言葉しかなければ主役はない（どれも消さずに並べる）
  const only = benchPlan(ps[0], [ps[0], ps[3], ps[4]], kidsOf([ps[0], ps[3], ps[4]]), turn);
  assert.equal(only.main, null);
  assert.deepEqual(only.rest.map((x) => x.p.id), ["m2", "m1"]);
  // 行への言葉が開いておく数（新しい 3 つ）を使わない
  const many = [ps[0], ...["r1", "r2", "r3", "r4"].map((id, i) => ({ id, view: "list", about: "c", by: "アリス", seq: 10 + i })), ...["n1", "n2", "n3"].map((id, i) => ({ id, view: "text", about: "c", by: "manager", data: { to: "アリス", text: "x" }, seq: 20 + i }))];
  const p2 = benchPlan(many[0], many, kidsOf(many), turn);
  assert.equal(p2.main.p.id, "r4");
  assert.deepEqual([...p2.fold], ["n3", "n2", "n1"], "結果は三つとも開いたまま");
});

test("面の中を押しても面は閉じない：開く・閉じるのは ▸ のボタンだけ", () => {
  // 面の箱に data-face を付けると、中のどこを押しても「面を閉じる」に化ける
  const box = take(/^function benchBox\([\s\S]*?^}$/m);
  assert.doesNotMatch(box, /dataset\.face/);
  assert.match(box, /box\.dataset\.bench = t\.id/);
  assert.match(html, /e\.target\.closest\("button\[data-face\]"\)/);
  assert.doesNotMatch(html, /closest\("\[data-face\]"\)/);
  // data-face を持つのはボタンだけ
  for (const m of html.matchAll(/<(\w+)[^<>]*\sdata-face=/g)) assert.equal(m[1], "button");
});
