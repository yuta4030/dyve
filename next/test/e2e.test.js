// 通し：serve を立て、Claude Code のふりをするスクリプト（fake-claude.js）を本物の spawn で起こす。外にはつながない
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageOf } from "../src/state.js";

// 機械の git の設定（コミットの署名など）に頼らない。ここで決めた環境は、起こした子のプロセスにも引き継がれる
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const BIN = fileURLToPath(new URL("../bin/dyve.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-claude.js", import.meta.url));

async function serve(room = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-e2e-"));
  const p = spawn(process.execPath, [BIN, "serve", "--port", "0", "--data", path.join(dir, "record.jsonl"), "--room", room ?? dir, "--config", path.join(dir, "config.json"), "--claude", FAKE], { stdio: ["ignore", "pipe", "pipe"] });
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

test("通し：パネル置き場の view を使うカード。置き場は立てるときに作られ、view の一覧と中身が読める", { timeout: 20000 }, async () => {
  const { base, stop, dir } = await serve();
  try {
    assert.ok(fs.existsSync(path.join(dir, "panels", "views", "bars.js")), "置き場は設定の隣に作られる");
    assert.deepEqual((await (await fetch(`${base}/api/views`)).json()).map((v) => v.name), ["bars"]);
    await say(base, "甲と乙を棒で比べて");
    const s = await until(base, (s) => s.backs.length === 1);
    const card = s.sessions[0].card;
    assert.equal(card.panels[0].view, "bars");
    assert.deepEqual(card.panels[0].data.map((r) => r.label), ["甲", "乙"]);
    assert.ok(card.panels[0].data[0].ref, "行に、もとのやりとりの番号");
  } finally {
    await stop();
  }
});

test("通し：開発のセッションが作業場で書いてコミットし、画面の口で取り込む。外に届く伺いはカードで受け入れたターンだけ通る", { timeout: 30000 }, async () => {
  const room = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-e2e-room-"));
  const git = (...a) => execFileSync("git", ["-C", room, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(room, "README.md"), "# 部屋\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "はじめ");
  const { base, stop } = await serve(room);
  const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    await say(base, "README に一行足して");
    let s = await until(base, (s) => s.backs.length === 1 && s.sessions[0].work);
    const A = s.sessions[0];
    assert.equal(A.role, "開発");
    assert.equal(A.work.ahead, 1);
    assert.equal(A.work.dirty, false);
    assert.match(A.last, /push は止められている/, "ふつうのターンは NEVER が効いている");
    assert.equal(git("rev-list", "--count", "HEAD"), "1", "押すまでは部屋に入らない");
    // 取り込む（画面の口）
    const m = await post("/api/integrate", { session: A.id });
    assert.equal(m.result, "merged", m.reason);
    assert.match(fs.readFileSync(path.join(room, "README.md"), "utf8"), /足した一行/);
    assert.equal(git("log", "-1", "--format=%P").split(" ").length, 2);
    s = await state(base);
    assert.equal(s.backs.at(-1).kind, "merge");
    assert.equal((await post("/api/integrate", { session: A.id })).result, "nothing", "押す前に確かめ直す");
    // ほかのオリジンからは押せない
    const evil = await fetch(`${base}/api/integrate`, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ session: A.id }) });
    assert.equal(evil.status, 403);
    // 手元のほかのポートのページからも、Origin のない手元のプロセスからも押せない
    for (const headers of [{ origin: "http://127.0.0.1:1" }, {}]) {
      const r = await fetch(`${base}/api/integrate`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ session: A.id }) });
      assert.equal(r.status, 403);
    }

    // 外に届く伺い → カードで受け入れたターンだけ通る
    await say(base, "A は push もして");
    s = await until(base, (s) => s.backs.filter((b) => b.kind === "card").length === 2);
    const card = s.sessions[0].card;
    assert.equal(card.ask.outward, true);
    assert.equal(stageOf(s.sessions[0]).stage, "wait");
    const a = await post("/api/accept", { session: A.id, card: card.seq });
    assert.equal(a.ok, true);
    s = await until(base, (s) => s.backs.filter((b) => b.kind === "card").length === 3);
    assert.match(s.sessions[0].last, /push できる/, "受け入れたターンだけ NEVER が外れる");
    assert.equal((await post("/api/accept", { session: A.id, card: card.seq })).status, 409, "同じ伺いを二度受け入れない");
    // チャットの「いいよ」はふつうの続き
    await say(base, "いいよ");
    s = await until(base, (s) => s.backs.filter((b) => b.kind === "card").length === 4);
    assert.match(s.sessions[0].last, /push は止められている/, "チャットの発言では NEVER は外れない");
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
