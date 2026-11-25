#!/usr/bin/env node
// Claude Code のふりをする小さなスクリプト。外につながず、決まった返事を返す（serve --claude にこれを渡して、通しで確かめる）
//   --version：版を出す
//   --json-schema：係かまとめ（schema に summary があればまとめ）。係は発言ごとに届け先を返す（「独り言」「うーん」で始まれば none、「続き」を含めば最後のセッション、ほかは new）
//   それ以外：セッションの一ターン。頼む文は標準入力。「ゆっくり」を含むと、出来事のあいだを少しあける。「失敗」を含むと結果を出さずに終わる
const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const out = (j) => process.stdout.write(JSON.stringify(j) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readAll = () => new Promise((ok) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (s += c)).on("end", () => ok(s)); });

if (args.includes("--version")) {
  process.stdout.write("0.0.0 (fake)\n");
  process.exit(0);
}

// まとめ：要約は決まった形。「どちら」を含めば選択肢を返す
async function matome() {
  const prompt = await readAll();
  const last = prompt.trim().split("\n").at(-1);
  const json = { summary: `- まとめ：${last.slice(0, 40)}`, choices: /どちら/.test(last) ? [{ label: "甲", say: "甲で進めて" }, { label: "乙", say: "乙で進めて" }] : [] };
  await sleep(Number(process.env.FAKE_KAKARI_MS ?? 10));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(json), structured_output: json }));
}

async function kakari() {
  const prompt = await readAll();
  const syms = [...prompt.matchAll(/^- ([A-Z]+)「/gm)].map((m) => m[1]);
  const block = prompt.split("新しい発言：\n")[1] ?? "";
  const says = [];
  for (const m of block.matchAll(/^- (\d+)(?:（([A-Z]+) を覗いていた）)?：(.*)$/gm)) {
    const id = Number(m[1]), peek = m[2], text = m[3];
    if (/^(うーん|独り言)/.test(text)) says.push({ id, to: "none" });
    else if (peek && /それ|あと/.test(text)) says.push({ id, to: peek });
    else if (/続き/.test(text) && syms.length) says.push({ id, to: syms.at(-1) });
    else says.push({ id, to: "new", name: text.slice(0, 10) });
  }
  await sleep(Number(process.env.FAKE_KAKARI_MS ?? 10));
  const json = { says };
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(json), structured_output: json }));
}

async function turn() {
  const prompt = (await readAll()).trim();
  const id = after("--resume") ?? `fake-${process.pid}-${Date.now()}`;
  const slow = /ゆっくり/.test(prompt) ? Number(process.env.FAKE_SLOW_MS ?? 800) : 0;
  out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd(), permissionMode: after("--permission-mode") });
  const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: id });
  if (/失敗/.test(prompt)) {
    process.stderr.write("fake: 失敗した\n");
    process.exit(2);
  }
  say("調べはじめます。");
  await sleep(slow);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }] }, parent_tool_use_id: null, session_id: id });
  await sleep(slow);
  const answer = /選ばせて/.test(prompt) ? "候補は甲と乙です。どちらにしますか？" : `「${prompt.split("\n")[0].slice(0, 30)}」の答えは 42 です。${after("--resume") ? "（続き）" : ""}`;
  say(answer);
  out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: id, total_cost_usd: 0.001 });
}

if (args.includes("--json-schema")) (JSON.parse(after("--json-schema")).properties.summary ? matome() : kakari());
else turn();
