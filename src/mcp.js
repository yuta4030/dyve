// MCP の口：エージェントがボードを読み書きする入口。人と同じ操作だけを出す。
// Streamable HTTP の POST だけを受け、JSON で返す（ストリームは使わない）
import { isPerson, marks, layoutOf, turnOf } from "./board.js";
import { legend, boardPng, changeLayout, layoutPanel } from "./view.js";

const VERSION = "0.8.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const reason = { type: "string", description: "なぜこの操作をするのか。人が後から読む" };
const panelFields = {
  view: { type: "string", description: "描き方：本体の say（発言）, text, list, table, task（仕事）, topic（話題。仕事を束ねる）, summary（要点の三つの欄）, json。ほかに利用者のパネル置き場（~/.dyve/panels/views/<名前>.js）の view を名前で使える（使えるものとデータの形は view_list）。人が「使わない」にした view は断られるので、そのときは text や list で置く" },
  data: {
    type: ["string", "array", "object", "number", "boolean", "null"],
    description: "中身。JSON の値をそのまま渡す（文字列を引用符でくるんで二重にしない）。形は view ごと：say・text・md は文字列、list・checklist は文字列の配列、table は {columns, rows}、task は {text, from?, to?, team?, write?}、topic は {title, note?}、summary は {points, decided, open}（項目は文字列か {text, from: [元の発言の id]}）",
  },
  about: { type: "string", description: "どのパネルについてのものか（関係する場所に置く）" },
  state: { type: "string", enum: ["task", "proposal", "done"], description: "仕事・提案・済み" },
  source: { type: "object", description: "データを shell コマンドの結果から流し込む：{ shell, every? }（every は秒、5 以上）。AI が置いたコマンドは、人が許可するまで走らない" },
  send: { type: "object", description: "パネルから外へ送り出す：{ shell, label? }（label は「送る」のボタンの字、40 字まで）。人が画面で書いて「送る」を押すと、その入力を標準入力に渡して shell コマンドを走らせる（文字列はそのまま、ほかは JSON。環境変数 DYVE_PANEL にパネルの id）。送るのは人だけで、AI が置いたコマンドは人が許可するまで走らない。null で外す" },
  rel: { type: "object", description: "ほかのパネルとの関係：{ kind: compare（比べる）| sequence（順番。並びは置いた順）, with: [id] }。with は同じものについての（about が同じ）パネル。画面は組を横に並べる。null で外す" },
  line: { type: "string", description: "行（表の中の仕事）に帰す一行：答えか、いまどこまで来たか。200 字まで（ふつうは 60 字くらい）。null で外す" },
  decided: { type: "string", description: "行で人が決めたこと（「今日やる」「見送り」）。120 字まで。null で外す" },
  wait: { type: "object", description: "行を条件つきの待ちにする：{ text, until?, after? }。until は日時（ISO 8601）、after は先に済ませる行の id。条件が満たされると、ボードが人の番で帰す。null で外す" },
};

