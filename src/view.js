// エージェントがボードを絵で見るための口。置き場所は view layout のパネルに一枚で持つ（画面が作る）。
// board_view はタイルの枠と番号の PNG と対応表（依存ゼロなので日本語は描かず、題名は対応表に出す）
import zlib from "node:zlib";
import { fixedTile, fixedPanel, panelOfKey } from "./board.js";

const BUILTIN = { talk: "トーク", summary: "いまの要点", status: "状況", quota: "残量", tools: "dyve 設定" };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (d) => (typeof d === "string" ? d : d?.title ?? d?.text ?? JSON.stringify(d) ?? "");

export const layoutPanel = (board) => board.list().find((p) => p.view === "layout") ?? null;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const DENSITIES = [12, 24, 48];
const ZOOM_MIN = 0.1, ZOOM_MAX = 5;

function titleOf(board, k) {
  if (BUILTIN[k]) return BUILTIN[k];
  const p = board.get(panelOfKey(k));
  return p ? clip(textOf(p.data), 60) : k;
}

// 対応表：番号は n。x・y はます目（y は下へ増える）。fixed は動かせない。panels は話題の中のパネル（x・y・w・h は話題の中のます目、なければ自動）
export function legend(board) {
  const lp = layoutPanel(board);
  if (!lp) return null;
  const d = lp.data || {}, inner = d.inner || {};
  const tiles = Object.entries(d.pos || {}).map(([key, p], i) => ({
    n: i + 1, key, title: titleOf(board, key), ...p,
    ...(d.zoom?.[key] ? { zoom: d.zoom[key] } : {}),
    ...(fixedTile(board.panels, d, key) ? { fixed: true } : {}),
    ...((d.min || []).includes(key) ? { min: true } : {}),
    ...((d.hidden || []).includes(key) ? { hidden: true } : {}),
  }));
  const panels = board.list().filter((p) => p.view !== "layout" && p.view !== "say" && p.view !== "summary").map((p) => ({
    id: p.id, view: p.view, title: clip(textOf(p.data), 40), ...(p.about ? { about: p.about } : {}), ...(p.state ? { state: p.state } : {}),
    ...(inner.tpos?.[p.id] ? { at: inner.tpos[p.id] } : {}), ...(inner.sizes?.[p.id] ? { size: inner.sizes[p.id] } : {}),
    ...((inner.min || []).includes(p.id) ? { min: true } : {}), ...((inner.unfold || []).includes(p.id) ? { unfold: true } : {}),
    ...(fixedPanel(board.panels, d, p.id) ? { fixed: true } : {}),
  }));
  return { density: d.density ?? 24, screen: { cols: d.density ?? 24, rows: d.metric?.rows ?? null }, metric: d.metric ?? null, tiles, panels };
}

