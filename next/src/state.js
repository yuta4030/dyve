// 記録の種類と、いまの状態の作り方。状態はデータに持たず、記録を頭から当て直して作る
// 種類を足すときは KINDS に一つ足す。make は受け取ったものから記録に書く中身を作り（だめなら投げる）、apply はそれを状態に当てる
// このファイルはサーバーと画面の両方が読む（画面は module としてそのまま読む）。だから import を持たない

const text = (v, what) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} がない`);
  return v;
};
const id = (v, what) => {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${what} は 1 以上の整数`);
  return v;
};
const usage = (u) => ({ input: u?.input || 0, output: u?.output || 0, cacheWrite: u?.cacheWrite || 0, cacheRead: u?.cacheRead || 0, costUsd: u?.costUsd || 0 });

// セッションの出来事は、どれも session（セッションの id）を持つ。セッションの id は、そのセッションができた記録の通し番号
const sessionOf = (s, r) => s.sessions.find((x) => x.id === r.session);
const saidOf = (s, n) => s.said.find((p) => p.id === n);

// カードの記号：A〜Z、そのあとは AA・AB…。声で「A は…」と呼ぶためのもので、データには持たず導く
export function symbolOf(n) {
  let out = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}
// オーバービューに出ているセッションが使っていない、いちばん若い字（できたとき・済みから戻ったときに振り、出ているあいだは変えない）。
// 済みに畳んだら字を空ける（sym は null）
function freeSymbol(s) {
  const used = new Set(s.sessions.filter((x) => x.sym).map((x) => x.sym));
  let i = 0;
  while (used.has(symbolOf(i))) i++;
  return symbolOf(i);
}

