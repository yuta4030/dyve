// 係：横で読む係。一人だけで、口ごとに自分の会話を持ち、互いに待たせない。
// 係も Claude Code。道具を持たず、Claude Code の既定の前置きを係の定義に差し替え、起こしっぱなしの会話で読む（速くて安いため）。
// 返すものは --json-schema で決まった形の JSON にする
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { wordLine } from "./words.js";
import { stageOf, headOf, callOf } from "./state.js";

export const DEFS = { said: fileURLToPath(new URL("../kakari/発言.md", import.meta.url)), session: fileURLToPath(new URL("../kakari/セッション.md", import.meta.url)) };
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

// 届け直せるものとして見せる、届けていない発言の数（新しいほうから）
const AGAIN = 5;

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
          body: { type: "string" },
          resend: { type: "array", items: { type: "integer" } },
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

const STAGE = { run: "実行中", wait: "人待ち", back: "帰った", done: "済み" };
// 係に見せる済みのセッションの数（新しく済んだほうから）
const DONE = 8;
const stageWord = (x) => { const g = stageOf(x); return STAGE[g.stage] + (g.none ? "（結果なし）" : ""); };
const shown = (p) => p?.fair ?? p?.text ?? "";
// 新しく起こせる役割（起きる場所が用意できているもの）
export const choosable = (roles) => Object.values(roles).filter((r) => r.place === "room");

