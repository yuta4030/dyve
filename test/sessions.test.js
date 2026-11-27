import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { Sessions, claudeArgs, toolLine } from "../src/sessions.js";

// 偽の起こし方：起こしたプロセスを覚える。writes は流し込んだ発言。answer(i) で i 番目のプロセスが一ターン答え、exit(i) で落ちる
function fakeSpawn() {
  const procs = [];
  const spawn = (job, emit) => {
    let close;
    const done = new Promise((r) => (close = r));
    const p = { job, emit, writes: [], killed: false, ended: false, exit: (r) => close(r) };
    procs.push(p);
    return {
      done,
      write: (text) => p.writes.push(text),
      end: () => { p.ended = true; close({ code: 0, stderr: "" }); },
      kill: () => { p.killed = true; close({ code: 143, stderr: "" }); },
    };
  };
  const tick = () => new Promise((r) => setImmediate(r));
  const answer = async (i, text = "答え", sid = `c${i}`) => {
    const p = procs[i];
    p.emit({ type: "system", subtype: "init", session_id: sid });
    p.emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "price" } }, { type: "text", text }] } });
    p.emit({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "中の話" }] } });
    p.emit({ type: "result", is_error: false, result: text, session_id: sid });
    await tick();
  };
  return { spawn, procs, answer, tick };
}
// 流し込んだ文の、頭の一行（記号と名前）を除いた本文
const body = (text) => text.replace(/^［dyve：[^\n]*］\n\n/, "");
const setup = ({ slots = 3, idle } = {}) => {
  const log = new Log(), f = fakeSpawn();
  const sessions = new Sessions({ log, spawn: f.spawn, room: "/room", slots, prompt: "P", ...(idle ? { idle } : {}) });
  const say = (text, session) => { const r = log.add("say", { text }); log.add("route", { say: r.seq, session }); sessions.send(session, r.seq); return r.seq; };
  return { log, sessions, say, ...f };
};

test("起こしっぱなしで発言を流し込む形。道具を絞らず、聞かずに進める。続きは --resume", () => {
  const a = claudeArgs({ prompt: "P" });
  assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--permission-mode") + 1], "auto");
  assert.ok(!a.includes("--allowedTools") && !a.includes("--disallowedTools"));
  assert.ok(!a.includes("--resume"));
  const b = claudeArgs({ prompt: "P", resume: "c1", model: "sonnet" });
  assert.equal(b[b.indexOf("--resume") + 1], "c1");
  assert.equal(b[b.indexOf("--model") + 1], "sonnet");
  // dyve の道具の口を足すときは、その道具だけ聞かずに使える
  const c = claudeArgs({ prompt: "P", mcp: "http://127.0.0.1:1/mcp/k/3" });
  assert.deepEqual(JSON.parse(c[c.indexOf("--mcp-config") + 1]), { mcpServers: { dyve: { type: "http", url: "http://127.0.0.1:1/mcp/k/3" } } });
  assert.deepEqual(c.slice(c.indexOf("--allowedTools") + 1), ["mcp__dyve__ask", "mcp__dyve__state"]);
});

test("一ターン：出来事を記録し、結果で待ちになる。中で呼ばれたものは出さない。プロセスは起きたまま", async () => {
  const { log, sessions, say, procs, answer } = setup();
  const id = sessions.open("料金");
  say("料金を調べて", id);
  assert.equal(body(procs[0].writes[0]), "料金を調べて");
  assert.equal(procs[0].job.cwd, "/room");
  assert.equal(log.state.sessions[0].status, "run");
  await answer(0, "月 20 ドル");
  const x = log.state.sessions[0];
  assert.equal(x.status, "wait");
  assert.equal(x.claude, "c0");
  assert.equal(x.last, "月 20 ドル");
  assert.deepEqual(x.flow.map((f) => f.text), ["料金を調べて", "Grep price", "月 20 ドル"]);
  // 続きは同じプロセスに流し込む（起こし直さない）
  say("年払いも", id);
  assert.equal(procs.length, 1);
  assert.equal(body(procs[0].writes[1]), "年払いも");
});

test("答えている途中の発言は、待たずにそのまま差し込み、同じターンに足す", async () => {
  const { log, sessions, say, procs, answer } = setup();
  const id = sessions.open("料金");
  const a = say("料金を調べて", id);
  const b = say("やっぱり年払いで", id);
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].writes.map(body), ["料金を調べて", "やっぱり年払いで"]);
  assert.deepEqual(log.state.sessions[0].turn, [a, b]);
  await answer(0);
  assert.ok(log.state.said.every((s) => s.done));
  assert.equal(log.state.chat.filter((c) => c.reply).length, 1);
});

