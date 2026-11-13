import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const fn = (name) => new Function(`${html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"))[0]}; return ${name};`)();

test("外のものを読まない（CDN・フォント・外の画像）", () => {
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script\s+src/i);
});

test("画面の言葉は L にまとめる", () => {
  assert.match(script, /^const L = \{/m);
  // スクリプトの中で、L の外に日本語の文字列を書かない（コメントは除く）
  const body = script.slice(script.indexOf("\n};", script.indexOf("const L = {")) + 3)
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /["'`][^"'`\n]*[぀-ヿ一-鿿][^"'`\n]*["'`]/);
  // HTML の地の文にも日本語を書かない
  const markup = html.replace(/<style>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(markup.replace(/<[^>]*>/g, ""), /[぀-ヿ一-鿿]/);
});

test("ダイアログを出さない・フォーカスを奪わない・音を鳴らさない", () => {
  assert.doesNotMatch(script, /\b(alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(script, /\.focus\s*\(|autofocus/);
  assert.doesNotMatch(html, /autofocus/);
  assert.doesNotMatch(script, /new Audio|AudioContext|\.play\s*\(|speechSynthesis/);
  assert.doesNotMatch(script, /scrollIntoView/);
});

test("Enter で置く。Shift+Enter と IME の変換確定では置かない", () => {
  const isSendKey = fn("isSendKey");
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), true);
  assert.equal(isSendKey({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }), false);
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }), false);
  // Safari：確定の Enter は isComposing が外れていて keyCode が 229
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false);
  assert.equal(isSendKey({ key: "a", shiftKey: false, isComposing: false, keyCode: 65 }), false);
});

test("声は間があいたら置き、打ったものは Enter まで待つ", () => {
  assert.match(script, /const PAUSE = \d+/);
  assert.match(script, /compositionstart/);
  assert.match(script, /compositionend/);
  // 打ったかどうかは、入力の直前にキーが押されたかで見分ける
  assert.match(script, /lastKey/);
});

test("記録の当て方は state.js 一つ。画面はそれを読み、自分では当て方を書かない", () => {
  assert.match(script, /^import \{ step(, \w+)* \} from "\/state\.js";$/m);
  assert.doesNotMatch(script, /\br\.kind\b/, "記録の種類で分けて当てない");
  const state = fs.readFileSync(new URL("../src/state.js", import.meta.url), "utf8");
  assert.doesNotMatch(state, /^\s*import\b|\brequire\(/m, "state.js は import を持たない");
});

test("届け先の印：続き・新しく起こした・届けていない・決まらなかった。まだなら出さない", () => {
  const Lsrc = script.match(/^const L = \{[\s\S]*?^\};/m)[0];
  const code = html.match(/^function chipOf\([\s\S]*?^}$/m)[0];
  const chipOf = new Function(`${Lsrc}; ${code}; return chipOf;`)();
  const state = { sessions: [{ id: 2, sym: "A", name: "競合の値段", role: "調べもの", asked: [1, 3] }] };
  assert.equal(chipOf({ id: 1, session: 2 }, state).text, "→ A 競合の値段（新しく起こした。調べものに任せた）");
  assert.equal(chipOf({ id: 3, session: 2 }, state).text, "→ A 競合の値段");
  assert.equal(chipOf({ id: 4, session: null, aside: true }, state).quiet, true);
  assert.equal(chipOf({ id: 5, session: null, aside: false, miss: "係が読めなかった" }, state).title, "係が読めなかった");
  assert.equal(chipOf({ id: 6, session: null, aside: false, miss: null }, state), null);
  assert.equal(chipOf({ id: 7, session: null, aside: true, resent: [4] }, state).text, "前の発言を届け直した");
  const done = { sessions: [{ id: 2, sym: null, folded: { seq: 9 }, name: "競合の値段", role: "調べもの", asked: [1] }] };
  assert.equal(chipOf({ id: 1, session: 2 }, done).text, "→ 競合の値段（済み）", "済みのものは記号なしで名前だけ");
  assert.equal(chipOf({ id: 8, session: 2, resent: [4, 5] }, state).text, "→ A 競合の値段・前の発言を届け直した（2 件）");
});

test("パネルは view の名前で描き手を選ぶ。本体が描くのは summary・list・table・text・json", () => {
  const views = script.match(/^const VIEWS = \{([\s\S]*?)^\};/m)[1];
  assert.deepEqual([...views.matchAll(/^  (\w+):/gm)].map((m) => m[1]), ["summary", "list", "table", "text", "json"]);
  assert.match(script, /if \(Object\.hasOwn\(VIEWS, p\.view\)\) return/);
  assert.match(script, /VIEWS\.json\(u\.data/, "置き場の view で描けなければ json で出す");
});

test("ステートといまどこまでは state.js のものを使う", () => {
  assert.match(script, /^import \{ step, stageOf, nowOf \} from "\/state\.js";$/m);
  assert.doesNotMatch(script, /function stageOf|function nowOf/);
});

test("パネル置き場の view は sandbox の iframe（allow-scripts だけ）で描き、外に出さない", () => {
  const sandboxes = [...script.matchAll(/setAttribute\("sandbox", "([^"]*)"\)/g)].map((m) => m[1]);
  assert.deepEqual(sandboxes, ["allow-scripts"]);
  assert.doesNotMatch(script, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  const csp = script.match(/^const FRAME_CSP = "([^"]*)";$/m)[1];
  assert.match(csp, /^default-src 'none';/);
  assert.doesNotMatch(csp, /connect-src|https?:|'self'/);
  // 囲いからの知らせで受けるのは、高さ・光らせたい・描けなかった、だけ
  const handler = script.slice(script.indexOf('addEventListener("message"'));
  assert.deepEqual([...handler.matchAll(/m\.dyve === "(\w+)"/g)].map((m) => m[1]), ["size", "fail", "light"]);
});

test("ライトとダークの両方がある", () => {
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /--bg: #f1f5f6/);
  assert.match(html, /--bg: #0b161b/);
});

test("作り直しのコードに現行の言葉を使わない", () => {
  const dir = new URL("../", import.meta.url);
  const files = ["src", "bin", "test", "roles", "kakari"].flatMap((d) => fs.readdirSync(new URL(`${d}/`, dir)).map((f) => new URL(`${d}/${f}`, dir)));
  const old = /(?<!キー)ボード|トーク|ピン留め|マネージャ|清書係|控室/;
  for (const f of files) {
    if (f.pathname.endsWith("/ui.test.js")) continue; // この試験そのもの
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), old, f.pathname);
  }
});
