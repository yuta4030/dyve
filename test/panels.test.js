import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { marks, sourceApproved } from "../src/board.js";
import { Feeds, parseOutput } from "../src/feeds.js";
import { ensurePanels, listViews, readView, readSettings, setView, offViews, trashView, restoreView, listTrash, catalog, SAMPLES, sampleSource, sampleData, describeViews } from "../src/panels.js";
import { execFileSync } from "node:child_process";
import { createServer } from "../src/server.js";
import { claudeArgs, claudeSpawner } from "../src/agents.js";
import { Waker } from "../src/waker.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("shell コマンドは人が置くか、人が許可したときだけ走らせてよい。AI が変えたら許可は外れる", () => {
  const store = new Store();
  const a = store.apply({ by: "human", type: "add", panel: { view: "bars", source: { shell: "echo 1" } } }).op.panel.id;
  assert.equal(sourceApproved(store.board, a), true);
  const b = store.apply({ by: "アリス", type: "add", panel: { view: "bars", source: { shell: "echo 2", every: 30 } }, reason: "x" }).op.panel.id;
  assert.equal(sourceApproved(store.board, b), false);
  assert.equal(marks(store.board)[b], "waiting");
  store.apply({ by: "human", type: "edit", panel: { id: b, source: { shell: "echo 2", every: 30 } } });
  assert.equal(sourceApproved(store.board, b), true);
  assert.equal(marks(store.board)[b], undefined);
  store.apply({ by: "アリス", type: "edit", panel: { id: b, source: { shell: "rm -rf /" } }, reason: "x" });
  assert.equal(sourceApproved(store.board, b), false);
  // データだけの書き換えでは許可は変わらない
  store.apply({ by: "アリス", type: "edit", panel: { id: a, data: [1] }, reason: "x" });
  assert.equal(sourceApproved(store.board, a), true);
  assert.equal(store.apply({ by: "human", type: "add", panel: { view: "x", source: { shell: "" } } }).code, "invalid");
  assert.equal(store.apply({ by: "human", type: "add", panel: { view: "x", source: { shell: "ls", every: 1 } } }).code, "invalid");
});

test("流し込み係：許可されたコマンドだけを部屋で走らせ、JSON なら JSON で渡す。結果は操作ログに積まない", async () => {
  const store = new Store();
  const runs = [];
  const exec = (cmd, opts, cb) => { runs.push({ cmd, cwd: opts.cwd }); setTimeout(() => (cmd === "fail" ? cb(Object.assign(new Error("x"), { code: 2 }), "", "だめ\n") : cb(null, '{"a": 3}\n', "")), 1); };
  const feeds = new Feeds({ store, room: "/repo", exec }).start();
  const seen = [];
  feeds.onChange((f) => seen.push(f));
  const ok = store.apply({ by: "human", type: "add", panel: { view: "bars", source: { shell: "count" } } }).op.panel.id;
  const ai = store.apply({ by: "ボブ", type: "add", panel: { view: "bars", source: { shell: "secret" } }, reason: "x" }).op.panel.id;
  const bad = store.apply({ by: "human", type: "add", panel: { view: "bars", source: { shell: "fail" } } }).op.panel.id;
  await tick(10);
  assert.deepEqual(runs.map((r) => r.cmd).sort(), ["count", "fail"]);
  assert.equal(runs[0].cwd, "/repo");
  const v = feeds.view();
  assert.deepEqual(v[ok].data, { a: 3 });
  assert.equal(v[ai].approved, false);
  assert.equal(v[bad].error, "だめ");
  assert.equal(feeds.run(ai), false);
  assert.ok(seen.some((f) => f.id === ok && f.data?.a === 3));
  assert.equal(store.board.seq, 3);
  feeds.stop();
  assert.equal(parseOutput("hello\n"), "hello");
  assert.deepEqual(parseOutput("[1,2]"), [1, 2]);
});

test("パネル置き場：README と見本と git を用意し、view を名前で配る", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-")), "panels");
  ensurePanels(dir);
  assert.ok(fs.existsSync(path.join(dir, "README.md")));
  assert.ok(fs.existsSync(path.join(dir, ".git")));
  const names = () => listViews(dir).map((v) => v.name).sort();
  assert.deepEqual(names(), [...SAMPLES].sort());
  assert.match(readView(dir, "bars"), /dyve\.view/);
  assert.equal(readView(dir, "../x"), null);
  fs.writeFileSync(path.join(dir, "views", "Bad Name.js"), "");
  assert.deepEqual(names(), [...SAMPLES].sort());
  // 二度目は見本を書き直さない（利用者が消したものを戻さない）
  fs.rmSync(path.join(dir, "views", "bars.js"));
  ensurePanels(dir);
  assert.deepEqual(names(), SAMPLES.filter((n) => n !== "bars").sort());
});

