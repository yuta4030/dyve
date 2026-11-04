// ボード：操作ログを正とし、頭から当て直してパネルの並びを作る。
// 操作は add・edit・drop の三つだけ。人も AI もここを通る。

export const PEOPLE = new Set(["human"]);
export const isPerson = (by) => PEOPLE.has(by);

export const STATES = ["task", "proposal", "done"];
export const CODES = {
  pinned: "人がピン留めしている",
  forbidden: "この立場ではできない",
  not_found: "そのパネルはない",
  conflict: "あいだに別の変更が入った",
  invalid: "操作の形が正しくない",
};
const FIELDS = ["view", "data", "about", "state", "pinned", "source", "to", "into"];
// into：清書係が一つの考えにまとめた発言の合流先。元の発言は消さず、印を外せば分け直せる
// view layout：タイルの置き場所を持つパネル。ボードに一枚だけで、固定（locked）は人だけが決める
// to：人が状況のアイコンで宛てた相手（控室のエージェントの名前）。宛てた発言はボードがそのまま相手に渡す
const badTo = (to) => (to == null || (typeof to === "string" && to.trim() && to.length <= 40) ? null : "to は相手の名前");

// source：データを shell コマンドの結果から流し込む（{ shell, every? }。every は秒、なければ一度だけ）。
// 走らせてよいかは人が決める：人が置いたか、人が置き直した（＝許可した）ときだけ走る。AI が変えたら許可は外れる
function badSource(src) {
  if (src == null) return null;
  if (typeof src !== "object" || Array.isArray(src)) return "source は { shell, every? }";
  if (typeof src.shell !== "string" || !src.shell.trim() || src.shell.length > 2000) return "source.shell はコマンドの文字列";
  if (src.every != null && !(Number.isFinite(src.every) && src.every >= 5)) return "source.every は 5 秒以上";
  return null;
}
export function sourceApproved(board, id) {
  let ok = false;
  for (const op of board.history(id)) if ("source" in op.panel) ok = isPerson(op.by) && op.panel.source != null;
  return ok;
}

// タイルの名前からパネルの id：g:<ボード>/<id> か panel:<id>
export const panelOfKey = (k) => (k.startsWith("g:") ? k.slice(k.lastIndexOf("/") + 1) : k.startsWith("panel:") ? k.slice(6) : null);
const tileLocked = (data, id) => (data.locked || []).some((k) => panelOfKey(k) === id);
// 固定：人が固定したタイルと、ピン留めしたパネル。その中のものも動かない
export function fixedTile(panels, data, k) {
  if ((data.locked || []).includes(k)) return true;
  return fixedPanel(panels, data, panelOfKey(k));
}
export function fixedPanel(panels, data, id) {
  const seen = new Set();
  for (let p = panels.get(id); p && !seen.has(p.id); p = panels.get(p.about)) {
    seen.add(p.id);
    if (p.pinned || tileLocked(data, p.id)) return true;
  }
  return false;
}
const has = (list, k) => (list || []).includes(k);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// AI は固定されたものを変えられず、固定そのものも変えられない（そのほかの見た目はいつでも変えてよい）
function badLayoutEdit(cur, body, panels) {
  if (Object.keys(body).some((k) => k !== "id" && k !== "data")) return { code: "forbidden", message: "置き場所のパネルで変えられるのは data だけ" };
  const old = cur.data || {}, next = body.data || {};
  if (!same(next.locked || [], old.locked || [])) return { code: "forbidden", message: "固定は人だけ" };
  const keys = new Set([...Object.keys(old.pos || {}), ...Object.keys(next.pos || {}), ...(old.extra || []), ...(next.extra || [])]);
  for (const k of keys) {
    if (!fixedTile(panels, old, k)) continue;
    const moved = !same(old.pos?.[k], next.pos?.[k]) || !same(old.zoom?.[k], next.zoom?.[k]);
    if (moved || has(old.min, k) !== has(next.min, k) || has(old.hidden, k) !== has(next.hidden, k) || has(old.extra, k) !== has(next.extra, k)) return { code: "pinned", message: `${k} は人が固定している` };
  }
  const a = old.inner || {}, z = next.inner || {};
  for (const f of ["tpos", "sizes"]) for (const id of new Set([...Object.keys(a[f] || {}), ...Object.keys(z[f] || {})])) if (fixedPanel(panels, old, id) && !same(a[f]?.[id], z[f]?.[id])) return { code: "pinned", message: `${id} は人が固定している` };
  for (const f of ["min", "unfold"]) for (const id of new Set([...(a[f] || []), ...(z[f] || [])])) if (fixedPanel(panels, old, id) && has(a[f], id) !== has(z[f], id)) return { code: "pinned", message: `${id} は人が固定している` };
  return null;
}

