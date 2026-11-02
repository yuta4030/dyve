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
const FIELDS = ["view", "data", "about", "state", "pinned"];

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
        if ("pinned" in body) {
          if (!person) return refuse("forbidden", "ピン留めは人だけ");
          body.pinned = !!body.pinned;
        }
        if ("view" in body && (typeof body.view !== "string" || !body.view)) return refuse("invalid", "view がない");
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
    if (p.state === "proposal") out[p.id] = "waiting";
    else if (p.state === "task" && !busy.has(p.id) && !hasAiAnswer(board, p.id)) out[p.id] = "untouched";
  }
  return out;
}

// 結果が付いたか：人でもマネージャでもボード自身でもない者（タスクエージェント）が about に置いたか
export const STAFF = new Set(["manager", "board"]);
export function hasAiAnswer(board, id) {
  return board.list().some((q) => q.about === id && !isPerson(q.by) && !STAFF.has(q.by));
}
