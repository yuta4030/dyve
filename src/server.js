// ボードのサーバー：一つだけ立て、画面（人）と MCP（エージェント）の両方がここへつなぐ
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRpc, boardView } from "./mcp.js";
import { toMarkdown } from "./export.js";
import { samplesOf, fitsSample } from "./desk.js";
import { listViews, readView, readSettings, offViews, setView, trashView, restoreView, catalog } from "./panels.js";
import { Focus } from "./focus.js";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
const MANAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "manage.html");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// desk：ボードを切り替えるときに使う（なければ一枚だけ）。{ current(), list(), open(name), create() }
// open・create は新しい { store, waker } を返す。前のボードの操作ログはそのまま残る
// restart：使う dyve を更新して立て直す（{ commit } を返し、そのあと落ちる。立て直すのは見張り役）
// feeds：流し込み係（shell コマンドの結果）。panels：利用者のパネル置き場（view を配る）
// words：辞書。shoot：パネルの絵を撮る（id -> PNG）。meta：動いている dyve の情報
export function createServer({ store, waker = null, feeds = null, title = "ボード", desk = null, restart = null, panels = null, words = null, shoot = null, meta = null }) {
  const clients = new Set();
  const send = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  let cur;
  const use = (next) => {
    if (cur?.store === next.store) return; // 同じボードを開き直しても、知らせを二重に付けない
    cur = next;
    // 人のいまは起こし係が持つ（起こしたエージェントに混ぜる）。エージェントを起こさないときも、MCP から読めるように持つ
    cur.focus = next.waker?.focus ?? new Focus();
    next.store.onOp((op) => cur.store === next.store && send("op", op));
    next.waker?.onChange((live) => cur.waker === next.waker && send("live", live));
    next.feeds?.onChange((f) => cur.feeds === next.feeds && send("feed", f));
  };
  use({ store, waker, feeds });
  const offView = (view) => !!panels && offViews(panels).has(view);
  // view のファイルが変わったら画面に知らせる（描き直しは画面がする）
  let watcher = null;
  if (panels) {
    try {
      let t = null;
      watcher = fs.watch(path.join(panels, "views"), () => { clearTimeout(t); t = setTimeout(() => send("views", listViews(panels)), 100); });
    } catch {}
  }

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
      // 管理のページ：ボードの一覧とパネルの一覧
      if (req.method === "GET" && (url.pathname === "/boards" || url.pathname === "/panels")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(MANAGE));
      }
      // 人のいま：画面が知らせてくる（ログには積まず、誰も起こさない）。返すのは端末をまたいでまとめた「見た」印
      if (req.method === "POST" && url.pathname === "/api/focus") {
        const body = await readJson(req);
        return json(200, { ok: true, seen: cur.focus.set(String(body.client || ""), body) });
      }
      if (req.method === "GET" && url.pathname === "/api/board") return json(200, { title, seen: cur.focus.seen, name: desk?.current() ?? null, boardTitle: desk?.titleOf(desk.current()) ?? null, panelSet: panels ? readSettings(panels) : { views: {} }, ...boardView(cur.store, cur.waker, {}, cur.focus), feeds: cur.feeds?.view() ?? {}, views: panels ? listViews(panels) : [] });
      if (req.method === "GET" && url.pathname === "/api/meta") return json(200, { ...(meta?.() ?? {}), name: desk?.current() ?? null, board: cur.store.file ?? null, seq: cur.store.board.seq, shoot: !!shoot });
      if (url.pathname === "/api/words") {
        if (!words) return json(404, { ok: false, code: "not_found", message: "辞書がない" });
        if (req.method === "GET") return json(200, { words: words.list() });
        // 画面から来るのは人の操作
        const body = await readJson(req);
        const r = body.action === "drop" ? words.drop({ by: "human", heard: body.heard }) : words.add({ by: "human", heard: body.heard, write: body.write, when: body.when });
        return json(r.ok ? 200 : 409, r);
      }
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
        if (body.type !== "drop" && body.panel?.view && offView(body.panel.view)) return json(409, { ok: false, code: "invalid", message: `view ${body.panel.view} は「使わない」にしている（パネルの管理で戻せる）` });
        const r = cur.store.apply({ by: "human", type: body.type, panel: body.panel });
        return json(r.ok ? 200 : 409, r.ok ? { ok: true, op: r.op } : r);
      }
      if (url.pathname === "/api/boards") {
        if (!desk) return json(404, { ok: false, code: "not_found", message: "ボードは一枚だけ" });
        if (req.method === "GET") return json(200, { current: desk.current(), boards: desk.list().map(noSamples), archived: desk.archived().map(noSamples), running: cur.waker?.runningTasks().length ?? 0 });
        // ボードの管理は人だけ（画面から）
        const body = await readJson(req);
        const name = String(body.name || "");
        if (body.action === "new" || body.action === "open") {
          use(body.action === "new" ? desk.create() : desk.open(name));
        } else if (body.action === "title") desk.setTitle(name, body.title);
        else if (body.action === "archive") desk.archive(name);
        else if (body.action === "restore") desk.restore(name);
        else return json(400, { ok: false, code: "invalid", message: "action は new・open・title・archive・restore のどれか" });
        send("board", { current: desk.current() });
        return json(200, { ok: true, current: desk.current() });
      }
      if (url.pathname === "/api/panels") {
        if (!panels) return json(404, { ok: false, code: "not_found", message: "パネル置き場がない" });
        if (req.method === "GET") {
          const here = {}, all = {};
          for (const p of cur.store.board.list()) if (p.view !== "layout") here[p.view] = (here[p.view] || 0) + 1;
          // 絵の見本：いまのボードのコマンドの結果、いまのボードのデータ、新しいボードの順に探す
          const boards = desk?.list() ?? [{ views: here, samples: {} }];
          const samples = {};
          for (const [id, f] of Object.entries(cur.feeds?.view() ?? {})) {
            const v = cur.store.board.get(id)?.view;
            if (v && fitsSample(f.data)) samples[v] = f.data;
          }
          for (const from of [samplesOf(cur.store.board), ...boards.map((b) => b.samples)]) for (const [v, d] of Object.entries(from)) samples[v] ??= d;
          for (const b of boards) for (const [v, n] of Object.entries(b.views)) all[v] = (all[v] || 0) + n;
          return json(200, catalog(panels, { here, all, samples }));
        }
        // パネルの管理も人だけ（画面から）
        const body = await readJson(req);
        const name = String(body.name || "");
        if (body.action === "set") {
          setView(panels, name, { off: body.off, w: body.w, h: body.h });
          cur.feeds?.sync();
          send("panelset", readSettings(panels));
        } else if (body.action === "trash") trashView(panels, name);
        else if (body.action === "restore") restoreView(panels, String(body.file || ""));
        else return json(400, { ok: false, code: "invalid", message: "action は set・trash・restore のどれか" });
        send("views", listViews(panels));
        return json(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/views/")) {
        const src = panels ? readView(panels, decodeURIComponent(url.pathname.slice(11))) : null;
        if (src == null) return json(404, { ok: false, code: "not_found", message: "その view はない" });
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(src);
      }
      if (req.method === "POST" && url.pathname === "/api/feeds/run") {
        // 「今すぐ更新」は人だけ（画面から）。許可されていないコマンドは走らせない
        const body = await readJson(req);
        const ok = cur.feeds?.run(String(body.id || "")) ?? false;
        return json(ok ? 200 : 409, ok ? { ok: true } : { ok: false, code: "forbidden", message: "許可されたコマンドがない" });
      }
      if (url.pathname === "/api/restart" && req.method === "POST") {
        // 更新と再起動は人だけ（画面から）
        if (!restart) return json(404, { ok: false, code: "not_found", message: "再起動できない起動のしかた" });
        const r = restart.prepare();
        json(200, { ok: true, ...r });
        setTimeout(() => restart.go(), 200);
        return;
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          return res.end();
        }
        const as = url.searchParams.get("as") || "guest";
        const body = await readJson(req);
        const rpc = { offView, words, shoot, focus: cur.focus };
        const out = Array.isArray(body)
          ? (await Promise.all(body.map((m) => handleRpc(cur.store, cur.waker, as, m, rpc)))).filter(Boolean)
          : await handleRpc(cur.store, cur.waker, as, body, rpc);
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
    watcher?.close();
    for (const res of clients) res.end();
    server.close();
  };
  return server;
}

const noSamples = ({ samples, ...b }) => b;

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
