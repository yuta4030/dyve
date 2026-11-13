// 画面の行の中：表の 2 段目の枝、状況の動いている行、面の担当の一覧（記録は主役にも知らせにもしない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isRecord as boardIsRecord, RECORD as BOARD_RECORD } from "../src/board.js";

const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const take = (re) => html.match(re)[0];
const fnSrc = (name) => take(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"));
const recSrc = [take(/^const RECORD = .*$/m), take(/^const isRecord = .*$/m)].join("\n");
const isRecord = new Function(`${recSrc}; return isRecord;`)();

const b = (id, state, depth = 1, parent = null) => ({ id, type: "Explore", what: `頼み ${id}`, depth, parent, state });

test("枝：数本までなら全部を、呼んだ順の木で。深さはそのまま", () => {
  const branchesOf = new Function(`${take(/^const BRANCH_MAX = .*$/m)}\n${fnSrc("branchesOf")}; return branchesOf;`)();
  const got = branchesOf([b("a", "running"), b("c", "done"), b("a1", "running", 2, "a")]);
  assert.deepEqual(got.shown.map((x) => [x.id, x.depth, x.state]), [["a", 1, "running"], ["a1", 2, "running"], ["c", 1, "done"]], "呼ばれたものは呼んだものの下に");
  assert.equal(got.more, 0);
  assert.deepEqual(branchesOf([]), { shown: [], more: 0, moreRunning: 0 });
  assert.deepEqual(branchesOf(undefined).shown, []);
});

test("枝：多いときは三本と「ほか N 本」。動いているもの → 止まったもの → 終わったものの順に選ぶ", () => {
  const branchesOf = new Function(`${take(/^const BRANCH_MAX = .*$/m)}\n${fnSrc("branchesOf")}; return branchesOf;`)();
  const list = [b("d1", "done"), b("d2", "done"), b("r1", "running"), b("f1", "failed"), b("r2", "running"), b("r3", "running", 2, "r2")];
  const got = branchesOf(list);
  assert.equal(got.shown.length, 3, "「ほか」と合わせて四行まで");
  assert.deepEqual(got.shown.map((x) => x.id), ["r1", "r2", "r3"], "動いているものを先に選び、木の順に並べる");
  assert.deepEqual([got.more, got.moreRunning], [3, 0]);
  const four = branchesOf(list.slice(0, 4));
  assert.deepEqual(four.shown.map((x) => x.id), ["d1", "d2", "r1", "f1"], "四本までは畳まない");
  const mostlyRunning = branchesOf(["a", "b", "c", "d", "e"].map((id) => b(id, "running")));
  assert.deepEqual([mostlyRunning.more, mostlyRunning.moreRunning], [2, 2]);
  // 深さは 1 から 4 に収める（字下げが崩れない）
  assert.deepEqual(branchesOf([{ id: "x", depth: 9, state: "running" }, { id: "y", state: "done" }]).shown.map((x) => x.depth), [4, 1]);
});

test("枝は行ではない：data-row を持たず、面も並びも動かさない", () => {
  const els = fnSrc("branchEls"), cx = fnSrc("branchCx");
  for (const s of [els, cx]) assert.doesNotMatch(s, /data-row|dataset\.row|takeOut|LAYOUT|op\(/);
  assert.match(fnSrc("rowEls"), /rowEl\(t\), \.\.\.branchEls\(t\.id\)/, "表の 2 段目に枝");
  assert.match(fnSrc("cardHtml"), /branchCx\(q\.id\)/, "面の札（行の中の行）にも枝");
});

test("状況：清書係とマネージャのほかは、動いている行を起きた順に。記号・名前・行の中で動いている数", () => {
  const panels = [{ id: "p1", view: "task", key: "A", data: { title: "予定を調べる" } }, { id: "p2", view: "task", data: { text: "受け入れた提案" } }];
  const runsOf = new Function("rowName", "clipText", "subText", `${fnSrc("runsOf")}; return runsOf;`)((t) => t.data.title, (s) => s, (t) => t.data.text);
  const byId = (id) => panels.find((p) => p.id === id);
  const agents = [
    { name: "backroom", task: "p2", startedAt: 20, inside: [] },
    { name: "backroom", task: "p1", startedAt: 10, inside: [b("a", "running"), b("b", "running"), b("c", "done")] },
    { name: "backroom", task: "gone", startedAt: 30 },
  ];
  assert.deepEqual(runsOf(agents, byId), [
    { id: "p1", key: "A", name: "予定を調べる", role: "backroom", run: 2 },
    { id: "p2", key: "", name: "受け入れた提案", role: "backroom", run: 0 },
    { id: "gone", key: "", name: "gone", role: "backroom", run: 0 },
  ]);
  assert.deepEqual(runsOf(undefined, byId), []);
  // 押すとその行へ（面は開かない）。宛てるボタンはない
  const live = fnSrc("renderLive");
  assert.match(live, /data-runrow=/);
  assert.match(live, /L\.runsIdle/);
  assert.doesNotMatch(live, /data-to|S\.to|S\.names/);
  assert.doesNotMatch(fnSrc("goRow"), /takeOut|LAYOUT/);
});

test("担当の一覧の見分け方は、ボードの isRecord と同じ", () => {
  assert.equal(BOARD_RECORD, "inside");
  const cases = [
    { by: "board", view: "table", data: { columns: [], rows: [], record: "inside" } },
    { by: "backroom", view: "table", data: { record: "inside" } },
    { by: "board", view: "text", data: { record: "inside" } },
    { by: "board", view: "table", data: { columns: [], rows: [] } },
    null,
  ];
  for (const p of cases) assert.equal(isRecord(p), boardIsRecord(p));
});

test("面：担当の一覧は主役にせず、畳まずに残りのいちばん後ろに。一覧しかなくても主役にしない", () => {
  const src = [recSrc, take(/^const REST_OPEN = .*$/m), fnSrc("benchPlan")].join("\n");
  const benchPlan = new Function(`${src}; return benchPlan;`)();
  const kids = (ps) => (id) => ps.filter((p) => p.about === id);
  const rec = { id: "rec", view: "table", about: "c", by: "board", data: { columns: ["誰"], rows: [["Explore"]], record: "inside" }, seq: 9, aiSeq: 9 };
  const ps = [
    { id: "c", view: "task", key: "C", seq: 1 },
    { id: "res", view: "list", about: "c", by: "backroom", seq: 3 },
    { id: "m", view: "text", about: "c", by: "manager", data: { to: "backroom", text: "続き" }, seq: 5 },
    rec,
  ];
  const plan = benchPlan(ps[0], ps, kids(ps), () => null, { marked: () => true });
  assert.equal(plan.main.p.id, "res", "いちばん新しくても、記録は主役にしない");
  assert.deepEqual(plan.rest.map((x) => x.p.id), ["m", "rec"], "記録は行への言葉よりも後ろ");
  assert.equal(plan.fold.has("rec"), false, "畳まない（見出しで担当の一覧とわかる）");
  const only = benchPlan(ps[0], [ps[0], rec], kids([ps[0], rec]), () => null);
  assert.equal(only.main, null);
  assert.deepEqual(only.rest.map((x) => x.p.id), ["rec"]);
  // 見出しは「担当の一覧」
  assert.match(html, /record: "担当の一覧"/);
  assert.match(html, /const kind = isRecord\(p\) \? "record"/);
});

test("担当の一覧は知らせにならず、結果の一行にも、まとまりの新しさにも数えない", () => {
  const markOf = new Function("S", "isPerson", `${recSrc}\n${fnSrc("markOf")}; return markOf;`)({ marks: {}, seen: {} }, (by) => by === "human");
  assert.equal(markOf({ id: "r", by: "board", view: "table", data: { record: "inside" }, aiSeq: 5 }), null);
  assert.equal(markOf({ id: "t", by: "backroom", view: "table", data: { columns: [], rows: [] }, aiSeq: 5 }), "notice", "ほかの表は知らせになる");
  const S = { panels: [
    { id: "k", view: "task" },
    { id: "rec", about: "k", by: "board", view: "table", data: { columns: ["誰"], rows: [["Explore"]], record: "inside" } },
  ] };
  const lineOf = (d) => (typeof d === "string" ? d : (d?.rows?.[0] || []).join(" "));
  const resultLine = new Function("S", "isPerson", "lineOf", "dataOf", "L", `${recSrc}\n${take(/^const STAFF = .*$/m)}\n${fnSrc("resultLine")}; return resultLine;`)(S, (by) => by === "human", lineOf, (p) => p.data, {});
  assert.equal(resultLine(S.panels[0]), "", "記録しかなければ結果の一行はない");
  S.panels.push({ id: "ans", about: "k", by: "backroom", view: "text", data: "答え" });
  assert.equal(resultLine(S.panels[0]), "答え");
  // 見たことの数え方・変わった行の色・まとまりの並び・まとまりの見出しの一行・トークの「→ N」からも外す
  assert.match(fnSrc("dwellCands"), /isRecord\(p\)/);
  assert.match(fnSrc("prevOf"), /isRecord\(p\)/);
  const render = fnSrc("render");
  assert.match(render, /const lastOf = \(g\) => [^\n]*!isRecord\(p\)/);
  assert.match(render, /const results = inside\.filter\(\(p\) => [^\n]*!isRecord\(p\)/);
  assert.match(render, /const d = desc\(p\.id\)\.filter\(\(x\) => !isRecord\(x\)\)/);
});

test("古い版の、to の付いた発言と直接の仕事：描けて、返事の「受け取りました」を足さない", () => {
  const repliesOf = new Function(`${fnSrc("repliesOf")}; return repliesOf;`)();
  const opts = { words: { busy: "取りかかっています…", wait: "受け取りました" } };
  const say = { id: "s", view: "say", by: "human", to: "アリス", data: "これやって", seq: 1 };
  assert.deepEqual(repliesOf(say, [say], opts), [], "仕事が立っていなければ何も出さない");
  const direct = { id: "d", view: "task", about: "s", by: "board", state: "done", data: { text: "これやって", to: "アリス", direct: true, from: ["s"] }, seq: 2 };
  const ack = { id: "d1", view: "text", about: "d", by: "アリス", data: "わかりました", seq: 3 };
  assert.deepEqual(repliesOf(say, [say, direct, ack], opts).map((r) => [r.id, r.text, r.wait]), [["d1", "わかりました", false]]);
  // 発言の小さな札は残る（呼び名で）
  assert.match(fnSrc("panelEl"), /if \(p\.to\) tags\.push\(`<span class="to">/);
  // 入力欄には宛てるものがない
  assert.doesNotMatch(html, /id="to"[ >]|\bsetTo\b|toPlaceholder|toChip|data-to=/);
  assert.doesNotMatch(take(/^const L = \{[\s\S]*?^\};$/m), /アリス|宛/);
});
