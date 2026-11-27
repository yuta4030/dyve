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
  // フォーカスを動かすのは keyFocus の中だけで、それを呼ぶのは画面のモードで人が i か / を押したときだけ
  assert.deepEqual(script.match(/\.focus\s*\(/g), [".focus("]);
  assert.match(script, /^function keyFocus\(el\) \{\n  el\.focus\(\);\n\}$/m);
  assert.equal(script.match(/keyFocus\(/g).length, 2);
  assert.doesNotMatch(script, /autofocus/);
  assert.doesNotMatch(html, /autofocus/);
  assert.doesNotMatch(script, /new Audio|AudioContext|\.play\s*\(|speechSynthesis/);
  assert.doesNotMatch(script, /scrollIntoView/);
});

test("web のリンクは別ウィンドウ一枚を名前で使い回す", () => {
  assert.match(script, /window\.open\(url, "dyve-view", "popup/);
});

test("ボタンは文字で作らない（アイコンか、チップ）", () => {
  // 中身がいきなり言葉のボタン（L の言葉や地の文字）を探す。チップ（pill・qref）は短い名前を持ってよい
  const text = [...script.matchAll(/<button(?![^>]*class="[^"]*\b(?:pill|qref)\b)[^>]*>(\$\{esc\(L\.|[^<$\s])/g)].map((m) => m[0]);
  assert.deepEqual(text, []);
  assert.doesNotMatch(script, /\$\("\[data-(?:reset|undo|history)\]"\)\.textContent/);
});

test("vim の編集：動く・消す・変える・写す・戻す。日本語は文字の種類で単語を切る", () => {
  const vimKey = fn("vimKey");
  const run = (text, pos, keys, mode = "normal") => { let v = { text, pos, mode, pend: "", reg: "", undo: [] }, act = null; for (const k of keys) ({ v, act } = vimKey(v, k)); return { ...v, act }; };
  const pick = (r) => [r.text, r.pos, r.mode];
  assert.deepEqual(pick(run("abc", 3, ["Escape"], "insert")), ["abc", 2, "normal"]);
  assert.equal(vimKey({ text: "", pos: 0, mode: "insert", pend: "", reg: "", undo: [] }, "a").handled, false);
  assert.deepEqual(pick(run("hello world foo", 0, ["w", "w"])), ["hello world foo", 12, "normal"]);
  assert.deepEqual(pick(run("hello world", 8, ["b"])), ["hello world", 6, "normal"]);
  assert.deepEqual(pick(run("hello world", 0, ["e"])), ["hello world", 4, "normal"]);
  assert.deepEqual(pick(run("料金を調べて", 0, ["w"])), ["料金を調べて", 2, "normal"]);
  assert.deepEqual(pick(run("a\nbb\nccc", 0, ["j", "j", "$"])), ["a\nbb\nccc", 7, "normal"]);
  assert.deepEqual(pick(run("a\nbb\nccc", 7, ["k", "0"])), ["a\nbb\nccc", 2, "normal"]);
  assert.deepEqual(pick(run("hello world", 0, ["d", "w"])), ["world", 0, "normal"]);
  assert.deepEqual(pick(run("hello world", 6, ["c", "w"])), ["hello ", 6, "insert"]);
  assert.deepEqual(pick(run("a\nbb\nccc", 3, ["d", "d", "p"])), ["a\nccc\nbb", 6, "normal"]);
  assert.deepEqual(pick(run("abc", 1, ["x", "u"])), ["abc", 1, "normal"]);
  assert.deepEqual(pick(run("abc", 1, ["r", "Z"])), ["aZc", 1, "normal"]);
  assert.deepEqual(pick(run("abc", 1, ["D"])), ["a", 0, "normal"]);
  assert.deepEqual(pick(run("abc", 0, ["A"])), ["abc", 3, "insert"]);
  assert.deepEqual(pick(run("ab", 0, ["o"])), ["ab\n", 3, "insert"]);
  assert.equal(run("abc", 0, ["Enter"]).act, "send");
  assert.equal(run("abc", 0, ["Escape"]).act, "leave");
  // ノーマルでは、知らないキーで文字が入らない
  assert.deepEqual(pick(run("abc", 0, ["q", "z"])), ["abc", 0, "normal"]);
});

test("幅と右のパネルはブラウザに覚え、読めなくても既定の幅で描く", () => {
  assert.match(script, /try \{ return JSON\.parse\(localStorage\.getItem\("dyve\.layout"\)\) \?\? \{\}; \} catch \{ return \{\}; \}/);
  assert.match(script, /try \{ localStorage\.setItem\("dyve\.layout"/);
  assert.match(html, /data-split="chat"/);
  assert.match(script, /data-split="side"/);
  assert.match(script, /data-side aria-pressed/);
});

test("Enter で置く。Shift+Enter と IME の変換確定では置かない", () => {
  const isSendKey = fn("isSendKey");
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), true);
  assert.equal(isSendKey({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }), false);
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }), false);
  assert.equal(isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false);
});

test("マイク：ブラウザの音声認識で聞きつづけ、確定したら設定に合わせて置く", () => {
  assert.match(script, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(script, /continuous = true/);
  assert.match(script, /interimResults = true/);
  // 区切りごとにすぐ置くか、間があくまでためるか
  assert.match(script, /state\.settings\?\.send === "each"\) input\.send\(\); else input\.arm\(\)/);
  // 止めたら、ためていたものをすぐ置く
  assert.match(script, /stop\(\) \{[\s\S]*?input\.send\(\)/);
  // 音声認識のない環境ではボタンを出さない
  assert.match(html, /<button id="mic"[^>]*hidden/);
});

test("声は間があいたら置き、打ったものは Enter まで待つ", () => {
  assert.match(script, /const PAUSE = \d+/);
  assert.match(script, /compositionstart/);
  assert.match(script, /lastKey/);
});

test("返ってきた文の最初の一行", () => {
  const headOf = fn("headOf");
  assert.equal(headOf("## 結論\n\n本文"), "本文");
  assert.equal(headOf("## 結論だけ"), "結論だけ");
  assert.equal(headOf("\n- **月 20 ドル**です\n詳細"), "**月 20 ドル**です");
  assert.equal(headOf(""), "");
});

// 画面の関数を取り出して、まとめて動かす（esc と inline と md）
const grab = (name) => html.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"))[0];
const mdOf = (rules = []) => new Function(`const esc = ${html.match(/^const esc = (.*);$/m)[1]};
const L = { copyCode: "c", run: "r", running: "…", exit: (c) => "exit " + c };
const runs = new Map();
const SHELL = ${html.match(/^const SHELL = (.*);$/m)[1]};
const FILE = ${html.match(/^const FILE = (.*);$/m)[1]};
let LINK_RULES = [];
${["linkify", "fileLink", "inline", "codeBlock", "md"].map(grab).join("\n")};
return (rules) => { LINK_RULES = rules; return { inline, md, linkify, runs }; };`)()(rules);

test("マークダウン：一行の中", () => {
  const { inline } = mdOf();
  assert.equal(inline("**月 20 ドル**と `a<b` と *少し*"), "<b>月 20 ドル</b>と <code>a&lt;b</code> と <i>少し</i>");
  assert.equal(inline("[出典](https://example.com/a?b=1&c=2)"), '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">出典</a>');
  // http と https のほかはリンクにしない。属性を閉じさせない
  assert.doesNotMatch(inline("[x](javascript:alert(1))"), /<a/);
  assert.doesNotMatch(inline('[x](https://a.example/"onmouseover=")'), /"onmouseover/);
  assert.equal(inline("<script>"), "&lt;script&gt;");
  assert.equal(inline("2 * 3 * 4"), "2 * 3 * 4");
});

test("マークダウン：塊", () => {
  const { md } = mdOf();
  assert.equal(md("## 結論\n本文の一行目\n二行目"), "<h4>結論</h4><p>本文の一行目<br>二行目</p>");
  assert.equal(md("- a\n- **b**\n\n1. x\n2. y"), "<ul><li>a</li><li><b>b</b></li></ul><ol><li>x</li><li>y</li></ol>");
  assert.match(md("```js\nif (a < b) {}\n```"), /<div class="code">.*data-copy-code.*<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre><\/div>/);
  assert.doesNotMatch(md("```js\nx\n```"), /data-run/);
  assert.equal(md("| 名前 | 数 |\n|---|---:|\n| 甲 | 3 |"), "<table><thead><tr><th>名前</th><th>数</th></tr></thead><tbody><tr><td>甲</td><td>3</td></tr></tbody></table>");
  assert.equal(md("> 引用\n\n---"), "<blockquote><p>引用</p></blockquote><hr>");
});

test("シェルのコードの塊には実行のボタンを付け、押した結果をその下に出す", () => {
  const { md, runs } = mdOf();
  assert.match(md("```sh\nls -la\n```"), /data-run/);
  assert.match(md("```bash\nls\n```"), /data-run/);
  runs.set("ls", { code: 2, out: "<なし>" });
  const h = md("```sh\nls\n```");
  assert.match(h, /run-out bad/);
  assert.match(h, /exit 2/);
  assert.match(h, /&lt;なし&gt;/);
});

test("リンク：URL と利用者の決まりに当てはまる言葉を押せるようにする。コードやリンクの中には当てない", () => {
  const { inline } = mdOf([{ re: /[A-Z][A-Z0-9]+-\d+/g, url: "https://x.atlassian.net/browse/$0" }]);
  assert.equal(inline("PROJ-12 を見て"), '<a href="https://x.atlassian.net/browse/PROJ-12" target="_blank" rel="noopener">PROJ-12</a> を見て');
  assert.equal(inline("`PROJ-12`"), "<code>PROJ-12</code>");
  assert.equal(inline("[票](https://a.example/PROJ-1)"), '<a href="https://a.example/PROJ-1" target="_blank" rel="noopener">票</a>');
  assert.equal(inline("詳しくは https://a.example/x?y=1&z=2。"), '詳しくは <a href="https://a.example/x?y=1&amp;z=2" target="_blank" rel="noopener">https://a.example/x?y=1&amp;z=2</a>。');
  // 括弧の中を差し込む
  const g = mdOf([{ re: /#(\d+)/g, url: "https://github.com/o/r/issues/$1" }]).inline;
  assert.match(g("#42 を直す"), /href="https:\/\/github\.com\/o\/r\/issues\/42"/);
});

test("手元のファイルの場所を押せるようにする。URL やふつうの言葉には当てない", () => {
  const { inline } = mdOf();
  const link = (h) => [...h.matchAll(/data-open="([^"]*)"(?: data-line="(\d+)")?(?: data-col="(\d+)")?/g)].map((m) => m.slice(1).filter(Boolean).join(":"));
  assert.deepEqual(link(inline("src/server.js:42 を直した")), ["src/server.js:42"]);
  assert.deepEqual(link(inline("`src/ui.html:10:3` と ~/notes/memo.md と /Users/me/a.txt")), ["src/ui.html:10:3", "~/notes/memo.md", "/Users/me/a.txt"]);
  assert.deepEqual(link(inline("README.md:12 を見て")), ["README.md:12"]);
  // 行のないただのファイル名・URL・版・メールは当てない
  assert.deepEqual(link(inline("README.md と https://a.example/b/c.js と v0.13.6 と a@b.example/c.md")), []);
  assert.match(inline("`src/a.js`"), /<a href="#" class="file" data-open="src\/a\.js"><code>src\/a\.js<\/code><\/a>/);
});

test("利用枠の吹き出し：戻る時刻と残り時間", () => {
  const L = { quotaLeft: (h, m) => (h ? `${h} 時間 ${m} 分` : `${m} 分`), quotaDays: (d, h) => `${d} 日 ${h} 時間` };
  const resetOf = new Function("L", `${grab("resetOf")}; return resetOf;`)(L);
  const now = new Date(2026, 10, 25, 13, 47).getTime();
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime() / 1000;
  assert.deepEqual(resetOf(at(2026, 10, 25, 16, 0), now), ["11/25 16:00", "2 時間 13 分"]);
  assert.deepEqual(resetOf(at(2026, 10, 25, 13, 52), now), ["11/25 13:52", "5 分"]);
  assert.deepEqual(resetOf(at(2026, 10, 28, 15, 47), now), ["11/28 15:47", "3 日 2 時間"]);
  assert.deepEqual(resetOf(at(2026, 10, 25, 13, 0), now)[1], "0 分");
});
