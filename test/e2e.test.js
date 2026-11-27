// 通し：serve を立て、Claude Code のふりをするスクリプト（fake-claude.js）を本物の spawn で起こす。外にはつながない
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/dyve.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-claude.js", import.meta.url));

async function serve(dir) {
  const p = spawn(process.execPath, [BIN, "serve", "--port", "0", "--data", path.join(dir, "record.jsonl"), "--room", dir, "--claude", FAKE], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const base = await new Promise((ok, ng) => {
    p.stdout.on("data", (c) => { out += c; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//); if (m) ok(`http://127.0.0.1:${m[1]}`); });
    p.on("exit", (code) => ng(new Error(`serve が終わった（${code}）`)));
  });
  const stop = () => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); });
  return { base, stop };
}
const state = async (base) => (await fetch(`${base}/api/state`)).json();
const say = (base, text) => fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).then((r) => r.json());
async function until(base, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(base);
    if (fn(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`待ちきれなかった：${JSON.stringify(s).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("喋ると二つのセッションが並んで動き、記号で続きを頼め、立て直しても残る", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  let { base, stop } = await serve(dir);
  await say(base, "料金を調べて");
  await say(base, "うーん");
  await say(base, "競合も調べて");
  let s = await until(base, (s) => s.sessions.length === 2 && s.sessions.every((x) => x.status === "wait"));
  assert.deepEqual(s.sessions.map((x) => x.sym), ["A", "B"]);
  assert.equal(s.said[1].session, null);
  assert.match(s.sessions[0].last, /料金を調べて.*42/);
  await say(base, "A は年払いも");
  s = await until(base, (s) => s.chat.filter((c) => c.reply === 1).length === 2);
  assert.match(s.sessions[0].last, /年払い.*（続き）/);
  await stop();
  ({ base, stop } = await serve(dir));
  s = await state(base);
  assert.equal(s.sessions.length, 2);
  await say(base, "B、それで続きも");
  s = await until(base, (s) => s.sessions[1].flow.filter((f) => f.who === "human").length === 2 && s.sessions[1].status === "wait");
  assert.match(s.sessions[1].last, /（続き）/);
  await stop();
});

test("走っているあいだに止めたセッションは、立て直すと止まったとわかる", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  let { base, stop } = await serve(dir);
  await say(base, "ゆっくり調べて");
  await until(base, (s) => s.sessions[0]?.status === "run");
  await stop();
  ({ base, stop } = await serve(dir));
  const s = await state(base);
  assert.equal(s.sessions[0].status, "fail");
  assert.match(s.sessions[0].last, /立て直した/);
  await stop();
});

test("セッションが dyve の道具で質問と木を出し、答えると同じセッションに届く", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  const { base, stop } = await serve(dir);
  await say(base, "候補を選ばせて");
  let s = await until(base, (s) => s.sessions[0]?.asks?.questions.length === 2 && s.sessions[0]?.tree && s.sessions[0].status === "wait");
  assert.equal(s.sessions[0].asks.questions[0].options[0].recommended, true);
  assert.equal(s.sessions[0].tree[0].items[1].ask, 1);
  await fetch(`${base}/api/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: 1, answers: [{ q: 0, a: "甲" }] }) });
  s = await until(base, (s) => s.sessions[0].flow.filter((f) => f.who === "human").length === 2 && s.sessions[0].status === "wait");
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].asks, null);
  assert.match(s.said[1].text, /1\. 案：甲/);
  await stop();
});

test("答えている途中の発言は差し込まれ、同じターンで答えが返る", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  const { base, stop } = await serve(dir);
  await say(base, "ゆっくり料金を調べて");
  await until(base, (s) => s.sessions[0]?.status === "run");
  await say(base, "A、やっぱり年払いで");
  const s = await until(base, (s) => s.sessions[0]?.status === "wait");
  assert.match(s.sessions[0].last, /途中で：A、やっぱり年払いで/);
  assert.equal(s.chat.filter((c) => c.reply).length, 1);
  assert.equal(s.sessions.length, 1);
  await stop();
});

test("「新規でそれやって」は、指している前の発言を添えて新しいセッションに届く", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  const { base, stop } = await serve(dir);
  await say(base, "料金を調べて");
  await until(base, (s) => s.sessions[0]?.status === "wait");
  await say(base, "新規でそれやって");
  const s = await until(base, (s) => s.sessions[1]?.status === "wait");
  assert.match(s.sessions[1].last, /指しているもの：料金を調べて/);
  await stop();
});

test("巻き戻すと、その発言から後が外れ、次の発言は手前の答えから枝分かれして続く", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  const { base, stop } = await serve(dir);
  await say(base, "料金を調べて");
  await until(base, (s) => s.sessions[0]?.status === "wait");
  await say(base, "A は年払いも");
  let s = await until(base, (s) => s.sessions[0].turns?.length === 2 && s.sessions[0].status === "wait");
  const mark = s.sessions[0].turns[0].mark, second = s.sessions[0].turns[1].say;
  const r = await fetch(`${base}/api/rewind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: 1, say: second }) });
  assert.equal(r.status, 200);
  await say(base, "A は月払いで");
  s = await until(base, (s) => s.sessions[0].status === "wait" && s.sessions[0].flow.at(-1)?.who === "ai" && /月払い/.test(s.sessions[0].last));
  assert.match(s.sessions[0].last, new RegExp(`（${mark} から）`));
  assert.ok(!s.sessions[0].flow.some((f) => /年払い/.test(f.text)));
  await stop();
});
