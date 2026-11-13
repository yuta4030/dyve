// 通し：serve を立て、Claude Code のふりをするスクリプト（fake-claude.js）を本物の spawn で起こす。外にはつながない
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageOf } from "../src/state.js";

const BIN = fileURLToPath(new URL("../bin/dyve.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-claude.js", import.meta.url));

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-e2e-"));
  const p = spawn(process.execPath, [BIN, "serve", "--port", "0", "--data", path.join(dir, "record.jsonl"), "--room", dir, "--config", path.join(dir, "config.json"), "--claude", FAKE], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const base = await new Promise((ok, ng) => {
    p.stdout.on("data", (c) => { out += c; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//); if (m) ok(`http://127.0.0.1:${m[1]}`); });
    p.on("exit", (code) => ng(new Error(`serve が終わった（${code}）`)));
  });
  const stop = () => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); });
  return { base, stop, dir };
}

const state = async (base) => (await fetch(`${base}/api/state`)).json();
const say = (base, text, peek) => fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...(peek ? { peek } : {}) }) }).then((r) => r.json());
async function until(base, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(base);
    if (fn(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`待ちきれなかった：${JSON.stringify(s).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("通し：発言 → 係が届け先を決める → セッション → 係がカード → チャットの一行。続き・人待ち・覗いていたときの曖昧な続き", { timeout: 30000 }, async () => {
  const { base, stop } = await serve();
  try {
    await say(base, "package.json の版を調べて");
    let s = await until(base, (s) => s.backs.length === 1);
    const A = s.sessions[0];
    assert.deepEqual([A.sym, A.role, A.name], ["A", "調べもの", "package.json"]);
    assert.equal(stageOf(A).stage, "back");
    assert.equal(A.card.line, "「package.json の版を調べて」の答えは 42 で");
    assert.equal(s.backs[0].kind, "card");
    assert.ok(A.card.panels[0].data[0].ref, "パネルの行に、もとのやりとりの番号が付く");
    assert.ok(A.flow.some((f) => f.tool === "Read README.md"));

    // 選ばせる頼み → 人待ち
    await say(base, "どちらの書き方にするか選ばせて");
    s = await until(base, (s) => s.backs.length === 2);
    const B = s.sessions[1];
    assert.equal(stageOf(B).stage, "wait");
    assert.equal(B.card.ask.text, "候補は甲と乙です。どちらにしますか？");

    // A が帰ったあとの発言が B に届いたので、A は済みに畳まれ、記号が空く
    assert.equal(stageOf(s.sessions[0]).stage, "done");
    assert.equal(s.sessions[0].sym, null);
    assert.equal(s.sessions[1].sym, "B");

    // 済みのものを名前で呼ぶと戻り、同じ会話を引き継ぐ。空いているいちばん若い字が振り直される
    await say(base, "package.json の続きも見て");
    s = await until(base, (s) => s.backs.length === 3);
    assert.equal(s.sessions.length, 2);
    assert.equal(s.sessions[0].asked.length, 2);
    assert.equal(s.sessions[0].sym, "A");
    assert.equal(s.sessions[0].folded, null);
    assert.equal(s.sessions[0].claude, A.claude, "--resume で引き継いだ");
    assert.equal(stageOf(s.sessions[1]).stage, "wait", "人待ちは畳まない");

    // B を覗いたまま曖昧な続き → B へ
    const r = await say(base, "それは甲で", B.id);
    assert.equal(r.record.peek, B.id);
    s = await until(base, (s) => s.backs.length === 4);
    assert.equal(s.said.at(-1).session, B.id);
    assert.equal(stageOf(s.sessions[0]).stage, "done", "帰った A は、別のセッションへの発言でまた畳まれる");

    // 独り言は届けない
    await say(base, "うーん、どうしようかな");
    s = await until(base, (s) => s.said.at(-1).aside);
    assert.equal(s.sessions.length, 2);
    await new Promise((r) => setTimeout(r, 100));
    s = await state(base);
    assert.equal(stageOf(s.sessions[1]).stage, "back", "どこにも届けない発言では畳まない");
  } finally {
    await stop();
  }
});

test("通し：立て直しても、カードとチャットの一行が残る", { timeout: 20000 }, async () => {
  const a = await serve();
  await say(a.base, "版を調べて");
  const before = await until(a.base, (s) => s.backs.length === 1);
  await a.stop();
  const dir = a.dir;
  const p = spawn(process.execPath, [BIN, "serve", "--port", "0", "--data", path.join(dir, "record.jsonl"), "--room", dir, "--config", path.join(dir, "config.json"), "--claude", FAKE], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise((ok) => { let o = ""; p.stdout.on("data", (c) => { o += c; const m = o.match(/:(\d+)\//); if (m) ok(`http://127.0.0.1:${m[1]}`); }); });
    const after = await state(base);
    assert.deepEqual(after.sessions[0].card, before.sessions[0].card);
    assert.deepEqual(after.backs, before.backs);
  } finally {
    await new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); });
  }
});
