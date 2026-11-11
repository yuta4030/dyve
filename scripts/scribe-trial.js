#!/usr/bin/env node
// 清書の確かめ：手で回す（本物の清書係につなぐので node --test には入れない）。
// 前に使ったボードの操作ログを頭から写しのボードに当て直し、人の発言が来るたびに、いまの清書係に流す。
// そのときの表・面・指した先は、元のボードと同じになる（清書係の操作だけを落とし、ほかはそのまま当て直す）。
// 元の文・前の清書・いまの清書を並べて出すので、崩れが残った数を数えて比べる。
//   node scripts/scribe-trial.js ~/.dyve/board-20261110-153001.jsonl [--model haiku] [--port 4799] [--claude claude] [--words ~/.dyve/words.jsonl]
// 写しと清書係のログは一時ディレクトリに置き、元のログと辞書には書かない
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../src/store.js";
import { Waker } from "../src/waker.js";
import { createServer } from "../src/server.js";
import { claudeSession } from "../src/agents.js";
import { Words } from "../src/words.js";
import { isPerson } from "../src/board.js";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string", default: "haiku" }, port: { type: "string", default: "4799" }, claude: { type: "string", default: "claude" }, words: { type: "string" } },
});
if (positionals.length !== 1) {
  process.stderr.write("使い方：node scripts/scribe-trial.js <操作ログ> [--model haiku] [--port 4799]\n");
  process.exit(1);
}
const log = fs.readFileSync(positionals[0], "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-scribe-trial-"));
const wordsFile = path.join(tmp, "words.jsonl");
if (args.words && fs.existsSync(args.words)) fs.copyFileSync(args.words, wordsFile);
const store = new Store(path.join(tmp, "board.jsonl"));
const words = new Words(wordsFile);
const port = Number(args.port);
const boardUrl = `http://127.0.0.1:${port}`;
const server = createServer({ store, words });
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const session = claudeSession({ cmd: args.claude, room: tmp, staff: path.join(tmp, "staff"), boardUrl, logDir: path.join(tmp, "logs"), models: { scribe: args.model } });
// 起こし係は清書係の会話を持つためだけに使う。ボードの動き（受け入れ・面を畳む）は元のログにあるので、操作を聞かせない
const waker = new Waker({ store, spawn: () => { throw new Error("清書係のほかは起こさない"); }, session, pause: 1e9, words });

// 清書係の操作を落とすと seq がずれ、id がずれる。元の id → 写しの id に読み替える
const ids = new Map();
const swap = (v) => (typeof v === "string" ? ids.get(v) ?? v : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
const said = new Map(); // 元の id -> { raw, old }
for (const op of log) {
  if (op.by === "scribe") {
    const s = said.get(op.panel.id);
    if (s && "data" in op.panel) s.old = op.panel.data;
    if (s && op.panel.into) s.old = `（${op.panel.into} に合成）`;
    continue;
  }
  const { rev, ...panel } = swap(op.panel);
  if (op.type === "add") delete panel.id;
  const r = store.apply({ by: op.by, type: op.type, panel, reason: op.reason, ...(op.from ? { from: swap(op.from) } : {}) });
  if (!r.ok) {
    process.stderr.write(`当て直せなかった（seq ${op.seq}）：${r.code} ${r.message ?? ""}\n`);
    continue;
  }
  if (op.type === "add") ids.set(op.panel.id, r.op.panel.id);
  if (op.type === "add" && op.panel.view === "say" && isPerson(op.by) && op.panel.point?.how !== "pick") {
    said.set(op.panel.id, { raw: op.panel.data, old: null });
    await waker._wakeScribe();
    process.stderr.write(".");
  }
}
process.stderr.write("\n");
waker.stop();
server.closeAll?.();
server.close();

const cell = (s) => String(s ?? "—").replace(/\|/g, "／").replace(/\n/g, " ");
const out = ["| 発言 | 元の文 | 前の清書 | いまの清書 | いまの理由 |", "|---|---|---|---|---|"];
for (const [id, s] of said) {
  const p = store.board.get(ids.get(id));
  const last = store.board.history(ids.get(id)).filter((o) => o.by === "scribe").at(-1);
  const now = p?.into ? `（${p.into} に合成）` : last ? p.data : null;
  out.push(`| ${id} | ${cell(s.raw)} | ${cell(s.old)} | ${cell(now)} | ${cell(store.board.history(ids.get(id)).filter((o) => o.by === "scribe").map((o) => o.reason).join(" ／ "))} |`);
}
const added = words.log.filter((o) => o.by === "scribe");
out.push("", `足された辞書：${added.length ? added.map((o) => `${o.heard} → ${o.write}`).join("、") : "なし"}`);
out.push(`使った額：$${waker.usage.costUsd.toFixed(3)}（${waker.usage.runs} 回）`, `写し：${tmp}`);
process.stdout.write(out.join("\n") + "\n");
process.exit(0);