export const KINDS = {
  // 発言：人が言った元の文。発言の id は、その記録の通し番号
  say: {
    // peek：人がこの発言を置いたとき覗いていたセッション（発言の一部として残す。人のいまを追い続けるのではない）
    make({ text: t, peek = null }) {
      return { text: text(t, "発言の text"), ...(peek != null ? { peek: id(peek, "peek") } : {}) };
    },
    apply(s, r) {
      // fair：清書した文（なければ null。元の文 text は残る）。届け先は session か aside（どこにも届けない）。miss：係が届け先を決められなかった理由。
      // body：セッションに渡した文が違ったとき。resent：この発言で届け直した発言
      s.said.push({ id: r.seq, at: r.at, text: r.text, peek: r.peek ?? null, fair: null, session: null, aside: false, miss: null, body: null, resent: [] });
    },
  },

  // 清書：元の文は残したまま、清書した文を足す
  fair: {
    make({ said, text: t }) {
      return { said: id(said, "said"), text: text(t, "清書の text") };
    },
    apply(s, r) {
      const p = saidOf(s, r.said);
      if (p) p.fair = r.text;
    },
  },

  // どこにも届けない（頼みでも答えでもない発言）。発言はチャットに残る
  aside: {
    make({ said }) {
      return { said: id(said, "said") };
    },
    apply(s, r) {
      const p = saidOf(s, r.said);
      if (p) {
        p.aside = true;
        p.miss = null;
      }
    },
  },

  // 届け直した：人が「それは A に送って」と言ったので、届けていなかった発言（says）を届けた。said はそう言った発言
  resend: {
    make({ said, says }) {
      if (!Array.isArray(says) || !says.length) throw new Error("says がない");
      return { said: id(said, "said"), says: says.map((x) => id(x, "says")) };
    },
    apply(s, r) {
      const p = saidOf(s, r.said);
      if (p) p.resent = [...(p.resent ?? []), ...r.says];
    },
  },

  // 係が届け先を決められなかった（係が動かない・返したものが読めない・ありもしない届け先）。発言は未定のまま、次の回に読み直す
  miss: {
    make({ says, reason }) {
      if (!Array.isArray(says) || !says.length) throw new Error("says がない");
      return { says: says.map((x) => id(x, "says")), reason: text(reason, "reason") };
    },
    apply(s, r) {
      for (const n of r.says) {
        const p = saidOf(s, n);
        if (p) p.miss = r.reason;
      }
    },
  },

  // セッションができた：どの役割で、どこで起きるか
  open: {
    make({ role, cwd, name = null }) {
      return { role: text(role, "役割"), cwd: text(cwd, "起きる場所"), name: name == null ? null : text(name, "name") };
    },
    // sym：カードの記号（導く。済みなら null）。shown：オーバービューに並んだ通し番号（できたとき・戻ったとき。カードはこの順）。
    // folded：済みに畳んだ記録（{ seq, at, by }。出ていれば null）。backAt：帰った（カード・読めなかった・結果なし）記録の通し番号。
    // work：開発の作業場のありさま。merged：いちばん新しい取り込みの結果。accepted：受け入れたカードの通し番号。
    // asked：渡した発言の id（順に）。turn：いちばん新しく終わったターン（end の通し番号）。
    // read：係が読んだターン（カードを書いたか、読めなかったか）。card：いちばん新しいカード
    apply(s, r) {
      s.sessions.push({ id: r.seq, at: r.at, sym: freeSymbol(s), shown: r.seq, folded: null, backAt: null, name: r.name ?? null, role: r.role, cwd: r.cwd, claude: null, running: false, work: null, merged: null, accepted: null, asked: [], pending: [], flow: [], last: null, failed: null, turn: null, read: null, card: null, usage: usage() });
    },
  },

  // 発言を渡した（発言とセッションの対応）。渡すのは、そのセッションの次のターンのはじめ
  // text：セッションに渡す文がその発言の文と違うとき（届け直しの指示がまじった発言から、頼みの中身だけを渡す）
  pass: {
    make({ session, said, text: t = null }) {
      return { session: id(session, "session"), said: id(said, "said"), ...(t != null ? { text: text(t, "text") } : {}) };
    },
    apply(s, r) {
      const x = sessionOf(s, r), p = s.said.find((y) => y.id === r.said);
      if (p) {
        p.session = r.session;
        p.miss = null;
        if (p.aside) p.again = true; // 届けていなかった発言を、あとから届け直した
        p.aside = false;
        if (r.text) p.body = r.text;
      }
      if (!x) return;
      // 済みのセッションに発言が届いたら戻る：オーバービューの後ろに並び、空いている字を振り直す
      if (x.folded) {
        x.folded = null;
        x.sym = freeSymbol(s);
        x.shown = r.seq;
      }
      x.asked.push(r.said);
      x.pending.push(r.said);
    },
  },

  // 済みに畳んだ：帰ったあと、人が別の話へ進んだ。by はそのきっかけの発言（別のセッションに届いた発言）
  fold: {
    make({ session, by }) {
      return { session: id(session, "session"), by: id(by, "by") };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x || x.folded) return;
      x.folded = { seq: r.seq, at: r.at, by: r.by };
      x.sym = null;
    },
  },

  // ターンが始まった：待っていた発言をまとめて渡した。resume は引き継いだ Claude の session_id（まっさらなら null）。
  // accept：人がカードの伺いを受け入れて始めたターン（受け入れたカードの通し番号。発言は渡さない）
  start: {
    make({ session, says = [], resume = null, accept = null }) {
      if (!Array.isArray(says) || (!says.length && accept == null)) throw new Error("says がない");
      return { session: id(session, "session"), says: says.map((x) => id(x, "says")), resume, ...(accept != null ? { accept: id(accept, "accept") } : {}) };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.running = true;
      x.failed = null;
      x.pending = x.pending.filter((p) => !r.says.includes(p));
      for (const said of r.says) if (!x.flow.some((f) => f.said === said)) x.flow.push({ seq: r.seq, at: r.at, said });
      if (r.accept != null) x.flow.push({ seq: r.seq, at: r.at, accept: r.accept });
    },
  },

  // 人がカードの伺い（外に届くこと・取り消せないことをしてよいか）を、画面で押して受け入れた。card は受け入れたカードの通し番号
  accept: {
    make({ session, card }) {
      return { session: id(session, "session"), card: id(card, "card") };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (x) x.accepted = r.card;
    },
  },

  // 開発の作業場のありさま（ターンが終わるたびに git から読む）：ブランチ・部屋のブランチ・何コミット進んだか・コミットしていない変更・変えたファイルの数・作業場がないか
  work: {
    make({ session, branch, base = null, ahead = 0, dirty = false, files = 0, gone = false }) {
      return { session: id(session, "session"), branch: text(branch, "branch"), base, ahead, dirty, files, gone };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (x) x.work = { branch: r.branch, base: r.base, ahead: r.ahead, dirty: r.dirty, files: r.files, gone: r.gone };
    },
  },

  // 取り込んだ結果（人が画面で押したとき）：merged・conflict・failed・dirty・nothing。チャットにも一行返す
  merge: {
    make({ session, branch, into = null, result, commit = null, reason = null }) {
      if (!["merged", "conflict", "failed", "dirty", "nothing"].includes(result)) throw new Error("result が違う");
      return { session: id(session, "session"), branch: text(branch, "branch"), into, result, ...(commit ? { commit } : {}), ...(reason ? { reason } : {}) };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.merged = { seq: r.seq, result: r.result, into: r.into, commit: r.commit ?? null, reason: r.reason ?? null };
      s.backs.push({ seq: r.seq, at: r.at, session: x.id, kind: "merge", result: r.result, text: r.commit ?? r.reason ?? "", into: r.into });
    },
  },

  // Claude の session_id がわかった（init が来た）。dyve が途中で落ちても、次の発言で引き継げるように
  bind: {
    make({ session, claude }) {
      return { session: id(session, "session"), claude: text(claude, "claude") };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (x) x.claude = r.claude;
    },
  },

  // セッションが言ったこと（文）
  talk: {
    make({ session, text: t }) {
      return { session: id(session, "session"), text: text(t, "text") };
    },
    apply(s, r) {
      sessionOf(s, r)?.flow.push({ seq: r.seq, at: r.at, talk: r.text });
    },
  },

  // 道具を使った（一行だけ。中身の全部は積まない）
  tool: {
    make({ session, line }) {
      return { session: id(session, "session"), line: text(line, "line") };
    },
    apply(s, r) {
      sessionOf(s, r)?.flow.push({ seq: r.seq, at: r.at, tool: r.line });
    },
  },

  // ターンが終わった：最後の言葉と使った量。claude は Claude の session_id（続きはこれを引き継ぐ）
  end: {
    make({ session, claude, last = null, usage: u }) {
      return { session: id(session, "session"), claude: text(claude, "claude"), last, usage: usage(u) };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.running = false;
      x.claude = r.claude;
      x.last = r.last;
      x.turn = r.seq;
      for (const k of Object.keys(x.usage)) x.usage[k] += r.usage[k];
    },
  },

  // 結果を出さずに終わった：理由を残す。claude は続きに引き継げる Claude の session_id（途中で落ちても、わかっていれば）。
  // null なら引き継げるものがない（次はまっさらで起こす）
  fail: {
    // retry：引き継げなかったので、すぐまっさらで起こし直す（チャットには返さない）
    make({ session, reason, claude = null, usage: u = null, retry = false }) {
      return { session: id(session, "session"), reason: text(reason, "reason"), claude, ...(u ? { usage: usage(u) } : {}), ...(retry ? { retry: true } : {}) };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.running = false;
      x.failed = r.reason;
      x.claude = r.claude ?? null;
      if (r.usage) for (const k of Object.keys(x.usage)) x.usage[k] += r.usage[k];
      if (r.retry) return;
      x.backAt = r.seq;
      s.backs.push({ seq: r.seq, at: r.at, session: x.id, kind: "fail", text: r.reason });
    },
  },

  // カード：係が止まったセッションを読んで書いたもの。セッションごとに、止まるたびに書き直す（状態はいちばん新しいもの）。
  // turn：読んだターン（end の通し番号）。back：チャットに帰る一行。ask：人への問い（{ text, ref }。なければ null）
  card: {
    make({ session, turn, line, back, what = null, steps = [], ask = null, panels = [] }) {
      if (!Array.isArray(steps) || !Array.isArray(panels)) throw new Error("steps と panels は配列");
      return { session: id(session, "session"), turn: id(turn, "turn"), line: text(line, "line"), back: text(back, "back"), what, steps, ask, panels };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.card = { seq: r.seq, at: r.at, turn: r.turn, line: r.line, what: r.what, steps: r.steps, ask: r.ask, panels: r.panels };
      x.read = r.turn;
      x.backAt = r.seq;
      s.backs.push({ seq: r.seq, at: r.at, session: x.id, kind: "card", text: r.back });
    },
  },

  // 係がカードを書けなかった：カードは前のまま、チャットには最後の言葉の頭を返す
  nocard: {
    make({ session, turn, reason }) {
      return { session: id(session, "session"), turn: id(turn, "turn"), reason: text(reason, "reason") };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.read = r.turn;
      x.backAt = r.seq;
      s.backs.push({ seq: r.seq, at: r.at, session: x.id, kind: "nocard", text: headOf(x.last) || r.reason, reason: r.reason });
    },
  },
};

