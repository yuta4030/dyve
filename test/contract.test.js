// 互換性の約束（README の「互換性」）を確かめる。
// ここが落ちる変更は壊れる変更：マイナー版を上げ、CHANGELOG の「壊れる変更」に書く。項目や道具を足すだけなら壊れる変更ではない（ここにも足す）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { Board, CODES, STATES, RELS, POINTS, marks, sourceApproved } from "../src/board.js";
import { Feeds, parseOutput, asStdin } from "../src/feeds.js";
import { createServer } from "../src/server.js";
import { handleRpc, TOOLS } from "../src/mcp.js";
import { readConfig } from "../src/crew.js";
import { ensurePanels } from "../src/panels.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const CLI = here("../bin/dyve.js");
const FIXTURE = here("./fixtures/board-0.5.0.jsonl");
const html = fs.readFileSync(here("../src/ui.html"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyve-contract-"));

// CLI を子プロセスで走らせる。設定は空の場所を指す（利用者の ~/.dyve を読まない）
function dyve(args, { stdin = "", home = tmp() } = {}) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => ok({ code, out, err }));
    p.stdin.end(stdin);
  });
}

async function withBoard(fn) {
  const store = new Store();
  const feeds = new Feeds({ store, exec: (c, o, cb) => { setTimeout(() => cb(null, "ok\n", ""), 1); return { stdin: { on() {}, end() {} } }; } }).start();
  const server = createServer({ store, feeds });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn({ store, port: String(server.address().port), base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    feeds.stop();
    server.closeAll();
  }
}

test("約束：操作ログ。0.5.0 が書いたログを当て直せて、パネルが同じ形で戻る", () => {
  const board = new Store(FIXTURE).board;
  assert.equal(board.seq, 20);
  const by = (view) => board.list().filter((p) => p.view === view);
  // 清書しても元の文はログに残り、id は変わらない
  const say = by("say")[0];
  assert.equal(say.id, "p1");
  assert.equal(say.data, "認証のやり方を調べて");
  assert.equal(board.history("p1")[0].panel.data, "えーと認証のやり方を調べて");
  assert.equal(by("say")[1].to, "アリス");
  assert.equal(by("say")[2].into, "p1");
  const topic = by("topic")[0];
  assert.equal(topic.pinned, true);
  const task = by("task")[0];
  assert.deepEqual({ state: task.state, about: task.about, from: task.data.from }, { state: "done", about: topic.id, from: ["p1"] });
  assert.equal(by("list")[0].about, undefined, "about を null にすると外へ移る");
  assert.equal(by("list")[0].rel.kind, "compare");
  assert.equal(by("text").find((p) => p.by === "ボブ@docs").state, "done");
  const bars = by("bars")[0];
  assert.deepEqual(bars.source, { shell: "du -s * | sort -n", every: 60 });
  assert.equal(sourceApproved(board, bars.id), true);
  assert.equal(by("layout")[0].data.v, 3);
  assert.equal(board.list().some((p) => p.data === "下書き"), false, "外したパネルは並びから消える（ログには残る）");
  assert.ok(board.log.some((o) => o.type === "drop"));
  assert.deepEqual(marks(board), {});
  // 一行の形
  for (const op of board.log) {
    assert.deepEqual(Object.keys(op).filter((k) => k !== "reason"), ["seq", "at", "by", "type", "panel"]);
    assert.ok(["add", "edit", "drop"].includes(op.type));
    if (op.by !== "human") assert.equal(typeof op.reason, "string");
  }
  // 当て直したボードに、いまの操作を続けて積める
  assert.equal(board.apply({ by: "human", type: "add", panel: { view: "say", data: "続き" } }).op.seq, 21);
});

test("約束：パネルの形と拒否コード", () => {
  const b = new Board();
  const r = b.apply({ by: "human", type: "add", panel: { view: "text", data: "a", source: { shell: "ls", every: 5 }, send: { shell: "cat", label: "送る" } } });
  assert.deepEqual(Object.keys(r), ["ok", "op"]);
  const p = b.get(r.op.panel.id);
  for (const k of ["id", "by", "view", "data", "pinned", "source", "send", "at", "seq", "rev"]) assert.ok(k in p, k);
  const t = b.apply({ by: "アリス", type: "add", panel: { view: "task", state: "task", about: p.id, data: { text: "x" }, rel: null }, reason: "x" }).op.panel;
  assert.deepEqual([t.about, t.state], [p.id, "task"]);
  for (const k of ["pinned", "forbidden", "not_found", "conflict", "invalid"]) assert.ok(k in CODES, k);
  assert.deepEqual(STATES, ["task", "proposal", "done"]);
  assert.deepEqual(RELS, ["compare", "sequence"]);
  // point：発言のとき指していたパネル（0.7.0 から）
  const sp = b.apply({ by: "human", type: "add", panel: { view: "say", data: "これ", point: { id: p.id, how: "hover" } } }).op.panel;
  assert.deepEqual(b.get(sp.id).point, { id: p.id, how: "hover" });
  assert.deepEqual(POINTS, ["hover", "view", "pick"]);
  // 断り方：{ ok: false, code, message }
  const no = b.apply({ by: "アリス", type: "edit", panel: { id: p.id, pinned: true }, reason: "x" });
  assert.deepEqual([no.ok, no.code, typeof no.message], [false, "forbidden", "string"]);
  assert.equal(b.apply({ by: "アリス", type: "add", panel: { view: "text" } }).code, "invalid", "AI の操作は reason を持つ");
  assert.equal(b.apply({ by: "human", type: "edit", panel: { id: "nai", data: 1 } }).code, "not_found");
  assert.equal(b.apply({ by: "human", type: "edit", panel: { id: p.id, rev: 0, data: 1 } }).code, "conflict");
  b.apply({ by: "human", type: "edit", panel: { id: p.id, pinned: true } });
  assert.equal(b.apply({ by: "アリス", type: "edit", panel: { id: p.id, data: 1 }, reason: "x" }).code, "pinned");
});

test("約束：流し込みと送り出しのデータの読み方", () => {
  // source の標準出力と dyve put の標準入力：JSON として読めればその形、読めなければ文字列
  assert.deepEqual(parseOutput('{"a": 1}\n'), { a: 1 });
  assert.equal(parseOutput("  3 files\n"), "3 files");
  // send の標準入力：文字列はそのまま、ほかは JSON。空でなければ改行で終える
  assert.equal(asStdin("はい"), "はい\n");
  assert.equal(asStdin({ a: [1] }), '{"a":[1]}\n');
  assert.equal(asStdin(""), "");
});

test("約束：CLI。引数と終了コード（成功は 0、エラーは 1 と stderr）", async () => {
  for (const args of [[], ["nai"], ["serve", "--nai"], ["put"], ["add"], ["export", "--data", path.join(tmp(), "nai.jsonl")]]) {
    const r = await dyve(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.out, "", args.join(" "));
    assert.ok(r.err.trim(), args.join(" "));
  }
  const usage = (await dyve([])).err;
  for (const c of ["dyve serve", "dyve export", "dyve app", "dyve put <id>", "dyve add --view"]) assert.ok(usage.includes(c), c);

  const ex = await dyve(["export", "--data", FIXTURE]);
  assert.equal(ex.code, 0);
  assert.match(ex.out, /認証のやり方を調べて/);

  await withBoard(async ({ store, port }) => {
    // add：人としてパネルを置き、id を一行で返す。標準入力はデータ（JSON なら JSON）
    const a = await dyve(["add", "--view", "table", "--shell", "ls", "--every", "30", "--send", "cat", "--label", "答える", "--port", port], { stdin: '{"columns": ["a"], "rows": [[1]]}' });
    assert.deepEqual([a.code, a.err], [0, ""]);
    const id = a.out.trim();
    const p = store.board.get(id);
    assert.deepEqual({ by: p.by, view: p.view, data: p.data, source: p.source, send: p.send }, { by: "human", view: "table", data: { columns: ["a"], rows: [[1]] }, source: { shell: "ls", every: 30 }, send: { shell: "cat", label: "答える" } });
    // put：標準入力をそのパネルのデータにする
    const u = await dyve(["put", id, "--port", port], { stdin: "ただの文\n" });
    assert.deepEqual([u.code, u.out.trim()], [0, id]);
    assert.equal(store.board.get(id).data, "ただの文");
    assert.equal(store.board.history(id).at(-1).by, "human");
    const bad = await dyve(["put", "nai", "--port", port], { stdin: "x" });
    assert.equal(bad.code, 1);
    assert.ok(bad.err.trim());
  });
  const down = await dyve(["put", "p1", "--port", "1"], { stdin: "x" });
  assert.equal(down.code, 1);
});

test("約束：MCP の口。道具の名前と引数、返事の形", async () => {
  const tools = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema]));
  const want = {
    board_read: ["since", "about"],
    panel_add: ["view", "data", "about", "state", "source", "send", "rel", "reason"],
    panel_edit: ["id", "rev", "view", "data", "about", "state", "source", "send", "rel", "reason"],
    panel_drop: ["id", "reason"],
    panel_history: ["id"],
    board_view: ["real"],
    panel_view: ["id"],
    board_layout: ["moves", "fold", "zoom", "float", "out", "density", "reset", "reason"],
    word_add: ["heard", "write", "when", "reason"],
    view_list: [],
  };
  for (const [name, args] of Object.entries(want)) {
    assert.ok(tools[name], name);
    for (const a of args) assert.ok(a in tools[name].properties, `${name}.${a}`);
  }
  assert.deepEqual(tools.panel_add.required, ["view", "reason"]);
  assert.deepEqual(tools.panel_edit.required, ["id", "reason"]);

  await withBoard(async ({ store, base }) => {
    const rpc = async (as, method, params) => (await fetch(`${base}/mcp?as=${encodeURIComponent(as)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    const init = (await rpc("アリス", "initialize", { protocolVersion: "2025-06-18" })).result;
    assert.equal(init.serverInfo.name, "board");
    assert.equal(typeof init.instructions, "string");
    const call = async (as, name, args) => JSON.parse((await rpc(as, "tools/call", { name, arguments: args })).result.content[0].text);
    const added = await call("アリス", "panel_add", { view: "text", data: "やあ", reason: "x" });
    assert.deepEqual(Object.keys(added), ["ok", "seq", "id"]);
    assert.equal(store.board.get(added.id).by, "アリス", "?as= の名前で書く");
    const read = await call("アリス", "board_read", {});
    for (const k of ["seq", "panels", "marks"]) assert.ok(k in read, k);
    assert.equal(read.panels[0].id, added.id);
    // 使える view とデータの形（パネル置き場がなければ本体の view だけ）
    const views = await call("アリス", "view_list", {});
    assert.ok(views.builtin.some((v) => v.name === "text" && typeof v.about === "string"));
    assert.deepEqual(views.user, []);
    // MCP から人として書けない
    assert.equal((await call("human", "panel_add", { view: "text", reason: "x" })).code, "forbidden");
  });
  assert.equal(handleRpc(new Store(), null, "アリス", { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("約束：利用者の view の書き方（dyve.view、ctx、色、囲い）", () => {
  const runtime = html.match(/const RUNTIME = `([\s\S]*?)`;\n/)[1];
  assert.match(runtime, /window\.dyve = /);
  assert.match(runtime, /return \{ view: /);
  assert.match(runtime, /fn\(root, init\.data, ctx\)/, "fn(el, data, ctx)");
  for (const k of ["panel", "board", "open", "send"]) assert.match(runtime, new RegExp(`\\b${k}: `), `ctx.${k}`);
  const theme = html.match(/const THEME = (\[.*?\]);/)[1];
  for (const v of ["--bg", "--card", "--ink", "--mute", "--line", "--accent", "--accent-soft", "--warn", "--ok"]) assert.ok(theme.includes(`"${v}"`), v);
  // 囲いは allow-scripts だけ（ボードの API に触れない）
  assert.match(html, /f\.setAttribute\("sandbox", "allow-scripts"\);/);
  // 置き場の決まり：views/<名前>.js
  const dir = path.join(tmp(), "panels");
  ensurePanels(dir);
  assert.ok(fs.existsSync(path.join(dir, "views", "bars.js")));
});

test("約束：設定（config.json）の項目", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "notes.md"), "指示");
  const conf = {
    port: 4740, data: "board.jsonl", room: ".", claude: "claude", slots: 3, agents: "agents",
    task: { model: "opus", prompt: "notes.md" },
    scribe: { model: "haiku", pause: 1000, cwd: ".", mode: "append", prompt: ["notes.md"] },
    manager: { model: "sonnet", pause: 4000, cwd: ".", mode: "replace", prompt: "notes.md" },
    team: [{ name: "マイ", initial: "M", model: "opus", room: ".", mode: "append", prompt: "notes.md" }, { name: "ケン" }],
    teams: [],
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(conf));
  const c = readConfig(path.join(dir, "config.json"));
  for (const k of Object.keys(conf)) assert.ok(k in c, k);
  assert.deepEqual(c.team.map((m) => m.name), ["マイ", "ケン"]);
  assert.deepEqual(readConfig(path.join(dir, "nai.json")), {}, "なければ既定のまま");
});
