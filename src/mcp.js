// MCP の口：エージェントがボードを読み書きする入口。人と同じ操作だけを出す。
// Streamable HTTP の POST だけを受け、JSON で返す（ストリームは使わない）
import { isPerson, marks } from "./board.js";
import { legend, boardPng, changeLayout, layoutPanel } from "./view.js";

const VERSION = "0.2.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const reason = { type: "string", description: "なぜこの操作をするのか。人が後から読む" };
const panelFields = {
  view: { type: "string", description: "描き方：本体の say（発言）, text（文字列）, list（文字列の配列）, table（{columns, rows}）, task（仕事：{text, to?, from?}）, topic（話題：{title, note?}。仕事を束ねる）, summary（いまの要点：{points, decided, open}）, json。ほかに利用者のパネル置き場（~/.dyve/panels/views/<名前>.js）の view を名前で使える" },
  data: {
    type: ["string", "array", "object", "number", "boolean", "null"],
    description: "中身。JSON の値をそのまま渡す（文字列を引用符でくるんで二重にしない）。形は view ごと：say・text・md は文字列、list・checklist は配列、table は {columns, rows}、task は {text, to?}、summary は {points, decided, open}",
  },
  about: { type: "string", description: "どのパネルについてのものか（関係する場所に置く）" },
  state: { type: "string", enum: ["task", "proposal", "done"], description: "仕事・提案・済み" },
  source: { type: "object", description: "データを shell コマンドの結果から流し込む：{ shell, every? }（every は秒、5 以上）。AI が置いたコマンドは、人が許可するまで走らない" },
};

