# claude-rc-ctl

複数のディレクトリで Claude Code の remote-control を常駐サービス（ユーザー単位の systemd）として動かし、登録・起動・停止・接続を単一のコマンドで管理する。

## 動作要件

| 項目        | 内容                                                 |
| ----------- | ---------------------------------------------------- |
| OS          | systemd を使う Linux                                 |
| コマンド    | `git`、`tmux`、`python3`、`systemctl`                |
| Claude Code | nvm 経由（`~/.nvm`）で `claude` が使える状態         |
| 権限        | 一般ユーザー（`sudo` は不要）                        |
| 常駐の維持  | `loginctl enable-linger <ユーザー名>` を実行しておく |

## インストール

```sh
curl -fsSL https://github.com/nekono-dev/claude-rc-ctl/releases/latest/download/install.sh | sh -s -- install
```

- 取得先は `~/.local/share/claude-rc-ctl`、コマンドは `~/.local/bin/claude-rc-ctl` に配置される。`~/.local/bin` を `PATH` に含めること。
- 取得先を変えるときは環境変数 `CLAUDE_RC_CTL_DIR` に絶対パスを指定する。
- ブランチ版（Pre-release）は、リリース名がブランチ名（`/` は `-`）の `install.sh` を同じ方法で実行する。

## 使い方

```sh
claude-rc-ctl add ~/work/myproj          # 登録して起動（名前は myproj）
claude-rc-ctl add ~/work/myproj name2    # 名前を指定して登録
claude-rc-ctl add --spawn worktree ~/work/myproj   # worktree モードで登録（git リポジトリのみ）
claude-rc-ctl list                       # 一覧と状態
claude-rc-ctl attach myproj              # tmux に接続（抜けるときは Ctrl-b d）
claude-rc-ctl logs myproj                # 直近の画面出力とジャーナル
claude-rc-ctl reap myproj                # アイドルのセッションを終了（--dry-run は対象の表示のみ、--all は全件）
claude-rc-ctl start|stop|restart|status myproj
claude-rc-ctl remove myproj              # 停止して登録解除
```

初回は `attach` で接続し、ディレクトリの信頼確認に応答する。

## 設定

登録ごとの設定ファイルは `~/.config/claude-rc/<名前>.env` である。

| キー                        | 既定値     | 内容                                                                           |
| --------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `CLAUDE_RC_DIR`             | （必須）   | 作業ディレクトリ                                                               |
| `CLAUDE_RC_SPAWN`           | `same-dir` | spawn モード（`same-dir` または `worktree`。`worktree` は git リポジトリのみ） |
| `CLAUDE_RC_PERMISSION_MODE` | `auto`     | 権限モード                                                                     |
| `CLAUDE_RC_IDLE_MINUTES`    | `240`      | アイドル回収の閾値（分）。`0` で回収しない                                     |

変更後は `claude-rc-ctl restart <名前>` で反映する。

## アイドルセッションの回収

remote-control サーバーの配下で放置されたセッションは、そのままだと増え続ける。`claude-rc-reap.timer`（インストーラが有効化する）が10分ごとに `claude-rc-ctl reap --all` を実行し、アイドルのセッションを終了してアプリ上でオフラインにする。サーバーは止めないので、アプリからメッセージを送ると、サーバーがそのセッションを再び起動する。

- アイドルの判定は、セッションの transcript（`~/.claude/projects/`）の最終更新が `CLAUDE_RC_IDLE_MINUTES` 分以上前であることによる。
- 配下で実行中のプロセスがあるセッションと、サーバー本体は終了しない。
- 回収対象は `claude-rc-ctl reap --dry-run --all` で事前に確認できる。
- 自動実行の状態は `systemctl --user list-timers claude-rc-reap.timer` で確認する。

## 更新と削除

```sh
claude-rc-ctl self update               # 導入時のブランチまたはタグの最新へ更新
claude-rc-ctl self status               # 導入情報の表示
claude-rc-ctl self uninstall            # 本体を削除（登録情報は残す）
claude-rc-ctl self uninstall --purge    # 登録情報と設定も削除
```

## 注意事項

- アイドル回収の「メッセージで再度オンラインになる」動作は、Claude Code の仕様（サーバー配下のセッションが終了していても、メッセージ送信で再起動される）に依存する。実機で確認してから運用すること。
- 更新でサービス定義が変わった場合、稼働中のインスタンスは自動では再起動されない。`restart` で反映する。
- `self uninstall` はインスタンスを停止する。再導入後は `start` で再開する。
- 取得先に未コミットの変更があると、更新と再導入は中止される。

開発者向けの要件・設計は `specs/claude-rc-ctl/` を参照する。