export const TOOLS = [
  {
    name: "board_read",
    description: "ボードを読む。since を渡すと、その seq より後に変わったパネルだけ。about を渡すと、そのパネルとそれについてのパネルだけ。marks は印、turns は行の番（ai・you・back・ok・wait）、live はいまの状況（動いているエージェント・残量）、focus は人のいま（presence・listening・viewing・inside・talking・followingTalk・unseen）",
    inputSchema: { type: "object", properties: { since: { type: "integer" }, about: { type: "string" } } },
  },
  {
    name: "panel_add",
    description: "パネルを置く",
    inputSchema: { type: "object", properties: { ...panelFields, reason }, required: ["view", "reason"] },
  },
  {
    name: "panel_edit",
    description: "パネルを書き換える。渡した項目だけ変わる。元の中身は操作ログに残る。rev を渡すと、あいだに変更があれば断られる",
    inputSchema: { type: "object", properties: { id: { type: "string" }, rev: { type: "integer" }, ...panelFields, from: { type: "array", items: { type: "string" }, description: "この書き換えの元になった人の発言の id。人が声で提案を受け入れたとき（「それでいいよ」）は、その発言を付けて state を done にする（マネージャだけ）" }, reason }, required: ["id", "reason"] },
  },
  {
    name: "panel_drop",
    description: "パネルを外す。人が置いたもの・ピン留めされたものは外せない",
    inputSchema: { type: "object", properties: { id: { type: "string" }, reason }, required: ["id", "reason"] },
  },
  {
    name: "board_view",
    description: "画面の並びを絵で見る。画面に並ぶパネルの枠と番号の PNG と、対応表（top：画面に並ぶパネル。auto は画面が自動で並べたもの、floating は浮かせているもの（絵には描かない）、inner：話題の中のパネル）を返す。橙の太枠は人がピン留めしたもの。real: true なら、人が見ている画面に近い本当の絵も付ける（ブラウザがあるときだけ）",
    inputSchema: { type: "object", properties: { real: { type: "boolean" } } },
  },
  {
    name: "panel_view",
    description: "パネル一枚の本当の見た目を絵で見る。話題なら中のパネルの並びごと。ブラウザがない環境では絵の代わりに中身を返す",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "board_layout",
    description: "画面の並びを変える。ふだんは要らない：並びは画面が、いまの話題・印・新しさと、中身の形と量から決める。外れたときだけ使う。人が画面でできることは全部できる（ピン留めだけは人のもの）。ピン留めされたものとその中は変えられず refused で返る。key は board_view の対応表のもの（組み込みのパネルの名前か、パネルの id）",
    inputSchema: { type: "object", properties: {
      moves: { type: "object", description: "動かす・大きさを変える：{ key: { x?, y?, w?, h? } }（ます目。w・h は 2 以上）。動かしたものはその場所に留まり、自動の並びから外れる。position: null で自動の並びへ戻す。話題の中のパネルなら話題の中のます目で、h: null は中身の高さ、size: [幅, 高さ]（ピクセル。null で戻す）も使える" },
      fold: { type: "object", description: "畳む・開く：{ key: true|false }。畳むと見出しだけ残る。済みの仕事と話題は、何も言わなければ畳まれる" },
      zoom: { type: "object", description: "画面に並ぶパネルの中身の拡大率：{ key: 0.1〜5 }" },
      float: { type: "object", description: "浮かせる（talk・status・quota・tools）：{ mode?: front|off（既定は front）, pos?: { key: { left か right, top か bottom, w, h? } | null }, zoom?: { key: 0.1〜5 } }。pos はピクセル（近い端からの距離。h を省くと中身の高さ。null で既定の場所）" },
      out: { type: "object", description: "面を開く・閉じる：{ 行（話題の中の仕事）の id: true|false }。開くと、その行について置かれたものが表の隣に面として出る。ほかの話題の中のパネルなら、取り出すと画面に一枚で並ぶ" },
      density: { type: "integer", enum: [12, 24, 48], description: "ます目の細かさ。全体が同じ見た目の大きさで直る。ピン留めしたものがあると変えられない" },
      reset: { type: "boolean", description: "並びを既定に戻す。全部が自動の並びに戻る（ピン留めしたものは残す）" },
      reason,
    }, required: ["reason"] },
  },
  {
    name: "word_add",
    description: "辞書（全部のボードで共通）に、音声認識が聞き違える言葉を足す。清書係が次の発言から使う。人が書いた項目と、人が消した言葉は変えられない",
    inputSchema: { type: "object", properties: { heard: { type: "string", description: "聞こえた形" }, write: { type: "string", description: "正しい書き方" }, when: { type: "string", description: "ふつうの言葉でもあるときの条件（例：dyve の話のときだけ）" }, reason }, required: ["heard", "write", "reason"] },
  },
  {
    name: "panel_history",
    description: "あるパネルへの操作の履歴（清書の前の文など）",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "view_list",
    description: "使える view と、それぞれのデータの形を読む。builtin は本体の view、user は利用者のパネル置き場の view（about はファイルの頭のコメント。データの形が書いてある）。人が「使わない」にしたものは出ない",
    inputSchema: { type: "object", properties: {} },
  },
];

