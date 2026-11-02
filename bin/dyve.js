#!/usr/bin/env node
// CLI：ボードのサーバーを立てる・ボードを Markdown に書き出す
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../src/store.js";
import { Waker } from "../src/waker.js";
import { claudeSpawner } from "../src/agents.js";
import { createServer } from "../src/server.js";
import { toMarkdown } from "../src/export.js";

const HOME = path.join(os.homedir(), ".dyve");
const USAGE = `使い方:
  dyve serve [--port 4740] [--data FILE] [--room DIR] [--no-agents] [--claude CMD] [--pause MS] [--slots N]
  dyve export [--data FILE] [--out FILE]`;

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
      slots: { type: "string", default: "3" },
      title: { type: "string", default: "ボード" },
      out: { type: "string" },
    },
  }).values;
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}

if (cmd === "serve") {
  const store = new Store(path.resolve(args.data));
  const port = Number(args.port);
  const boardUrl = `http://127.0.0.1:${port}`;
  const waker = args["no-agents"]
    ? null
    : new Waker({
        store,
        pause: Number(args.pause),
        slots: Number(args.slots),
        spawn: claudeSpawner({ cmd: args.claude, room: path.resolve(args.room), boardUrl, logDir: path.join(path.dirname(path.resolve(args.data)), "logs") }),
      });
  const server = createServer({ store, waker, title: args.title });
  server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ボードはもう立っています（${boardUrl}）。一つだけ立てて、そこへつないでください` : e.message));
  server.listen(port, "127.0.0.1", () => {
    waker?.start();
    process.stdout.write(`ボード：${boardUrl}/\nMCP：${boardUrl}/mcp\n操作ログ：${store.file}（${store.board.seq} 件）\n`);
  });
  const quit = () => {
    waker?.stop();
    server.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
} else if (cmd === "export") {
  const file = path.resolve(args.data);
  if (!fs.existsSync(file)) die(`操作ログがない：${file}`);
  const md = toMarkdown(new Store(file).board, { title: args.title });
  if (args.out) fs.writeFileSync(args.out, md);
  else process.stdout.write(md);
} else {
  die(USAGE);
}
