// 言いつけ（覗くのをやめる・畳む）、会話の大きさと起こし直し、新しく始める
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Log } from "../src/log.js";
import { loadRoles } from "../src/roles.js";
import { Sessions, renewPrompt } from "../src/sessions.js";
import { SaidMouth, SessionMouth, Kakari } from "../src/kakari.js";
import { createServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { stageOf } from "../src/state.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const roles = loadRoles();

function fakeConv() {
  const asks = [];
  let killed = 0;
  return {
    asks,
    get killed() { return killed; },
    send: (text) => new Promise((resolve) => asks.push({ text, reply: (json) => resolve({ ok: true, json }) })),
    kill() { killed++; },
  };
}
// 偽の spawn：一ターンを、会話の大きさ（usage）つきで最後まで流せる
function fakeSpawn() {
  const jobs = [];
  const spawn = (job, emit) => {
    let finish;
    const done = new Promise((r) => (finish = r));
    const j = {
      ...job,
      turn: async (id, text, context = 0) => {
        emit({ type: "system", subtype: "init", session_id: id });
        emit({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 2, cache_read_input_tokens: context - 2, cache_creation_input_tokens: 0 } }, parent_tool_use_id: null });
        // サブエージェントの大きさは数えない
        emit({ type: "assistant", message: { content: [], usage: { input_tokens: 999999 } }, parent_tool_use_id: "x" });
        emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: id, usage: { input_tokens: 1, output_tokens: 1 } });
        finish({ code: 0, stderr: "" });
        await tick();
      },
    };
    jobs.push(j);
    return { done, kill: () => finish({ code: null, stderr: "" }) };
  };
  return { jobs, spawn };
}

function setup({ renew } = {}) {
  const log = new Log();
  const { jobs, spawn } = fakeSpawn();
  const sessions = new Sessions({ log, roles, room: "/tmp/room", spawn, ...(renew != null ? { renew } : {}) }).start();
  const conv = fakeConv();
  const mouth = new SaidMouth({ log, sessions, roles, conv });
  new Kakari([mouth]).start();
  const say = (text, peek = null) => log.add("say", { text, peek }).record.seq;
  return { log, sessions, jobs, conv, say };
}

// 係を通さずに、一つのセッションを帰ったところまで進める
async function backSession(t, text = "競合の値段を調べて", context = 0) {
  const a = t.say(text);
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: a, text, to: "new", role: "調べもの", name: "値段" }] });
  await tick();
  await t.jobs.at(-1).turn("c1", "甲社 980 円です", context);
  const x = t.log.state.sessions.at(-1);
  t.log.add("card", { session: x.id, turn: x.turn, line: "甲社 980 円", back: "甲社 980 円", what: "競合の値段", steps: [{ text: "調べる", state: "done" }] });
  return x;
}

test("「戻って」：覗いていたセッションを言いつけとして置く。どこにも届けない", async () => {
  const t = setup();
  const x = await backSession(t);
  const b = t.say("戻って", x.id);
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: b, text: "戻って", to: "back" }] });
  await tick();
  const p = t.log.state.said.find((q) => q.id === b);
  assert.deepEqual(p.order, { act: "back", session: x.id, reason: null });
  assert.equal(p.session, null);
  assert.equal(stageOf(t.log.state.sessions[0]).stage, "back", "覗くのをやめても畳まない");
  // 覗いていなければ、やめるものがない
  const c = t.say("閉じて");
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: c, text: "閉じて", to: "back" }] });
  await tick();
  assert.equal(t.log.state.said.find((q) => q.id === c).order.reason, "覗いていなかった");
  // 言いつけは、次の回に読み直さない
  t.say("独り言");
  await tick();
  assert.doesNotMatch(t.conv.asks.at(-1).text.split("新しい発言：")[1], /戻って|閉じて/);
});

