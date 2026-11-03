import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { marks, sourceApproved } from "../src/board.js";
import { Feeds, parseOutput } from "../src/feeds.js";
import { ensurePanels, listViews, readView } from "../src/panels.js";
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
  assert.deepEqual(listViews(dir).map((v) => v.name), ["bars"]);
  assert.match(readView(dir, "bars"), /dyve\.view/);
  assert.equal(readView(dir, "../x"), null);
  fs.writeFileSync(path.join(dir, "views", "Bad Name.js"), "");
  assert.deepEqual(listViews(dir).map((v) => v.name), ["bars"]);
  // 二度目は見本を書き直さない（利用者が消したものを戻さない）
  fs.rmSync(path.join(dir, "views", "bars.js"));
  ensurePanels(dir);
  assert.deepEqual(listViews(dir), []);
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
    assert.deepEqual(b.views.map((v) => v.name), ["bars"]);
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
