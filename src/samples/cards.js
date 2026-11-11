// 札を列ごとに並べる（やることの段、案の比べ、段取り。どんなデータにも使える）
// data は [{ title, cards: [札] }]（列の並び）か { 列の名前: [札] }。札は文字列か { title, text?, tag?, tone?, done? }
// tone は ok・warn・accent・mute（左の線の色）。done: true は打ち消し線で薄く。形の違うデータは一列に並べる
dyve.view((el, data) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const str = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const card = (c) => (c && typeof c === "object" && !Array.isArray(c) ? c : { title: str(c) });
  const isCol = (c) => c && typeof c === "object" && Array.isArray(c.cards);
  let cols;
  if (Array.isArray(data)) cols = data.length && data.every(isCol) ? data.map((c) => ({ title: str(c.title ?? c.name), tone: c.tone, cards: c.cards })) : [{ title: "", cards: data }];
  else if (isCol(data)) cols = [{ title: str(data.title), tone: data.tone, cards: data.cards }];
  else if (data && typeof data === "object") cols = Object.entries(data).map(([title, v]) => ({ title, cards: Array.isArray(v) ? v : [v] }));
  else cols = [{ title: "", cards: str(data).split("\n").map((s) => s.trim()).filter(Boolean) }];
  const TONES = ["ok", "warn", "accent", "mute"];
  const tone = (t) => (TONES.includes(t) ? t : "");
  const one = (raw) => {
    const c = card(raw), title = str(c.title ?? c.text ?? c.name), text = c.title != null || c.name != null ? str(c.text ?? c.note) : "";
    return `<div class="c ${tone(c.tone)}${c.done ? " done" : ""}"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ""}${c.tag != null ? `<i>${esc(str(c.tag))}</i>` : ""}</div>`;
  };
  el.innerHTML = `<style>
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; align-items: start; }
    h4 { margin: 0 0 4px; font-size: 11px; letter-spacing: .06em; color: var(--mute); font-weight: 600; display: flex; gap: 6px; align-items: center; }
    h4 em { font-style: normal; background: var(--line); color: var(--ink); border-radius: 999px; padding: 0 6px; }
    h4.ok { color: var(--ok); } h4.warn { color: var(--warn); } h4.accent { color: var(--accent); }
    .c { display: grid; gap: 1px; padding: 6px 8px; border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: 7px; background: var(--bg); }
    .c + .c { margin-top: 5px; }
    .c b { font-weight: 600; overflow-wrap: anywhere; }
    .c span { color: var(--mute); font-size: 12px; overflow-wrap: anywhere; }
    .c i { justify-self: start; font-style: normal; font-size: 11px; padding: 0 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--mute); }
    .c.ok { border-left-color: var(--ok); } .c.warn { border-left-color: var(--warn); } .c.accent { border-left-color: var(--accent); }
    .c.mute, .c.done { opacity: .7; } .c.done b { text-decoration: line-through; text-decoration-color: var(--mute); }
    .none { color: var(--mute); font-size: 12px; }
  </style><div class="cols">${cols.map((col) => `<section>${col.title ? `<h4 class="${tone(col.tone)}">${esc(col.title)}<em>${col.cards.length}</em></h4>` : ""}${col.cards.map(one).join("") || '<div class="none">—</div>'}</section>`).join("")}</div>`;
});
