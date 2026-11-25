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

test("選ばせる答えには選択肢が出て、押すと同じセッションに届く", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-e2e-"));
  const { base, stop } = await serve(dir);
  await say(base, "候補を選ばせて");
  let s = await until(base, (s) => s.sessions[0]?.brief?.choices?.length === 2);
  assert.match(s.sessions[0].brief.summary, /どちら/);
  const c = s.sessions[0].brief.choices[0];
  await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: c.say, to: 1 }) });
  s = await until(base, (s) => s.sessions[0].flow.filter((f) => f.who === "human").length === 2 && s.sessions[0].status === "wait");
  assert.equal(s.sessions.length, 1);
  assert.equal(s.said[1].text, "甲で進めて");
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
