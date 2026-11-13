#!/usr/bin/env node
// Claude Code のふりをする小さなスクリプト。外につながず、決まった返事を返す（serve --claude にこれを渡して、通しで確かめる）。
//   --version：版を出す
//   --input-format stream-json：係の起こしっぱなしの会話。--json-schema の形で、発言を読む口かセッションを読む口かを見分ける
//   それ以外：セッションの一ターン。頼む文は標準入力。「ゆっくり」を含むと、出来事のあいだを少しあける
const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const out = (j) => process.stdout.write(JSON.stringify(j) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.includes("--version")) {
  process.stdout.write("0.0.0 (fake)\n");
  process.exit(0);
}

const readAll = () => new Promise((ok) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (s += c)).on("end", () => ok(s)); });

// ── 係：発言を読む口 ──
function routeSays(prompt) {
  const syms = [...prompt.matchAll(/^- ([A-Z]+)「/gm)].map((m) => m[1]);
  const block = prompt.split("新しい発言：\n")[1] ?? "";
  const says = [];
  for (const m of block.matchAll(/^- (\d+)(?:（([A-Z]+|#\d+) を覗いていた）)?：(.*)$/gm)) {
    const id = Number(m[1]), peek = m[2], text = m[3];
    const named = text.match(/^([A-Z]+)\s*[はにへのも、]/)?.[1];
    const done = [...prompt.matchAll(/^- (#\d+)「(.*?)」/gm)].find((m) => text.includes(m[2]))?.[1];
    if (/^(うーん|独り言)/.test(text)) says.push({ id, text, to: "none" });
    else if (done) says.push({ id, text, to: "session", session: done });
    else if (named && syms.includes(named)) says.push({ id, text, to: "session", session: named });
    else if (peek && /続き|それ|あと/.test(text)) says.push({ id, text, to: "session", session: peek });
    else if (/続き/.test(text) && syms.length) says.push({ id, text, to: "session", session: syms.at(-1) });
    else says.push({ id, text, to: "new", role: "調べもの", name: text.slice(0, 12) });
  }
  return { says, words: [] };
}

// ── 係：セッションを読む口 ──
function writeCard(prompt) {
  const last = (prompt.split("最後の言葉：\n")[1] ?? "").trim();
  const talks = [...prompt.matchAll(/^- (\d+) セッション：/gm)].map((m) => Number(m[1]));
  const ref = talks.at(-1);
  const head = last.split("\n")[0];
  const card = { line: head.slice(0, 30), back: head.slice(0, 60), what: "頼まれたことを調べる", steps: [{ text: "読む", state: "done" }, { text: "答える", state: /？|ですか/.test(last) ? "now" : "done" }], panels: [] };
  if (/？|ですか/.test(last)) card.ask = { text: head, ...(ref ? { ref } : {}) };
  if (/表/.test(prompt)) {
    card.panels.push({ view: "table", title: "数えたもの", data: { columns: ["名前", "数"], rows: Array.from({ length: 6 }, (_, i) => ({ cells: [`項目${i + 1}`, String(10 - i)], ...(ref ? { ref } : {}) })) } });
  }
  // 置き場に bars があって、頼みに「棒」があれば、それを使う
  if (/^- bars：/m.test(prompt) && /棒/.test(prompt.split("前のカード：")[0])) {
    card.panels.push({ view: "bars", title: "棒で比べる", data: [{ label: "甲", value: 3, ...(ref ? { ref } : {}) }, { label: "乙", value: 5 }] });
  }
  card.panels.push({ view: "list", title: "わかったこと", data: [{ text: "答え", value: "42", ...(ref ? { ref } : {}) }] });
  return card;
}

async function conv() {
  const said = JSON.parse(after("--json-schema") ?? "{}")?.properties?.says != null;
  let cost = 0, buf = "", queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      queue = queue.then(async () => {
        const text = JSON.parse(line).message.content;
        await sleep(Number(process.env.FAKE_KAKARI_MS ?? 20));
        const json = said ? routeSays(text) : writeCard(text);
        cost += 0.0001;
        out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(json), structured_output: json, total_cost_usd: cost, duration_ms: 20 });
      });
    }
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
}

async function turn() {
  const prompt = (await readAll()).trim();
  const id = after("--resume") ?? `fake-${process.pid}-${Date.now()}`;
  const slow = /ゆっくり/.test(prompt) ? Number(process.env.FAKE_SLOW_MS ?? 1500) : 0;
  out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd(), permissionMode: after("--permission-mode") });
  const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: id });
  say("調べはじめます。");
  await sleep(slow);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }] }, parent_tool_use_id: null, session_id: id });
  await sleep(slow);
  say("README.md を読みました。");
  await sleep(slow);
  const answer = /選ばせて|どちら/.test(prompt) ? "候補は甲と乙です。どちらにしますか？" : `「${prompt.split("\n")[0].slice(0, 30)}」の答えは 42 です。`;
  say(answer);
  out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: id, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
}

if (args.includes("--input-format")) conv();
else turn();