// 人が画面でできる見た目の操作を全部（固定は人だけなので、ない）。できなかったものは refused で返し、できたものだけ置く
export function changeLayout(store, by, change, reason) {
  const board = store.board, lp = layoutPanel(board);
  if (!lp) return { ok: false, code: "not_found", message: "置き場所がまだない（画面が一度も開かれていない）" };
  if (!change || typeof change !== "object" || !Object.keys(change).length) return { ok: false, code: "invalid", message: "変えるものがない" };
  const old = lp.data || {}, inner = old.inner || {};
  const d = { ...old, pos: { ...old.pos }, zoom: { ...old.zoom }, min: [...(old.min || [])], hidden: [...(old.hidden || [])], extra: [...(old.extra || [])] };
  const t = { tpos: { ...inner.tpos }, sizes: { ...inner.sizes }, min: new Set(inner.min || []), unfold: new Set(inner.unfold || []) };
  const done = [], refused = [];
  const no = (key, why) => refused.push({ key, why });
  const fixT = (k) => fixedTile(board.panels, old, k), fixP = (id) => fixedPanel(board.panels, old, id);
  const tile = (k) => { if (!d.pos[k]) no(k, "そのタイルはない"); else if (fixT(k)) no(k, "人が固定している"); else return true; return false; };
  const toggle = (arr, k, on) => (on ? [...new Set([...arr, k])] : arr.filter((x) => x !== k));

  // 並びを戻す（固定したものは残す）。置き場所のないタイルは画面が決まった場所へ置く
  if (change.reset) {
    if (old.locked?.length || Object.keys(d.pos).some(fixT)) no("reset", "固定したものがあるので、固定のないタイルだけ戻す");
    for (const k of Object.keys(d.pos)) if (!fixT(k)) { delete d.pos[k]; delete d.zoom[k]; d.min = toggle(d.min, k, false); d.hidden = toggle(d.hidden, k, false); d.extra = toggle(d.extra, k, false); }
    done.push("reset");
  }
  // ます目の細かさ：見た目の大きさを保つように全部を同じ割合で直す。固定したものがあると変えられない
  if (change.density != null) {
    const fixedAny = Object.keys(d.pos).some(fixT) || board.list().some((p) => t.tpos[p.id] && fixP(p.id));
    if (!DENSITIES.includes(change.density)) no("density", `density は ${DENSITIES.join("・")} のどれか`);
    else if (fixedAny) no("density", "固定したものがあると変えられない");
    else if (change.density !== (old.density ?? 24)) {
      const r = change.density / (old.density ?? 24);
      const scale = (p) => ({ x: Math.round((p.x - 1) * r) + 1, y: Math.round((p.y - 1) * r) + 1, w: Math.max(2, Math.round(p.w * r)), h: Math.max(2, Math.round(p.h * r)) });
      for (const k of Object.keys(d.pos)) d.pos[k] = scale(d.pos[k]);
      for (const [id, p] of Object.entries(t.tpos)) {
        const s = scale({ ...p, h: p.h || 2 });
        t.tpos[id] = { x: Math.max(1, s.x), y: Math.max(1, s.y), w: s.w, ...(p.h ? { h: s.h } : {}) };
      }
      d.density = change.density;
      done.push("density");
    }
  }
  // パネルをタイルに出す・なくす
  for (const id of change.tiles?.add || []) {
    const p = board.get(id), k = `panel:${id}`;
    if (!p || p.view === "say" || p.view === "layout") no(k, "タイルに出せるパネルではない");
    else if (!p.about) no(k, "話題や群はもうタイルになっている");
    else if (fixP(id)) no(k, "人が固定している");
    else {
      const bottom = Math.max(1, ...Object.values(d.pos).map((q) => q.y + q.h));
      if (!d.extra.includes(k)) { d.extra.push(k); d.pos[k] = { x: 1, y: bottom, w: 8, h: 8 }; done.push(k); }
    }
  }
  for (const k of change.tiles?.remove || []) {
    if (!d.extra.includes(k)) no(k, "パネルから出したタイルではない");
    else if (fixT(k)) no(k, "人が固定している");
    else { d.extra = d.extra.filter((x) => x !== k); delete d.pos[k]; done.push(k); }
  }
  // 動かす・大きさ
  for (const [k, m] of Object.entries(change.moves || {})) {
    if (!tile(k)) continue;
    const next = { ...d.pos[k], ...m };
    if (!["x", "y", "w", "h"].every((f) => Number.isInteger(next[f])) || next.w < 2 || next.h < 2) { no(k, "x・y は整数、w・h は 2 以上の整数"); continue; }
    d.pos[k] = { x: next.x, y: next.y, w: next.w, h: next.h };
    done.push(k);
  }
  for (const [k, on] of Object.entries(change.min || {})) if (tile(k)) { d.min = toggle(d.min, k, !!on); done.push(k); }
  // 閉じる・開き直す（dyve 設定は閉じられない）
  for (const [k, on] of Object.entries(change.hidden || {})) {
    if (k === "tools") no(k, "dyve 設定は閉じられない");
    else if (tile(k)) { d.hidden = toggle(d.hidden, k, !!on); done.push(k); }
  }
  for (const [k, z] of Object.entries(change.zoom || {})) {
    if (!tile(k)) continue;
    if (!(z >= ZOOM_MIN && z <= ZOOM_MAX)) { no(k, `zoom は ${ZOOM_MIN} から ${ZOOM_MAX}`); continue; }
    d.zoom[k] = z;
    done.push(k);
  }
  // 話題の中のパネル
  for (const [id, c] of Object.entries(change.panels || {})) {
    const p = board.get(id);
    if (!p || p.view === "layout") { no(id, "そのパネルはない"); continue; }
    if (fixP(id)) { no(id, "人が固定している"); continue; }
    if (["x", "y", "w", "h"].some((f) => f in c)) {
      const next = { ...t.tpos[id], ...Object.fromEntries(["x", "y", "w", "h"].filter((f) => f in c).map((f) => [f, c[f]])) };
      if (next.h == null) delete next.h;
      const okH = next.h === undefined || (Number.isInteger(next.h) && next.h >= 2);
      if (!["x", "y", "w"].every((f) => Number.isInteger(next[f])) || next.x < 1 || next.y < 1 || next.w < 2 || !okH) { no(id, "x・y・w は整数（x・y は 1 以上、w は 2 以上）、h は 2 以上の整数か null（中身の高さ）"); continue; }
      t.tpos[id] = next;
    }
    if (c.position === null) delete t.tpos[id];
    if (c.size === null) delete t.sizes[id];
    else if (Array.isArray(c.size) && c.size.length === 2 && c.size.every((n) => Number.isFinite(n) && n > 0)) t.sizes[id] = c.size;
    if ("min" in c) { if (p.view === "say" || p.view === "summary") { no(id, "この種類は最小化できない"); continue; } if (c.min) t.min.add(id); else t.min.delete(id); }
    if ("unfold" in c) { if (c.unfold) t.unfold.add(id); else t.unfold.delete(id); }
    done.push(id);
  }
  if (!done.length) return { ok: false, code: refused.some((x) => /固定/.test(x.why)) ? "pinned" : "invalid", message: "変えられるものがなかった", refused };
  const data = { ...d, inner: { tpos: t.tpos, sizes: t.sizes, min: [...t.min], unfold: [...t.unfold] } };
  const r = store.apply({ by, type: "edit", panel: { id: lp.id, data }, reason });
  if (!r.ok) return { ...r, refused };
  const shown = Object.keys(d.pos).filter((k) => !d.hidden.includes(k));
  const overlaps = shown.flatMap((a, i) => shown.slice(i + 1).filter((z) => overlap(d.pos[a], d.pos[z])).map((z) => [a, z]));
  return { ok: true, seq: r.op.seq, changed: [...new Set(done)], refused, overlaps };
}