// ボードの決まりはここに一つだけ書く。どのエージェントも MCP の説明として読む。役ごとの定義（agents・skills）には役割だけを書く
const INSTRUCTIONS = `ボード：人が声で流し込んだ思考を置く場所。パネルの並びでできている。人も AI も同じ操作で書く。
書く操作は panel_add・panel_edit・panel_drop・board_layout・word_add だけ。読むのは board_read と view_list（使える view とデータの形）、絵で見るのは board_view（全体）と panel_view（一枚）。

## パネル
- 形は { id, by, view, data, about?, state?, rel?, point?, pinned, source?, send?, key?, line?, decided?, wait? }。id は一度振ったら変わらない。view ごとの data の形は panel_add の説明のとおり
- 結果は中身に合った view で置く。変更（ブランチ・差分）、ファイルや場所の一覧、日ごとの予定、列に分けた札のように形のあるものは、view_list で利用者の view とデータの形を見て、その view と形のデータで置く（文章にして text に入れない）。合うものがなければ text・list・table
- source は入ってくる口（shell コマンドの結果がデータになる）、send は出ていく口（人が送った入力が shell コマンドに渡る）。どちらも、走らせてよいかは人が決める。送ったものは、そのパネルに about した人の text として残る
- about：どのパネルについてのものか。関係するパネルに about して置く
- rel：比べるもの（compare。案 A と案 B など）・順番のあるもの（sequence。手順や、順にやる仕事）を置くときに、同じものについてのパネルを with に入れる。画面はその組を横に並べる
- 話題（view topic、about なし、data { title, note? }）は仕事を束ねる。仕事は view task・state task で話題に about して置き、元の発言は data.from に id の配列で持つ
- state：task（仕事）→ proposal（提案。受け入れるのは人だけ）／done（AI の手を離れた）

## 行と面
- 話題は表で、中の仕事が表の行になる。行の記号（key：A, B, …。面の中の行は F1, F2）はボードが振る。人は声で「A は今日やる」と呼ぶ
- 投げたものの結末は、投げた行に帰る：仕事を受けた人は、終わったら行に line（答えの一行）と state done を書く。新しいパネルを足して返さない。時間がかかるときは、line を「いまどこまで来たか」に書き換える
- 一行に収まらないもの（比べる案、人が先に決めること、出典の並び）だけ、仕事に about して置く。行から開ける面になり、面の中で人は考えて喋る。面の中の呼び出しは、その行に about した仕事（行の中の行）
- まだ決まっていない問い（人が迷っていること・案のまま決めていないこと）は、話題の表の人の番の行にする（view task・state done・line に問いの一行）。人は行の記号で「E は見送り」と決める
- 話題の data.note は「いまどこまで来たか」の一行。話が進んだら書き換える
- 行の状態は誰の番かで、ボードが導く（turn）：AI の番（state task）、人の番（問いの行・提案・止まった・待ちが明けた）、帰った（back。仕事として投げた行に結果の line が帰った。読むだけで、人のやることはない。下に提案や問いの行があれば人の番）、決まった（decided）、待ち（wait）。帰った行を「読むだけ」と decided に書いて消さない。同じ行で何往復もする。決まったあとも、実行に移れば state を task に戻す（AI の番）
- 控室の人への言葉は、その仕事に about して text（data { to: 名前, text }）で置く。働いていれば途中で拾う。もう終えていれば、ボードが行を AI の番に戻してその人を起こし、答えは同じ行に帰る。to のない text は誰も起こさない
- 人が行で決めたこと（「今日やる」「見送り」）は decided に書く。条件つきの待ち（「明日まで」「B のあと」）は wait { text, until?, after? }。条件が満たされると、ボードが人の番で帰す
- 人が声で提案を受け入れたら（「それでいいよ」）、マネージャがその発言を from に付けて、提案の state を done にする
- 人の発言は view say・by human。書き換えるのは清書係だけ
- point：人がその発言をしたときに指していたパネル（{ id, how }。画面が付け、AI は付けられない）。「これ」「それ」はまずここを指すと読む。how が hover（マウスの下）・view（見ていたまん中）は手がかりで、話が合わなければ無視する。pick は「これにする」を押して選んだという人の決定

## 画面
- 人の発言はトークに出る。話題は表になり、中の仕事が一行ずつ並ぶ。ほかのものは about のないパネルごとに一枚にまとまり、about したものはその中に出る
- 行の下（面の中のどの深さでも）にある提案と、AI の番の仕事は、表のその行の下に一段字下げして出る。人は面を開かずに、表で受け入れられる。表に「…」がなければ、何も動いていない
- 表は動かない。行が開くと、その行について置かれたものが表の隣に面として出て、行と線でつながる。決まった行の面は、ボードが行に畳む（行の ▸ からいつでも開き直せる）
- 面は役割で並ぶ：頭に行の番と結論の一行、左にやること（行の中の行と、行に置かれた提案・仕事を番ごとの札に）、まん中に主役（AI が置いたいちばん新しい結果）、右に残り（新しい順。多いと古いものは一行に畳む）。行の中の行の結果も、その行の記号つきで面に出る。パネルの見出しは中身の種類で、置いた人は小さな丸。だから結果は一枚ごとに一つの種類にし、いちばん見てほしいものを最後に置く。面の中で置き場所を決めたもの（board_layout の moves）はその場所に残る
- 面を開く・閉じるはマネージャが人の話についていって決める（board_layout の out）。人がその行の話を始めたら開く。返ってきた結果だけで面を開かない（先回りしない）。閉じるのは、人がいま話している行の面でなければいつでもよい（話が別の行に移った、面が増えて表が見づらい）。中で動いているものや提案は表の 2 段目に出るので、閉じても見失わない
- 並びは画面が決める：いまの話題を先頭に大きく、次に印のあるもの、新しいもの、済み（畳む）の順に詰める。幅は中身の形（表は列の数、文章は読みやすい幅）から、高さは中身の量から。読んでいるパネルは画面の同じ位置に残る。並べる手間は要らない。置くときは関係するパネルに about し、組には rel を付けるだけ
- board_layout は、画面の並びが外れたとき（見せたいものが遠い・大きさが合わない）だけ使う。動かしたものはそこに留まる。人がピン留めしたものとその中は変わらない
- 人は一瞥で読む。文章を書かず、短い list・table を選ぶ。一枚は数行まで
- 畳んだパネルは見出しの一行だけが見える：仕事は結果の一行目、話題は data.note、ほかは中身の一行目。だから結果は結論の一行から始める
- 人がまだ見ていない変更は、変わった行だけに色が付く（summary・list・table。前に見たときとの差を画面が導く）。書き換えるときは、変わらない行を言い換えず、そのまま残す
- 比べるもの（rel compare）には「これにする」が出て、人は押して選べる。選んだことは人の発言（point.how が pick）として届き、画面は選ばれたものに印を付ける
- いまの要点と「いま」の枠はなくした（決まったこと・問いは行に、いまどこまでは話題の note にある）。前の版が置いた summary は、ふつうのパネルとして畳んで並ぶ。新しく summary を置いて要点をまとめ直さない
- 画面に並ぶものは全部パネル（トーク・状況・残量・dyve 設定も組み込みのパネル）
- パネルは about を変えれば移せる（話題から話題へ、about を null で外へ）。いくつかを一枚にまとめるときは、親にする topic を置いて about を寄せる
- トーク・いま・状況・残量・dyve 設定は浮いていて、ボードのどこを見ていても画面に出ている。ボードの拡大縮小は掛からない。浮かせ方は前面（front。既定。画面に留めて重ねる）・並べる（off。ます目に並べる）

## 人のいま
- 起こされたときの文や board_read の focus に、人のいまが付く：いる・離れている、聞いているか、見ているパネル（viewing・inside）、話している話題（talking）、まだ見ていないもの（unseen）
- 話している話題と見ているものに関係することを先にする。人がもう別の話に移った仕事の結果は、結論の一行にとどめる
- まだ見ていないものが溜まっているときは、新しく置くより、まとめる・畳む

## 印
- 行の番（turn）が、表の中での印の役目を持つ
- 印はボードが導く。未着手＝結果のない仕事、受け入れ待ち＝提案と許可待ちのコマンド、知らせ＝人が最後に見たあとに AI が置いた・変えたもの。置けば知らせになるので、印を付ける操作はない。知らせは、人が画面で読めば（押さなくても）消える

## 守ること
- どの操作にも reason（人が後から読む）を付ける
- 人に質問して答えを待たない。聞きたいことは関係するパネルに about して短く置く
- 「それ」「それでいい」は、指したもの（point）がなければ、いちばん新しく届いたもの（行に帰った一行・置かれた提案）を指す
- 人がいま考えているところについていく。古い話を蒸し返さない
- ピン留めされたものは変えない。人が置いたパネルは外せない。人が書き換えた直後のものに手を入れない
- ボードに書くのはこの MCP の口からだけ。画面の口（/api/…）と dyve put・dyve add は人のものなので使わない
- 行の次の一手が外に届くこと（push・取り込み・送信・起票など）なら、行に結果を帰すときに、その提案も一緒に置く（人が「やっていいよ」と言う前に、受け入れる口を出しておく）
- 外に届くこと（push・送信・起票など）はしない。要るなら state proposal で置き、人に決めてもらう。提案には、受け入れたら何をするか（コマンド・宛先・中身）をそのまま書く。人が受け入れると、提案を置いた人に仕事（data.accepted）として戻ってくるので、そのときは提案の範囲でやる。見送るときは人が外す
- 少なく、短く`;