test("見本の配り方：すでにある置き場には、まだ配っていない見本だけ足す。上書きせず、消したものは戻さない", () => {
  // 記録を持つ前の版が作った置き場（bars だけを配った）
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-")), "panels");
  fs.mkdirSync(path.join(dir, "views"), { recursive: true });
  fs.mkdirSync(path.join(dir, "trash"));
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  fs.writeFileSync(path.join(dir, "views", "cards.js"), "// 自分の札\ndyve.view(() => {});\n");
  fs.writeFileSync(path.join(dir, "trash", "tree.1700000000000.js"), "// 消した木\n");
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "前の版");
  ensurePanels(dir);
  const names = listViews(dir).map((v) => v.name).sort();
  assert.deepEqual(names, ["cards", "change", "days"], "bars は前に配ったので戻さない。tree は消したので戻さない");
  assert.match(readView(dir, "cards"), /自分の札/, "同じ名前のものは上書きしない");
  assert.equal(readView(dir, "change"), sampleSource("change"));
  assert.match(git("log", "--format=%s", "-1"), /見本の view を足す：change・days/);
  assert.equal(git("status", "--porcelain").trim(), "", "足したものと記録は履歴に積む");
  // 足したものを消しても、もう一度は配らない
  fs.rmSync(path.join(dir, "views", "change.js"));
  ensurePanels(dir);
  assert.equal(readView(dir, "change"), null);
});

test("見本の view：形の違うデータが来ても投げずに何か描き、頭のコメントにデータの形を書く", () => {
  const data = sampleData();
  const odd = [undefined, null, "", "ただの文\n二行目", 3, true, [], [1, "a", null, { x: 1 }], {}, { a: 1 }, { title: 5, files: "x", checks: 3, cards: "y" }, "diff --git a/x b/x\n+++ b/x\n+a\n-b\n"];
  for (const name of SAMPLES) {
    const src = sampleSource(name);
    assert.match(src, /^\/\/ .+\n/, `${name} の頭にコメント`);
    assert.ok(data[name] != null, `${name} の見本のデータ`);
    let fn = null;
    new Function("dyve", src)({ view: (f) => { fn = f; } });
    for (const d of [data[name], ...odd]) {
      const el = { innerHTML: "" };
      fn(el, d, { panel: { id: "p1", view: name } });
      assert.equal(typeof el.innerHTML, "string");
      assert.ok(el.innerHTML.length > 0, `${name} が ${JSON.stringify(d)} で何か描く`);
    }
  }
  const dir = ensurePanels(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-")), "panels"));
  const about = Object.fromEntries(describeViews(dir).map((v) => [v.name, v.about]));
  assert.match(about.change, /data は \{ title/);
  assert.ok(!about.change.includes("dyve.view"), "コメントのところだけ");
});

test("サーバー：view を配り、「今すぐ更新」は許可されたコマンドだけ", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-")), "panels");
  ensurePanels(dir);
  const store = new Store();
  const feeds = new Feeds({ store, exec: (c, o, cb) => cb(null, "ok", "") }).start();
  const server = createServer({ store, feeds, panels: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b) => fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const ai = store.apply({ by: "ボブ", type: "add", panel: { view: "bars", source: { shell: "x" } }, reason: "x" }).op.panel.id;
    let b = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(b.views.map((v) => v.name).sort(), [...SAMPLES].sort());
    assert.equal(b.feeds[ai].approved, false);
    assert.match(await (await fetch(`${base}/api/views/bars`)).text(), /dyve\.view/);
    assert.equal((await fetch(`${base}/api/views/nai`)).status, 404);
    assert.equal((await post("/api/feeds/run", { id: ai })).status, 409);
    await post("/api/op", { type: "edit", panel: { id: ai, source: { shell: "x" } } });
    assert.equal((await post("/api/feeds/run", { id: ai })).status, 200);
    b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.feeds[ai].data, "ok");
  } finally {
    feeds.stop();
    server.closeAll();
  }
});

