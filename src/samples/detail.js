// 詳細：同じものについてのほかのパネルで人が選んだもの（予定の一件、札の一枚）を、項目ごとに並べる
// 選ぶ側の view が ctx.select(値) で知らせたものを ctx.selected（{ from, value }）で受けて描く。data はなくてよい
// data を置くなら、選ばれたものに足す詳しい中身：{ id: 中身 } か [{ id, … }]。選ばれた値の id（か key。文字列・数ならそれ自体）で引いて重ねる
// 中身は title（か name・label）が見出し、text（か note・body）が本文、ほかは「項目：値」。選ばれるまでは、その案内を出す
dyve.view((el, data, ctx) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const str = (v) => (v == null ? "" : Array.isArray(v) ? v.map((x) => (obj(x) || Array.isArray(x) ? JSON.stringify(x) : String(x))).join("、") : typeof v === "object" ? JSON.stringify(v) : String(v));
  const css = `<style>
    .d { display: grid; gap: 6px; }
    .d h4 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
    .d p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .d dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; font-size: 12px; }
    .d dt { color: var(--mute); } .d dd { margin: 0; overflow-wrap: anywhere; }
    .none { color: var(--mute); }
  </style>`;
  const sel = ctx?.selected?.value;
  if (sel == null) {
    el.innerHTML = `${css}<span class="none">ほかのパネルで選ぶと、ここに詳しく出ます</span>`;
    return;
  }
  // data から、選ばれたものの詳しい中身を引く
  const key = obj(sel) ? sel.id ?? sel.key : sel;
  let more = null;
  if (key != null) {
    if (Array.isArray(data)) more = data.find((x) => obj(x) && String(x.id ?? x.key) === String(key)) ?? null;
    else if (obj(data) && Object.hasOwn(data, String(key))) more = data[String(key)];
  }
  const base = obj(sel) ? sel : { title: str(sel) }, extra = obj(more) ? more : more != null ? { text: str(more) } : {};
  const HEAD = ["title", "name", "label"], BODY = ["text", "note", "body"];
  const pick = (o, ks) => ks.find((k) => o[k] != null);
  const bh = pick(base, HEAD), bb = pick(base, BODY), xh = pick(extra, HEAD), xb = pick(extra, BODY);
  // 見出しは data の側が勝ち、なければ選ばれたものの見出し、それもなければ本文を見出しに。本文は、見出しに使わなかった方
  const head = xh ? str(extra[xh]) : bh ? str(base[bh]) : bb ? str(base[bb]) : xb ? str(extra[xb]) : "";
  const body = xb && (xh || bh || bb) ? str(extra[xb]) : bb && (xh || bh) ? str(base[bb]) : "";
  // 見た目のための項目（id・tone など）は並べない
  const skip = new Set([...HEAD, ...BODY, "id", "key", "tone", "done"]);
  const rest = Object.entries({ ...base, ...extra }).filter(([k, v]) => !skip.has(k) && v != null && v !== "");
  el.innerHTML = `${css}<div class="d">${head ? `<h4>${esc(head)}</h4>` : ""}${body ? `<p>${esc(body)}</p>` : ""}` +
    `${rest.length ? `<dl>${rest.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(str(v))}</dd>`).join("")}</dl>` : ""}</div>`;
});
