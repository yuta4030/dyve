// エージェントがボードを絵で見るための口。並びは view layout のパネルに一枚で持つ（画面が作る）。
// board_view は画面に並ぶパネルの枠と番号の PNG と対応表（依存ゼロなので日本語は描かず、題名は対応表に出す）
import zlib from "node:zlib";
import { BUILTIN, FLOATS, FLOAT_MODES, fixedTile, fixedPanel, layoutOf } from "./board.js";

const NAMES = { talk: "トーク", status: "状況", quota: "残量", tools: "dyve 設定" };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (d) => (typeof d === "string" ? d : d?.title ?? d?.text ?? JSON.stringify(d) ?? "");

export const layoutPanel = (board) => board.list().find((p) => p.view === "layout") ?? null;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const DENSITIES = [12, 24, 48];
const ZOOM_MIN = 0.1, ZOOM_MAX = 5;
const floatModeOf = (d) => (FLOAT_MODES.includes(d.float?.mode) ? d.float.mode : FLOAT_MODES[0]);
const FOLDLESS = ["say", "summary"]; // 発言と要点は、それだけを畳まない（並んでいる枠ごとなら畳める）

function titleOf(board, k) {
  if (NAMES[k]) return NAMES[k];
  const p = board.get(k);
  return p ? clip(textOf(p.data), 60) : k;
}

// 対応表：番号は n。x・y はます目（y は下へ増える）。top は画面に並ぶパネル、inner は話題の中のパネル（at は話題の中のます目、なければ自動）
// tiles：画面がいま並べた結果（人のいま）。auto は置き場所を決めていないもの（画面が順番と中身から並べた）。画面が開いていなければ、決めたものだけ
export function legend(board, tiles = null) {
  const lp = layoutPanel(board);
  if (!lp) return null;
  const d = layoutOf(lp.data, board.panels), inner = d.inner || {};
  const shown = tiles?.length ? tiles.map(({ key, x, y, w, h, auto, folded }) => [key, { x, y, w, h }, auto, folded]) : Object.entries(d.pos || {}).map(([key, p]) => [key, p, false, d.fold?.[key]]);
  const top = shown.map(([key, p, auto, folded], i) => ({
    n: i + 1, key, title: titleOf(board, key), ...p,
    ...(auto ? { auto: true } : {}),
    ...(d.zoom?.[key] ? { zoom: d.zoom[key] } : {}),
    ...(fixedTile(board.panels, d, key) ? { pinned: true } : {}),
    ...(folded != null ? { folded: !!folded } : {}),
    ...((d.out || []).includes(key) ? { out: true } : {}),
    // 浮かせているものは、ます目の上にない（x・y は並べるに戻したときの場所）。place はピクセルの置き場所で、なければ既定の場所
    ...(FLOATS.includes(key) && floatModeOf(d) !== "off" ? { floating: floatModeOf(d), ...(d.float?.pos?.[key] ? { place: d.float.pos[key] } : {}), ...(d.float?.zoom?.[key] ? { zoom: d.float.zoom[key] } : {}) } : {}),
  }));
  const panels = board.list().filter((p) => p.view !== "layout" && !FOLDLESS.includes(p.view)).map((p) => ({
    id: p.id, view: p.view, title: clip(textOf(p.data), 40), ...(p.about ? { about: p.about } : {}), ...(p.state ? { state: p.state } : {}),
    ...(inner.tpos?.[p.id] ? { at: inner.tpos[p.id] } : {}), ...(inner.sizes?.[p.id] ? { size: inner.sizes[p.id] } : {}),
    ...(d.fold?.[p.id] != null ? { folded: d.fold[p.id] } : {}),
    ...(fixedPanel(board.panels, d, p.id) ? { pinned: true } : {}),
  }));
  return { density: d.density ?? 24, floatMode: floatModeOf(d), screen: { cols: d.density ?? 24, rows: d.metric?.rows ?? null }, metric: d.metric ?? null, top, inner: panels };
}

