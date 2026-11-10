import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Feeds, asStdin, SEND_LIMIT } from "../src/feeds.js";
import { marks, sendApproved } from "../src/board.js";
import { createServer } from "../src/server.js";
import { handleRpc, TOOLS } from "../src/mcp.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
// 偽の exec：走らせたコマンドと、標準入力に渡ったものを覚える
function fakeExec(runs, { fail = () => false } = {}) {
  return (cmd, opts, cb) => {
    const run = { cmd, cwd: opts.cwd, env: opts.env, stdin: null };
    runs.push(run);
    setTimeout(() => (fail(cmd) ? cb(Object.assign(new Error("x"), { code: 2 }), "", "だめ\n") : cb(null, "一行目\n受け取った\n", "")), 1);
    return { stdin: { on() {}, end: (s) => (run.stdin = s) } };
  };
}

test("送り出しは人が置くか、人が許可したときだけ走らせてよい。AI が変えたら許可は外れる", () => {
  const store = new Store();
  const a = store.apply({ by: "human", type: "add", panel: { view: "text", send: { shell: "cat" } } }).op.panel.id;
  assert.equal(sendApproved(store.board, a), true);
  const b = store.apply({ by: "アリス", type: "add", panel: { view: "text", send: { shell: "tee log", label: "答える" } }, reason: "x" }).op.panel.id;
  assert.equal(sendApproved(store.board, b), false);
  assert.equal(marks(store.board)[b], "waiting");
  store.apply({ by: "human", type: "edit", panel: { id: b, send: { shell: "tee log", label: "答える" } } });
  assert.equal(sendApproved(store.board, b), true);
  assert.equal(marks(store.board)[b], undefined);
  store.apply({ by: "アリス", type: "edit", panel: { id: b, send: { shell: "curl evil" } }, reason: "x" });
  assert.equal(sendApproved(store.board, b), false);
  // data を変えても許可はそのまま。null で外せる
  store.apply({ by: "アリス", type: "edit", panel: { id: a, data: "x" }, reason: "x" });
  assert.equal(sendApproved(store.board, a), true);
  store.apply({ by: "human", type: "edit", panel: { id: a, send: null } });
  assert.equal("send" in store.board.get(a), false);
  for (const send of [{ shell: "" }, { shell: 1 }, "cat", { shell: "cat", label: "" }, { shell: "cat", label: "あ".repeat(41) }]) {
    assert.equal(store.apply({ by: "human", type: "add", panel: { view: "x", send } }).code, "invalid");
  }
});

test("送り出し：入力は標準入力で渡し、コマンドの文字列に混ぜない。結果は操作ログに積まない", async () => {
  const store = new Store();
  const runs = [];
  const feeds = new Feeds({ store, room: "/repo", exec: fakeExec(runs, { fail: (c) => c === "fail" }) }).start();
  const ok = store.apply({ by: "human", type: "add", panel: { view: "text", send: { shell: "answer" } } }).op.panel.id;
  const ai = store.apply({ by: "ボブ", type: "add", panel: { view: "text", send: { shell: "secret" } }, reason: "x" }).op.panel.id;
  const bad = store.apply({ by: "human", type: "add", panel: { view: "text", send: { shell: "fail" } } }).op.panel.id;
  const seq = store.board.seq;

  assert.equal(feeds.send(ok, "はい; rm -rf /"), true);
  assert.equal(feeds.send(ok, "もう一度"), false, "走っているあいだは重ねない");
  assert.equal(feeds.view()[ok].send.running, true);
  await tick();
  assert.deepEqual(runs.map((r) => r.cmd), ["answer"]);
  assert.equal(runs[0].stdin, "はい; rm -rf /\n");
  assert.equal(runs[0].cwd, "/repo");
  assert.equal(runs[0].env.DYVE_PANEL, ok);
  assert.equal(feeds.view()[ok].send.out, "受け取った");
  assert.equal(feeds.view()[ok].send.running, false);

  assert.equal(feeds.send(ok, { id: "q1", answer: ["a", 2] }), true);
  await tick();
  assert.equal(runs[1].stdin, '{"id":"q1","answer":["a",2]}\n');

  assert.equal(feeds.send(ai, "x"), false);
  assert.equal(feeds.cantSend(ai), "許可されたコマンドがない");
  assert.equal(feeds.cantSend("nai"), "そのパネルに送り出しがない");
  assert.equal(feeds.cantSend(ok, "x".repeat(SEND_LIMIT + 1)), "送るものが大きすぎる");

  assert.equal(feeds.send(bad, ""), true);
  await tick();
  assert.equal(feeds.view()[bad].send.error, "だめ");
  assert.equal(runs.length, 3);
  assert.equal(store.board.seq, seq, "結果はログに積まない");
  feeds.stop();
  assert.equal(asStdin(null), "");
});