test("「A は済みにして」：帰ったカードを畳む。動いているものは畳まない", async () => {
  const t = setup();
  const x = await backSession(t);
  const b = t.say("A は済みにして");
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: b, text: "A は済みにして", to: "fold", session: "A" }] });
  await tick();
  const s = t.log.state.sessions.find((y) => y.id === x.id);
  assert.equal(stageOf(s).stage, "done");
  assert.equal(s.folded.by, b);
  assert.deepEqual(t.log.state.said.find((q) => q.id === b).order, { act: "fold", session: x.id, reason: null });

  // 動いているものは畳まない
  const c = t.say("別の調べもの");
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: c, text: "別の調べもの", to: "new", role: "調べもの", name: "別" }] });
  await tick();
  const y = t.log.state.sessions.at(-1);
  assert.equal(y.sym, "A", "空いた字を振り直す");
  const d = t.say("A 片付けて");
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: d, text: "A 片付けて", to: "fold", session: "A" }] });
  await tick();
  assert.equal(t.log.state.said.find((q) => q.id === d).order.reason, "動いているので畳まない");
  assert.equal(t.log.state.sessions.at(-1).folded, null);
});

test("会話の大きさ：いちばん新しい一回で読んだもの（キャッシュを含め、サブエージェントは除く）", async () => {
  const t = setup();
  await backSession(t, "値段を調べて", 42000);
  assert.equal(t.log.state.sessions[0].context, 42000);
});

test("会話が長くなったら、次の続きは引き継がずに、これまでのことを添えて起こし直す", async () => {
  const t = setup({ renew: 50000 });
  const x = await backSession(t, "値段を調べて", 60000);
  t.sessions.ask(t.log.add("say", { text: "年払いも" }).record.seq, { session: x.id });
  const job = t.jobs.at(-1);
  assert.ok(!job.args.includes("--resume"), "引き継がない");
  assert.match(job.prompt, /長くなったので/);
  assert.match(job.prompt, /何の仕事か：競合の値段/);
  assert.match(job.prompt, /- 値段を調べて/);
  assert.match(job.prompt, /いまどこまで：甲社 980 円/);
  assert.match(job.prompt, /いまの頼み：\n年払いも$/);
  const s = t.log.state.sessions[0];
  assert.equal(s.context, null);
  assert.equal(s.flow.find((f) => f.renew).renew, 60000);
  // 小さいうちは引き継ぐ
  await job.turn("c2", "年払いは 9,800 円", 3000);
  t.sessions.ask(t.log.add("say", { text: "もう一つ" }).record.seq, { session: x.id });
  assert.equal(t.jobs.at(-1).args[t.jobs.at(-1).args.indexOf("--resume") + 1], "c2");
});

test("起こし直さない：0 にしたとき", async () => {
  const t = setup({ renew: 0 });
  const x = await backSession(t, "値段を調べて", 900000);
  t.sessions.ask(t.log.add("say", { text: "続き" }).record.seq, { session: x.id });
  assert.ok(t.jobs.at(-1).args.includes("--resume"));
});

test("起こし直すときの文：カードがなければ頼んだことといまの頼みだけ", () => {
  const p = renewPrompt({ card: null }, ["一つ目"], ["二つ目"]);
  assert.match(p, /これまでに頼んだこと：\n- 一つ目/);
  assert.doesNotMatch(p, /いまどこまで/);
  assert.match(p, /いまの頼み：\n二つ目$/);
});

test("設定：sessions.renew は 0 以上の整数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-conf-"));
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ sessions: { renew: 80000 } }));
  assert.equal(readConfig(f).sessions.renew, 80000);
  fs.writeFileSync(f, JSON.stringify({ sessions: { renew: -1 } }));
  assert.throws(() => readConfig(f), /0 以上の整数/);
  fs.writeFileSync(f, JSON.stringify({ sessions: { slots: 2 } }));
  assert.throws(() => readConfig(f), /知らない項目 sessions\.slots/);
});

