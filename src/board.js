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
const FIELDS = ["view", "data", "about", "state", "pinned", "source", "send", "to", "into", "rel"];
// into：清書係が一つの考えにまとめた発言の合流先。元の発言は消さず、印を外せば分け直せる
// view layout：画面の並びを持つパネル。ボードに一枚だけで、並びのピン留め（pinned）は人だけが決める
// to：人が状況のアイコンで宛てた相手（控室のエージェントの名前）。宛てた発言はボードがそのまま相手に渡す
const badTo = (to) => (to == null || (typeof to === "string" && to.trim() && to.length <= 40) ? null : "to は相手の名前");
// rel：置く人が付ける、ほかのパネルとの関係。compare（比べる）・sequence（順番。並びは置いた順）。画面は組を横に並べる。
// with は同じものについてのパネル（about が同じ）だけ
export const RELS = ["compare", "sequence"];
function badRel(rel, about, panels, self = null) {
  if (rel == null) return null;
  if (typeof rel !== "object" || Array.isArray(rel) || !RELS.includes(rel.kind)) return `rel は { kind: ${RELS.join("|")}, with: [id] }`;
  if (!Array.isArray(rel.with) || !rel.with.length || rel.with.length > 8 || rel.with.some((x) => typeof x !== "string")) return "rel.with はパネルの id の配列（8 まで）";
  for (const id of rel.with) {
    const p = panels.get(id);
    if (!p || id === self) return `rel.with のパネル ${id} がない`;
    if ((p.about ?? null) !== (about ?? null)) return `rel.with のパネル ${id} は、同じものについてのパネルではない`;
  }
  return null;
}

// source：データを shell コマンドの結果から流し込む（{ shell, every? }。every は秒、なければ一度だけ）。
// 走らせてよいかは人が決める：人が置いたか、人が置き直した（＝許可した）ときだけ走る。AI が変えたら許可は外れる
function badSource(src) {
  if (src == null) return null;
  if (typeof src !== "object" || Array.isArray(src)) return "source は { shell, every? }";
  if (typeof src.shell !== "string" || !src.shell.trim() || src.shell.length > 2000) return "source.shell はコマンドの文字列";
  if (src.every != null && !(Number.isFinite(src.every) && src.every >= 5)) return "source.every は 5 秒以上";
  return null;
}
// send：パネルから外へ送り出す（{ shell, label? }）。人が画面で「送る」を押すと、入力を標準入力に渡して shell コマンドを走らせる。
// source（入ってくる向き）と対になる出口。許可の決まりは source と同じで、走らせるのは人だけ（MCP に口はない）
function badSend(send) {
  if (send == null) return null;
  if (typeof send !== "object" || Array.isArray(send)) return "send は { shell, label? }";
  if (typeof send.shell !== "string" || !send.shell.trim() || send.shell.length > 2000) return "send.shell はコマンドの文字列";
  if (send.label != null && !(typeof send.label === "string" && send.label.trim() && send.label.length <= 40)) return "send.label は 40 字までの文字列";
  return null;
}
// コマンド（source・send）を走らせてよいか：最後にその項目を置いたのが人のときだけ
function approved(board, id, field) {
  let ok = false;
  for (const op of board.history(id)) if (field in op.panel) ok = isPerson(op.by) && op.panel[field] != null;
  return ok;
}
export const sourceApproved = (board, id) => approved(board, id, "source");
export const sendApproved = (board, id) => approved(board, id, "send");

