#!/usr/bin/env node
// CLI：ボードのサーバーを立てる・ボードを Markdown に書き出す
import { parseArgs } from "node:util";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../src/store.js";
import { Desk } from "../src/desk.js";
import { Feeds } from "../src/feeds.js";
import { ensurePanels } from "../src/panels.js";
import { Waker } from "../src/waker.js";
import { spawn as spawnChild } from "node:child_process";
import { claudeSpawner, claudeSession, updateApp, integrate, isAppOf, claudeMissing, ROOT } from "../src/agents.js";
import { createServer } from "../src/server.js";
import { toMarkdown } from "../src/export.js";

const HOME = path.join(os.homedir(), ".dyve");
const USAGE = `使い方:
  dyve serve [--port 4740] [--data FILE] [--room DIR] [--no-agents] [--claude CMD] [--pause MS] [--scribe-pause MS] [--slots N]
              [--scribe-model M] [--manager-model M] [--task-model M]
  dyve export [--data FILE] [--out FILE]
  dyve app [--room DIR] [--ref REF] [--app DIR]   使う dyve を作る側のコミットから切り出す・更新する
  dyve put <id> [--port 4740]                     標準入力をそのパネルのデータにする（JSON なら JSON で）
  dyve add --view V [--shell CMD] [--every SEC] [--port 4740]   人としてパネルを置く（標準入力があればデータに）`;

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
let args;
try {
  args = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4740" },
      data: { type: "string", default: path.join(HOME, "board.jsonl") },
      room: { type: "string", default: process.cwd() },
      "no-agents": { type: "boolean", default: false },
      claude: { type: "string", default: "claude" },
      pause: { type: "string", default: "4000" },
      "scribe-pause": { type: "string", default: "1000" },
      "scribe-model": { type: "string", default: "haiku" },
      "manager-model": { type: "string", default: "sonnet" },
      "task-model": { type: "string" },
      slots: { type: "string", default: "3" },
      title: { type: "string", default: "ボード" },
      out: { type: "string" },
      ref: { type: "string", default: "HEAD" },
      view: { type: "string" },
      shell: { type: "string" },
      every: { type: "string" },
      app: { type: "string", default: path.join(HOME, "app") },
    },
  });
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
const pos = args.positionals;
args = args.values;

// 立て直すときの終了コード。見張り役はこれで落ちた子だけを立て直す
const RESTART = 75;

