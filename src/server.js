// サーバー：画面を返し、発言を受け取り、いまの状態を返し、記録が増えるたびに状態を画面へ流す（SSE）
import http from "node:http";
import fs from "node:fs";

const UI = new URL("./ui.html", import.meta.url);
// 画面は一枚。外のものを読まず、ほかのページに埋め込ませない
const PAGE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);
// 記録が続けて増えるときは、まとめて一度だけ流す（ミリ秒）
const BATCH = 50;

// sessions：取り消す・止める・届け先を変える（なければその口は断る）
export function createServer({ log, sessions = null }) {
  const clients = new Set();
  let timer = null;
  const push = () => {
    timer = null;
    const chunk = `event: state\ndata: ${JSON.stringify(log.state)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  const off = log.on(() => { timer ??= setTimeout(push, BATCH); });

  const server = http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // ほかのサイトのページから読み書きされないように（DNS リバインディングも含めて）
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) return json(403, { ok: false, message: "ほかの場所からは使えない" });
    if (!LOCAL_HOST.has((req.headers.host || "").replace(/:\d+$/, ""))) return json(403, { ok: false, message: "localhost だけ" });
    if (req.method === "POST" && origin && origin.replace(/^https?:\/\//, "") !== req.headers.host) return json(403, { ok: false, message: "この画面からだけ書ける" });

    const { pathname } = new URL(req.url, "http://localhost");
    const route = `${req.method} ${pathname}`;
    try {
      if (route === "GET /") {
        res.writeHead(200, PAGE);
        return res.end(fs.readFileSync(UI));
      }
      if (route === "GET /api/state") return json(200, log.state);
      if (route === "POST /api/say") {
        const body = await readJson(req);
        const peek = Number.isInteger(body.peek) && log.state.sessions.some((x) => x.id === body.peek) ? body.peek : null;
        // to：選択肢を押したときの届け先。係を通さず、そのセッションへ直に渡す
        const to = Number.isInteger(body.to) && sessions && log.state.sessions.some((x) => x.id === body.to && !x.hidden) ? body.to : null;
        const record = log.add("say", { text: body.text, peek, ...(to ? { to } : {}) });
        if (to) sessions.send(to, record.seq);
        return json(200, { ok: true, record });
      }
      // 設定を変える（決まった名前と値だけ）
      if (route === "POST /api/set") {
        const b = await readJson(req);
        return json(200, { ok: true, record: log.add("set", { key: b.key, value: b.value }) });
      }
      // リセットと、それを戻す。どちらも記録に一件足すだけで、何も消さない
      if (route === "POST /api/reset") return json(200, { ok: true, record: log.add("reset") });
      if (route === "POST /api/undo") {
        if (!log.state.undo) return json(409, { ok: false, message: "戻せるリセットがない" });
        return json(200, { ok: true, record: log.add("undo") });
      }
      // 取り消す・止める・届け先を変える：人が画面で押したときの口
      if (route === "POST /api/cancel" || route === "POST /api/stop" || route === "POST /api/move") {
        if (!sessions) return json(409, { ok: false, message: "セッションがない" });
        const b = await readJson(req);
        const ok = route === "POST /api/cancel" ? sessions.cancel(Number(b.say))
          : route === "POST /api/stop" ? sessions.stop(Number(b.session))
          : sessions.move(Number(b.say), b.to === "new" ? "new" : Number(b.to));
        return json(ok ? 200 : 409, { ok });
      }
      if (route === "GET /api/events") {
        // つないだときに、いまの状態をまるごと送る。あとは増えるたびにまるごと
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
      json(404, { ok: false, message: "ない" });
    } catch (e) {
      json(400, { ok: false, message: e.message });
    }
  });
  server.closeAll = () => {
    off();
    clearTimeout(timer);
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
