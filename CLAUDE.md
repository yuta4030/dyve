# CLAUDE.md — dyve

入力欄が一つのまま、いくつもの仕事を切り替えずに頼める道具。何を確かめたいか・どこまで来たかは `PLAN.md`、入れ方・立て方は README。

## 守ること
- `PLAN.md` の「作らないもの」は、試して要るとわかるまで作らない。足すときは PLAN.md を先に直す
- 画面はダイアログを出さない・フォーカスを奪わない・音を鳴らさない（`test/ui.test.js` が確かめる）
- セッションは読むだけ。許す道具を広げるのは利用者の `--allow` だけ

## 構成
- `bin/dyve.js`：CLI（`serve`）
- `src/state.js`：記録の種類と、記録から状態を作るところ
- `src/log.js`：追記だけの記録
- `src/kakari.js`：係（発言の届け先を決める）
- `src/sessions.js`：セッション（Claude Code を起こし、続きを頼む）
- `src/server.js`・`src/ui.html`：サーバーと画面
- `prompts/`：係とセッションへの指示
- `test/`：テスト。`test/fake-claude.js` が Claude Code のふりをする

## 技術スタック
- 依存ゼロの Node 20+（http・fs・child_process だけ）。ビルド工程なし
- 画面は `src/ui.html` の 1 枚。外の CDN やフォントを読まない。画面の言葉は `L` にまとめる
- テストは `node --test`（`npm test`）。外にはつながず、偽の Claude Code で回す

## 文書
- 正本は一つずつ。確かめたいこと・いまあるもの・作らないものは `PLAN.md`、入れ方・立て方は README、版ごとの変更は CHANGELOG
- 結論だけを書く。経緯は CHANGELOG と git の履歴にある
- 版は `package.json` の `version` だけ。手順は README の「リリース」