// 係に渡す一通。batch：届け先を決める発言。context：その前の、届け先が決まった発言をいくつ添えるか
// again：届けていない発言のうち、届け直せるもの（人が「それは A に送って」と言ったときのため）
export function saidPrompt({ state, batch, again = [], roles, words = [], context = 5 }) {
  const said = (n) => state.said.find((p) => p.id === n);
  const first = Math.min(...batch.map((p) => p.id));
  const before = state.said.filter((p) => p.id < first && (p.session != null || p.aside)).slice(-context);
  const symOf = (sid) => { const x = state.sessions.find((y) => y.id === sid); return x ? callOf(x) : "?"; };
  const lastWords = (x) => x.last ?? x.flow.filter((f) => f.talk).at(-1)?.talk ?? "";
  const live = state.sessions.filter((x) => !x.folded);
  const done = state.sessions.filter((x) => x.folded).sort((a, b) => b.folded.seq - a.folded.seq).slice(0, DONE);
  return [
    "選べる役割：",
    ...choosable(roles).map((r) => `- ${r.name}：${r.about}`),
    "",
    "辞書：",
    ...(words.length ? words.map(wordLine) : ["（なし）"]),
    "",
    "いまのセッション：",
    ...(live.length
      ? live.map((x) => {
          const asked = x.asked.length ? clip(oneLine(shown(said(x.asked[0]))), 80) : "";
          const more = x.asked.length > 1 ? `（ほか ${x.asked.length - 1} 件。いちばん新しいもの：${clip(oneLine(shown(said(x.asked.at(-1)))), 60)}）` : "";
          const last = clip(oneLine(x.card?.line ?? headOf(lastWords(x))), 80);
          const ask = stageOf(x).stage === "wait" ? `　人への問い：${clip(oneLine(x.card.ask.text), 80)}` : "";
          return `- ${x.sym}「${x.name ?? x.role}」${x.role}・${stageWord(x)}。頼んだこと：${asked}${more}${last ? `　いまどこまで：${last}` : ""}${ask}`;
        })
      : ["（なし）"]),
    ...(done.length ? ["", "済みのセッション（話しかけられたら戻せる。新しく済んだ順）：", ...done.map((x) => `- ${callOf(x)}「${x.name ?? x.role}」${x.role}。${x.card?.what ? `${clip(oneLine(x.card.what), 40)}。` : ""}最後：${clip(oneLine(x.failed ? `結果なし（${x.failed}）` : x.card?.line ?? headOf(lastWords(x))), 60)}`)] : []),
    ...(before.length ? ["", "直前の発言：", ...before.map((p) => `- ${p.id}（${p.aside ? "届けていない" : `→ ${symOf(p.session)}`}）：${oneLine(shown(p))}`)] : []),
    ...(again.length ? ["", "届けていない発言（届け直せる）：", ...again.map((p) => `- ${p.id}：${oneLine(shown(p))}`)] : []),
    "",
    "新しい発言：",
    ...batch.map((p) => `- ${p.id}${p.peek != null ? `（${symOf(p.peek)} を覗いていた）` : ""}：${p.text}`),
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
    const first = batch[0].id;
    const again = this.log.state.said.filter((p) => p.aside && p.session == null && p.id < first).slice(-AGAIN);
    this.busy = true;
    for (const p of batch) this.reading.add(p.id);
    let res;
    try {
      res = await this.conv.send(saidPrompt({ state: this.log.state, batch, again, roles: this.roles, words: this.words?.list() ?? [] }));
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!this.stopped) {
      if (res.ok) this._apply(batch, res.json, again);
      else this.log.add("miss", { says: batch.map((p) => p.id), reason: `係が読めなかった：${res.error}` });
    }
    for (const p of batch) this.reading.delete(p.id);
    this.busy = false;
    if (this.again) {
      this.again = false;
      this.kick();
    }
  }

  // 返ったものを記録に置く：清書（変わったときだけ）→ 届け先。読めないもの・ありもしない届け先は miss にして、未定のまま残す。
  // 届けていない発言（again）を届け直すように言われたら、それも届け、言った発言に resend を置く
  _apply(batch, json, again = []) {
    const mine = new Map(batch.map((p) => [p.id, p])), back = new Map(again.map((p) => [p.id, p]));
    const items = Array.isArray(json?.says) ? json.says.filter((x) => x && (mine.has(x.id) || back.has(x.id))).sort((a, b) => a.id - b.id) : [];
    const done = new Set(), made = new Map(), missed = [], resent = [];
    const choices = new Set(choosable(this.roles).map((r) => r.name));
    for (const it of items) {
      if (done.has(it.id)) continue;
      done.add(it.id);
      const old = back.has(it.id), p = old ? back.get(it.id) : mine.get(it.id);
      // 届けていない発言は、届け直すときだけ扱う（届けないままなら何もしない）
      if (old && it.to !== "session" && it.to !== "new") continue;
      const text = typeof it.text === "string" ? it.text.trim() : "";
      if (!old && text && text !== p.text && text !== p.fair) this.log.add("fair", { said: p.id, text });
      // 届け直しの指示と頼みの中身がまじった発言は、中身（body）だけをセッションに渡す
      const body = !old && typeof it.body === "string" && it.body.trim() && it.body.trim() !== text ? { body: it.body.trim() } : {};
      let r = null;
      if (it.to === "none") {
        this.log.add("aside", { said: p.id });
        continue;
      } else if (it.to === "session") {
        // 出ているものは記号で、済みのものは #id で指す（済みに届けば戻る）
        const key = String(it.session ?? "").trim().toUpperCase();
        const x = this.log.state.sessions.find((s) => (s.folded ? `#${s.id}` : s.sym) === key);
        r = x ? this.sessions.ask(p.id, { session: x.id, ...body }) : { ok: false, message: `ありもしないセッション「${it.session ?? ""}」を返した` };
      } else if (it.to === "new") {
        const role = String(it.role ?? "").trim(), name = oneLine(it.name) || clip(oneLine(text || p.fair || p.text), 20);
        const key = `${role}\n${name}`;
        if (!choices.has(role)) r = { ok: false, message: `選べない役割「${role}」を返した` };
        else if (made.has(key)) r = this.sessions.ask(p.id, { session: made.get(key), ...body });
        else {
          r = this.sessions.ask(p.id, { role, name, ...body });
          if (r.ok) made.set(key, r.session);
        }
      } else {
        r = { ok: false, message: `届け先「${it.to}」がわからない` };
      }
      if (old) {
        if (r.ok) resent.push(p.id);
        continue; // 届け直せなかったものは、届けていないまま
      }
      if (!r.ok) missed.push([p.id, r.message]);
    }
    for (const p of batch) if (!done.has(p.id)) missed.push([p.id, "係が返さなかった"]);
    for (const [n, why] of missed) this.log.add("miss", { says: [n], reason: why });
    // 届け直した発言を、どの発言が言ったか：返した resend から。書いていなければ、この回のいちばん新しい発言に
    if (resent.length) {
      const by = new Map();
      for (const it of items) if (mine.has(it.id) && Array.isArray(it.resend)) for (const n of it.resend) if (resent.includes(n) && !by.has(n)) by.set(n, it.id);
      for (const n of resent) if (!by.has(n)) by.set(n, batch.at(-1).id);
      for (const who of new Set(by.values())) this.log.add("resend", { said: who, says: resent.filter((n) => by.get(n) === who) });
    }
    for (const w of Array.isArray(json?.words) ? json.words : []) this.words?.add({ by: "係", heard: w?.heard, write: w?.write, when: w?.when });
  }
}