test("答え終えたあとに差し込みでまた動きだしたら、動いていることにする", async () => {
  const { log, sessions, say, procs, answer } = setup();
  const id = sessions.open("a");
  say("x", id);
  await answer(0);
  assert.equal(log.state.sessions[0].status, "wait");
  procs[0].emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "追いかけて届いた分も見ます" }] } });
  assert.equal(log.state.sessions[0].status, "run");
});

test("同時に答えているのは slots まで。空いたら待たせていたものを渡す", async () => {
  const { sessions, say, procs, answer } = setup({ slots: 1 });
  const a = sessions.open("a"), b = sessions.open("b");
  say("一つめ", a);
  say("二つめ", b);
  assert.equal(procs.length, 1);
  // 答えている途中のセッションへの差し込みは、空きを待たない
  say("一つめの続き", a);
  assert.equal(procs[0].writes.length, 2);
  await answer(0);
  assert.equal(procs.length, 2);
  assert.equal(body(procs[1].writes[0]), "二つめ");
});

test("答えている途中で落ちたら失敗として残す。しばらく使わなくて閉じたときは何も残さない", async () => {
  const { log, sessions, say, procs, answer, tick } = setup({ idle: 5 });
  const id = sessions.open("x");
  say("やって", id);
  procs[0].exit({ code: 1, stderr: "warn\nError: ログインしていない\n" });
  await tick();
  assert.equal(log.state.sessions[0].status, "fail");
  assert.equal(log.state.sessions[0].last, "Error: ログインしていない");
  // 起こし直して答え、しばらく待つと閉じる。次の発言で --resume で起き直す
  say("もう一度", id);
  assert.equal(procs.length, 2);
  await answer(1, "できた", "c9");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(procs[1].ended);
  assert.equal(log.state.sessions[0].status, "wait");
  say("続き", id);
  assert.equal(procs.length, 3);
  assert.equal(procs[2].job.args[procs[2].job.args.indexOf("--resume") + 1], "c9");
});

test("道具の一行", () => {
  assert.equal(toolLine("Read", { file_path: "a.md" }), "Read a.md");
  assert.equal(toolLine("mcp__slack__search", { query: "料金" }), "mcp__slack__search 料金");
  assert.equal(toolLine("Task", {}), "Task");
});

test("止める：答えている途中を止め、空きを待っていた発言も渡さない。チャットには返さない。続きを話せば起き直す", async () => {
  const { log, sessions, say, procs, tick } = setup();
  const id = sessions.open("料金");
  say("料金を調べて", id);
  assert.ok(sessions.stop(id));
  await tick();
  assert.ok(procs[0].killed);
  assert.equal(log.state.sessions[0].status, "stop");
  assert.equal(log.state.chat.filter((c) => c.reply).length, 0);
  say("やっぱり続けて", id);
  assert.equal(procs.length, 2);
});

test("取り消す：空きを待っているなら渡さず、答えているところなら止める。答え終えたものは取り消せない", async () => {
  const { log, sessions, say, procs, answer, tick } = setup({ slots: 1 });
  const a = sessions.open("a"), b = sessions.open("b");
  const x = say("一つめ", a);
  const y = say("二つめ", b);
  assert.ok(sessions.cancel(y));
  await answer(0);
  assert.equal(procs.length, 1, "取り消したものは渡さない");
  assert.equal(log.state.said.find((p) => p.id === y).canceled, true);
  assert.equal(sessions.cancel(x), false);
  const z = say("税込みも", a);
  assert.ok(sessions.cancel(z));
  await tick();
  assert.ok(procs[0].killed);
  assert.equal(log.state.sessions[0].status, "stop");
});

test("取り消して発言が一つもなくなったセッションは、一覧から外す", async () => {
  const { log, sessions, say, tick } = setup();
  const id = sessions.open("間違い");
  const a = say("独り言", id);
  sessions.cancel(a);
  await tick();
  assert.equal(log.state.sessions[0].hidden, true);
});