test("パネルの仕事：アリスたちがパネル置き場で、そこだけを書く", async () => {
  const store = new Store();
  const jobs = [];
  const w = new Waker({ store, spawn: (j) => { jobs.push(j); return { done: new Promise(() => {}), kill() {} }; }, pause: 1e6 }).start();
  store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data: { text: "棒グラフのパネルを作って", write: "panels" } }, reason: "x" });
  assert.equal(jobs[0].role, "panels");
  assert.equal(jobs[0].name, "アリス");
  w.stop();
  const a = claudeArgs({ role: "panels", name: "アリス", prompt: "作って" }, "http://x", { task: "opus" });
  const allowed = a.slice(a.indexOf("--allowedTools") + 1);
  assert.ok(allowed.includes("Write") && allowed.includes("Bash(git commit:*)"));
  assert.ok(!allowed.some((t) => /node --test|push/.test(t)));
  assert.equal(a[a.indexOf("--model") + 1], "opus");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-pj-"));
  const panels = ensurePanels(path.join(dir, "panels"));
  const logDir = path.join(dir, "logs");
  await claudeSpawner({ cmd: "true", staff: path.join(dir, "staff"), panels, boardUrl: "http://x", logDir })({ role: "panels", name: "アリス", taskId: "p1", prompt: "作って" }).done;
  const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), "utf8");
  assert.match(log, new RegExp(`in ${panels}`));
  assert.match(log, /README\.md を読み/);
});

const panelsDir = () => ensurePanels(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-")), "panels"));

test("パネルの設定：渡した項目だけ変わり、置き場の外に持つ。本体の view は使わないにできない", () => {
  const dir = panelsDir();
  setView(dir, "bars", { off: true });
  setView(dir, "bars", { w: 480, h: 300 });
  assert.deepEqual(readSettings(dir).views.bars, { off: true, w: 480, h: 300 });
  assert.deepEqual([...offViews(dir)], ["bars"]);
  setView(dir, "bars", { off: false, h: null });
  assert.deepEqual(readSettings(dir).views.bars, { w: 480 });
  setView(dir, "bars", { w: null });
  assert.equal(readSettings(dir).views.bars, undefined);
  assert.equal(fs.existsSync(path.join(dir, "panel-settings.json")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), "panel-settings.json")), true);
  setView(dir, "topic", { w: 600 });
  assert.throws(() => setView(dir, "text", { off: true }), /本体/);
  assert.throws(() => setView(dir, "say", { w: 300 }), /大きさ/);
  assert.throws(() => setView(dir, "bars", { w: 50 }), /幅/);
  assert.throws(() => setView(dir, "bars", { h: 1.5 }), /高さ/);
  assert.throws(() => setView(dir, "../x", { w: 300 }), /名前/);
});

test("view を消しても trash に残り、履歴に積まれ、戻せる", () => {
  const dir = panelsDir();
  const src = readView(dir, "bars");
  const file = trashView(dir, "bars", 1700000000000);
  assert.equal(readView(dir, "bars"), null);
  assert.deepEqual(listTrash(dir).map((t) => t.name), ["bars"]);
  assert.match(execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }), /bars を消す/);
  assert.equal(execFileSync("git", ["-C", dir, "status", "--short"], { encoding: "utf8" }), "");
  assert.throws(() => restoreView(dir, "../../x.1.js"), /正しくない/);
  fs.writeFileSync(path.join(dir, "views", "bars.js"), "// 別のもの");
  assert.throws(() => restoreView(dir, file), /同じ名前/);
  fs.rmSync(path.join(dir, "views", "bars.js"));
  assert.equal(restoreView(dir, file), "bars");
  assert.equal(readView(dir, "bars"), src);
  assert.equal(listTrash(dir).length, 0);
  assert.throws(() => trashView(dir, "nai"), /ない/);
});

test("管理の一覧：自分の view、描き方がないもの、本体の view を枚数つきで", () => {
  const dir = panelsDir();
  setView(dir, "bars", { off: true, w: 400 });
  const { views } = catalog(dir, { here: { bars: 2, text: 1, gone: 1 }, all: { bars: 5, text: 3, gone: 1 } });
  const by = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.deepEqual(views.filter((v) => v.kind !== "builtin").map((v) => v.name), [...[...SAMPLES].sort(), "gone"]);
  assert.deepEqual(by.bars, { name: "bars", kind: "user", off: true, w: 400, h: null, sizable: true, here: 2, all: 5, sample: null, hash: by.bars.hash });
  assert.ok(by.bars.hash);
  assert.equal(catalog(dir, { samples: { bars: [1] } }).views.find((v) => v.name === "bars").sample[0], 1);
  assert.equal(by.gone.kind, "missing");
  assert.equal(by.say.sizable, false);
  assert.equal(by.text.here, 1);
});