// 最後の言葉の頭（はじめの空でない一行を 80 字まで）
export function headOf(t) {
  const line = String(t ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

// ステート：データに持たず導く。run（実行中）・wait（人待ち）・back（帰った）・done（済み）。none は結果を出さずに終わった理由
// ターンが終わっても係がまだ読んでいないあいだは実行中のまま（帰った→人待ち のちらつきを避ける）。係が読めなかったら帰った
export function stageOf(x) {
  if (x.folded) return { stage: "done", none: x.failed ?? null };
  if (x.running) return { stage: "run", none: null };
  if (x.failed) return { stage: "back", none: x.failed };
  if (x.turn != null && x.read !== x.turn) return { stage: "run", none: null };
  if (x.card?.ask && x.card.turn === x.turn) return { stage: "wait", none: null };
  return { stage: "back", none: null };
}

// いまどこまで：動いているあいだは、いちばん新しい言ったこと・道具の一行（係を呼ばない）。止まっていればカードの一行
export function nowOf(x) {
  if (stageOf(x).stage === "run") {
    const f = x.flow.findLast((e) => e.talk || e.tool);
    return f ? headOf(f.talk ?? f.tool) : "";
  }
  return x.failed ?? x.card?.line ?? headOf(x.last);
}

// 係が指すときの呼び方：出ているものは記号、済みのものは #id
export const callOf = (x) => x.sym ?? `#${x.id}`;

// backs：セッションからチャットに帰った一行（card・nocard・fail）。発言と通し番号の順に並ぶ
export const empty = () => ({ seq: 0, said: [], sessions: [], backs: [] });

// 知らない種類は飛ばす（通し番号だけ進める）
export function step(s, r) {
  KINDS[r.kind]?.apply(s, r);
  s.seq = r.seq;
  return s;
}

export const replay = (records) => records.reduce(step, empty());
