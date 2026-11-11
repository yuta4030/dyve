// 数の並びを横棒で。data は [{label, value}] か { ラベル: 数 }
dyve.view((el, data) => {
  const rows = (Array.isArray(data) ? data : data && typeof data === "object" ? Object.entries(data).map(([label, value]) => ({ label, value })) : [])
    .map((r) => (r && typeof r === "object" ? r : { label: r, value: r }));
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  el.innerHTML = `<style>
    .row { display: grid; grid-template-columns: minmax(4em, 30%) 1fr auto; gap: 8px; align-items: center; margin: 3px 0; }
    .row span { color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row b { display: block; height: 10px; border-radius: 5px; background: var(--accent); min-width: 2px; }
    .row em { font-style: normal; font-variant-numeric: tabular-nums; }
  </style>` + rows.map((r) => `<div class="row"><span>${esc(r.label)}</span><b style="width:${(Number(r.value) / max) * 100}%"></b><em>${esc(r.value)}</em></div>`).join("");
});
