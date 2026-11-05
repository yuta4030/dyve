import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { Board, layoutOf } from "../src/board.js";
import { Words } from "../src/words.js";
import { handleRpc } from "../src/mcp.js";
import { legend, boardPng, changeLayout } from "../src/view.js";
import { findBrowser, screenshot } from "../src/shot.js";
import { managerPrompt, scribePrompt } from "../src/waker.js";
import { toMarkdown } from "../src/export.js";

const storeOf = (board = new Board()) => ({ board, apply: (o) => board.apply(o) });
const human = (b, type, panel) => b.apply({ by: "human", type, panel });
const ai = (b, type, panel, by = "scribe") => b.apply({ by, type, panel, reason: "試す" });
const tools = (store, as, name, args, opts = {}) => handleRpc(store, null, as, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, opts);
const laid = (board, data) => human(board, "add", { view: "layout", data }).op.panel.id;
const POS = { talk: { x: 1, y: 1, w: 8, h: 8 }, p9: { x: 9, y: 1, w: 8, h: 8 } };

test("画面の script は全体が JavaScript として読める", () => {
  for (const f of ["ui.html", "manage.html"]) {
    const html = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const src = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf("</script>"));
    assert.ok(src.length > 1000, f);
    assert.doesNotThrow(() => new vm.Script(src), f);
  }
});

test("合成：発言だけ、一段だけ。宛てた発言とピン留めは AI が合流できず、人は印を外せる", () => {
  const b = new Board();
  const id = (r) => r.op.panel.id;
  const a = id(human(b, "add", { view: "say", data: "あとは" }));
  const c = id(human(b, "add", { view: "say", data: "続き" }));
  const d = id(human(b, "add", { view: "say", data: "宛て", to: "アリス" }));
  const t = id(ai(b, "add", { view: "text", data: "x" }));
  assert.equal(ai(b, "edit", { id: c, into: t }).code, "invalid");
  assert.equal(ai(b, "edit", { id: c, into: "nope" }).code, "not_found");
  assert.equal(ai(b, "edit", { id: d, into: a }).code, "invalid");
  assert.ok(ai(b, "edit", { id: c, into: a }).ok);
  assert.equal(b.get(c).data, "続き", "元の文は残る");
  assert.equal(ai(b, "edit", { id: a, into: c }).code, "invalid", "合流先はほかへ合流しない");
  const e = id(human(b, "add", { view: "say", data: "ピン" }));
  human(b, "edit", { id: e, pinned: true });
  const f = id(human(b, "add", { view: "say", data: "後" }));
  assert.equal(ai(b, "edit", { id: f, into: e }).code, "pinned");
  human(b, "edit", { id: c, into: null });
  assert.equal(b.get(c).into, undefined);
  assert.equal(new Board(b.log).get(a).data, "あとは", "当て直しても同じ");
});

test("合成した発言：マネージャは先頭だけを読み、書き出しにも先頭だけ出る", () => {
  const b = new Board();
  const a = human(b, "add", { view: "say", data: "前の半分" }).op.panel.id;
  const since = b.seq;
  const c = human(b, "add", { view: "say", data: "後の半分" }).op.panel.id;
  ai(b, "edit", { id: a, data: "前の半分と後の半分" });
  ai(b, "edit", { id: c, into: a });
  const k = ai(b, "add", { view: "text", about: c, data: "補足" }, "manager").op.panel.id;
  const m = managerPrompt(since, b);
  assert.match(m, new RegExp(`- ${a}：前の半分と後の半分`));
  assert.doesNotMatch(m, new RegExp(`- ${c}：`));
  const md = toMarkdown(b);
  assert.match(md, /前の半分と後の半分/);
  assert.doesNotMatch(md, /^- 後の半分/m);
  assert.match(md, /補足/, `合流した発言の下のもの ${k} も落とさない`);
});

