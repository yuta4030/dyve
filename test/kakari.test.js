import { test } from "node:test";
import assert from "node:assert/strict";
import { Log } from "../src/log.js";
import { Kakari, quick, routePrompt } from "../src/kakari.js";

// セッションの代わり：開いたものと、届いた発言を覚えるだけ
function fakeSessions(log) {
  const sent = [];
  return {
    sent,
    open(name) { const id = log.state.sessions.length + 1; log.add("open", { session: id, name }); return id; },
    send(session, say) { sent.push([session, say]); return true; },
  };
}
const setup = (answer) => {
  const log = new Log(), sessions = fakeSessions(log), asked = [];
  const kakari = new Kakari({ log, sessions, ask: async (t) => { asked.push(t); return answer(t); } });
  return { log, sessions, asked, kakari };
};

test("記号で始まる発言は、係に聞かずに届ける", () => {
  const ss = [{ id: 1, sym: "A" }, { id: 2, sym: "B" }];
  assert.equal(quick("A は今日やる", ss)?.id, 1);
  assert.equal(quick("Bに年払いも聞いて", ss)?.id, 2);
  assert.equal(quick("Ｂ、それで", ss)?.id, 2);
  assert.equal(quick("API を調べて", ss), null);
  assert.equal(quick("C は？", ss), null);
});

test("新しい頼みはセッションを起こして届け、同じ名前はまとめる", async () => {
  const { log, sessions, kakari } = setup(() => ({ ok: true, json: { says: [{ id: 1, to: "new", name: "料金" }, { id: 2, to: "new", name: "料金" }, { id: 3, to: "none" }] } }));
  kakari.start();
  log.add("say", { text: "料金を調べて" });
  log.add("say", { text: "年払いも" });
  log.add("say", { text: "うーん" });
  await kakari.kick();
  assert.equal(log.state.sessions.length, 1);
  assert.deepEqual(sessions.sent, [[1, 1], [1, 2]]);
  assert.deepEqual(log.state.said.map((s) => s.session), [1, 1, null]);
});

test("記号での続きと、知らない記号は新しく起こす", async () => {
  const { log, sessions, kakari, asked } = setup((t) => ({ ok: true, json: { says: [{ id: Number(t.match(/^- (\d+)：/m)[1]), to: /続き/.test(t.split("新しい発言：")[1]) ? "A" : "Z" }] } }));
  log.add("open", { session: 1, name: "料金" });
  const a = log.add("say", { text: "A は年払いも" }).seq;
  await kakari.kick();
  assert.equal(asked.length, 0);
  const b = log.add("say", { text: "その続きで月払いも" }).seq;
  await kakari.kick();
  const c = log.add("say", { text: "別の話" }).seq;
  await kakari.kick();
  assert.deepEqual(sessions.sent, [[1, a], [1, b], [2, c]]);
  assert.match(asked[0], /A「料金」/);
  assert.match(asked[1], /（→ A）/);
});

test("係が読めなかった発言は残し、次の発言のときに読み直す", async () => {
  let fail = true;
  const { log, sessions, kakari } = setup(() => (fail ? { ok: false, error: "落ちた" } : { ok: true, json: { says: [{ id: 1, to: "new", name: "a" }, { id: 3, to: "new", name: "b" }] } }));
  const a = log.add("say", { text: "一つめ" }).seq;
  await kakari.kick();
  assert.equal(log.state.said[0].session, undefined);
  assert.equal(log.state.said[0].error, "落ちた");
  fail = false;
  const b = log.add("say", { text: "二つめ" }).seq;
  await kakari.kick();
  assert.deepEqual(sessions.sent, [[1, a], [2, b]]);
});

test("係に渡す文：覗いていたセッションを添える", () => {
  const log = new Log();
  log.add("open", { session: 1, name: "料金" });
  log.add("say", { text: "それも", peek: 1 });
  assert.match(routePrompt(log.state, log.state.said), /- 2（A を覗いていた）：それも/);
});

test("リセットのあとは、一覧から外れたセッションにも前の発言にも届けない", async () => {
  const { log, sessions, kakari, asked } = setup((t) => ({ ok: true, json: { says: [{ id: Number(t.match(/^- (\d+)：/m)[1]), to: "A" }] } }));
  log.add("open", { session: 1, name: "料金" });
  log.add("end", { session: 1, result: "x" });
  const a = log.add("say", { text: "前の話" }).seq;
  log.add("route", { say: a, session: 1 });
  log.add("reset");
  const b = log.add("say", { text: "A は年払いも" }).seq;
  await kakari.kick();
  // A はもう一覧にいないので、係に聞き、知らない記号として新しく起こす
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], /料金|前の話/);
  assert.deepEqual(sessions.sent, [[2, b]]);
});