// focus：人のいま（なければ起こし係のもの）
export function boardView(store, waker, { since, about } = {}, focus = waker?.focus) {
  const board = store.board;
  const all = board.list();
  const lp = all.find((p) => p.view === "layout");
  let panels = all.filter((p) => p !== lp);
  if (about) panels = panels.filter((p) => p.id === about || p.about === about);
  if (since != null) panels = panels.filter((p) => p.rev > since);
  return {
    seq: board.seq,
    panels,
    layout: lp ? { id: lp.id, rev: lp.rev, data: layoutOf(lp.data, board.panels) } : null,
    marks: marks(board, { running: waker?.runningTasks() ?? [] }),
    // 行の番（話題の中の仕事）：ai・you・back・ok・wait
    turns: Object.fromEntries(all.filter((p) => p.view === "task").map((p) => [p.id, turnOf(board, p)])),
    live: waker?.status() ?? null,
    names: waker?.names ?? [],
    initials: waker?.initials ?? {},
    calls: waker?.calls ?? {},
    focus: focus?.view(board) ?? null,
  };
}

// エージェントは文字列を JSON の文字列リテラルのまま（"\"…\""）渡してくることがある。丸ごと JSON の文字列として読めるときだけほどく
export function unwrapData(data) {
  for (let i = 0; i < 3 && typeof data === "string" && /^\s*"[\s\S]*"\s*$/.test(data); i++) {
    try {
      const v = JSON.parse(data);
      if (typeof v !== "string") break;
      data = v;
    } catch {
      break;
    }
  }
  return data;
}