// ── PNG（依存ゼロ）──
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const DIGITS = ["01110100011001110101110011000101110", "00100011000010000100001000010001110", "01110100010000100010001000100011111", "11111000100010000010000011000101110", "00010001100101010010111110001000010", "11111100001111000001000011000101110", "00110010001000011110100011000101110", "11111000010001000100010000100001000", "01110100011000101110100011000101110", "01110100011000101111000010001001100"];

const COLOR = { bg: [246, 246, 243], screen: [226, 226, 220], tile: [190, 210, 232], group: [176, 224, 208], line: [60, 70, 80], fixed: [214, 110, 40], plate: [255, 255, 255], ink: [20, 24, 30] };

export function boardPng(lg, { maxW = 1400, maxH = 1000 } = {}) {
  const tiles = lg.tiles.filter((t) => !t.hidden);
  const sx0 = lg.metric?.sx || 40, sy0 = lg.metric?.sy || 26, cols = lg.density, rows = lg.screen.rows || Math.round(cols * 0.6);
  const x0 = Math.min(1, ...tiles.map((t) => t.x)), y0 = Math.min(1, ...tiles.map((t) => t.y));
  const x1 = Math.max(cols + 1, ...tiles.map((t) => t.x + t.w)), y1 = Math.max(rows + 1, ...tiles.map((t) => t.y + t.h));
  const k = Math.min(maxW / ((x1 - x0) * sx0), maxH / ((y1 - y0) * sy0), 1);
  const sx = sx0 * k, sy = sy0 * k;
  const W = Math.max(1, Math.round((x1 - x0) * sx)), H = Math.max(1, Math.round((y1 - y0) * sy));
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = y * (W * 3 + 1) + 1 + x * 3;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
  };
  const fill = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c); };
  const frame = (x, y, w, h, c, t = 1) => { fill(x, y, w, t, c); fill(x, y + h - t, w, t, c); fill(x, y, t, h, c); fill(x + w - t, y, t, h, c); };
  const num = (s, x, y, z) => {
    const str = String(s);
    fill(x, y, (str.length * 6 + 1) * z, 9 * z, COLOR.plate);
    [...str].forEach((d, n) => [...DIGITS[d]].forEach((b, i) => { if (b === "1") fill(x + (n * 6 + 1 + (i % 5)) * z, y + (1 + Math.floor(i / 5)) * z, z, z, COLOR.ink); }));
  };
  const X = (v) => Math.round((v - x0) * sx), Y = (v) => Math.round((v - y0) * sy);
  fill(0, 0, W, H, COLOR.bg);
  fill(X(1), Y(1), Math.round(cols * sx), Math.round(rows * sy), COLOR.screen); // 窓一枚ぶん
  for (const t of tiles) {
    const h = t.min ? Math.min(t.h, 2) : t.h;
    const x = X(t.x), y = Y(t.y), w = Math.max(4, Math.round(t.w * sx) - 2), hh = Math.max(4, Math.round(h * sy) - 2);
    fill(x, y, w, hh, t.key.includes(":") ? COLOR.group : COLOR.tile);
    frame(x, y, w, hh, t.fixed ? COLOR.fixed : COLOR.line, t.fixed ? 3 : 1);
    num(t.n, x + 4, y + 4, 2);
  }
  const lines = [];
  for (let j = 0; j < H; j++) lines.push(raw.subarray(j * (W * 3 + 1), (j + 1) * (W * 3 + 1)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