test("並び：AI は作れず、ピン留めを変えられず、ピン留めしたものを動かせない。古い形は組み込みのパネルだけ引き継ぐ", () => {
  const b = new Board();
  assert.equal(ai(b, "add", { view: "layout", data: {} }).code, "forbidden");
  const id = laid(b, { v: 3, density: 24, pos: POS, pinned: ["talk"] });
  assert.equal(human(b, "add", { view: "layout", data: {} }).code, "invalid", "一枚だけ");
  const cur = b.get(id).data;
  assert.equal(ai(b, "edit", { id, data: { ...cur, pinned: [] } }).code, "forbidden");
  assert.equal(ai(b, "edit", { id, data: { ...cur, pos: { ...POS, talk: { x: 2, y: 1, w: 8, h: 8 } } } }).code, "pinned");
  assert.equal(ai(b, "edit", { id, data: { pos: POS } }).code, "invalid", "v: 3 の形だけ");
  assert.equal(ai(b, "drop", { id }).code, "forbidden");
  assert.equal(ai(b, "edit", { id, view: "text" }).code, "forbidden");
  const old = layoutOf({ density: 48, pos: { talk: { x: 1, y: 1, w: 4, h: 4 }, "g:b/p9": { x: 5, y: 1, w: 4, h: 4 } }, locked: ["talk"], min: ["talk"], hidden: ["status"], inner: { tpos: { p3: { x: 1, y: 1, w: 2 } }, min: ["p3"] } });
  assert.deepEqual(old, { v: 3, density: 48, pos: { talk: { x: 1, y: 1, w: 4, h: 4 } }, zoom: {}, fold: {}, out: [], pinned: [], inner: { tpos: { p3: { x: 1, y: 1, w: 2 } }, sizes: {} } });
  // v 2 はまとまりの置き場所を全部覚えていた。組み込みのパネルとピン留めしたものだけ残し、ほかは自動の並びへ
  const topic = human(b, "add", { view: "topic", data: { title: "話題" } }).op.panel.id;
  human(b, "edit", { id: topic, pinned: true });
  const v2 = layoutOf({ v: 2, pos: { talk: POS.talk, p9: POS.p9, g: POS.p9, [topic]: POS.p9 }, pinned: ["g"] }, b.panels);
  assert.deepEqual([v2.v, Object.keys(v2.pos).sort()], [3, ["g", "talk", topic].sort()]);
});

test("board_layout：ピン留めは断り、残りは動かし、重なりを知らせる", () => {
  const b = new Board();
  for (let i = 0; i < 8; i++) human(b, "add", { view: "say", data: String(i) });
  const pinned = human(b, "add", { view: "topic", data: { title: "話題" } }).op.panel.id;
  human(b, "edit", { id: pinned, pinned: true });
  const pos = { talk: { x: 1, y: 1, w: 8, h: 8 }, tools: { x: 9, y: 1, w: 8, h: 8 }, [pinned]: { x: 17, y: 1, w: 8, h: 8 } };
  laid(b, { v: 3, density: 24, pos, pinned: ["talk"] });
  const s = storeOf(b);
  assert.equal(changeLayout(s, "manager", { moves: { talk: { x: 3, y: 3 } } }, "r").code, "pinned");
  const r = changeLayout(s, "manager", { moves: { talk: { x: 3 }, tools: { x: 2, y: 2 }, [pinned]: { x: 1 }, nope: { x: 1 } } }, "並べ直す");
  assert.ok(r.ok);
  assert.deepEqual(r.changed, ["tools"]);
  assert.deepEqual(r.refused.map((x) => x.key).sort(), [pinned, "nope", "talk"].sort());
  assert.deepEqual(r.overlaps, [["talk", "tools"]]);
  const l = legend(b).top;
  assert.equal(l.find((t) => t.key === "talk").pinned, true);
  assert.equal(l.find((t) => t.key === pinned).pinned, true, "パネルのピン留めも同じ");
  assert.equal(l.find((t) => t.key === pinned).title, "話題");
  assert.equal(changeLayout(s, "manager", { moves: { tools: { w: 1 } } }, "r").code, "invalid");
});

