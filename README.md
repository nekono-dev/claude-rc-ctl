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
- ブランチやタグを指定して導入するには、`install` に `--ref <ブランチ名またはタグ名>` を付ける（例: `... | sh -s -- install --ref feat/x`）。
- ブランチ版の `install.sh` は配布しない。CI はブランチの push ごとに検査し、Actions のアーティファクトに `install.sh` を残すだけである。

## 使い方

```sh
claude-rc-ctl add ~/work/myproj          # 登録して起動（名前は myproj）
claude-rc-ctl add ~/work/myproj name2    # 名前を指定して登録
claude-rc-ctl add --spawn worktree ~/work/myproj   # worktree モードで登録（git リポジトリのみ）
claude-rc-ctl list                       # 一覧と状態
claude-rc-ctl attach myproj              # tmux に接続（抜けるときは Ctrl-b d）
claude-rc-ctl logs myproj                # 直近の画面出力とジャーナル
claude-rc-ctl archive myproj             # 放置されていればアーカイブ（--dry-run は判定の表示のみ、--all は全件）
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
| `CLAUDE_RC_ARCHIVE_MINUTES` | `1440`     | アーカイブまでのアイドル時間（分）。`0` でアーカイブしない                     |
| `CLAUDE_RC_EFFORT`          | `medium`   | effort（`low`・`medium`・`high`・`xhigh`・`max`）                              |

変更後は `claude-rc-ctl restart <名前>` で反映する。

## 放置されたセッションのアーカイブ

remote-control サーバーの配下で放置されたセッションは、アプリの一覧に残り続ける。個別のセッションだけをアーカイブする公開された手段はないため、**サーバー配下のすべてのセッションが放置されたとき**に、サーバーごと正常終了させて再起動する。remote-control は停止時に動作中のセッションをアーカイブし、環境を登録解除する。

`claude-rc-archive.timer`（インストーラが有効化する）が10分ごとに `claude-rc-ctl archive --all` を実行し、次の条件をすべて満たすインスタンスだけを再起動する。

- 配下のすべてのセッションの transcript（`~/.claude/projects/`）の最終更新が、`CLAUDE_RC_ARCHIVE_MINUTES` 分（既定1440分）以上前である。
- 配下に、実行中のプロセスを持つセッションがない。
- セッションの作業ディレクトリの `.claude/scheduled_tasks.json` に、リマインダーが1件もない。

動作と制約は次のとおりである。

- 起動ラッパーは `--no-create-session-in-dir` を付けて起動する。起動時にセッションを作らないので、アプリからセッションを作って使う。事前作成があると、停止時に再開用として保持され、アーカイブされない。
- 1つのセッションが使われていれば、同じサーバーの別のセッションもアーカイブされない（サーバー単位の判定である）。
- セッションを開いている間だけ有効なリマインダー（保存しない設定のもの）は検出できない。残したいリマインダーは保存する設定で作ること。
- 判定は `claude-rc-ctl archive --dry-run --all` で事前に確認できる。自動実行の状態は `systemctl --user list-timers claude-rc-archive.timer` で確認する。

## effort

`CLAUDE_RC_EFFORT`（既定 `medium`）は、環境変数 `CLAUDE_CODE_EFFORT_LEVEL` として各セッションへ継承され、実際の思考量はこの値になる（transcript の `effort` で確認できる）。アプリのセッション画面の effort 表示は、アプリ側が子セッションへ渡す `--effort` の既定値のままで、実際の値と異なる場合がある。

## 更新と削除

```sh
claude-rc-ctl self update               # 導入中のブランチまたはタグの最新へ更新
claude-rc-ctl self update --ref feat/x  # 別のブランチまたはタグへ切り替えて更新（以後はそれに追従）
claude-rc-ctl self refs                 # 切り替えられるブランチとタグの一覧
claude-rc-ctl self status               # 導入情報の表示
claude-rc-ctl self uninstall            # 本体を削除（登録情報は残す）
claude-rc-ctl self uninstall --purge    # 登録情報と設定も削除
```

## 注意事項

- アーカイブの動作は Claude Code の内部仕様（停止時のアーカイブと環境の登録解除）に依存する。Claude Code の更新で変わる可能性がある。
- 旧版からの更新後、各インスタンスを初めて `restart` すると、サーバー側に残った旧環境の期限切れ（数分）まで起動に失敗することがある。サービスは10秒ごとに自動で再試行するので、そのまま待てばよい。
- 更新で旧版の `claude-rc-reap` が入っていた場合、旧ユニットは更新時に自動で撤去される。設定 `CLAUDE_RC_IDLE_MINUTES` は廃止したので、`CLAUDE_RC_ARCHIVE_MINUTES` に書き換える。
- 更新でサービス定義が変わった場合、稼働中のインスタンスは自動では再起動されない。`restart` で反映する。
- `self uninstall` はインスタンスを停止する。再導入後は `start` で再開する。
- 取得先に未コミットの変更があると、更新と再導入は中止される。
- ブランチ名とタグ名が同じときは、`refs/heads/<名前>` または `refs/tags/<名前>` で指定する。

開発者向けの要件・設計は `specs/claude-rc-ctl/` を参照する。
