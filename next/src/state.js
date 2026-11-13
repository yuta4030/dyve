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
// オーバービューに出ているセッションが使っていない、いちばん若い字（できたときに振り、出ているあいだは変えない）
function freeSymbol(s) {
  const used = new Set(s.sessions.map((x) => x.sym));
  let i = 0;
  while (used.has(symbolOf(i))) i++;
  return symbolOf(i);
}

export const KINDS = {
  // 発言：人が言った元の文。発言の id は、その記録の通し番号
  say: {
    make({ text: t }) {
      return { text: text(t, "発言の text") };
    },
    apply(s, r) {
      // fair：清書した文（なければ null。元の文 text は残る）。届け先は session か aside（どこにも届けない）。miss：係が届け先を決められなかった理由
      s.said.push({ id: r.seq, at: r.at, text: r.text, fair: null, session: null, aside: false, miss: null });
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
    // sym：カードの記号（導く）。asked：渡した発言の id（順に）
    apply(s, r) {
      s.sessions.push({ id: r.seq, at: r.at, sym: freeSymbol(s), name: r.name ?? null, role: r.role, cwd: r.cwd, claude: null, running: false, asked: [], pending: [], flow: [], last: null, failed: null, usage: usage() });
    },
  },

  // 発言を渡した（発言とセッションの対応）。渡すのは、そのセッションの次のターンのはじめ
  pass: {
    make({ session, said }) {
      return { session: id(session, "session"), said: id(said, "said") };
    },
    apply(s, r) {
      const x = sessionOf(s, r), p = s.said.find((y) => y.id === r.said);
      if (p) {
        p.session = r.session;
        p.miss = null;
      }
      x?.asked.push(r.said);
      x?.pending.push(r.said);
    },
  },

  // ターンが始まった：待っていた発言をまとめて渡した。resume は引き継いだ Claude の session_id（まっさらなら null）
  start: {
    make({ session, says, resume = null }) {
      if (!Array.isArray(says) || !says.length) throw new Error("says がない");
      return { session: id(session, "session"), says: says.map((x) => id(x, "says")), resume };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.running = true;
      x.failed = null;
      x.pending = x.pending.filter((p) => !r.says.includes(p));
      for (const said of r.says) if (!x.flow.some((f) => f.said === said)) x.flow.push({ seq: r.seq, at: r.at, said });
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
      for (const k of Object.keys(x.usage)) x.usage[k] += r.usage[k];
    },
  },

  // 結果を出さずに終わった：理由を残す。claude は続きに引き継げる Claude の session_id（途中で落ちても、わかっていれば）。
  // null なら引き継げるものがない（次はまっさらで起こす）
  fail: {
    make({ session, reason, claude = null, usage: u = null }) {
      return { session: id(session, "session"), reason: text(reason, "reason"), claude, ...(u ? { usage: usage(u) } : {}) };
    },
    apply(s, r) {
      const x = sessionOf(s, r);
      if (!x) return;
      x.running = false;
      x.failed = r.reason;
      x.claude = r.claude ?? null;
      if (r.usage) for (const k of Object.keys(x.usage)) x.usage[k] += r.usage[k];
    },
  },
};

export const empty = () => ({ seq: 0, said: [], sessions: [] });

// 知らない種類は飛ばす（通し番号だけ進める）
export function step(s, r) {
  KINDS[r.kind]?.apply(s, r);
  s.seq = r.seq;
  return s;
}

export const replay = (records) => records.reduce(step, empty());
