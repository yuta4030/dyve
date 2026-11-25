import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";

async function up() {
  const log = new Log();
  const server = createServer({ log });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { log, base: `http://127.0.0.1:${server.address().port}`, close: () => server.closeAll() };
}

test("発言を置き、状態を返す。覗いていたセッションを添えられる", async () => {
  const { log, base, close } = await up();
  log.add("open", { session: 1, name: "x" });
  const r = await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "これ", peek: 1 }) });
  assert.equal(r.status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.said[0].text, "これ");
  assert.equal(s.said[0].peek, 1);
  const bad = await fetch(`${base}/api/say`, { method: "POST", body: JSON.stringify({ text: " " }) });
  assert.equal(bad.status, 400);
  close();
});

test("ほかの場所からは読み書きさせない", async () => {
  const { base, close } = await up();
  const r = await fetch(`${base}/api/say`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(r.status, 403);
  const p = await fetch(`${base}/api/say`, { method: "POST", headers: { origin: "http://127.0.0.1:1" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(p.status, 403);
  close();
});

test("画面を返す", async () => {
  const { base, close } = await up();
  const r = await fetch(`${base}/`);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await r.text(), /<title>dyve<\/title>/);
  close();
});

test("リセットして戻す。戻せるものがなければ断る", async () => {
  const { log, base, close } = await up();
  const post = (p) => fetch(`${base}${p}`, { method: "POST" });
  assert.equal((await post("/api/undo")).status, 409);
  log.add("say", { text: "x" });
  assert.equal((await post("/api/reset")).status, 200);
  assert.deepEqual(log.state.chat, []);
  assert.equal((await post("/api/undo")).status, 200);
  assert.equal(log.state.chat.length, 1);
  close();
});

test("取り消す・止める・届け先を変えるの口は、セッションに渡す", async () => {
  const log = new Log();
  const calls = [];
  const sessions = { cancel: (s) => (calls.push(["cancel", s]), true), stop: (s) => (calls.push(["stop", s]), false), move: (s, to) => (calls.push(["move", s, to]), true) };
  const server = createServer({ log, sessions });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(`${base}${p}`, { method: "POST", body: JSON.stringify(b) });
  assert.equal((await post("/api/cancel", { say: 3 })).status, 200);
  assert.equal((await post("/api/stop", { session: 1 })).status, 409);
  assert.equal((await post("/api/move", { say: 3, to: "new" })).status, 200);
  assert.equal((await post("/api/move", { say: 3, to: 2 })).status, 200);
  assert.deepEqual(calls, [["cancel", 3], ["stop", 1], ["move", 3, "new"], ["move", 3, 2]]);
  server.closeAll();
});

test("選択肢を押した発言は、係を通さずそのセッションへ直に渡す", async () => {
  const log = new Log(), sent = [];
  log.add("open", { session: 1, name: "x" });
  const server = createServer({ log, sessions: { send: (s, say) => sent.push([s, say]) } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/say`, { method: "POST", body: JSON.stringify({ text: "甲で進めて", to: 1 }) });
  const { record } = await r.json();
  assert.equal(log.state.said[0].session, 1);
  assert.deepEqual(sent, [[1, record.seq]]);
  // ないセッションへは直に渡さず、係に任せる
  await fetch(`http://127.0.0.1:${server.address().port}/api/say`, { method: "POST", body: JSON.stringify({ text: "y", to: 9 }) });
  assert.equal(log.state.said[1].session, undefined);
  server.closeAll();
});
