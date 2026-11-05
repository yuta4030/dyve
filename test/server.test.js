import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { toMarkdown } from "../src/export.js";
import { claudeArgs } from "../src/agents.js";
import { unwrapData } from "../src/mcp.js";

async function withServer(fn) {
  const store = new Store();
  const server = createServer({ store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ store, base });
  } finally {
    server.closeAll();
  }
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("画面から来る操作は人のもの", async () => {
  await withServer(async ({ store, base }) => {
    const r = await (await post(`${base}/api/op`, { type: "add", panel: { view: "say", data: "やあ" } })).json();
    assert.equal(r.ok, true);
    assert.equal(store.board.list()[0].by, "human");
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.equal(b.panels.length, 1);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<script type="module">/);
  });
});

test("別のサイトからの書き込みは断る", async () => {
  await withServer(async ({ base }) => {
    const r = await post(`${base}/api/op`, { type: "add", panel: { view: "say", data: "x" } }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });
});

test("MCP の口：初期化・道具の一覧・書き込みは名乗った立場で、人にはなれない", async () => {
  await withServer(async ({ store, base }) => {
    const rpc = async (as, method, params, id = 1) => (await post(`${base}/mcp?as=${encodeURIComponent(as)}`, { jsonrpc: "2.0", id, method, params })).json();
    const init = await rpc("manager", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    // ボードの決まりは MCP の説明に一つだけ持つ（定義には役割だけ）
    assert.match(init.result.instructions, /## パネル[\s\S]*## 守ること/);
    const note = await post(`${base}/mcp?as=manager`, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const tools = await rpc("manager", "tools/list");
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["board_read", "panel_add", "panel_edit", "panel_drop", "board_view", "panel_view", "board_layout", "word_add", "panel_history"]);

    store.apply({ by: "human", type: "add", panel: { view: "say", data: "えっと、あの" } });
    const add = await rpc("アリス", "tools/call", { name: "panel_add", arguments: { view: "text", about: "p1", data: "答え", reason: "調べた" } });
    assert.equal(JSON.parse(add.result.content[0].text).ok, true);
    assert.equal(store.board.list()[1].by, "アリス");

    const noReason = await rpc("アリス", "tools/call", { name: "panel_add", arguments: { view: "text" } });
    assert.equal(noReason.result.isError, true);

    const asHuman = await rpc("human", "tools/call", { name: "panel_edit", arguments: { id: "p1", pinned: true, reason: "x" } });
    assert.equal(JSON.parse(asHuman.result.content[0].text).code, "forbidden");

    const read = await rpc("manager", "tools/call", { name: "board_read", arguments: { since: 1 } });
    const view = JSON.parse(read.result.content[0].text);
    assert.equal(view.seq, 2);
    assert.deepEqual(view.panels.map((p) => p.id), ["p2"]);
  });
});

test("MCP の data：二重にくるまれた文字列はほどき、ほかはそのまま", async () => {
  assert.equal(unwrapData('"# 見出し\\n本文"'), "# 見出し\n本文");
  assert.equal(unwrapData(JSON.stringify(JSON.stringify("二重"))), "二重");
  assert.equal(unwrapData("「引用」はそのまま"), "「引用」はそのまま");
  assert.equal(unwrapData('"閉じていない'), '"閉じていない');
  assert.equal(unwrapData('"a" と "b"'), '"a" と "b"');
  assert.deepEqual(unwrapData(["a"]), ["a"]);
  assert.equal(unwrapData("[1, 2]"), "[1, 2]");
  await withServer(async ({ store, base }) => {
    await post(`${base}/mcp?as=${encodeURIComponent("アリス")}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "panel_add", arguments: { view: "md", data: '"# dyve\\n本文"', reason: "x" } } });
    assert.equal(store.board.list()[0].data, "# dyve\n本文");
  });
});

test("操作ログはファイルに積まれ、起動し直しても同じボードになる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
  const file = path.join(dir, "log.jsonl");
  const a = new Store(file);
  a.apply({ by: "human", type: "add", panel: { view: "say", data: "一つ目" } });
  a.apply({ by: "manager", type: "edit", panel: { id: "p1", data: "一つ目。" }, reason: "清書" });
  const b = new Store(file);
  assert.deepEqual(b.board.list(), a.board.list());
  fs.rmSync(dir, { recursive: true });
});

test("Markdown に書き出す（AI を使わない）", () => {
  const s = new Store();
  s.apply({ by: "human", type: "add", panel: { view: "say", data: "検索を速くしたい" } });
  s.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", about: "p1", data: { text: "原因を調べる" } }, reason: "x" });
  s.apply({ by: "アリス", type: "add", panel: { view: "table", about: "p2", data: { columns: ["原因", "確度"], rows: [["索引がない", "高"]] } }, reason: "x" });
  const md = toMarkdown(s.board, { title: "テスト", now: new Date("2026-11-02T10:00:00Z") });
  assert.match(md, /^# テスト/);
  assert.match(md, /^- 検索を速くしたい$/m);
  assert.match(md, /^ {2}- manager：原因を調べる（仕事）$/m);
  assert.match(md, /\| 索引がない \| 高 \|/);
});

test("エージェントの起こし方：役割ごとの道具と、名乗りを付けた MCP の口", () => {
  const args = claudeArgs({ role: "task", name: "アリス", prompt: "やって" }, "http://127.0.0.1:4740");
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.equal(mcp.mcpServers.board.url, "http://127.0.0.1:4740/mcp?as=%E3%82%A2%E3%83%AA%E3%82%B9");
  assert.ok(args.includes("WebSearch"));
  const allowed = args.slice(args.indexOf("--allowedTools") + 1);
  assert.ok(!allowed.includes("Edit") && !allowed.includes("Bash"));
  const m = claudeArgs({ role: "manager", name: "manager", prompt: "整えて" }, "http://x");
  assert.deepEqual(m.slice(m.indexOf("--allowedTools") + 1), ["mcp__board"]);
  assert.match(m[m.indexOf("--append-system-prompt") + 1], /ボードマネージャ/);
  assert.ok(!m.includes("--model"));
  const r = claudeArgs({ role: "manager", name: "manager", prompt: "整えて" }, "http://x", {}, { room: "/repo/x" });
  assert.match(r[r.indexOf("--append-system-prompt") + 1], /リポジトリ \/repo\/x/);
});

test("エージェントの起こし方：前置きを固定してキャッシュを効かせる", () => {
  const t = claudeArgs({ role: "task", name: "ボブ", prompt: "やって" }, "http://x");
  assert.ok(t.includes("--exclude-dynamic-system-prompt-sections"));
  assert.equal(t[t.indexOf("--output-format") + 1], "json");
  const m = claudeArgs({ role: "manager", name: "manager", prompt: "整えて" }, "http://x");
  assert.ok(!m.includes("--exclude-dynamic-system-prompt-sections"));
  // 清書係は起こしっぱなしの会話で、発言を書き換える道具だけ
  const s = claudeArgs({ role: "scribe", name: "scribe" }, "http://x", { scribe: "haiku" }, { stream: true });
  assert.equal(s[s.indexOf("--input-format") + 1], "stream-json");
  assert.equal(s[s.indexOf("--model") + 1], "haiku");
  assert.deepEqual(s.slice(s.indexOf("--allowedTools") + 1), ["mcp__board__panel_edit", "mcp__board__word_add"]);
  assert.match(s[s.indexOf("--append-system-prompt") + 1], /清書係/);
});

test("エージェントの起こし方：役割ごとのモデル", () => {
  const models = { manager: "haiku", task: "opus" };
  const m = claudeArgs({ role: "manager", name: "manager", prompt: "整えて" }, "http://x", models);
  assert.equal(m[m.indexOf("--model") + 1], "haiku");
  assert.deepEqual(m.slice(m.indexOf("--allowedTools") + 1), ["mcp__board"]);
  const t = claudeArgs({ role: "task", name: "ボブ", prompt: "やって" }, "http://x", models);
  assert.equal(t[t.indexOf("--model") + 1], "opus");
  const n = claudeArgs({ role: "task", name: "ボブ", prompt: "やって" }, "http://x", { manager: "haiku" });
  assert.ok(!n.includes("--model"));
});
