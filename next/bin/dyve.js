#!/usr/bin/env node
// CLI：サーバーを立てる
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";

const USAGE = `使い方:
  dyve serve [--port 4750] [--data FILE]   既定の記録：~/.dyve/next/record.jsonl`;

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4750" },
      data: { type: "string", default: path.join(os.homedir(), ".dyve", "next", "record.jsonl") },
    },
  });
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
const [cmd, ...extra] = args.positionals;
if (cmd !== "serve" || extra.length) die(USAGE);

const port = Number(args.values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) die(`--port は 0〜65535 の整数\n${USAGE}`);
const file = path.resolve(args.values.data);
let log;
try {
  log = new Log(file);
} catch (e) {
  die(`記録が読めない：${e.message}`);
}
if (log.skipped) process.stderr.write(`注意：記録の ${log.skipped} 行が読めなかったので飛ばした（ファイルには残してある）\n`);

const server = createServer({ log });
server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ポート ${port} はもう使われている` : e.message));
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`チャット：http://127.0.0.1:${server.address().port}/\n記録：${file}（${log.state.seq} 件）\n`);
});
const quit = () => {
  server.closeAll();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