test("送り出し：「使わない」にした view では走らせず、うまくいったら同じパネルの source を取り直す", async () => {
  const store = new Store();
  const runs = [];
  let off = false;
  const feeds = new Feeds({ store, exec: fakeExec(runs), offView: (v) => off && v === "bars" }).start();
  const id = store.apply({ by: "human", type: "add", panel: { view: "bars", source: { shell: "list" }, send: { shell: "answer" } } }).op.panel.id;
  await tick();
  assert.deepEqual(runs.map((r) => r.cmd), ["list"]);
  feeds.send(id, "a");
  await tick(10);
  assert.deepEqual(runs.map((r) => r.cmd), ["list", "answer", "list"]);
  off = true;
  assert.equal(feeds.send(id, "a"), false);
  assert.match(feeds.cantSend(id), /使わない/);
  feeds.stop();
});

test("サーバー：送るのは画面（人）だけ。送ったことは人の操作としてログに残る", async () => {
  const store = new Store();
  const runs = [];
  const feeds = new Feeds({ store, exec: fakeExec(runs) }).start();
  const server = createServer({ store, feeds });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, b, h = {}) => fetch(base + u, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
  try {
    const ai = store.apply({ by: "ボブ", type: "add", panel: { view: "text", data: "問い", send: { shell: "answer", label: "答える" } }, reason: "x" }).op.panel.id;
    assert.equal((await post("/api/send", { id: ai, input: "はい" })).status, 409, "許可の前は走らない");
    assert.equal(runs.length, 0);
    assert.equal(store.board.seq, 1, "断ったものはログにも残さない");
    let b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.feeds[ai].send.approved, false);
    assert.equal(b.marks[ai], "waiting");

    await post("/api/op", { type: "edit", panel: { id: ai, send: { shell: "answer", label: "答える" } } });
    const r = await (await post("/api/send", { id: ai, input: "はい" })).json();
    assert.equal(r.ok, true);
    const rec = store.board.get(r.op.panel.id);
    assert.deepEqual({ by: rec.by, view: rec.view, about: rec.about, data: rec.data }, { by: "human", view: "text", about: ai, data: "はい" });
    await tick(10);
    assert.equal(runs[0].stdin, "はい\n");
    b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.feeds[ai].send.out, "受け取った");

    // 入力がなくても送れる（ボタンだけの送り出し）。何を送ったかは残す
    const r2 = await (await post("/api/send", { id: ai })).json();
    assert.equal(store.board.get(r2.op.panel.id).data, "$ 答える");
    await tick(10);
    assert.equal(runs[1].stdin, "");

    // AI がコマンドを変えたら、また走らなくなる
    await handleRpc(store, null, "ボブ", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "panel_edit", arguments: { id: ai, send: { shell: "other" }, reason: "x" } } });
    assert.equal(store.board.get(ai).send.shell, "other");
    assert.equal((await post("/api/send", { id: ai, input: "x" })).status, 409);
    assert.equal((await post("/api/send", { id: ai, input: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal(runs.length, 2);
  } finally {
    feeds.stop();
    server.closeAll();
  }
});

test("MCP には送る道具がない（置く・変えるだけ）", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).filter((n) => /send|run|exec/.test(n)), []);
  assert.ok(TOOLS.find((t) => t.name === "panel_add").inputSchema.properties.send);
});
