// dyve がセッションに貸す道具（MCP の口）。セッションごとに /mcp/<鍵>/<セッション> を渡し、Streamable HTTP の最小限で答える
//   ask：人に聞く（質問・背景・選択肢ごとの効き目・おすすめ）。画面の下に一問ずつ出る
//   state：決まったこと・まだのことの木を書く。画面の右上に出る
// 鍵は起動ごとに作る（ほかのプロセスから書かれないように）

const clip = (s, n) => { s = String(s ?? "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export const TOOLS = [
  {
    name: "ask",
    description: [
      "人に決めてもらうことがあるときに使う。人の画面の下に、質問が一問ずつ出て、人は選択肢を押して答える（自由に書くこともできる）。",
      "質問ごとに、なぜ聞くのか（背景）と、選択肢ごとにそれを選ぶと何が変わるか（効き目）を、人がそれだけ読んで決められるように文で書く。勧めるものがあれば recommended にする。",
      "答えは、人の次の発言として届く。呼んだあと、答えを待たずに進められることがなければ、そこでターンを終える。呼ぶたびに、前の質問は置き換わる。",
    ].join(""),
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "短い見出し（10 字くらい）" },
              why: { type: "string", description: "なぜ聞くのか。決めるのに要る背景" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 6,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "選択肢の名前（短く）" },
                    effect: { type: "string", description: "それを選ぶと何が変わるか" },
                    recommended: { type: "boolean" },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["title", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "state",
    description: [
      "決まったことと、まだ決まっていないことを、話題ごとの木で書く。人は画面の右上でこれを見て、いまどこまで決まったかを知る。",
      "決まったことやまだのことが増えたり変わったりしたときに、木の全体を書き直して呼ぶ。項目ごとに、中身と、なぜそうなったか・どこで決まったかを一言添える。",
      "まだのことが ask の質問で聞いているものなら、ask にその質問の番号（1 から）を書く。",
    ].join(""),
    inputSchema: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "話題の名前" },
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  properties: {
                    done: { type: "boolean", description: "決まったなら true" },
                    name: { type: "string" },
                    value: { type: "string", description: "決まった中身" },
                    why: { type: "string", description: "なぜそうなったか、どこで決まったか" },
                    ask: { type: "integer", description: "聞いている質問の番号（1 から）" },
                  },
                  required: ["done", "name"],
                },
              },
            },
            required: ["name", "items"],
          },
        },
      },
      required: ["groups"],
    },
  },
];

// 受け取ったものを、記録に置ける形に整える（長すぎるものは切る）
export function questionsOf(args) {
  const qs = Array.isArray(args?.questions) ? args.questions : [];
  return qs.slice(0, 6).map((q) => ({
    title: clip(q?.title, 40),
    why: clip(q?.why, 600),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o?.label, 60), effect: clip(o?.effect, 300), ...(o?.recommended ? { recommended: true } : {}) })).filter((o) => o.label),
  })).filter((q) => q.title && q.options.length);
}

export function groupsOf(args) {
  const gs = Array.isArray(args?.groups) ? args.groups : [];
  return gs.slice(0, 12).map((g) => ({
    name: clip(g?.name, 40),
    items: (Array.isArray(g?.items) ? g.items : []).slice(0, 20).map((it) => ({
      done: !!it?.done,
      name: clip(it?.name, 40),
      ...(it?.value ? { value: clip(it.value, 200) } : {}),
      ...(it?.why ? { why: clip(it.why, 300) } : {}),
      ...(Number.isInteger(it?.ask) && it.ask > 0 ? { ask: it.ask } : {}),
    })).filter((it) => it.name),
  })).filter((g) => g.name);
}

// JSON-RPC の一通に答える。返すのは送り返すもの（通知なら null）
export function answer(log, session, m) {
  const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
  if (m?.id === undefined) return null; // 通知（notifications/initialized など）
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "dyve", version: "1" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (!log.state.sessions.some((x) => x.id === session)) return fail(-32602, "そのセッションはない");
      const name = m.params?.name, args = m.params?.arguments ?? {};
      if (name === "ask") {
        const questions = questionsOf(args);
        if (!questions.length) return ok({ content: [{ type: "text", text: "質問が読めなかった。title と、2 つ以上の options（label）を書いて呼び直して" }], isError: true });
        log.add("asks", { session, questions });
        return ok({ content: [{ type: "text", text: `${questions.length} 問を人の画面に出した。答えは人の次の発言で届く` }] });
      }
      if (name === "state") {
        log.add("tree", { session, groups: groupsOf(args) });
        return ok({ content: [{ type: "text", text: "人の画面の右上に出した" }] });
      }
      return fail(-32602, `知らない道具：${name}`);
    }
    default:
      return fail(-32601, `知らない呼び出し：${m.method}`);
  }
}