const refuse = (code, message) => ({ ok: false, code, message: message || CODES[code] });

export class Board {
  constructor(log = []) {
    this.panels = new Map(); // id -> panel（並びは追加順）
    this.log = [];
    for (const op of log) this._commit(op);
  }

  get seq() {
    return this.log.length ? this.log.at(-1).seq : 0;
  }

  list() {
    return [...this.panels.values()];
  }

  get(id) {
    return this.panels.get(id);
  }

  history(id) {
    return this.log.filter((op) => op.panel.id === id);
  }

  // 操作を確かめてから積む。返り値は { ok, op } か { ok:false, code, message }
  apply({ by, type, panel, reason } = {}, now = new Date()) {
    if (typeof by !== "string" || !by) return refuse("invalid", "by がない");
    const person = isPerson(by);
    if (!person && !(typeof reason === "string" && reason.trim())) return refuse("invalid", "AI の操作は reason を持つ");
    if (!panel || typeof panel !== "object") return refuse("invalid", "panel がない");

    let body;
    if (type === "add") {
      if (typeof panel.view !== "string" || !panel.view) return refuse("invalid", "view がない");
      if (panel.view === "layout" && !person) return refuse("forbidden", "置き場所のパネルは画面が作る");
      if (panel.view === "layout" && this.list().some((p) => p.view === "layout")) return refuse("invalid", "置き場所のパネルは一枚だけ");
      body = { id: this._newId(), by, view: panel.view, data: panel.data ?? null, pinned: false };
      if (panel.about != null) {
        if (!this.panels.has(panel.about)) return refuse("not_found", `about のパネル ${panel.about} がない`);
        body.about = panel.about;
      }
      if (panel.state != null) {
        if (!STATES.includes(panel.state)) return refuse("invalid", `state は ${STATES.join("・")} のどれか`);
        body.state = panel.state;
      }
      if (panel.pinned) {
        if (!person) return refuse("forbidden", "ピン留めは人だけ");
        body.pinned = true;
      }
      if (panel.source != null) {
        const bad = badSource(panel.source);
        if (bad) return refuse("invalid", bad);
        body.source = panel.source;
      }
      if (panel.to != null) {
        if (badTo(panel.to)) return refuse("invalid", badTo(panel.to));
        body.to = panel.to;
      }
    } else if (type === "edit" || type === "drop") {
      const cur = this.panels.get(panel.id);
      if (!cur) return refuse("not_found");
      if (panel.rev != null && panel.rev !== cur.rev) return refuse("conflict");
      if (type === "drop") {
        if (!person && cur.pinned) return refuse("pinned");
        if (!person && isPerson(cur.by)) return refuse("forbidden", "人が置いたパネルは人だけが外せる");
        body = { id: cur.id };
      } else {
        body = { id: cur.id };
        for (const k of FIELDS) if (k in panel) body[k] = panel[k];
        if (Object.keys(body).length === 1) return refuse("invalid", "変えるものがない");
        if (!person && cur.pinned) return refuse("pinned");
        if (!person && cur.view === "layout") {
          const bad = badLayoutEdit(cur, body, this.panels);
          if (bad) return refuse(bad.code, bad.message);
        }
        if ("into" in body && body.into != null) {
          const bad = this._badInto(cur, body.into, person);
          if (bad) return bad;
        }
        if ("pinned" in body) {
          if (!person) return refuse("forbidden", "ピン留めは人だけ");
          body.pinned = !!body.pinned;
        }
        if ("view" in body && (typeof body.view !== "string" || !body.view)) return refuse("invalid", "view がない");
        if ("source" in body && badSource(body.source)) return refuse("invalid", badSource(body.source));
        if ("to" in body && badTo(body.to)) return refuse("invalid", badTo(body.to));
        if ("state" in body && body.state != null && !STATES.includes(body.state)) return refuse("invalid", `state は ${STATES.join("・")} のどれか`);
        if ("state" in body && cur.state === "proposal" && body.state !== "proposal" && !person) return refuse("forbidden", "提案を受け入れるのは人だけ");
        if ("about" in body && body.about != null) {
          if (!this.panels.has(body.about)) return refuse("not_found", `about のパネル ${body.about} がない`);
          if (this._wouldLoop(cur.id, body.about)) return refuse("invalid", "about が輪になる");
        }
      }
    } else {
      return refuse("invalid", "type は add・edit・drop のどれか");
    }

    const op = { seq: this.seq + 1, at: now.toISOString(), by, type, panel: body };
    if (reason) op.reason = reason;
    this._commit(op);
    return { ok: true, op };
  }

