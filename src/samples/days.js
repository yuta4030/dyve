// 日ごとの並び（予定・締め切り・やったこと）
// data は [{ date, items: [予定] }] か { 日付: [予定] } か [{ date, text, time?, tone? }]（予定ひとつずつ）。予定は文字列か { text, time?, tone? }
// date が YYYY-MM-DD なら「11/11（水）」と出し、今日・明日はそう書いて今日に印を付ける。ほかの字はそのまま見出しにする
// tone は warn・ok・accent（予定の左の線の色）。日は書いた順に並べる
dyve.view((el, data) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const str = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const ev = (x) => (x && typeof x === "object" && !Array.isArray(x) ? { ...x, text: str(x.text ?? x.title ?? x.name) } : { text: str(x) });
  const days = [];
  const day = (date) => {
    const k = str(date);
    let d = days.find((x) => x.date === k);
    if (!d) days.push((d = { date: k, items: [] }));
    return d;
  };
  if (Array.isArray(data)) {
    for (const x of data) {
      if (x && typeof x === "object" && Array.isArray(x.items)) day(x.date ?? x.day ?? x.title).items.push(...x.items.map(ev));
      else if (x && typeof x === "object" && (x.date != null || x.day != null)) day(x.date ?? x.day).items.push(ev(x));
      else day("").items.push(ev(x));
    }
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) day(k).items.push(...(Array.isArray(v) ? v : [v]).map(ev));
  } else if (data != null && data !== "") day("").items.push(...str(data).split("\n").filter((s) => s.trim()).map(ev));
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const now = new Date(), today = iso(now), tomorrow = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const label = (k) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k);
    if (!m) return k;
    if (m[0] === today) return "今日";
    if (m[0] === tomorrow) return "明日";
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return `${t.getMonth() + 1}/${t.getDate()}（${WD[t.getDay()]}）`;
  };
  const TONES = ["warn", "ok", "accent"];
  el.innerHTML = `<style>
    .days { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 4px; font-size: 12px; }
    .dy { border: 1px solid var(--line); border-radius: 7px; background: var(--bg); min-height: 58px; padding: 4px 5px; min-width: 0; }
    .dy b { display: block; color: var(--mute); font-weight: 600; }
    .dy.today { border-color: var(--accent); } .dy.today b { color: var(--ink); }
    .ev { margin-top: 3px; padding: 1px 5px; border-radius: 4px; background: var(--accent-soft); border-left: 2px solid var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ev.warn { background: var(--warn-soft); border-left-color: var(--warn); } .ev.ok { border-left-color: var(--ok); }
    .ev time { color: var(--mute); margin-right: 4px; }
    .none { color: var(--mute); }
  </style><div class="days">${days.map((d) => `<div class="dy${d.date.startsWith(today) ? " today" : ""}"><b>${esc(label(d.date)) || "&nbsp;"}</b>${d.items.map((e) => `<div class="ev ${TONES.includes(e.tone) ? e.tone : ""}" title="${esc(e.text)}">${e.time != null ? `<time>${esc(str(e.time))}</time>` : ""}${esc(e.text)}</div>`).join("")}</div>`).join("") || '<span class="none">—</span>'}</div>`;
});