test("board_layout：人が画面でできる操作を全部できる（ピン留めは除く）", () => {
  const b = new Board();
  const topic = human(b, "add", { view: "topic", data: { title: "話題" } }).op.panel.id;
  const res = ai(b, "add", { view: "list", about: topic, data: ["a"] }, "アリス").op.panel.id;
  const pos = { tools: { x: 1, y: 1, w: 4, h: 4 }, status: { x: 5, y: 1, w: 4, h: 4 }, [topic]: { x: 9, y: 1, w: 8, h: 8 } };
  const id = laid(b, { v: 3, density: 24, pos });
  const s = storeOf(b), data = () => b.get(id).data;
  const ok = (change) => { const r = changeLayout(s, "manager", change, "試す"); assert.ok(r.ok, JSON.stringify(r)); return r; };
  // 畳む：組み込みのパネルも、話題も、話題の中のパネルも同じ
  ok({ fold: { status: true, [topic]: true, [res]: true }, zoom: { status: 1.5 } });
  assert.deepEqual([data().fold, data().zoom.status], [{ status: true, [topic]: true, [res]: true }, 1.5]);
  ok({ fold: { status: false } });
  assert.equal(data().fold.status, false);
  assert.equal(legend(b).inner.find((p) => p.id === res).folded, true);
  // 取り出す・戻す
  ok({ out: { [res]: true } });
  assert.ok(data().out.includes(res) && !data().pos[res], "取り出したものも、置き場所を決めるまでは自動の並び");
  assert.equal(changeLayout(s, "manager", { out: { [topic]: true } }, "r").code, "invalid", "話題はもう並んでいる");
  ok({ out: { [res]: false } });
  assert.deepEqual([data().out, data().pos[res]], [[], undefined]);
  // 話題の中
  ok({ moves: { [res]: { x: 2, y: 3, w: 6, h: 4, size: [300, 200] } } });
  assert.deepEqual([data().inner.tpos[res], data().inner.sizes[res]], [{ x: 2, y: 3, w: 6, h: 4 }, [300, 200]]);
  ok({ moves: { [res]: { h: null, size: null } } });
  assert.deepEqual(data().inner.tpos[res], { x: 2, y: 3, w: 6 });
  ok({ moves: { [res]: { position: null } } });
  assert.equal(data().inner.tpos[res], undefined);
  assert.equal(legend(b).inner.find((p) => p.id === res).title.includes("a"), true);
  // ます目の細かさ・並びを戻す
  ok({ moves: { [res]: { x: 3, y: 5, w: 4 } } });
  ok({ density: 48 });
  assert.equal(data().density, 48);
  assert.deepEqual(data().pos.tools, { x: 1, y: 1, w: 8, h: 8 });
  assert.deepEqual(data().inner.tpos[res], { x: 5, y: 9, w: 8 });
  assert.equal(changeLayout(s, "manager", { density: 13 }, "r").code, "invalid");
  ok({ reset: true });
  assert.deepEqual(data().pos, {});
  assert.deepEqual(data().inner.tpos[res], { x: 5, y: 9, w: 8 }, "話題の中は人の操作と同じく残す");
  assert.equal(changeLayout(s, "manager", { nothing: 1 }, "r").code, "invalid");
});

