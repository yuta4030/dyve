// サーバー：画面を返し、発言を受け取り、いまの状態を返し、記録が増えるたびに画面へ流す（SSE）
import http from "node:http";
import fs from "node:fs";
import { listViews, readView } from "./panels.js";

const UI = new URL("./ui.html", import.meta.url);
// 状態の作り方は一つだけ。画面も同じものを module として読み、記録を一件ずつ当てる
const STATE = new URL("./state.js", import.meta.url);
// 画面は一枚。外のものを読まず、ほかのページに埋め込ませない
const PAGE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-src 'none'; frame-ancestors 'none'",
};
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);

// panels：利用者のパネル置き場（なければ利用者の view はない）
// works：開発の作業場（取り込む）。sessions：セッション（伺いを受け入れる）。どちらも画面の人が押したときだけの口
export function createServer({ log, panels = null, works = null, sessions = null }) {
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
    // 書く口は、この画面からだけ。手元のほかのポートで動くページ（セッションが作ったものかもしれない）からは書かせない
    const own = origin ? origin.replace(/^https?:\/\//, "") === req.headers.host : null;
    if (req.method === "POST" && own === false) return json(403, { ok: false, code: "forbidden", message: "この画面からだけ書ける" });
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
      // 利用者の view：一覧（名前・一行の説明・データの形）と中身。頼まれるたびに置き場から読む。名前で絞り、置き場の外は読ませない
      if (route === "GET /api/views") return json(200, panels ? listViews(panels) : []);
      if (req.method === "GET" && pathname.startsWith("/api/views/")) {
        const src = readView(panels, decodeURIComponent(pathname.slice("/api/views/".length)));
        if (src == null) return json(404, { ok: false, code: "not_found", message: "その view はない" });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end(src);
      }
      if (route === "POST /api/say") {
        const body = await readJson(req);
        // peek：覗いていたセッション（あるものだけ）
        const peek = Number.isInteger(body.peek) && log.state.sessions.some((x) => x.id === body.peek) ? body.peek : null;
        const r = log.add("say", { text: body.text, peek });
        return json(r.ok ? 200 : 400, r);
      }
      // 取り込む・受け入れる：画面で押したときだけ（チャットの発言や係からは呼ばない）。押されたときに、いまのありさまを確かめ直す
      if (route === "POST /api/integrate" || route === "POST /api/accept") {
        // 人が画面で押したときだけの口。ブラウザは書くときに必ず Origin を付けるので、ないものは通さない
        // （手元のプロセスが Origin を騙ることまでは防げない。セッションには道具の決まりと auto の判定がかかっている）
        if (!own) return json(403, { ok: false, code: "forbidden", message: "画面から押したときだけ" });
        const body = await readJson(req);
        const sid = Number(body.session);
        const r = route === "POST /api/integrate"
          ? works ? works.integrate(sid) : { ok: false, code: "unavailable", message: "作業場がない" }
          : sessions ? sessions.accept(sid, Number(body.card)) : { ok: false, code: "unavailable", message: "セッションがない" };
        return json(r.ok ? 200 : r.code === "not_found" ? 404 : 409, r);
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
