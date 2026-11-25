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

test("設定を変える。決まっていない値は断る", async () => {
  const { log, base, close } = await up();
  const set = (b) => fetch(`${base}/api/set`, { method: "POST", body: JSON.stringify(b) });
  assert.equal((await set({ key: "send", value: "each" })).status, 200);
  assert.equal(log.state.settings.send, "each");
  assert.equal((await set({ key: "send", value: "later" })).status, 400);
  close();
});

test("覗いているあいだの発言は、係を通さず覗いている先へ。記号で別を呼んだときは係に任せる", async () => {
  const log = new Log(), sent = [];
  log.add("open", { session: 1, name: "a" });
  log.add("open", { session: 2, name: "b" });
  const server = createServer({ log, sessions: { send: (s, say) => sent.push([s, say]) } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const say = (b) => fetch(`http://127.0.0.1:${server.address().port}/api/say`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
  const x = await say({ text: "それも見て", peek: 1 });
  const y = await say({ text: "B は年払いも", peek: 1 });
  assert.deepEqual(sent, [[1, x.record.seq]]);
  assert.equal(log.state.said[1].session, undefined);
  server.closeAll();
});

test("押したシェルを、その場所で動かして結果を返す。画面から押したときだけ", async () => {
  const log = new Log();
  const dir = (await import("node:os")).tmpdir();
  const server = createServer({ log, room: dir, shell: "/bin/sh" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runIt = (cmd, origin = base) => fetch(`${base}/api/run`, { method: "POST", headers: origin ? { origin } : {}, body: JSON.stringify({ cmd }) });
  const r = await (await runIt("pwd; echo oops >&2; exit 3")).json();
  assert.equal(r.code, 3);
  assert.match(r.out, /oops/);
  assert.equal((await runIt("echo x", null)).status, 403);
  server.closeAll();
});

test("押したファイルを手元のアプリで開く：途中からの場所は room から。ないものは断る", async () => {
  const log = new Log(), opened = [];
  const fsm = await import("node:fs"), osm = await import("node:os"), pathm = await import("node:path");
  const room = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "dyve-open-"));
  fsm.mkdirSync(pathm.join(room, "src"));
  fsm.writeFileSync(pathm.join(room, "src", "a.js"), "x");
  log.add("set", { key: "opener", value: "vscode" });
  const server = createServer({ log, room, opener: (o) => opened.push(o) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = (b, origin = base) => fetch(`${base}/api/open`, { method: "POST", headers: origin ? { origin } : {}, body: JSON.stringify(b) });
  assert.equal((await open({ path: "src/a.js", line: 42 })).status, 200);
  assert.deepEqual(opened, [{ file: pathm.join(room, "src", "a.js"), line: 42, col: null, how: "vscode" }]);
  assert.equal((await open({ path: "src/nope.js" })).status, 404);
  assert.equal((await open({ path: "src/a.js" }, null)).status, 403);
  server.closeAll();
});

test("OS の既定で開くと動いてしまうものは見分ける", async () => {
  const { runnable } = await import("../src/server.js");
  const fsm = await import("node:fs"), osm = await import("node:os"), pathm = await import("node:path");
  const d = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "dyve-run-"));
  const f = (n, mode = 0o644) => { const p = pathm.join(d, n); fsm.writeFileSync(p, "x"); fsm.chmodSync(p, mode); return p; };
  assert.equal(runnable(f("a.md")), false);
  assert.equal(runnable(f("go.command")), true);
  assert.equal(runnable(f("tool", 0o755)), true);
});
