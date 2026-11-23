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
claude-rc-ctl maintain myproj            # 本体の更新への追従と警告（--dry-run は判定の表示のみ、--all は全件）
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
| `CLAUDE_RC_EFFORT`          | `medium`   | effort（`low`・`medium`・`high`・`xhigh`・`max`）                              |

変更後は `claude-rc-ctl restart <名前>` で反映する。

## セッションの引き継ぎ

サーバーを再起動しても、OS ごと再起動しても、アプリのセッションはそのまま続けられる。remote-control は作業ディレクトリごとに環境 ID（アプリから見た接続先）を `~/.claude/projects/<ディレクトリ>/bridge-pointer.json` に記録し、次の起動で同じ環境 ID を再利用するためである（同じマシン・同じアカウントで30日以内）。

- 起動時に、remote-control がセッションを1つ作る（アプリの一覧に1件出る）。このセッションは再起動のたびに使い回され、再起動の直後に再接続される。
- アプリから作ったほかのセッションは、再起動後にメッセージを送ると再開する。異常終了の直後は、前の作業の貸し出しが切れるまで（数分）届かないことがある。
- 再起動で、実行中だった作業（応答の途中）は中断される。会話の内容は残る。
- サーバーを止めてもセッションはアーカイブされない。不要なセッションはアプリからアーカイブする。`remove` と `self uninstall` でも同じである。
- `bridge-pointer.json` を消さないこと。消すと次の起動で新しい環境になり、それまでのセッションが孤立する。さらに、旧環境がサーバー側に残っている間は起動に失敗し続ける。

## 定期実行（保守）

`claude-rc-maint.timer`（インストーラが有効化する）が10分ごとに `claude-rc-ctl maintain --all` を実行する。判定は `claude-rc-ctl maintain --dry-run --all` で事前に確認できる。自動実行の状態は `systemctl --user list-timers claude-rc-maint.timer` で確認する。

### claude 本体の版の固定と更新への追従

起動ラッパーは、起動時点の claude の実行ファイルを `~/.local/share/claude-rc/versions/<版>/` に固定し、そこからサーバーを起動する。サーバーは自分の実行ファイルから子セッションを起動するので、claude 本体が更新されても、サーバーと配下のセッションは同じ版で動き続ける。更新の途中で実行ファイルがなくなり、サーバーはオンラインに見えるのにセッションを作れない、という状態にもならない。

- 同じファイルシステムではハードリンクで固定するので、元と同じ版のうちは容量を使わない。
- npm で導入した claude は `node_modules/…` の配置のまま固定する。claude は置き場所で導入方式を判定し、自動更新の方法を変えるためである。自動更新は元の導入（nvm 配下）を更新し、固定した複製は書き換えない。
- どのプロセスも使わなくなった版は、定期実行が削除する。

定期実行は、固定した版が元の場所（`command -v claude`）の現在のファイルと異なるサーバーを検出し、次の条件をすべて満たせば再起動して新しい版へ切り替える。再起動してもセッションは引き継がれるので、猶予時間は設けない。

- 配下に、実行中のプロセスを持つセッションがない。
- セッションの作業ディレクトリの `.claude/scheduled_tasks.json` に、リマインダーが1件もない（再起動後、メッセージを受けるまでセッションが起動されず、リマインダーが実行されないため）。

条件を満たさない間は再起動を見送り、警告を記録する。すぐに新しい版にしたいときは `claude-rc-ctl restart <名前>` を実行する。

固定した実行ファイルが削除されたとき（手で消した場合）は、新しいセッションを起動できなくなる。定期実行はこれを検出して警告し、実行中のセッションがなければ、リマインダーがあっても再起動する。

### 応答しないセッション

実行ファイルがない間に作ったセッションは、起動に失敗して応答しないまま残る（版を固定する前のサーバーで、本体の更新の途中に起きていた）。**そのセッションにメッセージを送り直すと起動する**（サーバーの再起動は不要）。

同じ定期実行が、サーバーの画面出力から起動失敗の記録（`Session failed:`）を検出し、警告を記録する。同じ記録は繰り返し警告しない。警告は次のコマンドで確認できる。送り直しても繰り返すときは `claude-rc-ctl restart <名前>` を実行する。

```sh
journalctl --user -u claude-rc-maint.service | grep 警告
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

- セッションの引き継ぎは Claude Code の内部仕様（環境 ID の記録と再利用）に依存する。Claude Code の更新で変わる可能性がある。
- 旧版（アーカイブ機能あり）からの更新後、各インスタンスを初めて `restart` すると、旧方式のサーバーが停止時に配下のセッションをアーカイブする。以後の再起動ではセッションが引き継がれる。
- 旧版の `claude-rc-archive` の定期実行は、更新時に自動で撤去される。設定 `CLAUDE_RC_ARCHIVE_MINUTES` と `CLAUDE_RC_STALE_MINUTES` は廃止した（残っていても読まない）。
- 旧版からの更新後、各インスタンスを初めて `restart` すると、サーバー側に残った旧環境の期限切れ（数分）まで起動に失敗することがある。サービスは10秒ごとに自動で再試行するので、そのまま待てばよい。
- 更新で旧版の `claude-rc-reap` が入っていた場合、旧ユニットは更新時に自動で撤去される。設定 `CLAUDE_RC_IDLE_MINUTES` も廃止した。
- 更新でサービス定義や起動ラッパーが変わった場合、稼働中のインスタンスは自動では再起動されない。`restart` で反映する。
- `self uninstall` はインスタンスを停止する。再導入後は `start` で再開する。
- 版の固定を入れる前から動いているサーバーは、従来どおり削除済みの実行ファイルで動き続けている間だけ本体の更新を検出する。`restart` すると版を固定した起動に切り替わる。
- 取得先に未コミットの変更があると、更新と再導入は中止される。
- ブランチ名とタグ名が同じときは、`refs/heads/<名前>` または `refs/tags/<名前>` で指定する。

開発者向けの要件・設計は `specs/`（コンポーネントごと）を参照する。
