import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { answer, TOOLS, questionsOf, groupsOf } from "../src/mcp.js";
import { createServer } from "../src/server.js";

const setup = () => {
  const log = new Log();
  log.add("open", { session: 1, name: "料金" });
  return log;
};
const call = (log, name, args, session = 1) => answer(log, session, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

test("MCP：始まりのあいさつと道具の一覧に答え、通知には返さない", () => {
  const log = setup();
  const init = answer(log, 1, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(answer(log, 1, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = answer(log, 1, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["ask", "state"]);
  assert.equal(answer(log, 1, { jsonrpc: "2.0", id: 3, method: "server/discover" }).error.code, -32601);
  assert.ok(TOOLS.every((t) => t.inputSchema.type === "object"));
});

test("ask：質問を記録に置き、前の質問は置き換わる。読めないものは断る", () => {
  const log = setup();
  const r = call(log, "ask", { questions: [{ title: "案", why: "値段が違う", options: [{ label: "甲", effect: "安い", recommended: true }, { label: "乙" }] }] });
  assert.match(r.result.content[0].text, /1 問/);
  const x = log.state.sessions[0];
  assert.deepEqual(x.asks.questions, [{ title: "案", why: "値段が違う", options: [{ label: "甲", effect: "安い", recommended: true }, { label: "乙", effect: "" }] }]);
  call(log, "ask", { questions: [{ title: "時期", options: [{ label: "今月" }, { label: "来月" }] }] });
  assert.equal(x.asks.questions[0].title, "時期");
  assert.equal(call(log, "ask", { questions: [{ title: "", options: [] }] }).result.isError, true);
  assert.equal(call(log, "ask", { questions: [] }, 9).error.code, -32602);
});

test("state：木を記録に置く。長すぎるものや形の崩れは整える", () => {
  const log = setup();
  call(log, "state", { groups: [{ name: "契約", items: [{ done: true, name: "人数", value: "8 人", why: "会話で決めた" }, { done: false, name: "案", ask: 1 }, { name: "" }] }, { items: [] }] });
  assert.deepEqual(log.state.sessions[0].tree, [{ name: "契約", items: [{ done: true, name: "人数", value: "8 人", why: "会話で決めた" }, { done: false, name: "案", ask: 1 }] }]);
  assert.equal(questionsOf({ questions: [{ title: "x".repeat(100), options: [{ label: "a" }] }] })[0].title.length, 40);
  assert.deepEqual(groupsOf({}), []);
});

test("MCP の口：鍵の合うものだけ答える。答えると質問を一通の発言にしてそのセッションへ渡し、質問を下げる", async () => {
  const log = setup(), sent = [];
  const server = createServer({ log, mcpKey: "k", sessions: { send: (s, say) => sent.push([s, say]) } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = (path, m) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(m) });
  assert.equal((await rpc("/mcp/nope/1", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
  const r = await rpc("/mcp/k/1", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { questions: [{ title: "案", options: [{ label: "甲" }, { label: "乙" }] }, { title: "時期", options: [{ label: "今月" }, { label: "来月" }] }] } } });
  assert.equal(r.status, 200);
  assert.equal((await rpc("/mcp/k/1", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const a = await fetch(`${base}/api/answer`, { method: "POST", body: JSON.stringify({ session: 1, answers: [{ q: 0, a: "乙" }, { q: 1, a: "来月" }, { q: 5, a: "x" }] }) });
  assert.equal(a.status, 200);
  const say = log.state.said.at(-1);
  assert.equal(say.text, "質問への答え\n1. 案：乙\n2. 時期：来月");
  assert.equal(say.session, 1);
  assert.deepEqual(sent, [[1, say.id]]);
  assert.equal(log.state.sessions[0].asks, null);
  server.closeAll();
});
