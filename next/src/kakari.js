// 係：横で読む係。一人だけで、口ごとに自分の会話を持ち、互いに待たせない。
// 係も Claude Code。道具を持たず、Claude Code の既定の前置きを係の定義に差し替え、起こしっぱなしの会話で読む（速くて安いため）。
// 返すものは --json-schema で決まった形の JSON にする
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { wordLine } from "./words.js";

export const DEFS = { said: fileURLToPath(new URL("../kakari/発言.md", import.meta.url)) };
export const readDef = (name) => fs.readFileSync(DEFS[name], "utf8").trim();

// 起こし直す目安：渡した数と、あいた時間（前置きのキャッシュの持ちは 1 時間）。一回で返らなければ止めて起こし直す
const TURNS = 30;
const IDLE = 55 * 60 * 1000;
const TIMEOUT = 60 * 1000;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 起こしっぱなしの会話（本物）：stream-json で一通ずつ渡し、結果の出来事を待つ。
// 返すもの：{ send(text) -> Promise<{ ok, json?, error?, usage? }>, kill(), alive }
export function claudeConv({ cmd = "claude", prompt, schema, model = null, cwd }) {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--system-prompt", prompt,
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--json-schema", JSON.stringify(schema),
    ...(model ? ["--model", model] : []),
  ];
  const c = { alive: true };
  let wait = null, buf = "", cost = 0, child, tail = "";
  const finish = (r) => { const w = wait; wait = null; w?.(r); };
  const dead = (why) => { c.alive = false; finish({ ok: false, error: why }); };
  try {
    child = nodeSpawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    c.alive = false;
    return { ...c, send: async () => ({ ok: false, error: e.message }), kill() {} };
  }
  child.on("error", (e) => dead(e.message));
  child.on("close", (code) => dead(`係の会話が終わった（終了コード ${code}${tail.trim() ? `：${clip(oneLine(tail.trim().split("\n").at(-1)), 200)}` : ""}）`));
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (b) => { tail = (tail + b).slice(-2000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== "result") continue;
      // total_cost_usd は会話の通算なので、一回ぶんは差で出す
      const total = j.total_cost_usd || 0, usage = { costUsd: Math.max(0, total - cost), ms: j.duration_ms || 0 };
      cost = total;
      if (j.is_error) { finish({ ok: false, error: oneLine(j.result || (j.errors ?? []).join(" / ") || j.subtype), usage }); continue; }
      const json = j.structured_output ?? strictJson(j.result);
      finish(json ? { ok: true, json, usage } : { ok: false, error: `返したものが JSON として読めない：${clip(oneLine(j.result), 120)}`, usage });
    }
  });
  c.send = (text) => new Promise((resolve) => {
    if (!c.alive) return resolve({ ok: false, error: "係の会話が終わっている" });
    wait = resolve;
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  });
  c.kill = () => { c.alive = false; child.kill("SIGTERM"); };
  return c;
}

// JSON だけが返ったときだけ読む（前後に文があれば読まない）
function strictJson(s) {
  if (typeof s !== "string") return null;
  try {
    const v = JSON.parse(s.trim());
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 口ごとの会話。死んでいたり、伸びすぎたり、あきすぎたりしたら起こし直す。open は新しい会話を作る関数
export class Conv {
  constructor({ open, turns = TURNS, idle = IDLE, timeout = TIMEOUT, now = () => Date.now() }) {
    Object.assign(this, { open, turns, idle, timeout, now, c: null, n: 0, last: 0 });
  }

  async send(text) {
    const t = this.now();
    if (!this.c || !this.c.alive || this.n >= this.turns || t - this.last > this.idle) {
      this.c?.kill();
      this.c = this.open();
      this.n = 0;
    }
    this.n++;
    this.last = t;
    const c = this.c;
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r({ ok: false, error: `${Math.round(this.timeout / 1000)} 秒で返らなかった` }), this.timeout); });
    const r = await Promise.race([c.send(text), late]);
    clearTimeout(timer);
    if (!r.ok && c.alive && /返らなかった/.test(r.error)) c.kill();
    return r;
  }

  kill() {
    this.c?.kill();
    this.c = null;
  }
}

// ── 発言を読む口 ──

export const SAID_SCHEMA = {
  type: "object",
  properties: {
    says: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
          to: { type: "string", enum: ["session", "new", "none"] },
          session: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "text", "to"],
      },
    },
    words: {
      type: "array",
      items: { type: "object", properties: { heard: { type: "string" }, write: { type: "string" }, when: { type: "string" } }, required: ["heard", "write"] },
    },
  },
  required: ["says"],
};

const stateWord = (x) => (x.running ? "実行中" : x.failed ? "止まっている（結果なし）" : "止まっている");
const shown = (p) => p?.fair ?? p?.text ?? "";
// 新しく起こせる役割（起きる場所が用意できているもの）
export const choosable = (roles) => Object.values(roles).filter((r) => r.place === "room");