// 本体の view とデータの形（panel_add の data の説明と同じ）
const BUILTIN_VIEWS = [
  { name: "text", about: "文字列" },
  { name: "list", about: "文字列の配列" },
  { name: "table", about: "{ columns: [列の名前], rows: [[値]] }" },
  { name: "json", about: "どんな JSON でも（そのまま見せる）" },
  { name: "task", about: "{ text, from?, to?, team?, write? }（仕事）" },
  { name: "topic", about: "{ title, note? }（話題）" },
  { name: "summary", about: "{ points, decided, open }（要点の三つの欄。前の版のボードに残っているもの）" },
  { name: "say", about: "文字列（人の発言）" },
];

function call(store, waker, as, name, args = {}, offView, words, focus, views) {
  const { reason: why, ...rest } = args;
  switch (name) {
    case "board_read":
      return boardView(store, waker, rest, focus);
    case "panel_history":
      return store.board.history(rest.id);
    case "view_list":
      return { builtin: BUILTIN_VIEWS, user: views?.() ?? [] };
    case "board_layout":
      return changeLayout(store, as, rest, why, focus?.tiles());
    case "word_add":
      if (!words) return { ok: false, code: "not_found", message: "辞書がない" };
      return words.add({ by: as, heard: rest.heard, write: rest.write, when: rest.when, reason: why });
    case "panel_add":
    case "panel_edit":
    case "panel_drop": {
      if ("data" in rest) rest.data = unwrapData(rest.data);
      if (name !== "panel_drop" && rest.view && offView?.(rest.view)) return { ok: false, code: "invalid", message: `view ${rest.view} は人が「使わない」にしている。text や list など別の view で置く` };
      const { from, ...panel } = rest;
      const r = store.apply({ by: as, type: name.slice(6), panel, reason: why, ...(name === "panel_edit" && from != null ? { from } : {}) });
      return r.ok ? { ok: true, seq: r.op.seq, id: r.op.panel.id } : r;
    }
    default:
      throw Object.assign(new Error(`知らない道具：${name}`), { rpc: -32602 });
  }
}