// ── セッションを読む口 ──

export const VIEWS = ["summary", "list", "table", "text", "json"];
export const CARD_SCHEMA = {
  type: "object",
  properties: {
    line: { type: "string" },
    back: { type: "string" },
    what: { type: "string" },
    steps: { type: "array", items: { type: "object", properties: { text: { type: "string" }, state: { type: "string", enum: ["done", "now", "todo"] } }, required: ["text", "state"] } },
    ask: { type: "object", properties: { text: { type: "string" }, ref: { type: "integer" } }, required: ["text"] },
    panels: { type: "array", items: { type: "object", properties: { view: { type: "string", enum: VIEWS }, title: { type: "string" }, data: {} }, required: ["view", "data"] } },
  },
  required: ["line", "back"],
};

// 係に渡すやりとりの上限：一つの言葉の長さ、最後の言葉の長さ、並べる数
const TALK = 600, LAST = 4000, FLOW = 60;

// セッションの中で、行の ref に書ける通し番号：渡した発言の id と、言ったこと・道具の記録の通し番号
export const refsOf = (x) => new Set([...x.asked, ...x.flow.filter((f) => f.talk || f.tool).map((f) => f.seq)]);

// 係に渡す一通：セッション・頼んだこと・前のカード・前のカードのあとのやりとり・最後の言葉
export function sessionPrompt(state, x) {
  const said = (n) => state.said.find((p) => p.id === n);
  const since = x.card?.turn ?? 0;
  const flow = x.flow.filter((f) => f.seq > since).slice(-FLOW).map((f) =>
    f.said ? `- ${f.said} 人：${oneLine(shown(said(f.said)))}` : f.tool ? `- ${f.seq} 道具：${f.tool}` : `- ${f.seq} セッション：${clip(oneLine(f.talk), TALK)}`);
  const prev = x.card ? JSON.stringify({ line: x.card.line, what: x.card.what, steps: x.card.steps, ask: x.card.ask, panels: x.card.panels }) : "なし";
  return [
    `セッション：${callOf(x)}「${x.name ?? x.role}」（役割：${x.role}）`,
    "",
    "頼んだこと：",
    ...x.asked.map((n) => `- ${n}：${oneLine(shown(said(n)))}`),
    "",
    `前のカード：${prev}`,
    "",
    "前のカードのあとのやりとり：",
    ...(flow.length ? flow : ["（なし）"]),
    "",
    "最後の言葉：",
    clip(String(x.last ?? "（なし）"), LAST),
  ].join("\n");
}

const str = (v, n) => {
  const t = typeof v === "number" ? String(v) : typeof v === "string" ? oneLine(v) : "";
  return t ? clip(t, n) : "";
};
const arr = (v) => (Array.isArray(v) ? v : []);

// パネル一枚を確かめる。知らない view は、文字列なら text、ほかは json に落とす。ありもしない ref は外す。中身がなければ null
export function panelOf(p, refs) {
  if (!p || typeof p !== "object") return null;
  const ref = (r) => (Number.isInteger(r) && refs.has(r) ? { ref: r } : {});
  const title = str(p.title, 40);
  let view = VIEWS.includes(p.view) ? p.view : typeof p.data === "string" ? "text" : "json";
  let data = null;
  const d = p.data;
  if (view === "text") data = typeof d === "string" && d.trim() ? clip(d.trim(), 300) : null;
  if (view === "list") {
    data = arr(d).map((i) => (typeof i === "string" ? { text: str(i, 80) } : { text: str(i?.text, 80), ...(str(i?.value, 40) ? { value: str(i.value, 40) } : {}), ...ref(i?.ref) })).filter((i) => i.text).slice(0, 12);
  }
  if (view === "summary") {
    data = arr(d).map((i) => ({ label: str(i?.label, 40), value: str(i?.value, 40), ...ref(i?.ref) })).filter((i) => i.label && i.value).slice(0, 8);
  }
  if (view === "table") {
    const columns = arr(d?.columns).map((c) => str(c, 30)).filter(Boolean).slice(0, 6);
    const rows = arr(d?.rows).map((r) => (Array.isArray(r) ? { cells: r } : r)).map((r) => ({ cells: columns.map((_, k) => str(arr(r?.cells)[k], 40)), ...ref(r?.ref) })).filter((r) => r.cells.some(Boolean)).slice(0, 20);
    data = columns.length && rows.length ? { columns, rows } : null;
  }
  if (view === "json") data = d != null && JSON.stringify(d).length <= 4000 ? d : null;
  if (data == null || (Array.isArray(data) && !data.length)) return null;
  return { view, ...(title ? { title } : {}), data };
}