export const TOOLS = [
  {
    name: "board_read",
    description: "ボードを読む。since を渡すと、その seq より後に変わったパネルだけ。about を渡すと、そのパネルとそれについてのパネルだけ",
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
    inputSchema: { type: "object", properties: { id: { type: "string" }, rev: { type: "integer" }, ...panelFields, reason }, required: ["id", "reason"] },
  },
  {
    name: "panel_drop",
    description: "パネルを外す。人が置いたもの・ピン留めされたものは外せない",
    inputSchema: { type: "object", properties: { id: { type: "string" }, reason }, required: ["id", "reason"] },
  },
  {
    name: "board_view",
    description: "ボード全体を絵で見る。タイルの枠と番号の PNG と、タイルと話題の中のパネルの対応表を返す。橙の太枠は人が固定したタイル。real: true なら、人が見ている画面に近い本当の絵も付ける（ブラウザがあるときだけ）",
    inputSchema: { type: "object", properties: { real: { type: "boolean" } } },
  },
  {
    name: "panel_view",
    description: "パネル一枚の本当の見た目を絵で見る。話題なら中のパネルの並びごと。ブラウザがない環境では絵の代わりに中身を返す",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "board_layout",
    description: "画面の見た目を変える。人が画面でできることは全部できる（固定する・外すだけは人のもの）。人が固定したタイルとピン留めしたパネル、その中のものは変えられず refused で返る。それ以外はいつでもどれだけ変えてよい。key・id は board_view の対応表のもの",
    inputSchema: { type: "object", properties: {
      moves: { type: "object", description: "タイルを動かす・大きさを変える：{ key: { x?, y?, w?, h? } }（ます目。w・h は 2 以上）" },
      min: { type: "object", description: "タイルを最小化する・戻す：{ key: true|false }" },
      hidden: { type: "object", description: "タイルを閉じる・開き直す：{ key: true|false }（dyve 設定は閉じられない）" },
      zoom: { type: "object", description: "タイルの中身の拡大率：{ key: 0.1〜5 }" },
      tiles: { type: "object", description: "パネルをタイルに出す・なくす：{ add?: [パネルの id], remove?: [panel:<id> の key] }" },
      panels: { type: "object", description: "話題の中のパネル：{ id: { x?, y?, w?, h?, position?, size?, min?, unfold? } }。x・y・w・h は話題の中のます目（h: null は中身の高さ）、position: null で自動の並びへ戻す、size は [幅, 高さ]（ピクセル。null で戻す）、min で最小化、unfold で済みのものを開く・畳む" },
      density: { type: "integer", enum: [12, 24, 48], description: "ます目の細かさ。全体が同じ見た目の大きさで直る。固定したものがあると変えられない" },
      reset: { type: "boolean", description: "並びを既定に戻す（固定したものは残す）" },
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
];

const INSTRUCTIONS =
  "人が声で流し込んだ思考を置くボード。パネルの並びでできていて、変更は panel_add・panel_edit・panel_drop・board_layout・word_add だけ。絵は board_view（全体）と panel_view（一枚）で見る。" +
  "どの操作にも reason を付ける。人がピン留めしたものは変えない。答えを人に求めて待たない。";

export function boardView(store, waker, { since, about } = {}) {
  const board = store.board;
  const all = board.list();
  const lp = all.find((p) => p.view === "layout");
  let panels = all.filter((p) => p !== lp);
  if (about) panels = panels.filter((p) => p.id === about || p.about === about);
  if (since != null) panels = panels.filter((p) => p.rev > since);
  return {
    seq: board.seq,
    panels,
    layout: lp ? { id: lp.id, rev: lp.rev, data: lp.data } : null,
    marks: marks(board, { running: waker?.runningTasks() ?? [] }),
    live: waker?.status() ?? null,
    names: waker?.names ?? [],
    initials: waker?.initials ?? {},
    calls: waker?.calls ?? {},
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

function call(store, waker, as, name, args = {}, offView, words) {
  const { reason: why, ...rest } = args;
  switch (name) {
    case "board_read":
      return boardView(store, waker, rest);
    case "panel_history":
      return store.board.history(rest.id);
    case "board_layout":
      return changeLayout(store, as, rest, why);
    case "word_add":
      if (!words) return { ok: false, code: "not_found", message: "辞書がない" };
      return words.add({ by: as, heard: rest.heard, write: rest.write, when: rest.when, reason: why });
    case "panel_add":
    case "panel_edit":
    case "panel_drop": {
      if ("data" in rest) rest.data = unwrapData(rest.data);
      if (name !== "panel_drop" && rest.view && offView?.(rest.view)) return { ok: false, code: "invalid", message: `view ${rest.view} は人が「使わない」にしている。text や list など別の view で置く` };
      const r = store.apply({ by: as, type: name.slice(6), panel: rest, reason: why });
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
async function boardPicture(store, real, shoot) {
  const lg = legend(store.board);
  if (!lg) return { content: [asText({ ok: false, code: "not_found", message: "置き場所がまだない（画面が一度も開かれていない）" })], isError: true };
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
// パネルの絵の幅：タイルになっているなら、その幅で撮る（話題の中の並びは幅で変わる）
function shotSize(board, id) {
  const d = layoutPanel(board)?.data, sx = d?.metric?.sx, sy = d?.metric?.sy;
  let p = board.get(id);
  while (p?.about && board.get(p.about)) p = board.get(p.about);
  const pos = d?.pos && Object.entries(d.pos).find(([k]) => k.endsWith(`/${id}`) || k === `panel:${id}` || k.endsWith(`/${p?.id}`))?.[1];
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

export function handleRpc(store, waker, as, msg, { offView, words, shoot } = {}) {
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
      if (msg.params?.name === "board_view") return boardPicture(store, msg.params?.arguments?.real, shoot).then(reply);
      if (msg.params?.name === "panel_view") return panelPicture(store, msg.params?.arguments?.id, shoot).then(reply);
      try {
        const out = call(store, waker, as, msg.params?.name, msg.params?.arguments, offView, words);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], isError: out?.ok === false });
      } catch (e) {
        return e.rpc ? fail(e.rpc, e.message) : reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
