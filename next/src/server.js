// サーバー：画面を返し、発言を受け取り、いまの状態を返し、記録が増えるたびに画面へ流す（SSE）
import http from "node:http";
import fs from "node:fs";

const UI = new URL("./ui.html", import.meta.url);
// 状態の作り方は一つだけ。画面も同じものを module として読み、記録を一件ずつ当てる
const STATE = new URL("./state.js", import.meta.url);
// 画面は一枚。外のものを読まず、ほかのページに埋め込ませない
const PAGE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
};
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createServer({ log }) {
  const clients = new Set();
  const off = log.on((record) => {
    const chunk = `event: record\ndata: ${JSON.stringify(record)}\n\n`;
    for (const res of clients) res.write(chunk);
  });

  const server = http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // ほかのサイトのページから書かれないように（DNS リバインディングも含めて）
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) return json(403, { ok: false, code: "forbidden", message: "ほかの場所からは使えない" });
    if (!LOCAL_HOST.has((req.headers.host || "").replace(/:\d+$/, ""))) return json(403, { ok: false, code: "forbidden", message: "localhost だけ" });

    const { pathname } = new URL(req.url, "http://localhost");
    const route = `${req.method} ${pathname}`;
    try {
      if (route === "GET /") {
        res.writeHead(200, PAGE);
        return res.end(fs.readFileSync(UI));
      }
      if (route === "GET /state.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(STATE));
      }
      if (route === "GET /api/state") return json(200, log.state);
      if (route === "POST /api/say") {
        const body = await readJson(req);
        // peek：覗いていたセッション（あるものだけ）
        const peek = Number.isInteger(body.peek) && log.state.sessions.some((x) => x.id === body.peek) ? body.peek : null;
        const r = log.add("say", { text: body.text, peek });
        return json(r.ok ? 200 : 400, r);
      }
      if (route === "GET /api/events") {
        // つないだときに、いまの状態をまるごと一度送る。あとは増えた記録を一件ずつ
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(log.state)}\n\n`);
        clients.add(res);
        const beat = setInterval(() => res.write(": beat\n\n"), 25000);
        req.on("close", () => {
          clearInterval(beat);
          clients.delete(res);
        });
        return;
      }
      json(404, { ok: false, code: "not_found", message: "ない" });
    } catch (e) {
      json(400, { ok: false, code: "invalid", message: e.message });
    }
  });
  server.closeAll = () => {
    off();
    for (const res of clients) res.end();
    clients.clear();
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
      if (raw.length > 1e6) {
        reject(new Error("大きすぎる"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const v = raw ? JSON.parse(raw) : {};
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        reject(new Error("JSON として読めない"));
      }
    });
  });
}
