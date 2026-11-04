import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Desk } from "../src/desk.js";
import { createServer } from "../src/server.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyve-desk-"));

test("新しいボードにしても前の操作ログは残り、切り替えて戻れる", () => {
  const dir = tmp();
  const woke = [];
  const wake = (store) => ({ store, started: false, stopped: false, start() { this.started = true; woke.push(this); }, stop() { this.stopped = true; } });
  const desk = new Desk({ file: path.join(dir, "board.jsonl"), wake, now: () => new Date("2026-11-03T01:02:03Z") });
  desk.store.apply({ by: "human", type: "add", panel: { view: "say", data: "前の話" } });
  assert.equal(desk.current(), "board");
  desk.create();
  assert.equal(desk.current(), "board-20261103-010203");
  assert.equal(desk.store.board.list().length, 0);
  // 前のボードの起こし係は止め、新しいボードの起こし係を動かす
  assert.equal(woke[0].stopped, true);
  assert.equal(woke[1].started, true);
  assert.deepEqual(desk.list().map((b) => b.name).sort(), ["board", "board-20261103-010203"]);
  desk.open("board");
  assert.equal(desk.store.board.list()[0].data, "前の話");
  assert.throws(() => desk.open("../etc/passwd"), /名前/);
  assert.throws(() => desk.open("nai"), /ない/);
});

test("画面からボードを切り替えると、MCP も新しいボードを読み書きする", async () => {
  const dir = tmp();
  const desk = new Desk({ file: path.join(dir, "board.jsonl") });
  desk.store.apply({ by: "human", type: "add", panel: { view: "say", data: "一枚目" } });
  const server = createServer({ store: desk.store, waker: desk.waker, desk });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.name, "board");
    assert.equal(b.panels.length, 1);
    const r = await (await post(`${base}/api/boards`, { action: "new" })).json();
    assert.equal(r.ok, true);
    b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.panels.length, 0);
    await post(`${base}/mcp?as=manager`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "panel_add", arguments: { view: "text", data: "二枚目", reason: "x" } } });
    assert.equal(desk.store.board.list()[0].data, "二枚目");
    const list = await (await fetch(`${base}/api/boards`)).json();
    assert.equal(list.boards.length, 2);
    await post(`${base}/api/boards`, { action: "open", name: "board" });
    b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.panels[0].data, "一枚目");
    const bad = await (await post(`${base}/api/boards`, { action: "open", name: "../x" })).json();
    assert.equal(bad.ok, false);
  } finally {
    server.closeAll();
  }
});
