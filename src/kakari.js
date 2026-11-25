// 係：発言を読んで、どのセッションに届けるかだけを決める。それ以外はしない
// 「A は〜」のように記号で始まる発言は、係に聞かずにそのまま届ける。ほかは Claude Code（道具なし・速いモデル）に聞く
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { shown } from "./state.js";

const PROMPT = fileURLToPath(new URL("../prompts/係.md", import.meta.url));
const TIMEOUT = 60 * 1000;
// 係に見せる直前の発言の数
const CONTEXT = 6;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const STATUS = { idle: "まだ", run: "実行中", wait: "待ち", fail: "失敗", stop: "止めた" };

export const SCHEMA = {
  type: "object",
  properties: {
    says: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, to: { type: "string" }, name: { type: "string" }, text: { type: "string" } },
        required: ["id", "to"],
      },
    },
  },
  required: ["says"],
};

// 記号で始まる発言なら、そのセッション（なければ null）
export function quick(text, sessions) {
  const m = text.normalize("NFKC").match(/^([A-Z]{1,2})(?=[\s、,。:：はにへのもってで]|$)/);
  return m ? sessions.find((x) => x.sym === m[1]) ?? null : null;
}

// 係に渡す一通
export function routePrompt(state, batch) {
  const symOf = (id) => state.sessions.find((x) => x.id === id)?.sym ?? "?";
  const first = (x) => state.said.find((p) => p.session === x.id)?.text ?? "";
  const before = state.said.filter((p) => p.id > state.since && p.id < batch[0].id && p.session !== undefined).slice(-CONTEXT);
  const live = shown(state);
  return [
    "いまのセッション：",
    ...(live.length
      ? live.map((x) => `- ${x.sym}「${x.name}」${STATUS[x.status]}。最初の頼み：${clip(oneLine(first(x)), 80)}。最後：${clip(oneLine(x.last), 80)}`)
      : ["（なし）"]),
    ...(before.length ? ["", "直前の発言：", ...before.map((p) => `- （${p.session == null ? "届けていない" : `→ ${symOf(p.session)}`}）${clip(oneLine(p.text), 120)}`)] : []),
    "",
    `清書：${state.settings?.fair ? "する" : "しない"}`,
    "",
    "新しい発言：",
    ...batch.map((p) => `- ${p.id}${p.peek != null ? `（${symOf(p.peek)} を覗いていた）` : ""}：${p.text}`),
  ].join("\n");
}

// 本物の聞き方：道具を持たない Claude Code を一回ごとに起こし、決まった形の JSON で受ける（係とまとめで使う）
// prompt：指示のファイル。schema：返す形。key：返したものに必ずある項目。返すもの：Promise<{ ok, json?, error? }>
export function claudeAsk({ cmd = "claude", model = "haiku", cwd, timeout = TIMEOUT, prompt = PROMPT, schema = SCHEMA, key = "says" }) {
  const system = fs.readFileSync(prompt, "utf8").trim();
  const args = [
    "-p", "--output-format", "json",
    "--tools", "", "--system-prompt", system,
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--json-schema", JSON.stringify(schema),
    ...(model ? ["--model", model] : []),
  ];
  return (text) => new Promise((resolve) => {
    let out = "", err = "", child;
    try {
      child = nodeSpawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ ok: false, error: `${timeout / 1000} 秒で返らなかった` }); }, timeout);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (err = (err + c).slice(-2000)));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
    child.on("close", (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (!j) return resolve({ ok: false, error: clip(oneLine(err.trim().split("\n").at(-1) || `終了コード ${code}`), 200) });
      if (j.is_error) return resolve({ ok: false, error: clip(oneLine(j.result || j.subtype), 200) });
      const json = j.structured_output ?? (() => { try { return JSON.parse(j.result); } catch { return null; } })();
      resolve(json?.[key] != null ? { ok: true, json } : { ok: false, error: "決まった形で返らなかった" });
    });
  });
}

export class Kakari {
  // ask(text) -> Promise<{ ok, json, error }>
  constructor({ log, sessions, ask }) {
    Object.assign(this, { log, sessions, ask });
    this.busy = false;
    this.again = false;
  }

  start() {
    this.off = this.log.on((r) => { if (r.kind === "say") this.kick(); });
    this.kick(); // 立て直す前に届け先が決まらなかった発言
    return this;
  }

  stop() {
    this.off?.();
  }

  kick() {
    if (this.busy) { this.again = true; return this.idle; }
    this.busy = true;
    this.idle = (async () => {
      do {
        this.again = false;
        await this.read();
      } while (this.again);
      this.busy = false;
    })();
    return this.idle;
  }

  async read() {
    const state = this.log.state;
    const batch = state.said.filter((p) => p.session === undefined && !p.canceled);
    if (!batch.length) return;
    const ask = [];
    for (const p of batch) {
      const x = quick(p.text, shown(state));
      if (x) this.deliver(p.id, x.id);
      else ask.push(p);
    }
    if (!ask.length) return;
    const r = await this.ask(routePrompt(state, ask));
    if (!r.ok) {
      for (const p of ask) if (p.session === undefined && !p.canceled) this.log.add("route", { say: p.id, error: r.error });
      return;
    }
    const made = new Map(); // 同じ回の新しいセッション（名前 -> 番号）
    for (const p of ask) {
      // 聞いているあいだに人が届け先を決めたり、取り消したりしたものは触らない
      if (p.session !== undefined || p.canceled) continue;
      const d = r.json.says.find((s) => s.id === p.id) ?? { to: "new" };
      const to = String(d.to ?? "new").trim();
      // 清書は、清書する設定のときだけ受け取る
      const fair = state.settings?.fair && typeof d.text === "string" && d.text.trim() ? d.text.trim() : null;
      if (to === "none") { this.log.add("route", { say: p.id, session: null, fair }); continue; }
      const x = shown(state).find((y) => y.sym === to);
      if (x) { this.deliver(p.id, x.id, fair); continue; }
      // 知らない記号や形の崩れは、新しく起こすほうに倒す（落とさない）
      const name = clip(oneLine(d.name) || oneLine(fair ?? p.text), 20);
      if (!made.has(name)) made.set(name, this.sessions.open(name));
      this.deliver(p.id, made.get(name), fair);
    }
  }

  deliver(say, session, fair = null) {
    this.log.add("route", { say, session, fair });
    this.sessions.send(session, say);
  }
}