// 人が画面でできる見た目の操作を全部（ピン留めは人だけなので、ない）。できなかったものは refused で返し、できたものだけ置く
// moves：画面に並ぶパネル（key）なら置き場所（動かしたものはそこに留まる。position: null で自動の並びへ戻す）、話題の中のパネル（id）なら話題の中の置き場所。
// float：浮かせ方・浮かせたものの置き場所（ピクセル）と拡大率。fold：畳む・開く。out：取り出す・戻す。tiles：画面がいま並べた結果（自動のものの今の場所）
export function changeLayout(store, by, change, reason, tiles = null) {
  const board = store.board, lp = layoutPanel(board);
  if (!lp) return { ok: false, code: "not_found", message: "並びがまだない（画面が一度も開かれていない）" };
  if (!change || typeof change !== "object" || !Object.keys(change).length) return { ok: false, code: "invalid", message: "変えるものがない" };
  const old = layoutOf(lp.data, board.panels), inner = old.inner || {};
  const d = { ...old, pos: { ...old.pos }, zoom: { ...old.zoom }, fold: { ...old.fold }, out: [...(old.out || [])] };
  const t = { tpos: { ...inner.tpos }, sizes: { ...inner.sizes } };
  const done = [], refused = [];
  const no = (key, why) => refused.push({ key, why });
  const pinned = (k) => fixedTile(board.panels, old, k);
  const known = (k) => k in d.pos || BUILTIN.includes(k) || board.get(k);
  const ok = (k) => { if (!known(k) || board.get(k)?.view === "layout") no(k, "そのパネルはない"); else if (pinned(k)) no(k, "人がピン留めしている"); else return true; return false; };
  // 画面に並ぶパネル：組み込みのもの・置き場所を決めたもの・取り出したもの・画面が並べたもの・話題（画面がまだ並べていなくても枠になる）
  const seen = (k) => tiles?.find((t) => t.key === k);
  const isTop = (k) => k in d.pos || BUILTIN.includes(k) || d.out.includes(k) || !!seen(k) || (board.get(k)?.view === "topic" && !board.get(k).about);

  // 並びを戻す（ピン留めしたものは残す）。置き場所のないパネルは画面が決まった場所へ置く
  if (change.reset) {
    if (Object.keys(d.pos).some(pinned)) no("reset", "ピン留めしたものがあるので、それ以外だけ戻す");
    for (const k of Object.keys(d.pos)) if (!pinned(k)) { delete d.pos[k]; delete d.zoom[k]; delete d.fold[k]; d.out = d.out.filter((x) => x !== k); }
    done.push("reset");
  }
  // ます目の細かさ：見た目の大きさを保つように全部を同じ割合で直す。ピン留めしたものがあると変えられない
  if (change.density != null) {
    const any = Object.keys(d.pos).some(pinned) || Object.keys(t.tpos).some((id) => fixedPanel(board.panels, old, id));
    if (!DENSITIES.includes(change.density)) no("density", `density は ${DENSITIES.join("・")} のどれか`);
    else if (any) no("density", "ピン留めしたものがあると変えられない");
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
  // 取り出す（話題の中のパネルを、画面に一枚で並べる）・戻す
  for (const [id, on] of Object.entries(change.out || {})) {
    const p = board.get(id);
    if (!ok(id)) continue;
    if (on) {
      if (!p?.about || p.view === "say") { no(id, "取り出せるのは、話題の中のパネルだけ"); continue; }
      if (!d.out.includes(id)) d.out.push(id);
    } else {
      if (!d.out.includes(id)) { no(id, "取り出したパネルではない"); continue; }
      d.out = d.out.filter((x) => x !== id);
      delete d.pos[id];
    }
    done.push(id);
  }
  // 動かす・大きさ
  for (const [k, m] of Object.entries(change.moves || {})) {
    if (!ok(k)) continue;
    if (isTop(k)) {
      if (m.position === null) { delete d.pos[k]; done.push(k); continue; }
      const base = d.pos[k] ?? seen(k) ?? {};
      const next = { ...base, ...Object.fromEntries(["x", "y", "w", "h"].filter((f) => f in m).map((f) => [f, m[f]])) };
      if (!["x", "y", "w", "h"].every((f) => Number.isInteger(next[f])) || next.w < 2 || next.h < 2) { no(k, base.w ? "x・y は整数、w・h は 2 以上の整数" : "画面がまだ並べていないので、x・y・w・h を全部渡す"); continue; }
      d.pos[k] = { x: next.x, y: next.y, w: next.w, h: next.h };
      done.push(k);
      continue;
    }
    if (!board.get(k)?.about) { no(k, "画面に並んでいないパネル"); continue; }
    // 話題の中：x・y・w・h はます目（h: null で中身の高さ）、position: null で自動の並び、size は [幅, 高さ]（ピクセル。null で戻す）
    if (["x", "y", "w", "h"].some((f) => f in m)) {
      const next = { ...t.tpos[k], ...Object.fromEntries(["x", "y", "w", "h"].filter((f) => f in m).map((f) => [f, m[f]])) };
      if (next.h == null) delete next.h;
      const okH = next.h === undefined || (Number.isInteger(next.h) && next.h >= 2);
      if (!["x", "y", "w"].every((f) => Number.isInteger(next[f])) || next.x < 1 || next.y < 1 || next.w < 2 || !okH) { no(k, "x・y・w は整数（x・y は 1 以上、w は 2 以上）、h は 2 以上の整数か null（中身の高さ）"); continue; }
      t.tpos[k] = next;
    }
    if (m.position === null) delete t.tpos[k];
    if (m.size === null) delete t.sizes[k];
    else if (Array.isArray(m.size) && m.size.length === 2 && m.size.every((n) => Number.isFinite(n) && n > 0)) t.sizes[k] = m.size;
    done.push(k);
  }
  // 畳む・開く
  for (const [k, on] of Object.entries(change.fold || {})) {
    if (!ok(k)) continue;
    if (!isTop(k) && FOLDLESS.includes(board.get(k)?.view)) { no(k, "発言と要点は、それだけを畳めない"); continue; }
    d.fold[k] = !!on;
    done.push(k);
  }
  for (const [k, z] of Object.entries(change.zoom || {})) {
    if (!ok(k)) continue;
    if (!isTop(k)) { no(k, "拡大率は画面に並んでいるパネルだけ"); continue; }
    if (!(z >= ZOOM_MIN && z <= ZOOM_MAX)) { no(k, `zoom は ${ZOOM_MIN} から ${ZOOM_MAX}`); continue; }
    d.zoom[k] = z;
    done.push(k);
  }
  // 浮かせる：浮かせ方は四枚に効くので、どれかがピン留めされていると変えられない
  if (change.float) {
    const f = change.float, cur = { ...old.float, pos: { ...old.float?.pos }, zoom: { ...old.float?.zoom } };
    const floatOk = (k) => { if (!FLOATS.includes(k)) no(k, `浮かせられるのは ${FLOATS.join("・")}`); else if (pinned(k)) no(k, "人がピン留めしている"); else return true; return false; };
    if ("mode" in f) {
      if (!FLOAT_MODES.includes(f.mode)) no("float", `mode は ${FLOAT_MODES.join("・")} のどれか`);
      else if (FLOATS.some(pinned)) no("float", "浮かせるパネルを人がピン留めしているので、浮かせ方は変えられない");
      else { cur.mode = f.mode; done.push("float"); }
    }
    for (const [k, p] of Object.entries(f.pos || {})) {
      if (!floatOk(k)) continue;
      if (p === null) { delete cur.pos[k]; done.push(k); continue; }
      const dist = (v) => Number.isInteger(v) && v >= 0;
      const okPlace = p && dist(p.left ?? p.right) && dist(p.top ?? p.bottom) && (p.left == null || p.right == null) && (p.top == null || p.bottom == null) && Number.isInteger(p.w) && p.w >= 140 && (p.h == null || (Number.isInteger(p.h) && p.h >= 60));
      if (!okPlace) { no(k, "left か right、top か bottom は 0 以上の整数（ピクセル）、w は 140 以上、h は 60 以上か省く（中身の高さ）"); continue; }
      cur.pos[k] = { ...(p.left != null ? { left: p.left } : { right: p.right }), ...(p.top != null ? { top: p.top } : { bottom: p.bottom }), w: p.w, ...(p.h != null ? { h: p.h } : {}) };
      done.push(k);
    }
    for (const [k, z] of Object.entries(f.zoom || {})) {
      if (!floatOk(k)) continue;
      if (!(z >= ZOOM_MIN && z <= ZOOM_MAX)) { no(k, `zoom は ${ZOOM_MIN} から ${ZOOM_MAX}`); continue; }
      cur.zoom[k] = z;
      done.push(k);
    }
    d.float = cur;
  }
  if (!done.length) return { ok: false, code: refused.some((x) => /ピン留め/.test(x.why)) ? "pinned" : "invalid", message: "変えられるものがなかった", refused };
  const data = { ...d, inner: { tpos: t.tpos, sizes: t.sizes } };
  const r = store.apply({ by, type: "edit", panel: { id: lp.id, data }, reason });
  if (!r.ok) return { ...r, refused };
  const shown = Object.keys(d.pos);
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
  const shown = lg.top.filter((t) => !t.floating); // 浮かせているものは、ます目の上にない
  const sx0 = lg.metric?.sx || 40, sy0 = lg.metric?.sy || 26, cols = lg.density, rows = lg.screen.rows || Math.round(cols * 0.6);
  const x0 = Math.min(1, ...shown.map((t) => t.x)), y0 = Math.min(1, ...shown.map((t) => t.y));
  const x1 = Math.max(cols + 1, ...shown.map((t) => t.x + t.w)), y1 = Math.max(rows + 1, ...shown.map((t) => t.y + t.h));
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
  for (const t of shown) {
    const h = t.folded ? Math.min(t.h, 2) : t.h;
    const x = X(t.x), y = Y(t.y), w = Math.max(4, Math.round(t.w * sx) - 2), hh = Math.max(4, Math.round(h * sy) - 2);
    fill(x, y, w, hh, BUILTIN.includes(t.key) ? COLOR.tile : COLOR.group);
    frame(x, y, w, hh, t.pinned ? COLOR.fixed : COLOR.line, t.pinned ? 3 : 1);
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
