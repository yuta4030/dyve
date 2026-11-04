// MCP の口：エージェントがボードを読み書きする入口。人と同じ操作だけを出す。
// Streamable HTTP の POST だけを受け、JSON で返す（ストリームは使わない）
import { isPerson, marks } from "./board.js";

const VERSION = "0.1.0";
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
    name: "panel_history",
    description: "あるパネルへの操作の履歴（清書の前の文など）",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const INSTRUCTIONS =
  "人が声で流し込んだ思考を置くボード。パネルの並びでできていて、変更は panel_add・panel_edit・panel_drop だけ。" +
  "どの操作にも reason を付ける。人がピン留めしたものは変えない。答えを人に求めて待たない。";

export function boardView(store, waker, { since, about } = {}) {
  const board = store.board;
  let panels = board.list();
  if (about) panels = panels.filter((p) => p.id === about || p.about === about);
  if (since != null) panels = panels.filter((p) => p.rev > since);
  return {
    seq: board.seq,
    panels,
    marks: marks(board, { running: waker?.runningTasks() ?? [] }),
    live: waker?.status() ?? null,
    names: waker?.names ?? [],
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

function call(store, waker, as, name, args = {}) {
  const { reason: why, ...rest } = args;
  switch (name) {
    case "board_read":
      return boardView(store, waker, rest);
    case "panel_history":
      return store.board.history(rest.id);
    case "panel_add":
    case "panel_edit":
    case "panel_drop": {
      if ("data" in rest) rest.data = unwrapData(rest.data);
      const r = store.apply({ by: as, type: name.slice(6), panel: rest, reason: why });
      return r.ok ? { ok: true, seq: r.op.seq, id: r.op.panel.id } : r;
    }
    default:
      throw Object.assign(new Error(`知らない道具：${name}`), { rpc: -32602 });
  }
}

// 一つの JSON-RPC メッセージに答える。通知なら null
export function handleRpc(store, waker, as, msg) {
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
      try {
        const out = call(store, waker, as, msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], isError: out?.ok === false });
      } catch (e) {
        return e.rpc ? fail(e.rpc, e.message) : reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
