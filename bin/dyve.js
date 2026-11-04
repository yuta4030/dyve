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
import { ensurePanels, offViews } from "../src/panels.js";
import { Waker } from "../src/waker.js";
import { spawn as spawnChild } from "node:child_process";
import { loadCrew, readConfig, ensureCrew, namesOf, initialsOf, callsOf, teamsOf, checkName } from "../src/crew.js";
import { claudeSpawner, claudeSession, updateApp, integrate, isAppOf, claudeMissing, ROOT } from "../src/agents.js";
import { createServer } from "../src/server.js";
import { toMarkdown } from "../src/export.js";

const HOME = path.join(os.homedir(), ".dyve");
const USAGE = `使い方:
  dyve serve [--port 4740] [--data FILE] [--room DIR] [--no-agents] [--claude CMD] [--pause MS] [--scribe-pause MS] [--slots N]
              [--scribe-model M] [--manager-model M] [--task-model M] [--config FILE] [--agents DIR] [--names A,B,…]
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
      // port・data・room・claude・slots の既定は、設定（~/.dyve/config.json）を読んでから決める
      config: { type: "string" },
      port: { type: "string" },
      data: { type: "string" },
      room: { type: "string" },
      "no-agents": { type: "boolean", default: false },
      claude: { type: "string" },
      // 既定は置き場（~/.dyve/agents）を読んでから決める。コマンドで渡したものがいちばん強い
      pause: { type: "string" },
      "scribe-pause": { type: "string" },
      "scribe-model": { type: "string" },
      "manager-model": { type: "string" },
      agents: { type: "string" },
      names: { type: "string" },
      "task-model": { type: "string" },
      slots: { type: "string" },
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

// 設定：コマンド > config.json > 既定
const configFile = path.resolve(args.config ?? path.join(HOME, "config.json"));
if (args.config && !fs.existsSync(configFile)) die(`設定がない：${configFile}`);
let conf;
try {
  conf = readConfig(configFile);
} catch (e) {
  die(`設定が読めない：${e.message}`);
}
const DEFAULTS = { port: "4740", data: path.join(HOME, "board.jsonl"), room: process.cwd(), claude: "claude", slots: "3" };
for (const [k, v] of Object.entries(DEFAULTS)) args[k] ??= conf[k] != null ? String(conf[k]) : v;
// task.model は控室の一人ずつの model より弱いので、ここでは混ぜない（modelOf が順に見る）

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
  // 配役：コマンド > 置き場（~/.dyve/agents）> 既定
  let crew;
  try {
    crew = loadCrew({ config: configFile, agents: args.agents ? path.resolve(args.agents) : null, fallback: path.join(home, "agents") });
    ensureCrew(crew.agents);
  } catch (e) {
    die(`設定が読めない：${e.message}`);
  }
  // 知らせるだけで止めない（名前がぶつかった、など）。画面には出さない
  for (const w of crew.warnings) process.stderr.write(`注意：${w}\n`);
  const cliNames = args.names ? args.names.split(/[,、]/).map((n) => n.trim()).filter(Boolean) : null;
  if (cliNames && new Set(cliNames).size !== cliNames.length) die("--names に同じ名前が二つある");
  try {
    cliNames?.forEach((n) => checkName(n, "--names の名前"));
  } catch (e) {
    die(e.message);
  }
  const names = namesOf(crew, cliNames);
  const num = (v, name) => {
    const n = Number(v);
    if (!(n >= 0)) die(`${name} は 0 以上の数`);
    return n;
  };
  const pause = num(args.pause ?? crew.manager?.pause ?? 4000, "--pause");
  const scribePause = num(args["scribe-pause"] ?? crew.scribe?.pause ?? 1000, "--scribe-pause");
  const how = {
    panels,
    cmd: args.claude,
    room: path.resolve(args.room),
    staff: path.join(home, "staff"), // 清書係とマネージャの作業場（空のディレクトリ）
    boardUrl,
    logDir: path.join(home, "logs"),
    models: { scribe: args["scribe-model"] ?? crew.scribe?.model ?? "haiku", manager: args["manager-model"] ?? crew.manager?.model ?? "sonnet", task: args["task-model"] },
    crew,
    names,
  };
  const spawn = claudeSpawner(how), session = claudeSession(how);
  const workDir = path.join(home, "work");
  const rooms = crew.members.map((a) => a.room).filter(Boolean);
  const merge = ({ board, taskId }) => integrate({ room: how.room, rooms, workDir, board, taskId });
  // ボードを切り替えるたびに、そのボードの起こし係を作り直す（前のボードの会話は止める）
  const wake = (store) => args["no-agents"]
    ? null
    : new Waker({ store, pause, scribePause, slots: Number(args.slots), spawn, session, integrate: merge, names, initials: initialsOf(crew, names), calls: callsOf(crew, names), teams: teamsOf(crew, names) });
  // 流し込み係：許可された shell コマンドを部屋で走らせる
  const feed = (store) => new Feeds({ store, room: how.room, offView: (v) => offViews(panels).has(v) });
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
