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

test("比べる・順番の組（rel）は一行にまとめ、組でないものは一枚ずつ。並びは置いた順", () => {
  const code = html.match(/^function relRows\([\s\S]*?^}$/m)[0];
  const relRows = new Function(`${code}; return relRows;`)();
  const a = { id: "a" }, b = { id: "b", rel: { kind: "compare", with: ["a"] } }, c = { id: "c" };
  const d = { id: "d", rel: { kind: "sequence", with: ["c"] } }, e = { id: "e", rel: { kind: "sequence", with: ["d"] } }, lone = { id: "f", rel: { kind: "compare", with: ["gone"] } };
  assert.deepEqual(relRows([a, b, c, d, e, lone]).map((r) => r.map((p) => p.id)), [["a", "b"], ["c", "d", "e"], ["f"]]);
});

test("いまの話題：いちばん新しい人の発言から出たものが入っている枠を、新しい順に", () => {
  const code = html.match(/^function talkingKeys\([\s\S]*?^}$/m)[0];
  const S = { panels: [
    { id: "s1", view: "say", by: "human" }, { id: "t1", view: "topic" }, { id: "k1", view: "task", about: "t1", data: { from: ["s1"] } },
    { id: "s2", view: "say", by: "human" }, { id: "t2", view: "topic" }, { id: "k2", view: "task", about: "t2", data: { from: ["s2"] } }, { id: "r2", view: "text", about: "k2" },
    { id: "s3", view: "say", by: "human" }, { id: "s4", view: "say", by: "human", into: "s3" },
  ] };
  const talkingKeys = new Function("S", "isPerson", `${code}; return talkingKeys;`)(S, (by) => by === "human");
  assert.deepEqual(talkingKeys(["t1", "t2"]), ["t2", "t1"], "まだ何も付いていない発言は飛ばす");
  assert.deepEqual(talkingKeys(["t1"]), ["t1"], "並んでいない枠は入れない");
});

const fnOf = (name, ...args) => new Function(...args, `${html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"))[0]}; return ${name};`);
const FLOAT_MIN = { w: 140, h: 60, margin: 8 };

test("浮かせる：四枚は同じ扱いで、ボードの外の層に出す（ボードの拡大縮小が掛からない）", () => {
  assert.match(html, /const FLOATS = \["talk", "status", "quota", "tools"\]/);
  assert.match(html, /<\/main>\s*<div id="floats"><\/div>/, "層は #grid の外");
  const home = html.match(/const FLOAT_HOME = (\{[\s\S]*?\n\});/)[1];
  for (const k of ["talk", "status", "quota", "tools"]) assert.match(home, new RegExp(`\\b${k}: \\{`));
  assert.doesNotMatch(home, /summary/, "いまの要点はボードに残す");
  assert.match(html, /grid\.addEventListener\("click", onClick\);\s*floats\.addEventListener\("click", onClick\);/, "浮かせても押せる");
});

test("浮かせる置き場所：端からの距離で持ち、窓が狭くなっても画面の中に収める", () => {
  const style = fnOf("floatStyle", "FLOAT_MIN")(FLOAT_MIN);
  assert.deepEqual(style({ right: 14, top: 20, w: 224 }, 1000, 800, 90), { left: "auto", right: "14px", top: "20px", bottom: "auto", width: "224px", height: "auto" });
  assert.deepEqual(style({ left: 900, bottom: 700, w: 300, h: 260 }, 1000, 800, 260), { left: "692px", right: "auto", top: "auto", bottom: "532px", width: "300px", height: "260px" });
  assert.equal(style({ left: 14, top: 14, w: 2000, h: 260 }, 500, 800, 260).width, "484px", "窓より広くしない");
});

test("つまんで離したら、近い端で覚える。高さを決めていないものは中身の高さのまま", () => {
  const anchor = fnOf("floatAnchor")();
  const r = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  assert.deepEqual(anchor(r(10, 20, 200, 100), 1000, 800, false), { left: 10, top: 20, w: 200 });
  assert.deepEqual(anchor(r(780, 680, 200, 100), 1000, 800, true), { right: 20, bottom: 20, w: 200, h: 100 });
});

test("追従の遅れは時間で縮み、止まる", () => {
  const step = fnOf("followStep")();
  assert.ok(Math.abs(step(100, 180, 180) - 100 / Math.E) < 1e-9);
  assert.ok(step(-100, 16, 180) < 0 && step(-100, 16, 180) > -100, "向きは変わらない");
  assert.equal(step(0.4, 16, 180), 0);
});

const fn = (name, ...args) => (...vals) => new Function(...args, `${html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"))[0]}; return ${name};`)(...vals);

test("パネルを移す：話題だけが先になり、いまの親と自分の下へは移せない", () => {
  const moveTargets = fn("moveTargets")();
  const ps = [{ id: "a", view: "topic" }, { id: "b", view: "topic" }, { id: "c", view: "topic", about: "x" }, { id: "x", view: "list", about: "a" }, { id: "n", view: "text" }];
  assert.deepEqual(moveTargets(ps, "x").map((p) => p.id), ["b"], "いまの親 a と、自分の下の c は除く");
  assert.deepEqual(moveTargets(ps, "a").map((p) => p.id), ["b"], "自分自身と自分の下は除く");
  assert.deepEqual(moveTargets(ps, "n").map((p) => p.id), ["a", "b", "c"]);
});

test("親のパネルにまとめる：同じ親の下と画面に並ぶものから選び、ほどく先を覚える", () => {
  const cand = fn("bundleCandidates")();
  const plan = fn("bundlePlan")();
  const ps = [{ id: "t", view: "topic" }, { id: "u", view: "topic" }, { id: "x", view: "list", about: "t" }, { id: "y", view: "text", about: "t" }, { id: "z", view: "text", about: "u" }, { id: "s", view: "say" }, { id: "m", view: "summary" }, { id: "l", view: "layout" }];
  assert.deepEqual(cand(ps, "x").map((p) => p.id), ["u", "y"], "親 t は選べない。発言・要点・並びも選べない");
  assert.deepEqual(plan(ps, ["x", "y"]), { about: "t", bundled: { x: "t", y: "t" } }, "同じ親の下なら、その中に作る");
  assert.deepEqual(plan(ps, ["x", "u"]), { about: null, bundled: { x: "t", u: null } }, "ばらばらなら外に作り、それぞれの元の親を覚える");
});

test("いまの話題だけ、枠の高さの上限を外す。ほかは一画面まで", () => {
  assert.match(html, /clamp\(needRows\(tileOf\(k\), m\), 3, k === S\.talking\?\.\[0\] \? Infinity : vr\)/);
});

test("dyve 設定を浮かせても、マップの下のボードの倍率のボタンは隠さない", () => {
  assert.match(html, /\$\("#toTools"\)\.hidden = isFloat\("tools"\)/);
  assert.doesNotMatch(html, /\$\("#toTools"\)\.parentElement\.hidden/);
});

test("浮かせ方の既定は追従（先頭）", () => {
  assert.match(html, /const FLOAT_MODES = \["follow", "front", "off"\]/);
});