// 返ったカードを確かめる。きびしすぎて全部を落とさない：直せるものは直し、一行がなければ読めなかったことにする（null）
export function cardOf(json, x) {
  if (!json || typeof json !== "object") return null;
  const refs = refsOf(x);
  let line = str(json.line, 80), back = str(json.back, 160);
  line ||= back;
  back ||= line;
  if (!line) return null;
  const steps = arr(json.steps).map((s) => ({ text: str(s?.text, 60), state: ["done", "now", "todo"].includes(s?.state) ? s.state : "todo" })).filter((s) => s.text).slice(0, 10);
  const askText = str(json.ask?.text, 160);
  const ask = askText ? { text: askText, ref: Number.isInteger(json.ask.ref) && refs.has(json.ask.ref) ? json.ask.ref : null } : null;
  const panels = arr(json.panels).map((p) => panelOf(p, refs)).filter(Boolean).slice(0, 3);
  return { line, back, what: str(json.what, 80) || x.card?.what || null, steps, ask, panels };
}

export class SessionMouth {
  constructor({ log, conv }) {
    Object.assign(this, { log, conv });
    this.reading = new Set();
    this.busy = false;
    this.again = false;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.off = this.log.on((r) => r.kind === "end" && this.kick());
    this.kick();
    return this;
  }

  stop() {
    this.stopped = true;
    this.off?.();
    clearTimeout(this.timer);
    this.conv.kill?.();
  }

  // 読むもの：ターンが終わって止まっていて、まだ読んでいないセッション。終わった順に。
  // すぐ次のターンが始まったもの（待たせていた発言があった）は読まず、次に止まったときにまとめて読む。結果なしは読まない
  _due() {
    return this.log.state.sessions
      .filter((x) => !x.running && !x.failed && x.turn != null && x.read !== x.turn && !this.reading.has(x.id))
      .sort((a, b) => a.turn - b.turn);
  }

  kick() {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.read(), 0);
  }

  async read() {
    this.timer = null;
    const x = this._due()[0];
    if (this.stopped || !x) return;
    this.busy = true;
    this.reading.add(x.id);
    const turn = x.turn;
    let res;
    try {
      res = await this.conv.send(sessionPrompt(this.log.state, x));
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!this.stopped) {
      const cur = this.log.state.sessions.find((s) => s.id === x.id);
      const card = res.ok ? cardOf(res.json, cur) : null;
      if (card) this.log.add("card", { session: x.id, turn, ...card });
      else this.log.add("nocard", { session: x.id, turn, reason: res.ok ? "係の返したカードが読めない" : `係が読めなかった：${res.error}` });
    }
    this.reading.delete(x.id);
    this.busy = false;
    this.again = false;
    this.kick(); // 読んでいるあいだに止まったほかのセッションを、順に
  }
}

// ── 畳む ──
// 決まり（仮）：帰ったセッションは、帰ったあとに置かれた発言が別のセッションに届いたら、済みに畳む。
// 人待ち・実行中・待たせている発言があるものは畳まない。どこにも届けない発言、帰る前に置かれた発言、届け直された前の発言では畳まない。
// いまの決まりは読まなくても決まるので、Claude Code を呼ばずにこの部品が畳み、記録に置く（あとで決まりを変えても、前に畳んだものは変わらない）
export function toFold(state, pass) {
  const p = state.said.find((q) => q.id === pass.said);
  if (!p || p.again) return [];
  return state.sessions.filter((x) => x.id !== pass.session && !x.folded && stageOf(x).stage === "back" && !x.pending.length && x.backAt != null && p.id > x.backAt);
}

export class Folder {
  constructor({ log }) {
    this.log = log;
  }

  start() {
    // 渡したあとの続き（ターンの始まり）を先に置かせてから畳む
    this.off = this.log.on((r) => r.kind === "pass" && queueMicrotask(() => {
      if (this.stopped) return;
      for (const x of toFold(this.log.state, r)) this.log.add("fold", { session: x.id, by: r.said });
    }));
    return this;
  }

  stop() {
    this.stopped = true;
    this.off?.();
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