test("新しく始める：記録を隣に退けて、空から始める。退けたものは消えない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-anew-"));
  const file = path.join(dir, "record.jsonl");
  const log = new Log(file);
  log.add("say", { text: "前の話" });
  let heard = null;
  log.onAnew((moved) => (heard = moved));
  const moved = log.anew(new Date("2026-11-19T12:34:56Z"));
  assert.equal(path.basename(moved), "record-20261119-123456.jsonl");
  assert.equal(heard, moved);
  assert.match(fs.readFileSync(moved, "utf8"), /前の話/);
  assert.equal(log.state.seq, 0);
  assert.equal(log.era, 1);
  const r = log.add("say", { text: "新しい話" }).record;
  assert.equal(r.seq, 1);
  assert.deepEqual(new Log(file).state.said.map((p) => p.text), ["新しい話"], "立て直しても前の記録は読まない");
  // 同じ秒にもう一度
  assert.equal(path.basename(log.anew(new Date("2026-11-19T12:34:56Z"))), "record-20261119-123456-2.jsonl");
});

test("新しく始める：動いているものがあれば断る。取り込んでいない作業場は confirm のときだけ進める", async () => {
  const t = setup();
  const a = t.say("調べて");
  await tick();
  t.conv.asks.at(-1).reply({ says: [{ id: a, text: "調べて", to: "new", role: "調べもの", name: "値段" }] });
  await tick();
  assert.equal(t.sessions.anew().code, "running");
  await t.jobs.at(-1).turn("c1", "済んだ");
  const x = t.log.state.sessions[0];
  t.log.add("work", { session: x.id, branch: "dyve/s1-abc", ahead: 2 });
  const r = t.sessions.anew();
  assert.equal(r.code, "unmerged");
  assert.deepEqual(r.sessions, [x.id]);
  assert.equal(t.log.state.sessions.length, 1, "断ったら何も変えない");
  const ok = t.sessions.anew({ confirm: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.left, ["dyve/s1-abc"]);
  assert.equal(t.log.state.sessions.length, 0);
  assert.ok(t.conv.killed > 0, "係の会話も起こし直す");
});

test("新しく始める：前の記録のために読んでいた係の答えは、新しい記録に置かない", async () => {
  const t = setup();
  const a = t.say("前の話");
  await tick();
  const pending = t.conv.asks.at(-1);
  assert.equal(t.sessions.anew().ok, true);
  t.say("新しい話");
  pending.reply({ says: [{ id: a, text: "前の話", to: "new", role: "調べもの", name: "前" }] });
  await tick();
  assert.equal(t.log.state.sessions.length, 0);
  assert.equal(t.log.state.said[0].text, "新しい話");
  // 新しい発言は次の回に読む
  await tick();
  assert.match(t.conv.asks.at(-1).text, /- 1：新しい話/);
});

test("新しく始める：セッションを読む口も、前の記録のカードを置かない", async () => {
  const log = new Log();
  const conv = fakeConv();
  const mouth = new SessionMouth({ log, conv, views: () => [] }).start();
  const s = log.add("open", { role: "調べもの", cwd: "/tmp" }).record.seq;
  log.add("say", { text: "x" });
  log.add("pass", { session: s, said: 2 });
  log.add("start", { session: s, says: [2] });
  log.add("end", { session: s, claude: "c", last: "答え" });
  await tick();
  assert.equal(conv.asks.length, 1);
  log.anew();
  conv.asks[0].reply({ line: "答え", back: "答え" });
  await tick();
  assert.equal(log.state.seq, 0);
  mouth.stop();
});

test("画面の口：新しく始めると、空の状態をまるごと流し直す。画面の外からは押せない", async () => {
  const log = new Log();
  const sessions = new Sessions({ log, roles, room: "/tmp/room", spawn: () => ({ done: new Promise(() => {}), kill() {} }) });
  const server = createServer({ log, sessions });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  log.add("say", { text: "前の話" });
  const post = (headers) => new Promise((ok) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/anew", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c)).on("end", () => ok({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.end("{}");
  });
  assert.equal((await post({})).status, 403, "Origin のないものは通さない");
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re) => { while (!re.test(buf)) buf += dec.decode((await reader.read()).value, { stream: true }); };
  await until(/event: state\ndata: .*前の話/);
  buf = "";
  const r = await post({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
  assert.equal(r.status, 200);
  await until(/event: state\ndata: \{"seq":0/);
  ac.abort();
  server.closeAll();
});
