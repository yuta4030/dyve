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

test("一覧は中身の様子を持ち、呼び名を付けられ、しまっても戻せる", () => {
  const dir = tmp();
  const desk = new Desk({ file: path.join(dir, "board.jsonl"), now: () => new Date("2026-11-03T01:02:03Z") });
  const s = desk.store;
  const say = s.apply({ by: "human", type: "add", panel: { view: "say", data: "予算の話をする" } }).op.panel.id;
  s.apply({ by: "manager", type: "add", panel: { view: "topic", data: { title: "予算" } }, reason: "x" });
  s.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: say, data: { text: "調べる" } }, reason: "x" });
  s.apply({ by: "アリス", type: "add", panel: { view: "text", state: "proposal", about: say, data: "案" }, reason: "x" });
  s.apply({ by: "manager", type: "add", panel: { view: "summary", data: { points: ["要点1", { text: "要点2" }] } }, reason: "x" });

  const b = desk.list()[0];
  assert.equal(b.first, "予算の話をする");
  assert.deepEqual(b.topics, ["予算"]);
  assert.deepEqual(b.points, ["要点1", "要点2"]);
  assert.equal(b.tasks, 1);
  assert.equal(b.waiting, 1);
  assert.equal(b.views.task, 1);
  assert.equal(b.at, s.board.log.at(-1).at);

  // 呼び名は名前（id）を変えない。空にすれば外れる
  desk.setTitle("board", "  予算の検討 ");
  assert.equal(desk.list()[0].title, "予算の検討");
  assert.equal(desk.list()[0].name, "board");
  assert.equal(desk.titleOf("board"), "予算の検討");
  desk.setTitle("board", "");
  assert.equal(desk.list()[0].title, null);
  assert.throws(() => desk.setTitle("nai", "x"), /ない/);
  assert.throws(() => desk.setTitle("board", "あ".repeat(81)), /80/);

  // いま開いているものはしまえない。しまっても中身は同じで、戻せる
  assert.throws(() => desk.archive("board"), /開いている/);
  desk.create();
  desk.archive("board");
  assert.deepEqual(desk.list().map((x) => x.name), ["board-20261103-010203"]);
  assert.equal(desk.archived()[0].name, "board");
  assert.equal(desk.archived()[0].panels, 5);
  assert.throws(() => desk.open("board"), /ない/);
  desk.restore("board");
  assert.equal(desk.archived().length, 0);
  desk.open("board");
  assert.equal(desk.store.board.list().length, 5);
  assert.throws(() => desk.restore("../x"), /名前/);
});

test("読めないログがあっても一覧は出る", () => {
  const dir = tmp();
  const desk = new Desk({ file: path.join(dir, "board.jsonl") });
  fs.writeFileSync(path.join(dir, "broken.jsonl"), "{ だめ\n");
  assert.equal(desk.list().find((b) => b.name === "broken").broken, true);
});

test("管理の API：ボードの管理と、同じボードを開き直しても知らせが二重にならない", async () => {
  const dir = tmp();
  const desk = new Desk({ file: path.join(dir, "board.jsonl") });
  const server = createServer({ store: desk.store, waker: desk.waker, desk });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => (await fetch(`${base}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  try {
    for (const page of ["/boards", "/panels"]) {
      const r = await fetch(base + page);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /<main id="main">/);
    }
    assert.equal((await post({ action: "title", name: "board", title: "一枚目" })).ok, true);
    assert.equal((await (await fetch(`${base}/api/board`)).json()).boardTitle, "一枚目");
    assert.equal((await post({ action: "archive", name: "board" })).ok, false);
    assert.equal((await post({ action: "nai" })).ok, false);
    assert.equal(desk.store.listeners.size, 1);
    await post({ action: "open", name: "board" });
    assert.equal(desk.store.listeners.size, 1);
    await post({ action: "new" });
    await post({ action: "archive", name: "board" });
    const list = await (await fetch(`${base}/api/boards`)).json();
    assert.equal(list.archived[0].title, "一枚目");
    assert.equal(list.running, 0);
    assert.equal((await post({ action: "restore", name: "board" })).ok, true);
  } finally {
    server.closeAll();
  }
});
