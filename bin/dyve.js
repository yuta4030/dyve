#!/usr/bin/env node
// CLI：ボードのサーバーを立てる・ボードを Markdown に書き出す
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../src/store.js";
import { Desk } from "../src/desk.js";
import { Waker } from "../src/waker.js";
import { claudeSpawner, claudeSession, updateApp } from "../src/agents.js";
import { createServer } from "../src/server.js";
import { toMarkdown } from "../src/export.js";

const HOME = path.join(os.homedir(), ".dyve");
const USAGE = `使い方:
  dyve serve [--port 4740] [--data FILE] [--room DIR] [--no-agents] [--claude CMD] [--pause MS] [--scribe-pause MS] [--slots N]
              [--scribe-model M] [--manager-model M] [--task-model M]
  dyve export [--data FILE] [--out FILE]
  dyve app [--room DIR] [--ref REF] [--app DIR]   使う dyve を作る側のコミットから切り出す・更新する`;

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
let args;
try {
  args = parseArgs({
    args: rest,
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
      app: { type: "string", default: path.join(HOME, "app") },
    },
  }).values;
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}

if (cmd === "serve") {
  const port = Number(args.port);
  const boardUrl = `http://127.0.0.1:${port}`;
  const home = path.dirname(path.resolve(args.data));
  const how = {
    cmd: args.claude,
    room: path.resolve(args.room),
    staff: path.join(home, "staff"), // 清書係とマネージャの作業場（空のディレクトリ）
    boardUrl,
    logDir: path.join(home, "logs"),
    models: { scribe: args["scribe-model"], manager: args["manager-model"], task: args["task-model"] },
  };
  const spawn = claudeSpawner(how), session = claudeSession(how);
  // ボードを切り替えるたびに、そのボードの起こし係を作り直す（前のボードの会話は止める）
  const wake = (store) => args["no-agents"]
    ? null
    : new Waker({ store, pause: Number(args.pause), scribePause: Number(args["scribe-pause"]), slots: Number(args.slots), spawn, session });
  const desk = new Desk({ file: path.resolve(args.data), wake });
  const server = createServer({ store: desk.store, waker: desk.waker, title: args.title, desk });
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
} else if (cmd === "export") {
  const file = path.resolve(args.data);
  if (!fs.existsSync(file)) die(`操作ログがない：${file}`);
  const md = toMarkdown(new Store(file).board, { title: args.title });
  if (args.out) fs.writeFileSync(args.out, md);
  else process.stdout.write(md);
} else {
  die(USAGE);
}
