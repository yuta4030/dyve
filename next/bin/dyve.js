#!/usr/bin/env node
// CLI：サーバーを立てる
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";
import { loadRoles } from "../src/roles.js";
import { Sessions, claudeSpawn, claudeMissing } from "../src/sessions.js";

const HOME = path.join(os.homedir(), ".dyve", "next");
const USAGE = `使い方:
  dyve serve [--port 4750] [--data FILE] [--room DIR] [--claude CMD] [--slots 3] [--config FILE]
    --data    記録（既定：~/.dyve/next/record.jsonl）
    --room    セッションが起きる場所（既定：いまの場所）
    --config  利用者の設定（既定：~/.dyve/next/config.json。役割の定義はその隣の roles/<名前>.md）`;

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
      data: { type: "string", default: path.join(HOME, "record.jsonl") },
      room: { type: "string", default: process.cwd() },
      claude: { type: "string", default: "claude" },
      slots: { type: "string", default: "3" },
      config: { type: "string", default: path.join(HOME, "config.json") },
    },
  });
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
const [cmd, ...extra] = args.positionals;
if (cmd !== "serve" || extra.length) die(USAGE);
const v = args.values;

const port = Number(v.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) die(`--port は 0〜65535 の整数\n${USAGE}`);
const slots = Number(v.slots);
if (!Number.isInteger(slots) || slots < 1) die(`--slots は 1 以上の整数\n${USAGE}`);
const file = path.resolve(v.data);
const room = path.resolve(v.room);
let log, roles;
try {
  log = new Log(file);
} catch (e) {
  die(`記録が読めない：${e.message}`);
}
try {
  roles = loadRoles({ config: path.resolve(v.config) });
} catch (e) {
  die(`役割が読めない：${e.message}`);
}
if (log.skipped) process.stderr.write(`注意：記録の ${log.skipped} 行が読めなかったので飛ばした（ファイルには残してある）\n`);
const missing = claudeMissing(v.claude);
if (missing) process.stderr.write(`注意：${missing}\n`);

const sessions = new Sessions({ log, roles, room, spawn: claudeSpawn(v.claude), slots }).start();
const server = createServer({ log });
server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ポート ${port} はもう使われている` : e.message));
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`チャット：http://127.0.0.1:${server.address().port}/\n記録：${file}（${log.state.seq} 件）\nセッションが起きる場所：${room}（役割：${Object.keys(roles).join("・")}）\n`);
});
const quit = () => {
  sessions.stop();
  server.closeAll();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
