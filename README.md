# dyve

入力欄が一つのまま、いくつもの仕事を切り替えずに頼める道具。何を確かめたいかは [PLAN.md](PLAN.md)。

## 入れる

Node 20 以上と、入れてログインした [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)（`claude`）が要る。依存はない。

```sh
npm i -g github:yuta4030/dyve#v0.13.0     # 版はタグで固定する
```

入れずに試すだけなら `npx github:yuta4030/dyve#v0.13.0 serve`。

## 立てる

```sh
dyve serve --room <セッションが働く場所>
```

出てきた URL（既定は http://127.0.0.1:4750/）を開く。

- 喋るか書く。声は OS の音声入力を使い、間があくと置かれる。打ったものは Enter で置かれる（改行は Shift+Enter）
- 係が、どのセッションの続きか・新しく起こすかを決める。「A は〜」「B、〜」のように記号で始めれば、そのセッションにそのまま届く
- カードを押すと、そのセッションのやりとりが見える。覗いているあいだの曖昧な発言は、そのセッションに届く。Esc で一覧に戻る
- 止めて立て直しても記録は残り、続きを頼めば同じ会話で再開する

## オプション

| オプション | 中身 |
|---|---|
| `--room DIR` | セッションが起きる場所（既定：いまの場所） |
| `--allow TOOL` | セッションに許す道具を足す。何度でも書ける |
| `--model NAME` | セッションのモデル（既定：Claude Code の既定） |
| `--kakari NAME` | 係のモデル（既定：`haiku`） |
| `--slots N` | 同時に走るセッションの数（既定：3） |
| `--data FILE` | 記録（既定：`~/.dyve/record.jsonl`） |
| `--port N` | 待つポート（既定：4750） |

### 許す道具

セッションは読むだけで動く。許すのは `Read`・`Grep`・`Glob`・`WebSearch`・`WebFetch` と、`git log`・`git status`・`git diff`・`git show`・`ls`。ほかの道具は聞かずに断られる（`--permission-mode dontAsk`）。

Claude Code に設定してある MCP を使わせるときは、読むだけの道具を名前で足す。

```sh
dyve serve --room ~/work --allow mcp__slack__search_messages --allow mcp__slack__read_channel
```

`--allow mcp__slack` のようにサーバー名だけを書くと、そのサーバーの道具がすべて許される（送る道具も含む）。

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
