import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Log } from "../src/log.js";
import { createServer } from "../src/server.js";

async function start(file = null) {
  const log = new Log(file);
  const server = createServer({ log });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  return { log, server, port, base: `http://127.0.0.1:${port}` };
}

// fetch は Host と Origin を書き換えられないので、http で送る
function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((ok, ng) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c)).on("end", () => ok({ status: res.statusCode, headers: res.headers, body: s }));
    });
    req.on("error", ng);
    if (body != null) req.write(body);
    req.end();
  });
}

const say = (base, text, headers = {}) =>
  fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text }) });

// SSE を読み、届いた出来事を順に返す
async function events(base, n) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const got = [];
  let buf = "";
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  const next = async () => {
    while (got.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.*)$/m)?.[1], data = chunk.match(/^data: (.*)$/m)?.[1];
        if (ev) got.push({ event: ev, data: JSON.parse(data) });
      }
    }
    ac.abort();
    return got;
  };
  return { res, next };
}

test("画面を返す。外のものを読ませない", async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(res.headers.get("content-security-policy"), /script-src 'self' 'unsafe-inline'/);
    assert.match(await res.text(), /<dyve-chat/);
    const st = await fetch(`${base}/state.js`);
    assert.equal(st.status, 200);
    assert.match(st.headers.get("content-type"), /text\/javascript/);
    assert.match(await st.text(), /export function step/);
  } finally {
    server.closeAll();
  }
});

test("発言を置くと記録に残り、いまの状態で読める", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-"));
  const file = path.join(dir, "record.jsonl");
  const { server, base } = await start(file);
  try {
    const r = await (await say(base, "料金ページを直す前に、競合がいくらか調べておいて")).json();
    assert.equal(r.ok, true);
    assert.equal(r.record.seq, 1);
    assert.equal(r.record.kind, "say");
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.said.map((s) => s.text), ["料金ページを直す前に、競合がいくらか調べておいて"]);
    assert.equal(state.seq, 1);
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    server.closeAll();
  }
});

test("立て直しても、前に置いた発言がいまの状態にある", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-")), "record.jsonl");
  const a = await start(file);
  await say(a.base, "一つめ");
  a.server.closeAll();
  const b = await start(file);
  try {
    const state = await (await fetch(`${b.base}/api/state`)).json();
    assert.deepEqual(state.said.map((s) => s.text), ["一つめ"]);
  } finally {
    b.server.closeAll();
  }
});

test("中身のない発言や壊れた JSON は 400 で断り、記録しない", async () => {
  const { server, base, log, port } = await start();
  try {
    const r = await say(base, "  ");
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "invalid");
    const bad = await request(port, { method: "POST", path: "/api/say", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(bad.status, 400);
    assert.equal(log.state.seq, 0);
  } finally {
    server.closeAll();
  }
});

test("つなぐと、まずいまの状態が流れ、そのあと増えた記録が一件ずつ流れる", async () => {
  const { server, base } = await start();
  try {
    await say(base, "前から");
    const { res, next } = await events(base, 3);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const done = next();
    await say(base, "あとから一つめ");
    await say(base, "あとから二つめ");
    const got = await done;
    assert.equal(got[0].event, "state");
    assert.deepEqual(got[0].data.said.map((s) => s.text), ["前から"]);
    assert.deepEqual(got.slice(1).map((g) => [g.event, g.data.seq, g.data.text]), [["record", 2, "あとから一つめ"], ["record", 3, "あとから二つめ"]]);
  } finally {
    server.closeAll();
  }
});

test("ほかのオリジンからは断る。書き込みも残らない", async () => {
  const { server, port, log } = await start();
  try {
    const body = JSON.stringify({ text: "外から" });
    const evil = await request(port, { method: "POST", path: "/api/say", headers: { origin: "https://example.com", "content-type": "text/plain" }, body });
    assert.equal(evil.status, 403);
    assert.equal(JSON.parse(evil.body).code, "forbidden");
    const read = await request(port, { path: "/api/state", headers: { origin: "http://localhost.example.com" } });
    assert.equal(read.status, 403);
    // DNS リバインディング：名前で来たものは断る
    const rebind = await request(port, { method: "POST", path: "/api/say", headers: { host: `evil.example:${port}`, "content-type": "application/json" }, body });
    assert.equal(rebind.status, 403);
    assert.equal(log.state.seq, 0);
    // 手元の画面からは通す
    const own = await request(port, { method: "POST", path: "/api/say", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, body });
    assert.equal(own.status, 200);
    const lh = await request(port, { method: "POST", path: "/api/say", headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, "content-type": "application/json" }, body });
    assert.equal(lh.status, 200);
    // 手元のほかのポートで動くページからは書けない
    const before = log.state.seq;
    const other = await request(port, { method: "POST", path: "/api/say", headers: { origin: `http://127.0.0.1:${port + 1}`, "content-type": "text/plain" }, body });
    assert.equal(other.status, 403);
    assert.equal(log.state.seq, before);
  } finally {
    server.closeAll();
  }
});

test("知らない口は 404", async () => {
  const { server, base } = await start();
  try {
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/api/say`)).status, 404);
  } finally {
    server.closeAll();
  }
});