test("board_layout：ピン留めしたものとその中は動かず、ピン留めがあるとます目は変えられない。並びのピン留めそのものは変えられない", () => {
  const b = new Board();
  const say = human(b, "add", { view: "say", data: "発言" }).op.panel.id;
  const res = ai(b, "add", { view: "list", about: say, data: ["a"] }, "manager").op.panel.id;
  const free = human(b, "add", { view: "topic", data: { title: "別" } }).op.panel.id;
  // 発言から出たまとまりは、並びの pinned でピン留めする
  const id = laid(b, { v: 3, density: 24, pos: { tools: { x: 1, y: 1, w: 4, h: 4 }, [say]: { x: 5, y: 1, w: 8, h: 8 }, [free]: { x: 13, y: 1, w: 8, h: 8 } }, pinned: [say], inner: { tpos: { [res]: { x: 1, y: 1, w: 4 } }, sizes: {} } });
  const s = storeOf(b);
  for (const change of [{ moves: { [res]: { x: 3 } } }, { fold: { [res]: true } }, { fold: { [say]: true } }, { zoom: { [say]: 2 } }, { out: { [res]: true } }, { density: 12 }]) {
    const r = changeLayout(s, "manager", change, "r");
    assert.equal(r.ok, false, JSON.stringify(change));
  }
  const cur = b.get(id).data;
  // MCP を通らずに panel_edit で書いても、ボードが同じように断る
  for (const data of [{ ...cur, inner: { ...cur.inner, tpos: { [res]: { x: 9, y: 1, w: 4 } } } }, { ...cur, fold: { [say]: true } }, { ...cur, zoom: { [say]: 2 } }, { ...cur, fold: { [res]: true } }, { ...cur, out: [res] }]) {
    assert.equal(ai(b, "edit", { id, data }).code, "pinned");
  }
  assert.equal(ai(b, "edit", { id, data: { ...cur, pinned: [] } }).code, "forbidden");
  // 並びを戻してもピン留めは残る
  const r = changeLayout(s, "manager", { reset: true }, "r");
  assert.ok(r.ok);
  assert.ok(b.get(id).data.pos[say] && !b.get(id).data.pos.tools);
  assert.deepEqual(b.get(id).data.pinned, [say]);
  assert.equal(legend(b).inner.find((p) => p.id === res).pinned, true);
  // 人が外せば動かせる
  human(b, "edit", { id, data: { ...b.get(id).data, pinned: [] } });
  assert.ok(changeLayout(s, "manager", { moves: { [res]: { x: 3 } } }, "r").ok);
});

test("board_view：並びがなければそう言い、あれば読める PNG と対応表を返す。board_read に並びのパネルは混ざらない", async () => {
  const b = new Board(), s = storeOf(b);
  assert.equal((await tools(s, "manager", "board_view", {})).result.isError, true);
  laid(b, { v: 3, density: 24, pos: POS, pinned: ["talk"], metric: { sx: 40, sy: 26, rows: 20 } });
  const { content } = (await tools(s, "manager", "board_view", {})).result;
  assert.equal(content[0].mimeType, "image/png");
  const png = Buffer.from(content[0].data, "base64");
  assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IDAT") + 4 + png.readUInt32BE(png.indexOf("IDAT") - 4));
  assert.equal(zlib.inflateSync(idat).length, (w * 3 + 1) * h);
  assert.equal(JSON.parse(content[1].text).top.length, 2);
  assert.ok(boardPng(legend(b), { maxW: 100, maxH: 100 }).readUInt32BE(16) <= 100, "大きすぎれば縮める");
  const real = (await tools(s, "manager", "board_view", { real: true }, { shoot: async (x, size) => Buffer.from(`${x}:${size.width}`) })).result.content;
  assert.equal(Buffer.from(real[2].data, "base64").toString(), "board:1400");
  assert.match((await tools(s, "manager", "board_view", { real: true })).result.content[2].text, /撮れなかった/);
  const read = JSON.parse(tools(s, "manager", "board_read", {}).result.content[0].text);
  assert.ok(!read.panels.some((p) => p.view === "layout"));
});

test("panel_view：撮れれば絵、撮れなければ中身を返す", async () => {
  const b = new Board(), s = storeOf(b);
  const id = human(b, "add", { view: "text", data: "中身" }).op.panel.id;
  const none = await tools(s, "manager", "panel_view", { id });
  assert.equal(JSON.parse(none.result.content[0].text).panel.data, "中身");
  let size;
  const shot = await tools(s, "manager", "panel_view", { id }, { shoot: async (x, z) => { size = z; return Buffer.from(`png:${x}`); } });
  assert.equal(size.width, 900, "タイルでなければ既定の幅");
  assert.equal(shot.result.content[0].type, "image");
  assert.equal(Buffer.from(shot.result.content[0].data, "base64").toString(), `png:${id}`);
  const broken = await tools(s, "manager", "panel_view", { id }, { shoot: async () => { throw new Error("落ちた"); } });
  assert.match(broken.result.content[0].text, /落ちた/);
  assert.equal((await tools(s, "manager", "panel_view", { id: "nope" })).result.isError, true);
});

