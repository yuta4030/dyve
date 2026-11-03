// ボードのサーバー：一つだけ立て、画面（人）と MCP（エージェント）の両方がここへつなぐ
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRpc, boardView } from "./mcp.js";
import { toMarkdown } from "./export.js";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// desk：ボードを切り替えるときに使う（なければ一枚だけ）。{ current(), list(), open(name), create() }
// open・create は新しい { store, waker } を返す。前のボードの操作ログはそのまま残る
export function createServer({ store, waker = null, title = "ボード", desk = null }) {
  const clients = new Set();
  const send = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  let cur;
  const use = (next) => {
    cur = next;
    next.store.onOp((op) => cur.store === next.store && send("op", op));
    next.waker?.onChange((live) => cur.waker === next.waker && send("live", live));
  };
  use({ store, waker });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    // ブラウザから別のサイト経由で書かれないように（DNS リバインディングも含めて）
    const origin = req.headers.origin;
    if (origin && !LOCAL.test(origin)) return json(403, { ok: false, code: "forbidden", message: "別の場所からは使えない" });
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return json(403, { ok: false, code: "forbidden", message: "localhost だけ" });

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(UI));
      }
      if (req.method === "GET" && url.pathname === "/api/board") return json(200, { title, name: desk?.current() ?? null, ...boardView(cur.store, cur.waker) });
      if (req.method === "GET" && url.pathname === "/api/history") return json(200, cur.store.board.history(url.searchParams.get("id")));
      if (req.method === "GET" && url.pathname === "/api/export.md") {
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="board-${new Date().toISOString().slice(0, 10)}.md"`,
        });
        return res.end(toMarkdown(cur.store.board, { title, running: cur.waker?.runningTasks() ?? [] }));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: hello\ndata: ${JSON.stringify({ seq: cur.store.board.seq })}\n\n`);
        clients.add(res);
        const beat = setInterval(() => res.write(": beat\n\n"), 25000);
        req.on("close", () => {
          clearInterval(beat);
          clients.delete(res);
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/op") {
        // 画面から来る操作は人のもの
        const body = await readJson(req);
        const r = cur.store.apply({ by: "human", type: body.type, panel: body.panel });
        return json(r.ok ? 200 : 409, r.ok ? { ok: true, op: r.op } : r);
      }
      if (url.pathname === "/api/boards") {
        if (!desk) return json(404, { ok: false, code: "not_found", message: "ボードは一枚だけ" });
        if (req.method === "GET") return json(200, { current: desk.current(), boards: desk.list() });
        // 切り替え・新しいボードは人だけ（画面から）
        const body = await readJson(req);
        const next = body.action === "new" ? desk.create() : body.action === "open" ? desk.open(String(body.name || "")) : null;
        if (!next) return json(400, { ok: false, code: "invalid", message: "action は new か open" });
        use(next);
        send("board", { current: desk.current() });
        return json(200, { ok: true, current: desk.current() });
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          return res.end();
        }
        const as = url.searchParams.get("as") || "guest";
        const body = await readJson(req);
        const out = Array.isArray(body)
          ? body.map((m) => handleRpc(cur.store, cur.waker, as, m)).filter(Boolean)
          : handleRpc(cur.store, cur.waker, as, body);
        if (out == null || (Array.isArray(out) && !out.length)) {
          res.writeHead(202);
          return res.end();
        }
        return json(200, out);
      }
      json(404, { ok: false, code: "not_found", message: "ない" });
    } catch (e) {
      json(400, { ok: false, code: "invalid", message: e.message });
    }
  });
  server.closeAll = () => {
    for (const res of clients) res.end();
    server.close();
  };
  return server;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5e6) reject(new Error("大きすぎる"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON として読めない"));
      }
    });
  });
}
