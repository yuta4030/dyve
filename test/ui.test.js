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
  const body = script.slice(script.indexOf("\n};", script.indexOf("const L = {")) + 3).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /["'`][^"'`\n]*[぀-ヿ一-鿿][^"'`\n]*["'`]/);
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
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false);
});

test("声は間があいたら置き、打ったものは Enter まで待つ", () => {
  assert.match(script, /const PAUSE = \d+/);
  assert.match(script, /compositionstart/);
  assert.match(script, /lastKey/);
});

test("返ってきた文の最初の一行", () => {
  const headOf = fn("headOf");
  assert.equal(headOf("## 結論\n\n本文"), "結論");
  assert.equal(headOf("\n**月 20 ドル**です\n詳細"), "月 20 ドルです");
  assert.equal(headOf(""), "");
});
