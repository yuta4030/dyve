// ボードをそのまま Markdown に並べる。AI は使わない。外へ持ち出すための「落とさない」
import { isPerson, marks } from "./board.js";

const STATE = { task: "仕事", proposal: "提案", done: "済み" };
const MARK = { waiting: "受け入れ待ち", untouched: "未着手" };

export function toMarkdown(board, { title = "ボード", now = new Date(), running = [] } = {}) {
  const panels = board.list();
  const ids = new Set(panels.map((p) => p.id));
  const kids = new Map();
  for (const p of panels) {
    const parent = p.about && ids.has(p.about) ? p.about : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  const m = marks(board, { running });
  const lines = [`# ${title}`, "", `${now.toISOString().slice(0, 16).replace("T", " ")} 時点・${panels.length} 枚`, ""];
  const walk = (p, depth) => {
    const pad = "  ".repeat(depth);
    const tags = [p.state && STATE[p.state], m[p.id] && MARK[m[p.id]], p.pinned && "ピン留め"].filter(Boolean);
    const who = isPerson(p.by) ? "" : `${p.by}：`;
    const body = render(p.data).split("\n");
    lines.push(`${pad}- ${who}${body[0]}${tags.length ? `（${tags.join("・")}）` : ""}`);
    for (const l of body.slice(1)) lines.push(`${pad}  ${l}`);
    for (const k of kids.get(p.id) || []) walk(k, depth + 1);
  };
  for (const p of kids.get(null) || []) walk(p, 0);
  return lines.join("\n") + "\n";
}

function render(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map((x) => `- ${render(x)}`).join("\n").replace(/^- /, "\n- ");
  if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
    const row = (r) => `| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
    return ["", row(data.columns), row(data.columns.map(() => "---")), ...data.rows.map(row)].join("\n");
  }
  // いまの要点
  if (["points", "decided", "open"].some((k) => Array.isArray(data[k]))) {
    const NAME = { points: "要点", decided: "決まったこと", open: "まだ決まっていない" };
    return "いまの要点\n" + Object.keys(NAME).filter((k) => data[k]?.length).map((k) => `${NAME[k]}：\n${data[k].map((x) => `- ${render(x)}`).join("\n")}`).join("\n");
  }
  if (typeof data.text === "string") return data.to ? `${data.text}（宛先：${data.to}）` : data.text;
  return "\n```json\n" + JSON.stringify(data, null, 2) + "\n```";
}