// 一つの JSON-RPC メッセージに答える。通知なら null
// offView(view)：人が「使わない」にした view か。ログを当て直すときには関係ないので、ボードではなくこの口で断る
const asText = (v) => ({ type: "text", text: JSON.stringify(v) });
const asImage = (buf) => ({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
async function boardPicture(store, focus, real, shoot) {
  const lg = legend(store.board, focus?.tiles());
  if (!lg) return { content: [asText({ ok: false, code: "not_found", message: "並びがまだない（画面が一度も開かれていない）" })], isError: true };
  const content = [asImage(boardPng(lg)), asText(lg)];
  if (real) {
    try {
      if (!shoot) throw new Error("ブラウザがない");
      content.push(asImage(await shoot("board", { width: 1400, height: 900 })));
    } catch (e) {
      content.push(asText({ real: false, message: `本当の絵は撮れなかった（${e.message}）` }));
    }
  }
  return { content };
}
// パネルの絵の幅：画面に並んでいるなら、その幅で撮る（話題の中の並びは幅で変わる）
function shotSize(board, id) {
  const lp = layoutPanel(board), d = lp && layoutOf(lp.data), sx = d?.metric?.sx, sy = d?.metric?.sy;
  let p = board.get(id);
  while (p?.about && board.get(p.about)) p = board.get(p.about);
  const pos = d?.pos?.[id] ?? d?.pos?.[p?.id];
  return pos && sx && sy ? { width: Math.max(320, pos.w * sx + 24), height: Math.min(1600, Math.max(320, pos.h * sy + 24)) } : { width: 900, height: 800 };
}
async function panelPicture(store, id, shoot) {
  const panel = store.board.get(id);
  if (!panel) return { content: [asText({ ok: false, code: "not_found", message: "そのパネルはない" })], isError: true };
  if (shoot) {
    try {
      return { content: [asImage(await shoot(id, shotSize(store.board, id))), asText({ ok: true, id, view: panel.view })] };
    } catch (e) {
      return { content: [asText({ ok: true, picture: false, message: `絵を撮れなかった（${e.message}）`, panel })] };
    }
  }
  return { content: [asText({ ok: true, picture: false, message: "ブラウザがないので絵は撮れない", panel })] };
}

export function handleRpc(store, waker, as, msg, { offView, words, shoot, focus = waker?.focus, views } = {}) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "board", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (isPerson(as) || as === "board") {
        return reply({ content: [{ type: "text", text: JSON.stringify({ ok: false, code: "forbidden", message: "MCP から人やボード自身として書くことはできない" }) }], isError: true });
      }
      if (msg.params?.name === "board_view") return boardPicture(store, focus, msg.params?.arguments?.real, shoot).then(reply);
      if (msg.params?.name === "panel_view") return panelPicture(store, msg.params?.arguments?.id, shoot).then(reply);
      try {
        const out = call(store, waker, as, msg.params?.name, msg.params?.arguments, offView, words, focus, views);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], isError: out?.ok === false });
      } catch (e) {
        return e.rpc ? fail(e.rpc, e.message) : reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