test("使わないにした view：AI も人も新しく置けない。コマンドは止まる。パネルは消えない", async () => {
  const dir = panelsDir();
  const store = new Store();
  const ran = [];
  const exec = (cmd, opts, cb) => { ran.push(cmd); cb(null, "1", ""); };
  const feeds = new Feeds({ store, exec, offView: (v) => offViews(dir).has(v) });
  feeds.start();
  const a = store.apply({ by: "human", type: "add", panel: { view: "bars", source: { shell: "echo 1", every: 60 } } }).op.panel.id;
  assert.equal(ran.length, 1);
  const server = createServer({ store, feeds, panels: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => (await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const mcp = async (name, args) => JSON.parse((await post("/mcp?as=manager", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { reason: "x", ...args } } })).result.content[0].text);
  try {
    const listed = async () => (await mcp("view_list", {})).user.map((v) => v.name);
    assert.ok((await listed()).includes("bars"));
    assert.match((await mcp("view_list", {})).user.find((v) => v.name === "bars").about, /data は/, "頭のコメントでデータの形を伝える");
    assert.equal((await post("/api/panels", { action: "set", name: "bars", off: true })).ok, true);
    assert.ok(!(await listed()).includes("bars"), "使わないにした view は出さない");
    assert.equal(feeds.timers.size, 0, "見張りは止まる");
    assert.equal(feeds.run(a), false);
    const refused = await mcp("panel_add", { view: "bars" });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /使わない/);
    assert.equal((await mcp("panel_add", { view: "text", data: "別の形で" })).ok, true);
    assert.equal((await post("/api/op", { type: "add", panel: { view: "bars" } })).ok, false);
    // すでにあるパネルは消えず、中身は書き換えられる
    assert.equal(store.board.get(a).view, "bars");
    assert.equal((await post("/api/op", { type: "edit", panel: { id: a, data: [1] } })).ok, true);
    const board = await (await fetch(`${base}/api/board`)).json();
    assert.equal(board.panelSet.views.bars.off, true);
    const cat = await (await fetch(`${base}/api/panels`)).json();
    assert.equal(cat.views.find((v) => v.name === "bars").here, 1);
    assert.equal((await post("/api/panels", { action: "set", name: "text", off: true })).ok, false);
    assert.equal((await post("/api/panels", { action: "set", name: "bars", off: false })).ok, true);
    assert.equal(feeds.timers.size, 1);
    assert.equal((await post("/api/panels", { action: "trash", name: "bars" })).ok, true);
    assert.equal(readView(dir, "bars"), null);
    const after = await (await fetch(`${base}/api/panels`)).json();
    assert.equal(after.views.find((v) => v.name === "bars").kind, "missing");
    assert.equal((await post("/api/panels", { action: "restore", file: after.trash[0].file })).ok, true);
    assert.notEqual(readView(dir, "bars"), null);
    assert.equal((await post("/api/panels", { action: "nai" })).ok, false);
  } finally {
    feeds.stop();
    server.closeAll();
  }
});

test("絵の見本：いちばん新しいデータ、コマンドの結果、ほかのボードの順に。ボードの一覧には載せない", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-panels-"));
  const dir = ensurePanels(path.join(root, "panels"));
  const { Desk, samplesOf } = await import("../src/desk.js");
  const other = new Store(path.join(root, "old.jsonl"));
  other.apply({ by: "human", type: "add", panel: { view: "bars", data: [{ label: "前のボード", value: 1 }] } });
  other.apply({ by: "human", type: "add", panel: { view: "text", data: "x".repeat(30000) } });
  assert.deepEqual(Object.keys(samplesOf(other.board)), ["bars"], "大きすぎるものは使わない");
  const desk = new Desk({ file: path.join(root, "board.jsonl") });
  const server = createServer({ store: desk.store, waker: desk.waker, desk, panels: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sample = async (v) => (await (await fetch(`${base}/api/panels`)).json()).views.find((x) => x.name === v).sample;
  try {
    assert.equal((await sample("bars"))[0].label, "前のボード");
    // まだ使っていない見本の view は、配った見本のデータで描く。頭の一行を書き換えたら、別の形とみなして使わない
    assert.deepEqual(await sample("change"), sampleData().change);
    fs.writeFileSync(path.join(dir, "views", "days.js"), "// 自分の形\ndyve.view(() => {});\n");
    assert.equal(await sample("days"), null);
    desk.store.apply({ by: "human", type: "add", panel: { view: "bars", data: [{ label: "古い", value: 1 }] } });
    desk.store.apply({ by: "human", type: "add", panel: { view: "bars", data: [{ label: "新しい", value: 1 }] } });
    assert.equal((await sample("bars"))[0].label, "新しい");
    assert.equal(await sample("table"), null);
    const list = await (await fetch(`${base}/api/boards`)).json();
    assert.equal("samples" in list.boards[0], false);
  } finally {
    server.closeAll();
  }
});