test("届け先を変える：前のセッションで答えていれば止め、新しい先へ渡す。間違って起きたセッションは外す", async () => {
  const { log, sessions, say, procs, answer, tick } = setup();
  const a = sessions.open("料金");
  say("料金を調べて", a);
  await answer(0);
  const wrong = sessions.open("年払い");
  const s = say("年払いも", wrong);
  assert.ok(sessions.move(s, a));
  await tick();
  assert.ok(procs[1].killed);
  assert.equal(body(procs[0].writes.at(-1)), "年払いも");
  const st = log.state;
  assert.equal(st.said.find((p) => p.id === s).session, a);
  assert.equal(st.sessions.find((x) => x.id === wrong).hidden, true);
  // 新しく起こす先へ
  await answer(0);
  assert.ok(sessions.move(s, "new"));
  assert.equal(log.state.sessions.at(-1).name, "年払いも");
  assert.equal(procs.length, 3);
  assert.ok(!log.state.sessions.find((x) => x.id === a).hidden);
});

test("清書したものがあれば、セッションにはそれを渡す", () => {
  const { log, sessions, procs } = setup();
  const id = sessions.open("a");
  const s = log.add("say", { text: "えー料金を" }).seq;
  log.add("route", { say: s, session: id, fair: "料金を" });
  sessions.send(id, s);
  assert.equal(body(procs[0].writes[0]), "料金を");
});

test("指しているものがあれば、元の文のまま添えて渡す。付け替えても残る", () => {
  const { log, sessions, procs } = setup();
  const a = sessions.open("料金");
  log.add("end", { session: a, result: "次は請求書を直せます" });
  const p = log.add("say", { text: "えー請求書も" }).seq;
  log.add("route", { say: p, session: a, fair: "請求書も" });
  const b = sessions.open("それ");
  const s = log.add("say", { text: "新規でそれやって" }).seq;
  log.add("route", { say: s, session: b, ref: [p], from: a, quote: "次は請求書を直せます" });
  sessions.send(b, s);
  assert.equal(body(procs[0].writes[0]), "新規でそれやって\n\n［dyve：この発言が指しているもの（人の言葉と、ほかのセッションの答えをそのまま写したもの）］\n人の前の発言：請求書も\nA「料金」の最後の答え：\n次は請求書を直せます");
  log.add("route", { say: s, session: a });
  assert.deepEqual(log.state.said.find((q) => q.id === s).ref, [p]);
});

test("利用枠：rate_limit_event を、変わったときだけ記録に置く", () => {
  const { log, sessions, say, procs } = setup();
  const id = sessions.open("a");
  say("x", id);
  const ev = (u) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: u, resetsAt: 100 }, seven_day: { utilization: 0.394, resetsAt: 200 } } } });
  const before = log.state.seq;
  procs[0].emit(ev(0.21));
  procs[0].emit(ev(0.2101));
  procs[0].emit(ev(0.3));
  assert.equal(log.state.quota.five, 0.3);
  assert.equal(log.state.quota.week, 0.39);
  assert.equal(log.state.quota.fiveAt, 100);
  assert.equal(log.state.seq - before, 2);
});

test("会話の ID は届いた時点で記録に書く（立て直しても続きを頼めるように）", () => {
  const { log, sessions, say, procs } = setup();
  const id = sessions.open("料金");
  say("調べて", id);
  procs[0].emit({ type: "system", subtype: "init", session_id: "c9" });
  assert.equal(log.state.sessions[0].claude, "c9");
  assert.equal(log.state.sessions[0].status, "run");
});

test("返事が空のターンは、最後の本文を返事にする", async () => {
  const { log, sessions, say, procs, tick } = setup();
  const id = sessions.open("a");
  say("調べて", id);
  procs[0].emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "サブエージェントに任せた結果：42" }] } });
  procs[0].emit({ type: "result", is_error: false, result: "" });
  await tick();
  assert.equal(log.state.sessions[0].last, "サブエージェントに任せた結果：42");
  assert.equal(log.state.chat.at(-1).text, "サブエージェントに任せた結果：42");
});

test("流し込むたびに、自分の記号と名前、ほかのセッションの記号・名前・最後の一行を一行で添える", async () => {
  const { sessions, say, procs, answer } = setup();
  const a = sessions.open("料金");
  say("料金を調べて", a);
  assert.match(procs[0].writes[0].split("\n")[0], /^［dyve：このセッションは A「料金」。ほかのセッションはない］$/);
  await answer(0, "月 20 ドル\n詳しくは…");
  const b = sessions.open("競合");
  say("A と同じ形で競合も", b);
  const head = procs[1].writes[0].split("\n")[0];
  assert.match(head, /このセッションは B「競合」/);
  assert.match(head, /ほかのセッション：A「料金」（最後：月 20 ドル 詳しくは…）/);
});
