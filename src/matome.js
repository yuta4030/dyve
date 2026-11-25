// まとめ：セッションのターンが終わるたびに、そのセッションの要約と、人が押すだけで答えられる選択肢を書く
// 係と同じく道具を持たない Claude Code（速いモデル）に聞く。セッションそのものには何も足さない
import { fileURLToPath } from "node:url";

export const PROMPT = fileURLToPath(new URL("../prompts/まとめ.md", import.meta.url));
export const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    choices: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, say: { type: "string" } }, required: ["label", "say"] },
    },
  },
  required: ["summary", "choices"],
};
// まとめに渡すやりとりの長さ（新しいほうを残す）
const MOST = 12000;
const EACH = 2000;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// まとめに渡す一通：人の頼みと AI の言葉（道具は省く）。最後の答えは切らずに渡す
export function briefPrompt(x) {
  const talk = x.flow.filter((f) => f.who === "human" || f.who === "ai");
  const lines = talk.map((f, i) => `${f.who === "human" ? "人" : "AI"}：${i === talk.length - 1 ? f.text : clip(f.text, EACH)}`);
  let body = "";
  for (let i = lines.length - 1; i >= 0 && body.length < MOST; i--) body = `${lines[i]}\n\n${body}`;
  return `セッション「${x.name}」のやりとり：\n\n${body.trim()}`;
}

export class Matome {
  // ask(text) -> Promise<{ ok, json, error }>
  constructor({ log, ask }) {
    Object.assign(this, { log, ask });
    this.runs = new Map(); // セッション -> 読んでいるところ
    this.again = new Set(); // 読んでいるあいだにまた終わったセッション（読み終えてからもう一度）
  }

  start() {
    this.off = this.log.on((r) => { if (r.kind === "end" && !r.stopped && !r.error) this.kick(r.session); });
    return this;
  }

  stop() {
    this.off?.();
  }

  kick(session) {
    if (this.runs.has(session)) {
      this.again.add(session);
      return this.runs.get(session);
    }
    const run = (async () => {
      do {
        this.again.delete(session);
        await this.read(session);
      } while (this.again.has(session));
      this.runs.delete(session);
    })();
    this.runs.set(session, run);
    return run;
  }

  async read(session) {
    const x = this.log.state.sessions.find((y) => y.id === session);
    if (!x || x.hidden) return;
    const r = await this.ask(briefPrompt(x));
    // 読めなかったら前の要約のまま（次に終わったとき読み直す）
    if (r.ok) this.log.add("brief", { session, summary: r.json.summary, choices: r.json.choices });
  }
}