if (cmd === "serve" && !process.env.DYVE_CHILD) {
  // 見張り役：本体を子として起こし、「更新して再起動」で落ちたら、更新されたコードでもう一度起こす。
  // Ctrl+C は同じプロセスグループの子にも届くので、子が終われば見張り役も終わる
  const script = fileURLToPath(import.meta.url);
  let child = null;
  const run = () => {
    child = spawnChild(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DYVE_CHILD: "1" } });
    child.on("exit", (code, signal) => {
      if (code === RESTART) {
        process.stdout.write("立て直します\n");
        return run();
      }
      process.exit(signal ? 0 : code ?? 0);
    });
  };
  // Ctrl+C は子にも直接届く。kill などで見張り役だけに来たときは子に伝える
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child?.kill(sig));
  run();
} else if (cmd === "serve") {
  if (!args["no-agents"]) {
    const missing = claudeMissing(args.claude);
    if (missing) die(missing);
  }
  const port = Number(args.port);
  const boardUrl = `http://127.0.0.1:${port}`;
  const home = path.dirname(path.resolve(args.data));
  const panels = ensurePanels(path.join(home, "panels"));
  const how = {
    panels,
    cmd: args.claude,
    room: path.resolve(args.room),
    staff: path.join(home, "staff"), // 清書係とマネージャの作業場（空のディレクトリ）
    boardUrl,
    logDir: path.join(home, "logs"),
    models: { scribe: args["scribe-model"], manager: args["manager-model"], task: args["task-model"] },
  };
  const spawn = claudeSpawner(how), session = claudeSession(how);
  const workDir = path.join(home, "work");
  const merge = ({ board, taskId }) => integrate({ room: how.room, workDir, board, taskId });
  // ボードを切り替えるたびに、そのボードの起こし係を作り直す（前のボードの会話は止める）
  const wake = (store) => args["no-agents"]
    ? null
    : new Waker({ store, pause: Number(args.pause), scribePause: Number(args["scribe-pause"]), slots: Number(args.slots), spawn, session, integrate: merge });
  // 流し込み係：許可された shell コマンドを部屋で走らせる
  const feed = (store) => new Feeds({ store, room: how.room });
  const desk = new Desk({ file: path.resolve(args.data), wake, feed });
  // 使う dyve（ROOT）が部屋から切り出したもの（dyve で dyve を開発しているとき）なら、部屋のいまのコミットに更新してから立て直す。
  // npm などで入れた dyve は立て直すだけ（更新は npm で）
  const restart = {
    prepare: () => {
      if (path.resolve(ROOT) === path.resolve(how.room) || !isAppOf({ room: how.room, app: ROOT })) return { updated: false };
      const r = updateApp({ room: how.room, app: ROOT });
      return { updated: true, commit: r.commit.slice(0, 7) };
    },
    go: () => {
      desk.stop();
      server.closeAll();
      process.exit(RESTART);
    },
  };
  const server = createServer({ store: desk.store, waker: desk.waker, feeds: desk.feeds, title: args.title, desk, restart, panels });
  server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ボードはもう立っています（${boardUrl}）。一つだけ立てて、そこへつないでください` : e.message));
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`ボード：${boardUrl}/\nMCP：${boardUrl}/mcp\n操作ログ：${desk.store.file}（${desk.store.board.seq} 件）\n`);
  });
  const quit = () => {
    desk.stop();
    server.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
} else if (cmd === "app") {
  const room = path.resolve(args.room), app = path.resolve(args.app);
  try {
    const r = updateApp({ room, app, ref: args.ref });
    process.stdout.write(`使う dyve：${app}（${r.commit.slice(0, 7)}${r.created ? "、新しく作った" : "、更新した"}）\n起動：node ${path.join(app, "bin", "dyve.js")} serve --room ${room}\n`);
  } catch (e) {
    die(String(e.stderr || e.message).trim());
  }
} else if (cmd === "put" || cmd === "add") {
  // 画面と同じ口（/api/op）から、人として書く。手元のスクリプトや shell から何でも流し込める
  const readStdin = () => (process.stdin.isTTY ? Promise.resolve(null) : new Promise((ok) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c)).on("end", () => ok(s));
  }));
  const asData = (s) => { const t = s.trim(); try { return JSON.parse(t); } catch { return t; } };
  if (cmd === "put" && !pos[0]) die(`パネルの id がない\n${USAGE}`);
  if (cmd === "add" && !args.view) die(`--view がない\n${USAGE}`);
  const raw = await readStdin();
  const text = raw != null && raw.trim() ? raw : null;
  let panel;
  if (cmd === "put") {
    if (text == null) die("標準入力がない（例：df -h | dyve put p12）");
    panel = { id: pos[0], data: asData(text) };
  } else {
    panel = { view: args.view, ...(text != null ? { data: asData(text) } : {}) };
    if (args.shell) panel.source = { shell: args.shell, ...(args.every ? { every: Number(args.every) } : {}) };
  }
  const r = await fetch(`http://127.0.0.1:${args.port}/api/op`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: cmd === "put" ? "edit" : "add", panel }) })
    .then((x) => x.json())
    .catch((e) => die(`ボードにつながらない（${e.message}）`));
  if (!r.ok) die(r.message);
  process.stdout.write(`${r.op.panel.id}\n`);
} else if (cmd === "export") {
  const file = path.resolve(args.data);
  if (!fs.existsSync(file)) die(`操作ログがない：${file}`);
  const md = toMarkdown(new Store(file).board, { title: args.title });
  if (args.out) fs.writeFileSync(args.out, md);
  else process.stdout.write(md);
} else {
  die(USAGE);
}
