#!/usr/bin/env node
// CLI：サーバーを立てる
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";
import { loadRoles } from "../src/roles.js";
import { Sessions, claudeSpawn, claudeMissing } from "../src/sessions.js";
import { readConfig } from "../src/config.js";
import { Words } from "../src/words.js";
import { ensurePanels, listViews } from "../src/panels.js";
import { Kakari, SaidMouth, SessionMouth, Folder, Conv, claudeConv, readDef, SAID_SCHEMA, CARD_SCHEMA } from "../src/kakari.js";

const HOME = path.join(os.homedir(), ".dyve", "next");
const USAGE = `使い方:
  dyve serve [--port 4750] [--data FILE] [--room DIR] [--claude CMD] [--slots 3] [--config FILE] [--panels DIR]
    --data    記録（既定：~/.dyve/next/record.jsonl）
    --room    セッションが起きる場所（既定：いまの場所）
    --config  利用者の設定（既定：~/.dyve/next/config.json。役割の定義はその隣の roles/<名前>.md、辞書は words.jsonl）
    --panels  パネル置き場（既定：設定の隣の panels/。なければ作る）`;

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
      panels: { type: "string" },
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
const config = path.resolve(v.config);
const place = path.dirname(config);
let log, roles, conf;
try {
  log = new Log(file);
} catch (e) {
  die(`記録が読めない：${e.message}`);
}
try {
  conf = readConfig(config);
  roles = loadRoles({ config });
} catch (e) {
  die(`役割が読めない：${e.message}`);
}
if (log.skipped) process.stderr.write(`注意：記録の ${log.skipped} 行が読めなかったので飛ばした（ファイルには残してある）\n`);
const missing = claudeMissing(v.claude);
if (missing) process.stderr.write(`注意：${missing}\n`);

// パネル置き場：なければ作る（git の履歴つき）。あれば何も上書きしない
let panels;
try {
  const made = ensurePanels(path.resolve(v.panels ?? path.join(place, "panels")));
  panels = made.dir;
  if (made.warn) process.stderr.write(`注意：${made.warn}\n`);
} catch (e) {
  die(`パネル置き場を作れない：${e.message}`);
}
const sessions = new Sessions({ log, roles, room, panels, spawn: claudeSpawn(v.claude), slots }).start();
// 係：道具を持たない Claude Code。起きる場所は置き場の中の空のディレクトリ（リポジトリの CLAUDE.md などを読まないように）
const kakariDir = path.join(place, "kakari");
fs.mkdirSync(kakariDir, { recursive: true });
const words = new Words(path.join(place, "words.jsonl"));
// 口ごとに自分の会話を持つ（互いに待たせない）
const conv = (def, schema) => new Conv({ open: () => claudeConv({ cmd: v.claude, prompt: readDef(def), schema, model: conf.kakari.model ?? "haiku", cwd: kakariDir }) });
const kakari = new Kakari([
  new SaidMouth({ log, sessions, roles, words, conv: conv("said", SAID_SCHEMA) }),
  new SessionMouth({ log, conv: conv("session", CARD_SCHEMA), views: () => listViews(panels) }),
  new Folder({ log }),
]).start();
const server = createServer({ log, panels });
server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ポート ${port} はもう使われている` : e.message));
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`チャット：http://127.0.0.1:${server.address().port}/\n記録：${file}（${log.state.seq} 件）\nセッションが起きる場所：${room}（役割：${Object.keys(roles).join("・")}）\nパネル置き場：${panels}\n`);
});
const quit = () => {
  kakari.stop();
  sessions.stop();
  server.closeAll();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
