#!/usr/bin/env node
// CLI：サーバーを立てる
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";
import { Sessions, claudeSpawn, claudeMissing } from "../src/sessions.js";
import { Kakari, claudeAsk } from "../src/kakari.js";
import { Matome, PROMPT as BRIEF, SCHEMA as BRIEF_SCHEMA } from "../src/matome.js";

const HOME = path.join(os.homedir(), ".dyve");
const USAGE = `使い方:
  dyve serve [オプション]   チャットと一覧の画面を立てる（127.0.0.1 だけで待つ）

オプション:
  --port N        待つポート（既定：4750。0 なら空いているもの）
  --data FILE     記録（既定：~/.dyve/record.jsonl）
  --room DIR      セッションが起きる場所（既定：いまの場所）
  --model NAME    セッションのモデル（既定：Claude Code の既定）
  --kakari NAME   係とまとめのモデル（既定：haiku）
  --slots N       同時に答えていられるセッションの数（既定：3）
  --claude CMD    Claude Code のコマンド（既定：claude）
  -h, --help      この使い方を出す`;

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
      model: { type: "string" },
      kakari: { type: "string", default: "haiku" },
      slots: { type: "string", default: "3" },
      claude: { type: "string", default: "claude" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
if (args.values.help) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
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
if (!fs.statSync(room, { throwIfNoEntry: false })?.isDirectory()) die(`--room がディレクトリでない：${room}`);

let log;
try {
  log = new Log(file);
} catch (e) {
  die(`記録が読めない：${e.message}`);
}
if (log.skipped) process.stderr.write(`注意：記録の ${log.skipped} 行が読めなかったので飛ばした（ファイルには残してある）\n`);
// パスで渡されたコマンドは、いまの場所から決めておく（係とセッションは別の場所で起きるため）
const claude = v.claude.includes("/") ? path.resolve(v.claude) : v.claude;
const missing = claudeMissing(claude);
if (missing) process.stderr.write(`注意：${missing}\n`);

// 止まる前に走っていたターンは、もう帰ってこない。そうとわかるように終わらせる（続きを頼めば同じ会話で動く）
for (const x of log.state.sessions) if (x.status === "run") log.add("end", { session: x.id, error: "dyve を立て直したので止まった。続きを頼めば再開する" });

// 利用者の書き足し（用語.md・係.md・まとめ.md・セッション.md）は、記録と同じフォルダに置く
const place = path.dirname(file);
const sessions = new Sessions({ log, room, model: v.model ?? null, slots, spawn: claudeSpawn(claude), user: place });
// 届け先は決まったのに、空きを待っていてまだ渡せていなかった発言は、いま渡す
for (const s of log.state.said) {
  const x = s.session != null && log.state.sessions.find((y) => y.id === s.session);
  if (x && !s.canceled && !x.flow.some((f) => f.say === s.id)) sessions.send(x.id, s.id);
}
// 係は道具を持たない。起きる場所は記録の隣の空のディレクトリ（リポジトリの CLAUDE.md などを読まないように）
const kakariDir = path.join(path.dirname(file), "kakari");
fs.mkdirSync(kakariDir, { recursive: true });
const kakari = new Kakari({ log, sessions, ask: claudeAsk({ cmd: claude, model: v.kakari, cwd: kakariDir, user: place, name: "係" }) }).start();

// まとめ：ターンが終わるたびに、要約と選択肢を書く。係と同じ場所・同じモデル
const matome = new Matome({ log, ask: claudeAsk({ cmd: claude, model: v.kakari, cwd: kakariDir, prompt: BRIEF, schema: BRIEF_SCHEMA, key: "summary", user: place, name: "まとめ" }) }).start();
const server = createServer({ log, sessions, room });
server.on("error", (e) => die(e.code === "EADDRINUSE" ? `ポート ${port} はもう使われている` : e.message));
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`チャット：http://127.0.0.1:${server.address().port}/\n記録：${file}（${log.state.seq} 件）\nセッションが起きる場所：${room}\n`);
});
const quit = () => {
  kakari.stop();
  matome.stop();
  sessions.stopAll();
  server.closeAll();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
