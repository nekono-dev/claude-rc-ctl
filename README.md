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

| キー                        | 既定値     | 内容                                                                                      |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `CLAUDE_RC_DIR`             | （必須）   | 作業ディレクトリ                                                                          |
| `CLAUDE_RC_SPAWN`           | `same-dir` | spawn モード（`same-dir` または `worktree`。`worktree` は git リポジトリのみ）            |
| `CLAUDE_RC_PERMISSION_MODE` | `auto`     | 権限モード                                                                                |
| `CLAUDE_RC_ARCHIVE_MINUTES` | `10080`    | アーカイブまでのアイドル時間（分）。`0` でアーカイブしない                                |
| `CLAUDE_RC_STALE_MINUTES`   | `10080`    | claude 本体の更新後、新しい版で再起動するまでに待つアイドル時間（分）。`0` で再起動しない |
| `CLAUDE_RC_EFFORT`          | `medium`   | effort（`low`・`medium`・`high`・`xhigh`・`max`）                                         |

変更後は `claude-rc-ctl restart <名前>` で反映する。

## 放置されたセッションのアーカイブ

remote-control サーバーの配下で放置されたセッションは、アプリの一覧に残り続ける。個別のセッションだけをアーカイブする公開された手段はないため、**サーバー配下のすべてのセッションが放置されたとき**に、サーバーごと正常終了させて再起動する。remote-control は停止時に動作中のセッションをアーカイブし、環境を登録解除する。

`claude-rc-archive.timer`（インストーラが有効化する）が10分ごとに `claude-rc-ctl archive --all` を実行し、次の条件をすべて満たすインスタンスだけを再起動する。

- 配下のすべてのセッションの transcript（`~/.claude/projects/`）の最終更新が、`CLAUDE_RC_ARCHIVE_MINUTES` 分（既定10080分＝1週間）以上前である。
- 配下に、実行中のプロセスを持つセッションがない。
- セッションの作業ディレクトリの `.claude/scheduled_tasks.json` に、リマインダーが1件もない。

動作と制約は次のとおりである。

- 起動ラッパーは `--no-create-session-in-dir` を付けて起動する。起動時にセッションを作らないので、アプリからセッションを作って使う。事前作成があると、停止時に再開用として保持され、アーカイブされない。
- 1つのセッションが使われていれば、同じサーバーの別のセッションもアーカイブされない（サーバー単位の判定である）。
- セッションを開いている間だけ有効なリマインダー（保存しない設定のもの）は検出できない。残したいリマインダーは保存する設定で作ること。
- 判定は `claude-rc-ctl archive --dry-run --all` で事前に確認できる。自動実行の状態は `systemctl --user list-timers claude-rc-archive.timer` で確認する。

### claude 本体の版の固定と更新への追従

起動ラッパーは、起動時点の claude の実行ファイルを `~/.local/share/claude-rc/versions/<版>/` に固定し、そこからサーバーを起動する。サーバーは自分の実行ファイルから子セッションを起動するので、claude 本体が更新されても、サーバーと配下のセッションは同じ版で動き続ける。更新の途中で実行ファイルがなくなり、サーバーはオンラインに見えるのにセッションを作れない、という状態にもならない。

- 同じファイルシステムではハードリンクで固定するので、元と同じ版のうちは容量を使わない。
- npm で導入した claude は `node_modules/…` の配置のまま固定する。claude は置き場所で導入方式を判定し、自動更新の方法を変えるためである。自動更新は元の導入（nvm 配下）を更新し、固定した複製は書き換えない。
- どのプロセスも使わなくなった版は、定期実行が削除する。

同じ定期実行が、固定した版が元の場所（`command -v claude`）の現在のファイルと異なるサーバーを検出し、次の条件をすべて満たすときに再起動して新しい版へ切り替える。配下にセッションがなければ、すぐに再起動する。

- 配下のすべてのセッションの最終更新が、`CLAUDE_RC_STALE_MINUTES` 分（既定10080分＝1週間）以上前である。
- 配下に、実行中のプロセスを持つセッションがない。
- リマインダーが1件もない。

条件を満たさない間は再起動を見送り、警告を記録する。すぐに新しい版にしたいときは `claude-rc-ctl restart <名前>` を実行する。再起動すると、配下のセッションはアプリ上でアーカイブされる。

猶予時間の既定はアーカイブの閾値と同じ1週間である。本体は頻繁に更新されるため、猶予時間を短くすると、更新のたびに、その時間だけ放置したセッションがアーカイブされる。サーバーを早く新しい版にそろえたいインスタンスだけ、`CLAUDE_RC_STALE_MINUTES` を短くする。

固定した実行ファイルが削除されたとき（手で消した場合）は、新しいセッションを起動できなくなる。定期実行はこれを検出して警告し、実行中のセッションがなければ、猶予時間を待たずに再起動する。

### 応答しないセッション

実行ファイルがない間に作ったセッションは、起動に失敗して応答しないまま残る（版を固定する前のサーバーで、本体の更新の途中に起きていた）。**そのセッションにメッセージを送り直すと起動する**（サーバーの再起動は不要）。

同じ定期実行が、サーバーの画面出力から起動失敗の記録（`Session failed:`）を検出し、警告を記録する。同じ記録は繰り返し警告しない。警告は次のコマンドで確認できる。送り直しても繰り返すときは `claude-rc-ctl restart <名前>` を実行する。

```sh
journalctl --user -u claude-rc-archive.service | grep 警告
```

### 認証に失敗して止まったセッション

アプリに「このセッションを実行しているコンピューターの Claude Code で、再度サインインする必要があります」と出るのは、資格情報の期限切れとは限らない。通信が一時的に遮断される（Cloudflare の `403 Attention Required` など）と、claude はこれを認証失敗として扱い、セッションが止まる。**そのセッションにメッセージを送り直す**と、資格情報が有効ならそのまま続けられる。

同じ定期実行が、セッションの記録の最後が `Failed to authenticate` で終わっているものを検出して警告する。同じ記録は繰り返し警告しない。繰り返すときは `claude auth status` で資格情報を確認し、無効なら `claude` でサインインし直す。

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
- 版の固定を入れる前から動いているサーバーは、従来どおり削除済みの実行ファイルで動き続けている間だけ本体の更新を検出する。`restart` すると版を固定した起動に切り替わる。
- 取得先に未コミットの変更があると、更新と再導入は中止される。
- ブランチ名とタグ名が同じときは、`refs/heads/<名前>` または `refs/tags/<名前>` で指定する。

開発者向けの要件・設計は `specs/`（コンポーネントごと）を参照する。