  _newId() {
    // 一度振ったら変えない。ログの長さから作るので当て直しても同じになる
    return "p" + (this.seq + 1).toString(36);
  }

  _badInto(cur, into, person) {
    const head = this.panels.get(into);
    if (!head) return refuse("not_found", `合流先のパネル ${into} がない`);
    if (cur.view !== "say" || head.view !== "say") return refuse("invalid", "合流できるのは発言だけ");
    if (head.id === cur.id || head.into || this.list().some((p) => p.into === cur.id)) return refuse("invalid", "合流は一段だけ");
    if (!person && head.pinned) return refuse("pinned");
    if (!person && (cur.to || head.to)) return refuse("invalid", "宛てた発言は合流しない");
    return null;
  }

  _wouldLoop(id, about) {
    for (let cur = about; cur; cur = this.panels.get(cur)?.about) if (cur === id) return true;
    return false;
  }

  _commit(op) {
    const p = op.panel;
    if (op.type === "add") {
      this.panels.set(p.id, { ...p, at: op.at, seq: op.seq, rev: op.seq, ...(isPerson(op.by) ? {} : { aiSeq: op.seq }) });
    } else if (op.type === "edit") {
      const cur = this.panels.get(p.id);
      const next = { ...cur, ...p, rev: op.seq };
      if (next.about == null) delete next.about;
      if (next.state == null) delete next.state;
      if (next.source == null) delete next.source;
      if (next.to == null) delete next.to;
      if (next.into == null) delete next.into;
      if (!isPerson(op.by)) next.aiSeq = op.seq;
      this.panels.set(p.id, next);
    } else if (op.type === "drop") {
      this.panels.delete(p.id);
    }
    this.log.push(op);
  }
}

// 印はデータに持たず導く。知らせは人が最後に見た位置に依るので画面で導く（aiSeq を使う）
export function marks(board, { running = [] } = {}) {
  const busy = new Set(running);
  const out = {};
  for (const p of board.list()) {
    if (p.state === "proposal" || (p.source && !sourceApproved(board, p.id))) out[p.id] = "waiting";
    else if (p.state === "task" && !busy.has(p.id) && !hasAiAnswer(board, p.id)) out[p.id] = "untouched";
  }
  return out;
}

// 結果が付いたか：人でも清書係でもマネージャでもボード自身でもない者（タスクエージェント）が about に置いたか
export const STAFF = new Set(["scribe", "manager", "board"]);
export function hasAiAnswer(board, id) {
  return board.list().some((q) => q.about === id && !isPerson(q.by) && !STAFF.has(q.by));
}