test("ブラウザ：指定を優先し、PATH と決まった場所から探す。偽の実行で撮る", async () => {
  assert.equal(findBrowser("/x/chrome"), "/x/chrome");
  assert.equal(findBrowser(null, { exists: (p) => p === "/usr/bin/chromium", env: { PATH: "/usr/bin" } }), "/usr/bin/chromium");
  assert.match(findBrowser(null, { exists: (p) => p.endsWith("chrome.exe"), env: { PATH: "" } }), /chrome\.exe$/);
  assert.equal(findBrowser(null, { exists: () => false, env: { PATH: "/none" } }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-shot-test-"));
  let args;
  const png = await screenshot({
    browser: "/x/chrome", url: "http://localhost:1/?shot=p1",
    area: () => ({ dir, outward: (p) => p }),
    run: async (_, a) => { args = a; fs.writeFileSync(a.find((x) => x.startsWith("--screenshot=")).slice(13), "PNG"); },
  });
  assert.equal(png.toString(), "PNG");
  assert.ok(args.includes("--headless=new") && args.at(-1).endsWith("shot=p1"));
  assert.ok(args.some((x) => x.startsWith("--user-data-dir=")), "使っているブラウザのプロファイルに触らない");
  assert.ok(!fs.existsSync(dir), "片付ける");
});

test("辞書：追記のログを当て直す。AI は人の項目を変えられず、消せず、人が消した言葉を足し直せない", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyve-words-")), "words.jsonl");
  const w = new Words(file);
  assert.equal(w.add({ by: "scribe", heard: "ライブ", write: "dyve" }).code, "invalid", "AI は reason が要る");
  assert.ok(w.add({ by: "scribe", heard: "ライブ", write: "dyve", when: "dyve の話のとき", reason: "訂正された" }).ok);
  assert.ok(w.add({ by: "manager", heard: "ライブ", write: "DYVE", reason: "直す" }).ok, "AI の項目は AI も直せる");
  assert.ok(w.add({ by: "human", heard: "やめる", write: "yml" }).ok);
  assert.equal(w.add({ by: "scribe", heard: "やめる", write: "x", reason: "r" }).code, "forbidden");
  assert.equal(w.drop({ by: "scribe", heard: "ライブ" }).code, "forbidden");
  assert.equal(w.add({ by: "human", heard: "同じ", write: "同じ" }).code, "invalid");
  assert.ok(w.drop({ by: "human", heard: "ライブ" }).ok);
  assert.equal(w.add({ by: "scribe", heard: "ライブ", write: "dyve", reason: "r" }).code, "forbidden");
  const again = new Words(file);
  assert.deepEqual(again.list().map((x) => x.heard), ["やめる"]);
  assert.equal(again.add({ by: "scribe", heard: "ライブ", write: "dyve", reason: "r" }).code, "forbidden", "当て直しても覚えている");
  assert.ok(again.add({ by: "human", heard: "ライブ", write: "dyve" }).ok, "人は戻せる");
  const r = tools(storeOf(), "scribe", "word_add", { heard: "ケツダウン", write: "k2down", reason: "聞き違い" }, { words: again });
  assert.equal(r.result.isError, false);
  assert.ok(again.items.has("ケツダウン"));
  assert.match(scribePrompt([{ id: "p2", rev: 2, data: "x" }], [{ id: "p1", rev: 1, data: "y" }], ["- あ → い"]), /辞書[\s\S]*あ → い[\s\S]*p1（rev 1）[\s\S]*p2（rev 2）/);
});

test("自動の並び：画面が並べた結果を対応表に出し、AI が動かしたものはそこに留まり、position: null で自動へ戻る", () => {
  const b = new Board();
  const topic = human(b, "add", { view: "topic", data: { title: "話題" } }).op.panel.id;
  const id = laid(b, { v: 3, density: 24, pos: { talk: POS.talk } });
  const s = storeOf(b), data = () => b.get(id).data;
  const tiles = [{ key: "talk", ...POS.talk }, { key: topic, x: 13, y: 1, w: 12, h: 20, auto: true }];
  const top = legend(b, tiles).top;
  assert.deepEqual(top.map((t) => [t.key, !!t.auto]), [["talk", false], [topic, true]]);
  assert.equal(legend(b).top.length, 1, "画面がなければ決めたものだけ");
  // 画面がまだ並べていないものは、全部の数を渡さないと動かせない
  assert.equal(changeLayout(s, "manager", { moves: { [topic]: { x: 1 } } }, "r").code, "invalid");
  assert.ok(changeLayout(s, "manager", { moves: { [topic]: { y: 30 } } }, "下へ", tiles).ok);
  assert.deepEqual(data().pos[topic], { x: 13, y: 30, w: 12, h: 20 });
  assert.ok(changeLayout(s, "manager", { moves: { [topic]: { position: null } } }, "自動へ戻す", tiles).ok);
  assert.equal(data().pos[topic], undefined);
  assert.ok(changeLayout(s, "manager", { zoom: { [topic]: 1.2 }, fold: { [topic]: true } }, "r", tiles).ok, "自動のものも拡大率と畳むは変えられる");
});

test("board_layout：浮かせ方と、浮かせたものの置き場所・拡大率を変えられる。ピン留めされたものは変えない", () => {
  const b = new Board();
  laid(b, { v: 3, density: 24, pos: { talk: POS.talk, tools: POS.talk, status: POS.talk, quota: POS.talk }, pinned: [] });
  const s = storeOf(b);
  assert.equal(legend(b).floatMode, "front", "決めていなければ前面");
  assert.equal(legend(b).top.find((t) => t.key === "talk").floating, "front");
  const r = changeLayout(s, "manager", { float: { mode: "front", pos: { tools: { right: 10, top: 20, w: 200 }, nope: { left: 1, top: 1, w: 200 }, talk: { left: 1, right: 1, top: 1, w: 200 } }, zoom: { quota: 0.8 } } }, "比べる");
  assert.ok(r.ok);
  assert.deepEqual(r.changed.sort(), ["float", "quota", "tools"]);
  assert.deepEqual(r.refused.map((x) => x.key).sort(), ["nope", "talk"]);
  const l = legend(b);
  assert.equal(l.floatMode, "front");
  assert.deepEqual(l.top.find((t) => t.key === "tools").place, { right: 10, top: 20, w: 200 });
  assert.equal(l.top.find((t) => t.key === "quota").zoom, 0.8);
  assert.ok(changeLayout(s, "manager", { float: { mode: "off" } }, "並べる").ok);
  assert.equal(legend(b).top.find((t) => t.key === "talk").floating, undefined);
  assert.equal(changeLayout(s, "manager", { float: { mode: "side" } }, "r").code, "invalid");
});

test("board_layout：ピン留めした浮かせるパネルは動かず、浮かせ方も変えられない。人は変えられる", () => {
  const b = new Board();
  const id = laid(b, { v: 3, density: 24, pos: { talk: POS.talk }, pinned: ["talk"] });
  const s = storeOf(b);
  assert.equal(changeLayout(s, "manager", { float: { mode: "off" } }, "r").code, "pinned");
  assert.equal(changeLayout(s, "manager", { float: { pos: { talk: { left: 1, top: 1, w: 200 } } } }, "r").code, "pinned");
  assert.ok(changeLayout(s, "manager", { float: { pos: { tools: { left: 1, top: 1, w: 200 } } } }, "r").ok, "ほかの浮かせるものは動かせる");
  const cur = b.get(id).data;
  assert.equal(ai(b, "edit", { id, data: { ...cur, float: { ...cur.float, mode: "off" } } }).code, "pinned", "パネルの編集でも同じ");
  assert.ok(human(b, "edit", { id, data: { ...cur, float: { mode: "off" } } }).ok);
});
