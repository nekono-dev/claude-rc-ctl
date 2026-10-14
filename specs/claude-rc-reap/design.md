# claude-rc-reap 設計書

## 1. 構成

| パス                         | 責務                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `src/claude-rc-ctl`          | reap サブコマンド。対象の選択と、セッションの判定・終了を行う     |
| `src/claude-rc-reap.service` | 一括回収を1回実行する oneshot のユーザー単位ユニット              |
| `src/claude-rc-reap.timer`   | 一括回収を10分ごとに起動するタイマー                              |
| `installer/main.sh`          | 定期実行ユニットの配置・有効化・無効化・撤去                      |
| `tests/helpers.mjs`          | tmux の display-message と systemctl の停止状態を返す擬似コマンド |
| `tests/reap.test.mjs`        | reap と定期実行ユニットのテスト                                   |

## 2. 設計項目

### D-1: セッションの判定と終了 (FR-1, FR-2, FR-3, FR-6)

```
claude-rc-ctl reap [--dry-run] <name>
  need_name <name>                       # 未登録は「未登録です」で終了コード1
  idle = ${CLAUDE_RC_IDLE_MINUTES:-60}   # 整数以外はエラー、0 なら何もせず成功
  systemctl --user is-active が active でない → 何もせず成功
  server = tmux -L claude-rc-<name> display-message -p -t <name> '#{pane_pid}'
  python3 で次を判定する
```

```python
sessions = server の直接の子プロセス
for pid in sessions:
    last = transcript の更新時刻（なければプロセスの起動時刻）
    busy = pid とその子孫のいずれかの状態が R
    if now - last >= idle * 60 and not busy:
        dry なら表示のみ、そうでなければ SIGTERM
```

transcript は `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd の英数字以外を - に置換した名前>/` にある。子の引数に `--session-id` か `--resume` の ID があればそのファイル、なければディレクトリ内で最も新しいファイルの更新時刻を使う。ファイルがなければ起動時刻だけで判定する。

出力は `[name] 回収: pid=<pid> セッション=<id または -> アイドル=<分>分` とし、確認のみのときは「回収対象」と表示する。

### D-2: 一括回収 (FR-4, NFR-1)

```
claude-rc-ctl reap [--dry-run] --all
  for 登録情報 in ~/.config/claude-rc/*.env
      reap_one <name>          # 失敗してもほかのインスタンスを続ける
  1件でも失敗したら終了コード1
```

インスタンス1件あたりの外部コマンドは systemctl・tmux・python3 の各1回に抑え、10件で5秒以内に収める。

### D-3: 定期実行 (FR-5)

```ini
# claude-rc-reap.service
[Service]
Type=oneshot
ExecStart=%h/.local/bin/claude-rc-ctl reap --all

# claude-rc-reap.timer
[Timer]
OnBootSec=10min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
```

| 操作       | 処理                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 導入・更新 | 2つのユニットをコピーし、daemon-reload 後に `systemctl --user enable --now claude-rc-reap.timer` |
| 削除       | `systemctl --user disable --now claude-rc-reap.timer` の後に2つのユニットを削除                  |
| パージ     | timers.target.wants 内のタイマーのリンクを削除                                                   |

## 3. エラー処理

| 事象                             | 処理                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| 未登録の名前                     | 「未登録です」を標準エラーへ出し、終了コード1                 |
| 閾値が整数でない                 | 理由を標準エラーへ出し、そのインスタンスを飛ばして終了コード1 |
| サーバーのプロセスを特定できない | 警告を標準エラーへ出し、そのインスタンスを飛ばして成功        |
| 引数が不正                       | 使い方を出して終了コード1                                     |