// 係に渡す一通。batch：届け先を決める発言。context：その前の、届け先が決まった発言をいくつ添えるか
export function saidPrompt({ state, batch, roles, words = [], context = 5 }) {
  const said = (n) => state.said.find((p) => p.id === n);
  const first = Math.min(...batch.map((p) => p.id));
  const before = state.said.filter((p) => p.id < first && (p.session != null || p.aside)).slice(-context);
  const symOf = (sid) => state.sessions.find((x) => x.id === sid)?.sym ?? "?";
  const lastWords = (x) => x.last ?? x.flow.filter((f) => f.talk).at(-1)?.talk ?? "";
  return [
    "選べる役割：",
    ...choosable(roles).map((r) => `- ${r.name}：${r.about}`),
    "",
    "辞書：",
    ...(words.length ? words.map(wordLine) : ["（なし）"]),
    "",
    "いまのセッション：",
    ...(state.sessions.length
      ? state.sessions.map((x) => {
          const asked = x.asked.length ? clip(oneLine(shown(said(x.asked[0]))), 80) : "";
          const more = x.asked.length > 1 ? `（ほか ${x.asked.length - 1} 件。いちばん新しいもの：${clip(oneLine(shown(said(x.asked.at(-1)))), 60)}）` : "";
          const last = clip(oneLine(lastWords(x).split("\n").find((l) => l.trim()) ?? ""), 80);
          return `- ${x.sym}「${x.name ?? x.role}」${x.role}・${stateWord(x)}。頼んだこと：${asked}${more}${last ? `　最後の言葉：${last}` : ""}`;
        })
      : ["（なし）"]),
    ...(before.length ? ["", "直前の発言：", ...before.map((p) => `- ${p.id}（${p.aside ? "届けていない" : `→ ${symOf(p.session)}`}）：${oneLine(shown(p))}`)] : []),
    "",
    "新しい発言：",
    ...batch.map((p) => `- ${p.id}：${p.text}`),
  ].join("\n");
}

export class SaidMouth {
  // conv：Conv（send(text) を持つもの）。words：Words。pause：発言が来てから読むまで（ミリ秒）。most：一度に読む発言の数
  constructor({ log, sessions, roles, words, conv, pause = 0, most = 20 }) {
    Object.assign(this, { log, sessions, roles, words, conv, pause, most });
    this.reading = new Set();
    this.busy = false;
    this.again = false;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.off = this.log.on((r) => r.kind === "say" && this.kick());
    if (this._undecided().length) this.kick();
    return this;
  }

  stop() {
    this.stopped = true;
    this.off?.();
    clearTimeout(this.timer);
    this.conv.kill?.();
  }

  // 届け先の決まっていない発言（いま読んでいるものは除く）
  _undecided() {
    return this.log.state.said.filter((p) => p.session == null && !p.aside && !this.reading.has(p.id));
  }

  // 読んでいるあいだに来た発言は、終わってから次の回にまとめて読む
  kick() {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.read(), this.pause);
  }

  async read() {
    this.timer = null;
    const batch = this._undecided().slice(-this.most);
    if (this.stopped || !batch.length) return;
    this.busy = true;
    for (const p of batch) this.reading.add(p.id);
    let res;
    try {
      res = await this.conv.send(saidPrompt({ state: this.log.state, batch, roles: this.roles, words: this.words?.list() ?? [] }));
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!this.stopped) {
      if (res.ok) this._apply(batch, res.json);
      else this.log.add("miss", { says: batch.map((p) => p.id), reason: `係が読めなかった：${res.error}` });
    }
    for (const p of batch) this.reading.delete(p.id);
    this.busy = false;
    if (this.again) {
      this.again = false;
      this.kick();
    }
  }

  // 返ったものを記録に置く：清書（変わったときだけ）→ 届け先。読めないもの・ありもしない届け先は miss にして、未定のまま残す
  _apply(batch, json) {
    const mine = new Map(batch.map((p) => [p.id, p]));
    const items = Array.isArray(json?.says) ? json.says.filter((x) => x && mine.has(x.id)).sort((a, b) => a.id - b.id) : [];
    const done = new Set(), made = new Map(), missed = [];
    const choices = new Set(choosable(this.roles).map((r) => r.name));
    for (const it of items) {
      if (done.has(it.id)) continue;
      done.add(it.id);
      const p = mine.get(it.id);
      const text = typeof it.text === "string" ? it.text.trim() : "";
      if (text && text !== p.text && text !== p.fair) this.log.add("fair", { said: p.id, text });
      let r = null;
      if (it.to === "none") {
        this.log.add("aside", { said: p.id });
        continue;
      } else if (it.to === "session") {
        const x = this.log.state.sessions.find((s) => s.sym === String(it.session ?? "").trim().toUpperCase());
        r = x ? this.sessions.ask(p.id, { session: x.id }) : { ok: false, message: `ありもしないセッション「${it.session ?? ""}」を返した` };
      } else if (it.to === "new") {
        const role = String(it.role ?? "").trim(), name = oneLine(it.name) || clip(oneLine(text || p.text), 20);
        const key = `${role}\n${name}`;
        if (!choices.has(role)) r = { ok: false, message: `選べない役割「${role}」を返した` };
        else if (made.has(key)) r = this.sessions.ask(p.id, { session: made.get(key) });
        else {
          r = this.sessions.ask(p.id, { role, name });
          if (r.ok) made.set(key, r.session);
        }
      } else {
        r = { ok: false, message: `届け先「${it.to}」がわからない` };
      }
      if (!r.ok) missed.push([p.id, r.message]);
    }
    for (const p of batch) if (!done.has(p.id)) missed.push([p.id, "係が返さなかった"]);
    for (const [n, why] of missed) this.log.add("miss", { says: [n], reason: why });
    for (const w of Array.isArray(json?.words) ? json.words : []) this.words?.add({ by: "係", heard: w?.heard, write: w?.write, when: w?.when });
  }
}

// 係：口を並べて持つだけ。口どうしは互いに待たせない（それぞれ自分の会話を持つ）
export class Kakari {
  constructor(mouths) {
    this.mouths = mouths;
  }

  start() {
    for (const m of this.mouths) m.start();
    return this;
  }

  stop() {
    for (const m of this.mouths) m.stop();
  }
}
