// 利用者が書き足す指示：記録と同じフォルダ（既定は ~/.dyve/）に置いた Markdown を、dyve の指示の後ろに足す。
//   用語.md：係とセッションの全員が読む（製品名・社内の言葉・略語・よく聞き違える言葉）
//   <名前>.md（係.md・セッション.md）：その者だけが読む
// 形は決めない。読めなければ足さない（呼ぶたびに読み直すので、書き換えたらすぐ効く）
import fs from "node:fs";
import path from "node:path";

export const GLOSSARY = "用語";

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

// base：dyve の指示。dir：利用者のファイルを置くフォルダ（null なら足さない）。name：読む者の名前
export function withUser(base, dir, name) {
  if (!dir) return base;
  const words = read(path.join(dir, `${GLOSSARY}.md`));
  const own = read(path.join(dir, `${name}.md`));
  return [
    base,
    ...(words ? [`## 用語（利用者が書いたもの）\n人が使う言葉と、その書き方・意味です。発言を読むとき、書くときはこれに合わせます。\n\n${words}`] : []),
    ...(own ? [`## 利用者からの指示\n\n${own}`] : []),
  ].join("\n\n");
}