// 並び（view layout のパネルの data）。画面に並ぶパネルの key は、組み込みのパネルの名前か、パネルの id
// { v: 3, density, metric, pos: { key: {x,y,w,h} }, zoom: { key }, fold: { key: true|false }, out: [取り出したパネルの id], pinned: [ピン留めした key], inner: { tpos, sizes } }
// pos は置き場所を決めたもの（組み込みのパネルと、人か AI が動かしたもの）だけ。ほかは画面が並べるたびに、順番と中身から置き直す（自動の並び）
// pinned に入るのは、ボードのパネルでピン留めできないもの（組み込みのパネルと、発言から出たまとまり）だけ。ほかはパネルの pinned を使う
export const BUILTIN = ["talk", "summary", "status", "quota", "tools"];
// 浮かせる組み込みのパネルと浮かせ方（先頭の front が既定）。front：画面に留めて重ねる、off：ます目に並べる
export const FLOATS = ["talk", "status", "quota", "tools"];
export const FLOAT_MODES = ["front", "off"];
export function layoutOf(data, panels = null) {
  const d = data || {};
  if (d.v === 3) return d;
  // v 2 はまとまりの置き場所を全部覚えていた。組み込みのパネルとピン留めしたものだけ残し、ほかは自動の並びにする
  if (d.v === 2) {
    const keep = (k) => BUILTIN.includes(k) || (d.pinned || []).includes(k) || (panels && fixedPanel(panels, d, k));
    return { ...d, v: 3, pos: Object.fromEntries(Object.entries(d.pos || {}).filter(([k]) => keep(k))) };
  }
  // もっと古い形は読み替えない。組み込みのパネルの置き場所と拡大率、話題の中の置き場所だけ引き継ぐ
  const own = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => BUILTIN.includes(k)));
  return { v: 3, ...(d.density ? { density: d.density } : {}), ...(d.metric ? { metric: d.metric } : {}), pos: own(d.pos), zoom: own(d.zoom), fold: {}, out: [], pinned: [], inner: { tpos: d.inner?.tpos || {}, sizes: d.inner?.sizes || {} } };
}
// ピン留め：その key か、そのパネルか、たどった上のどれかがピン留めされていれば、AI は動かせない
export function fixedPanel(panels, data, id) {
  const seen = new Set();
  for (let p = panels.get(id); p && !seen.has(p.id); p = panels.get(p.about)) {
    seen.add(p.id);
    if (p.pinned || (data.pinned || []).includes(p.id)) return true;
  }
  return false;
}
export const fixedTile = (panels, data, k) => (data.pinned || []).includes(k) || fixedPanel(panels, data, k);
const has = (list, k) => (list || []).includes(k);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// AI はピン留めされたものの見た目を変えられず、並びのピン留めそのものも変えられない（そのほかの見た目はいつでも変えてよい）
function badLayoutEdit(cur, body, panels) {
  if (Object.keys(body).some((k) => k !== "id" && k !== "data")) return { code: "forbidden", message: "並びのパネルで変えられるのは data だけ" };
  const old = layoutOf(cur.data, panels), next = body.data || {};
  if (next.v !== 3) return { code: "invalid", message: "並びの data は v: 3 の形" };
  if (!same(next.pinned || [], old.pinned || [])) return { code: "forbidden", message: "ピン留めは人だけ" };
  const a = old.inner || {}, z = next.inner || {};
  const fa = old.float || {}, fz = next.float || {};
  if ((fa.mode ?? FLOAT_MODES[0]) !== (fz.mode ?? FLOAT_MODES[0]) && FLOATS.some((k) => fixedTile(panels, old, k))) return { code: "pinned", message: "浮かせるパネルを人がピン留めしているので、浮かせ方は変えられない" };
  const keys = new Set([old.pos, next.pos, old.zoom, next.zoom, old.fold, next.fold, a.tpos, z.tpos, a.sizes, z.sizes, fa.pos, fz.pos, fa.zoom, fz.zoom].flatMap((o) => Object.keys(o || {})).concat(old.out || [], next.out || []));
  for (const k of keys) {
    if (!fixedTile(panels, old, k)) continue;
    const changed = ["pos", "zoom", "fold"].some((f) => !same(old[f]?.[k], next[f]?.[k])) || ["tpos", "sizes"].some((f) => !same(a[f]?.[k], z[f]?.[k])) || ["pos", "zoom"].some((f) => !same(fa[f]?.[k], fz[f]?.[k])) || has(old.out, k) !== has(next.out, k);
    if (changed) return { code: "pinned", message: `${k} は人がピン留めしている` };
  }
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
      if (panel.view === "layout" && !person) return refuse("forbidden", "並びのパネルは画面が作る");
      if (panel.view === "layout" && this.list().some((p) => p.view === "layout")) return refuse("invalid", "並びのパネルは一枚だけ");
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
      if (panel.send != null) {
        const bad = badSend(panel.send);
        if (bad) return refuse("invalid", bad);
        body.send = panel.send;
      }
      if (panel.to != null) {
        if (badTo(panel.to)) return refuse("invalid", badTo(panel.to));
        body.to = panel.to;
      }
      if (panel.rel != null) {
        const bad = badRel(panel.rel, body.about, this.panels);
        if (bad) return refuse(/がない/.test(bad) ? "not_found" : "invalid", bad);
        body.rel = { kind: panel.rel.kind, with: [...panel.rel.with] };
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
        if ("send" in body && badSend(body.send)) return refuse("invalid", badSend(body.send));
        if ("to" in body && badTo(body.to)) return refuse("invalid", badTo(body.to));
        if ("rel" in body) {
          const bad = badRel(body.rel, "about" in body ? body.about : cur.about, this.panels, cur.id);
          if (bad) return refuse(/がない/.test(bad) ? "not_found" : "invalid", bad);
        }
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
      if (next.send == null) delete next.send;
      if (next.to == null) delete next.to;
      if (next.into == null) delete next.into;
      if (next.rel == null) delete next.rel;
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
    if (p.state === "proposal" || (p.source && !sourceApproved(board, p.id)) || (p.send && !sendApproved(board, p.id))) out[p.id] = "waiting";
    else if (p.state === "task" && !busy.has(p.id) && !hasAiAnswer(board, p.id)) out[p.id] = "untouched";
  }
  return out;
}

// 結果が付いたか：人でも清書係でもマネージャでもボード自身でもない者（タスクエージェント）が about に置いたか
export const STAFF = new Set(["scribe", "manager", "board"]);
export function hasAiAnswer(board, id) {
  return board.list().some((q) => q.about === id && !isPerson(q.by) && !STAFF.has(q.by));
}
