#!/usr/bin/env node
// Claude Code のふりをする小さなスクリプト。外につながず、決まった返事を返す（serve --claude にこれを渡して、通しで確かめる）
//   --version：版を出す
//   --json-schema：係。発言ごとに届け先を返す（「独り言」「うーん」で始まれば none、「続き」を含めば最後のセッション、ほかは new）
//   それ以外：セッション。発言は標準入力に stream-json で届く（下の session を見る）
const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const out = (j) => process.stdout.write(JSON.stringify(j) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readAll = () => new Promise((ok) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (s += c)).on("end", () => ok(s)); });

if (args.includes("--version")) {
  process.stdout.write("0.0.0 (fake)\n");
  process.exit(0);
}

// dyve が貸す道具（MCP）を呼ぶ。--mcp-config の URL に tools/call を送る
async function callTool(name, args) {
  const conf = after("--mcp-config");
  if (!conf) return;
  const url = JSON.parse(conf).mcpServers.dyve.url;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
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

// セッション：stream-json で届く発言を一通ずつ読む。答えている途中に届いた発言は、道具の合間に読んで同じターンで答える（本物と同じ）。
// 「ゆっくり」を含むと、出来事のあいだを少しあける。「失敗」を含むと結果を出さずに終わる
async function session() {
  const id = after("--resume") ?? `fake-${process.pid}-${Date.now()}`;
  let turns = after("--resume") ? 1 : 0, buf = "", closed = false, working = false;
  const queue = [];
  const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: id });
  // dyve が頭に添える一行（記号と名前）は読み飛ばす
  const take = () => queue.splice(0).map((t) => t.trim().replace(/^［dyve：[^\n]*］\n\n/, ""));
  out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd(), permissionMode: after("--permission-mode") });
  const work = async () => {
    if (working) return;
    working = true;
    while (queue.length) {
      const asked = take();
      const slow = asked.some((t) => /ゆっくり/.test(t)) ? Number(process.env.FAKE_SLOW_MS ?? 800) : 0;
      if (asked.some((t) => /失敗/.test(t))) {
        process.stderr.write("fake: 失敗した\n");
        process.exit(2);
      }
      out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1795602000 }, seven_day: { utilization: 0.39, resetsAt: 1795680000 } } } });
      say("調べはじめます。");
      await sleep(slow);
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }] }, parent_tool_use_id: null, session_id: id });
      await sleep(slow);
      // 道具の合間に届いた発言は、このターンで一緒に答える
      asked.push(...take());
      const first = asked[0].split("\n")[0];
      // 「選ばせて」と頼まれたら、dyve の道具で質問と木を出す
      if (/選ばせて/.test(first)) {
        out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "mcp__dyve__ask", input: {} }] }, parent_tool_use_id: null, session_id: id });
        await callTool("ask", { questions: [{ title: "案", why: "値段が違う", options: [{ label: "甲", effect: "安い", recommended: true }, { label: "乙", effect: "速い" }] }, { title: "時期", options: [{ label: "今月" }, { label: "来月" }] }] });
        await callTool("state", { groups: [{ name: "契約", items: [{ done: true, name: "人数", value: "8 人", why: "会話で決めた" }, { done: false, name: "案", ask: 1 }] }] });
      }
      let answer = /選ばせて/.test(first) ? "候補は甲と乙です。どちらにしますか？" : `「${first.slice(0, 30)}」の答えは 42 です。${turns ? "（続き）" : ""}`;
      if (asked.length > 1) answer += `（途中で：${asked.slice(1).map((t) => t.split("\n")[0]).join("／")}）`;
      turns++;
      say(answer);
      out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: id, total_cost_usd: 0.001 });
    }
    working = false;
    if (closed) process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { queue.push(JSON.parse(line).message.content); } catch {}
    }
    work();
  });
  process.stdin.on("end", () => { closed = true; if (!working) process.exit(0); });
}

if (args.includes("--json-schema")) kakari();
else session();
