// 記録の種類と、いまの状態の作り方。状態はデータに持たず、記録を頭から当て直して作る
// 種類を足すときは KINDS に一つ足す。make は受け取ったものから記録に書く中身を作り（だめなら投げる）、apply はそれを状態に当てる

export const KINDS = {
  // 発言：人が言った元の文。発言の id は、その記録の通し番号
  say: {
    make({ text }) {
      if (typeof text !== "string" || !text.trim()) throw new Error("発言の text がない");
      return { text };
    },
    apply(s, r) {
      s.said.push({ id: r.seq, at: r.at, text: r.text });
    },
  },
};

export const empty = () => ({ seq: 0, said: [] });

// 知らない種類は飛ばす（通し番号だけ進める）
export function step(s, r) {
  KINDS[r.kind]?.apply(s, r);
  s.seq = r.seq;
  return s;
}

export const replay = (records) => records.reduce(step, empty());
