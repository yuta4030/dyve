// ボードをそのまま Markdown に並べる。AI は使わない。外へ持ち出すための「落とさない」
import { isPerson, marks, turnOf } from "./board.js";

const STATE = { task: "仕事", proposal: "提案", done: "済み" };
const MARK = { waiting: "受け入れ待ち", untouched: "未着手" };
const TURN = { ai: "AI の番", you: "人の番", ok: "決まった", wait: "待ち" };

export function toMarkdown(board, { title = "ボード", now = new Date(), running = [] } = {}) {
  // 置き場所は画面のためのもの。合流した発言は先頭に入っている（下に付いたものは先頭へ寄せる）
  const panels = board.list().filter((p) => p.view !== "layout" && !p.into);
  const ids = new Set(panels.map((p) => p.id));
  const kids = new Map();
  for (const p of panels) {
    const about = board.get(p.about)?.into ?? p.about;
    const parent = about && ids.has(about) ? about : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  const m = marks(board, { running });
  const lines = [`# ${title}`, "", `${now.toISOString().slice(0, 16).replace("T", " ")} 時点・${panels.length} 枚`, ""];
  const walk = (p, depth) => {
    const pad = "  ".repeat(depth);
    const tags = [p.state && STATE[p.state], m[p.id] && MARK[m[p.id]], p.pinned && "ピン留め", p.point && `${p.point.how === "pick" ? "選んだ" : "指した"}：${p.point.id}`].filter(Boolean);
    const who = isPerson(p.by) ? "" : `${p.by}：`;
    const turn = p.key ? turnOf(board, p) : null;
    if (turn) tags.unshift(TURN[turn]);
    const body = render(p.data).split("\n");
    lines.push(`${pad}- ${p.key ? `${p.key}. ` : ""}${who}${body[0]}${tags.length ? `（${tags.join("・")}）` : ""}`);
    for (const l of body.slice(1)) lines.push(`${pad}  ${l}`);
    // 行に帰った一行・決まったこと・待ち
    if (p.line) lines.push(`${pad}  → ${p.line}`);
    if (p.decided) lines.push(`${pad}  決まった：${p.decided}`);
    if (p.wait) lines.push(`${pad}  待ち：${p.wait.text}${p.wait.until ? `（${p.wait.until} まで）` : ""}${p.wait.after ? `（${board.get(p.wait.after)?.key ?? p.wait.after} のあと）` : ""}`);
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
