import { test } from "node:test";
import assert from "node:assert/strict";
import { Board } from "../src/board.js";
import { Focus } from "../src/focus.js";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { managerPrompt, taskPrompt } from "../src/waker.js";

const ai = (b, panel, by = "アリス") => b.apply({ by, type: "add", panel, reason: "試す" }).op.panel.id;

test("人のいま：最新の画面だけを持ち、見たものは端末をまたいで一つにまとめる", () => {
  let t = 0;
  const f = new Focus({ now: () => t });
  assert.equal(f.view(new Board()).presence, "gone");
  f.set("a", { presence: "here", viewing: ["p2"], seen: { p2: 3 } });
  t = 1000;
  f.set("b", { presence: "away", viewing: ["p9"], seen: { p2: 1, p5: 7 } });
  assert.deepEqual(f.current().data.viewing, ["p2"], "人がいる画面を先に");
  assert.deepEqual(f.seen, { p2: 3, p5: 7 }, "大きい方を残す");
  t = 10 * 60 * 1000;
  assert.equal(f.current(), null, "便りがなければいない");
  assert.throws(() => f.set("", {}));
});

test("人のいま：形の悪いものは捨て、まだ見ていないものを導く", () => {
  const b = new Board();
  const say = b.apply({ by: "human", type: "add", panel: { view: "say", data: "やあ" } }).op.panel.id;
  const r = ai(b, { view: "text", data: "結果" });
  const f = new Focus();
  f.set("a", { viewing: ["p1", 3, "x".repeat(99)], tiles: [{ key: "talk", x: 1, y: 1, w: 3, h: 15 }, { key: "bad", x: "1" }], talking: [say] });
  const v = f.view(b);
  assert.deepEqual(v.viewing, ["p1"]);
  assert.deepEqual(v.unseen, [r], "人の発言は知らせにならない");
  assert.deepEqual(f.tiles(), [{ key: "talk", x: 1, y: 1, w: 3, h: 15 }]);
  f.set("a", { seen: { [r]: b.get(r).aiSeq } });
  assert.deepEqual(f.view(b).unseen, []);
});

test("人のいま：マネージャを起こす文と控室の最初の文に数行で混ぜる", () => {
  const b = new Board();
  const topic = ai(b, { view: "topic", data: { title: "並べ方" } }, "manager");
  const task = ai(b, { view: "task", state: "task", about: topic, data: { text: "調べる" } }, "manager");
  const f = new Focus();
  f.set("a", { presence: "here", listening: true, viewing: [topic], talking: [topic], followingTalk: true });
  const m = managerPrompt(0, b, [], f);
  assert.match(m, /## 人のいま\n- いる・聞いています\n- 見ている：p1「並べ方」、トークの末尾/);
  assert.match(m, /話している話題：p1「並べ方」/);
  assert.match(m, /まだ見ていない：p1 p2/);
  assert.match(taskPrompt(b, b.get(task), "アリス", "アリス", f), /人のいま（受け持ったときのもの）：\n- いる/);
  assert.doesNotMatch(managerPrompt(0, b), /人のいま/, "画面がなければ混ぜない");
});

test("人のいま：画面から POST /api/focus で受け、board_read の focus に出る。ログには積まない", async () => {
  const store = new Store();
  const waker = { focus: new Focus(), onChange: () => {}, status: () => null, runningTasks: () => [] };
  const server = createServer({ store, waker });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, body) => fetch(`${base}${u}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const r = await post("/api/focus", { client: "tab1", presence: "here", viewing: ["p1"], seen: { p1: 2 } });
    assert.deepEqual(r.seen, { p1: 2 });
    assert.equal(store.board.seq, 0, "操作ログには積まない");
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(b.seen, { p1: 2 });
    assert.deepEqual(b.focus.viewing, ["p1"]);
    const rpc = await post("/mcp?as=manager", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_read", arguments: {} } });
    assert.equal(JSON.parse(rpc.result.content[0].text).focus.presence, "here");
  } finally {
    server.closeAll();
  }
});
