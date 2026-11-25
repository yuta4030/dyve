# dyve

入力欄が一つのまま、いくつもの仕事を切り替えずに頼める道具。何を確かめたいかは [PLAN.md](PLAN.md)。

## 入れる

Node 20 以上と、入れてログインした [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)（`claude`）が要る。依存はない。

```sh
npm i -g github:yuta4030/dyve#v0.13.1     # 版はタグで固定する
```

入れずに試すだけなら `npx github:yuta4030/dyve#v0.13.1 serve`。

## 立てる

```sh
dyve serve --room <セッションが働く場所>
```

出てきた URL（既定は http://127.0.0.1:4750/）を開く。

- 喋るか書く。声は OS の音声入力を使い、間があくと置かれる。打ったものは Enter で置かれる（改行は Shift+Enter）
- 係が、どのセッションの続きか・新しく起こすかを決める。「A は〜」「B、〜」のように記号で始めれば、そのセッションにそのまま届く
- カードを押すと、そのセッションのやりとりが見える。覗いているあいだの曖昧な発言は、そのセッションに届く。Esc で一覧に戻る
- 「リセット」でチャットを空にし、動いていないセッションを一覧から外す。記録は消えず、次に話すまでは「元に戻す」で戻せる
- 止めて立て直しても記録は残り、続きを頼めば同じ会話で再開する

## オプション

| オプション | 中身 |
|---|---|
| `--room DIR` | セッションが起きる場所（既定：いまの場所） |
| `--model NAME` | セッションのモデル（既定：Claude Code の既定） |
| `--kakari NAME` | 係のモデル（既定：`haiku`） |
| `--slots N` | 同時に走るセッションの数（既定：3） |
| `--data FILE` | 記録（既定：`~/.dyve/record.jsonl`） |
| `--port N` | 待つポート（既定：4750） |

### セッションの権限

セッションは道具を絞らずに、人に聞かずに進む（`--permission-mode auto`）。ファイルを書く、コマンドを動かす、Claude Code に設定してある MCP（Slack など）を使う、もそのままできる。危ない操作（強制 push や大量の削除など）だけは Claude Code の判定が止める。

- セッションはみな `--room` で同時に動く。同じファイルを二つのセッションに直させると、ぶつかることがある
- 送る・投稿する・push する・消すは、頼まれたときだけやるよう指示してある（`prompts/セッション.md`）

## テスト

```sh
npm test
```

外にはつながない。`test/fake-claude.js` が Claude Code のふりをするので、`node bin/dyve.js serve --claude test/fake-claude.js` で費用をかけずに通しで動かせる。

## リリース

1. `package.json` の `version` を上げる
2. `CHANGELOG.md` に `## [<版>] - <日付>` の節を書く（テストが、いまの版の節があるかを確かめる）
3. PR をマージする。main の版にまだタグがなければ、CI が `v<版>` のタグと GitHub Release を作る
4. README の「入れる」の版を新しいタグに直す
