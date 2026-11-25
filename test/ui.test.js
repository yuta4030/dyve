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
let LINK_RULES = [];
${["linkify", "inline", "codeBlock", "md"].map(grab).join("\n")};
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
