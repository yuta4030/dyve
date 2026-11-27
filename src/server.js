// サーバー：画面を返し、発言を受け取り、いまの状態を返し、記録が増えるたびに状態を画面へ流す（SSE）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { shown } from "./state.js";
import { quick } from "./kakari.js";
import { answer as mcpAnswer } from "./mcp.js";

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
// room：押したシェルを動かす場所（なければその口は断る）
// opener：ファイルを開く関数（テストで差し替える）
// mcpKey：セッションに貸す道具の口の鍵（/mcp/<鍵>/<セッション>）。なければその口は開けない
export function createServer({ log, sessions = null, room = null, shell = process.env.SHELL || "/bin/sh", opener = openFile, mcpKey = null }) {
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
      // セッションに貸す道具（MCP）。鍵の合うものだけ。返事は JSON で一通ずつ（SSE は使わない）
      const mcp = pathname.match(/^\/mcp\/([^/]+)\/(\d+)$/);
      if (mcp) {
        if (!mcpKey || mcp[1] !== mcpKey) return json(404, { ok: false, message: "ない" });
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
        const m = await readJson(req);
        const out = mcpAnswer(log, Number(mcp[2]), m);
        if (!out) { res.writeHead(202); return res.end(); }
        return json(200, out);
      }
      // 質問に答える：答えを一通の発言にしてそのセッションへ直に渡し、質問を下げる。answers が空なら下げるだけ
      if (route === "POST /api/answer") {
        const b = await readJson(req);
        const x = log.state.sessions.find((y) => y.id === b.session && !y.hidden);
        if (!x || !sessions) return json(404, { ok: false, message: "そのセッションはない" });
        const qs = x.asks?.questions ?? [];
        const lines = (Array.isArray(b.answers) ? b.answers : [])
          .filter((a) => Number.isInteger(a?.q) && qs[a.q] && String(a.a ?? "").trim())
          .map((a) => `${a.q + 1}. ${qs[a.q].title}：${String(a.a).trim()}`);
        if (lines.length) {
          const record = log.add("say", { text: `質問への答え\n${lines.join("\n")}`, to: x.id });
          sessions.send(x.id, record.seq);
        }
        log.add("asks", { session: x.id, questions: [] });
        return json(200, { ok: true });
      }
      if (route === "POST /api/say") {
        const body = await readJson(req);
        const peek = Number.isInteger(body.peek) && log.state.sessions.some((x) => x.id === body.peek) ? body.peek : null;
        // to：選択肢を押したときの届け先。係を通さず、そのセッションへ直に渡す
        let to = Number.isInteger(body.to) && sessions && log.state.sessions.some((x) => x.id === body.to && !x.hidden) ? body.to : null;
        // 覗いているあいだの発言は、係を通さず覗いている先へ直に渡す（ほとんどがそこ宛てで、係を待つぶん遅いため）。
        // 記号で別のセッションを呼んでいるときだけは係に任せる。違っていたら人が付け替える
        const live = shown(log.state);
        if (to == null && peek != null && sessions && live.some((x) => x.id === peek) && !quick(String(body.text ?? ""), live)) to = peek;
        const record = log.add("say", { text: body.text, peek, ...(to ? { to } : {}) });
        if (to) sessions.send(to, record.seq);
        return json(200, { ok: true, record });
      }
      // リンクの決まりを置き換える
      if (route === "POST /api/links") {
        const b = await readJson(req);
        return json(200, { ok: true, record: log.add("links", { rules: b.rules }) });
      }
      // 返事の中のシェルを、人が押したときに動かす。画面から押したときだけ（Origin のない呼び出しは断る）
      if (route === "POST /api/run") {
        if (!origin) return json(403, { ok: false, message: "画面から押したときだけ" });
        if (!room) return json(409, { ok: false, message: "動かす場所がない" });
        const b = await readJson(req);
        const cmd = String(b.cmd ?? "").trim();
        if (!cmd) return json(400, { ok: false, message: "コマンドがない" });
        // そのセッションの返事の中のシェルは、そのセッションが起きた場所で動かす
        const x = log.state.sessions.find((y) => y.id === b.session);
        return json(200, { ok: true, ...(await run(shell, cmd, x?.room ?? room)) });
      }
      // シェルを動かした結果を、そのセッションへの発言として届ける（係を通さない）。画面から押したときだけ
      if (route === "POST /api/report") {
        if (!origin) return json(403, { ok: false, message: "画面から押したときだけ" });
        const b = await readJson(req);
        if (!sessions || !log.state.sessions.some((x) => x.id === b.session && !x.hidden)) return json(404, { ok: false, message: "そのセッションはない" });
        const record = log.add("say", { text: reportOf(String(b.cmd ?? ""), b.code, String(b.out ?? "")), peek: null, to: b.session });
        sessions.send(b.session, record.seq);
        return json(200, { ok: true, record });
      }
      // これから起こすセッションの場所を変える。画面から押したときだけ。ある場所（フォルダ）だけ
      if (route === "POST /api/room") {
        if (!origin) return json(403, { ok: false, message: "画面から押したときだけ" });
        const b = await readJson(req);
        const dir = resolvePath(String(b.path ?? ""), log.state.room ?? room);
        if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return json(404, { ok: false, message: `フォルダが見つからない：${b.path}` });
        if (log.state.room !== dir) log.add("room", { path: dir });
        return json(200, { ok: true, path: dir });
      }
      // 返事の中のファイルを、人が押したときに手元のアプリで開く。画面から押したときだけ
      if (route === "POST /api/open") {
        if (!origin) return json(403, { ok: false, message: "画面から押したときだけ" });
        const b = await readJson(req);
        // 相対の場所は、起きる場所を先に、そのセッションが触った場所の順に探す（セッションが下のフォルダで作業していることがある）
        const x = log.state.sessions.find((y) => y.id === b.session);
        const file = [...new Set([x?.room, room, ...placesOf(x)].filter(Boolean))].map((base) => resolvePath(String(b.path ?? ""), base)).find((f) => f && fs.existsSync(f));
        if (!file) return json(404, { ok: false, message: `見つからない：${b.path}` });
        const line = Number.isInteger(b.line) && b.line > 0 ? b.line : null;
        const col = Number.isInteger(b.col) && b.col > 0 ? b.col : null;
        opener({ file, line, col, how: log.state.settings?.opener ?? "os" });
        return json(200, { ok: true, file });
      }
      // カードを畳む・広げる（人が押したとき）
      if (route === "POST /api/fold") {
        const b = await readJson(req);
        if (!log.state.sessions.some((x) => x.id === b.session)) return json(404, { ok: false, message: "そのセッションはない" });
        return json(200, { ok: true, record: log.add("fold", { session: b.session, on: b.on }) });
      }
      // 設定を変える（決まった名前と値だけ）
      if (route === "POST /api/set") {
        const b = await readJson(req);
        return json(200, { ok: true, record: log.add("set", { key: b.key, value: b.value }) });
      }
      // リセットと、それを戻す。どちらも記録に一件足すだけで、何も消さない
      if (route === "POST /api/reset") return json(200, { ok: true, record: log.add("reset") });
      if (route === "POST /api/restore") {
        const b = await readJson(req);
        if (!log.state.history.some((e) => e.seq === b.era)) return json(404, { ok: false, message: "その履歴はない" });
        return json(200, { ok: true, record: log.add("restore", { era: b.era }) });
      }
      if (route === "POST /api/undo") {
        if (!log.state.undo) return json(409, { ok: false, message: "戻せるリセットがない" });
        return json(200, { ok: true, record: log.add("undo") });
      }
      // 取り消す・止める・届け先を変える：人が画面で押したときの口
      if (route === "POST /api/rewind") {
        const b = await readJson(req);
        const r = await sessions.rewind(Number(b.session), Number(b.say), !!b.files);
        return json(r.ok ? 200 : 409, r);
      }
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

// 返事に書かれた場所を、手元のファイルの場所にする：~ は家、途中からの場所は room から
// セッションが触った場所：道具の一行に出た絶対の場所（ファイルならそのフォルダ）と cd の先、そこから上のフォルダ。近いものから
export function placesOf(x) {
  if (!x) return [];
  const seen = new Set(), out = [];
  const lines = [...(x.flow ?? []).filter((f) => f.who === "tool").map((f) => f.text), ...(x.info ?? []).filter((i) => i.kind === "file").map((i) => `Edit ${i.ref}`)].reverse();
  for (const line of lines) {
    const hits = [line.match(/^\S+ (\/\S+)/)?.[1], ...[...line.matchAll(/(?:^|[;&|]\s*|\s)cd\s+(\/[^\s;&|]+)/g)].map((m) => m[1])].filter(Boolean);
    for (const hit of hits) {
      let dir = path.normalize(hit);
      if (path.extname(dir) || /\/[^/]*\.[^/]*$/.test(dir)) dir = path.dirname(dir);
      for (; dir !== path.dirname(dir) && dir !== os.homedir(); dir = path.dirname(dir)) {
        if (!seen.has(dir)) { seen.add(dir); out.push(dir); }
      }
    }
  }
  return out;
}

export function resolvePath(p, room) {
  p = p.trim();
  if (!p) return null;
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : room ? path.resolve(room, p) : null;
}

// 開くと動いてしまうもの（OS の既定で開くときは、開かずにフォルダの中で見せる）
const RUNNABLE = /\.(app|command|tool|sh|bash|zsh|exe|bat|cmd|com|msi|ps1|scpt|applescript|workflow|jar|desktop|run|bin|appimage|pkg|dmg|deb|rpm)$/i;
export function runnable(file) {
  try {
    const st = fs.statSync(file);
    return st.isDirectory() ? /\.app$/i.test(file) : RUNNABLE.test(file) || (process.platform !== "win32" && (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

// 本物の開き方。VS Code は行まで飛ぶ。OS の既定では、動いてしまうものは開かずにフォルダで見せる
export function openFile({ file, line, col, how }) {
  const at = line ? `${file}:${line}${col ? `:${col}` : ""}` : file;
  const mac = process.platform === "darwin", win = process.platform === "win32";
  let cmd, args;
  if (how === "vscode") [cmd, args] = ["code", ["-g", at]];
  else if (runnable(file)) [cmd, args] = mac ? ["open", ["-R", file]] : win ? ["explorer", [`/select,${file}`]] : ["xdg-open", [path.dirname(file)]];
  else [cmd, args] = mac ? ["open", [file]] : win ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: win && cmd !== "cmd" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// シェルを動かして、終了コードと出力（標準出力と標準エラーを混ぜたもの）を返す。長いものは後ろを残し、止まらなければ切る
// シェルを動かした結果をセッションへ届ける文。出力が長ければ終わりのほうを残す（エラーは終わりに出ることが多いので）
const REPORT_MAX = 4000;
export function reportOf(cmd, code, out) {
  const body = out.length > REPORT_MAX ? `…（前の ${out.length - REPORT_MAX} 文字は省いた）\n${out.slice(-REPORT_MAX)}` : out;
  return ["［dyve：人がコマンドを動かした結果］", "```", `$ ${cmd.trim()}`, body.replace(/\n+$/, ""), "```", `終了コード ${code}`].join("\n");
}

const RUN_MS = 120 * 1000;
const RUN_MAX = 20000;
export function run(shell, cmd, cwd, ms = RUN_MS) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const keep = (c) => { out = (out + c).slice(-RUN_MAX); };
    let child;
    try {
      child = spawn(shell, ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const timer = setTimeout(() => { child.kill("SIGTERM"); keep(`\n（${ms / 1000} 秒で止めた）`); }, ms);
    child.stdout.setEncoding("utf8").on("data", keep);
    child.stderr.setEncoding("utf8").on("data", keep);
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    child.on("error", (e) => { keep(e.message); finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
  });
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
