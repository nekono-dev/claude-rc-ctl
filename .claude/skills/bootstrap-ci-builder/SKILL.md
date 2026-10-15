---
name: bootstrap-ci-builder
description: 単独で動作するブートストラップ型インストーラ（install.sh、curl経由でも実行可能）と、導入後の常設コマンド（<アプリ名>-ctl）による update / uninstall、設定ファイル（/etc/<アプリ名>/<アプリ名>.env）の生成・反映、およびそれらをブランチpush時はCIアーティファクトとして・タグpush時はGitHub Releaseとして自動生成・頒布するGitHub Actionsワークフローを新規に整備する際に使う。導入・更新時のブランチ・タグの指定と切り替え（--ref）、手動実行（workflow_dispatch）にも対応する。ベアメタルのほか、LXC / LXD コンテナ（Ubuntu等）へ配布するインストーラにも使う。「install.shを作りたい」「頒布用のインストーラを作りたい」「ワンライナーでインストールできるようにしたい」「installerワークフローを作りたい」「インストーラにupdate / uninstallを付けたい」「インストーラで設定ファイルを扱いたい」「ブランチやタグを切り替えて更新したい」「一般ユーザー権限（sudo不要）で導入したい」「lxc / lxd コンテナでインストーラを配布したい」「LXCコンテナ向けのインストーラを作りたい」といった依頼で使う。
---

# ブートストラップ型インストーラ・CI整備

Linuxサーバ等のベアメタル、およびLXC / LXD コンテナ（コンテナ内で `curl|sh` を実行する、または `lxc exec <コンテナ名> -- sh -c '…'` から実行する）へ「1行のcurl|shコマンド」で導入できる、単独動作のインストーラ（頒布物`install.sh`）と、導入後の常設コマンド、それらをブランチ・タグへのpushごとに自動生成・頒布するGitHub Actionsワークフローを整備するための作業方式。`templates/`配下のひな形を対象プロジェクトの実情に合わせて調整し、配置する。

## 全体像（役割と実行の流れ）

```
[頒布物 install.sh]  curl … | sudo sh -s -- install [--ref 名前] [--set K=V …]  ← 初回導入。既定は埋め込みコミット、--ref指定時はそのブランチ・タグ
        │                                          update [--ref 名前] …           ← 導入済みの常設コマンドへ委譲（取得しない）
        │                                          uninstall [--purge]            ← 同上
        ▼ 取得・コミット一致確認ののち委譲
[installer/main.sh]  本体。参照の解決 → 設定の検証・反映 → 導入メタ情報の記録 → 常設コマンドの配置 → app_install
        │
        ▼ 導入後はcurl不要
[/usr/local/bin/<アプリ名>-ctl]  update [--ref 名前] [--set K=V …] / refs / uninstall [--purge] / status
```

## 成果物の構成（ファイルレイアウト）

対象プロジェクトの `installer/` 配下（プロジェクトの慣習に合わせてディレクトリ名は変えてよいが、以下の役割分担は変えない）:

| ファイル | 役割 |
|---|---|
| `installer/bootstrap.sh.tmpl` | 頒布される`install.sh`のひな形。`@@REF@@`・`@@COMMIT@@`・`@@REPO_URL@@`が未置換のプレースホルダとして残る。git等の導入・ソースの取得（clone/fetch）・コミット一致確認を行い、本体（`main.sh`）へサブコマンドと引数を渡して実行するだけの薄い層。`uninstall`は取得せず常設コマンドへ委譲する。 |
| `installer/build-bootstrap.sh` | `bootstrap.sh.tmpl`へ`REF`・`COMMIT`・`REPO_URL`を埋め込み、標準出力へ`install.sh`を出す生成スクリプト。CIと手元の両方から同じ手順で使う。 |
| `installer/main.sh` | 本体。`install` / `update` / `uninstall [--purge]` / `status`、設定ファイルの検証・反映、導入メタ情報の記録、常設コマンドの配置を行う。**プロジェクト固有の処理は、ファイル冒頭近くの3つのフック関数（`app_install`・`app_uninstall`・`app_purge`）だけに書く**。それ以外は書き換えない。 |
| `installer/config.schema` | 設定ファイルに持てるキーの宣言（キー名・既定値・必須か・説明）。`--set`・環境変数から受け付けるのは、ここに宣言したキーだけ。 |
| `.github/workflows/release-installer.yml` | ブランチpushでは`install.sh`をCIアーティファクト（`installer-<ブランチ名>`）として保存するだけで、タグ・Pre-releaseは作らない。タグ（`v*`）pushではGitHub Releaseへ`install.sh`と`.sha256`を添付する。`workflow_dispatch`による手動実行にも対応する。ジョブのサマリへ、そのブランチ・タグの導入・切り替えコマンドを出す。 |

**頒布スクリプトの書き方**: `bootstrap.sh.tmpl`・`main.sh`・`config.schema`は利用者へ頒布されるもので、利用者が中身を読んだり編集したりしない。コメントを書かず、アプリ固有の説明・文言（アプリ名や用途の解説など）を埋め込まない。`--help`の使い方表示とエラーメッセージ、設定ファイルに書き出す各キーの1行説明（`config.schema`の説明欄）だけを最低限残す。仕様や書式の説明は、このSKILL.mdに書く。

**`config.schema`の書式**: 1行1キー、区切りは`|`で`KEY|既定値|required または optional|説明`。KEYは大文字英数字と`_`のみ（英字始まり）。既定値と説明に`|`と改行は使えない。`#`で始まる行と空行は無視される。

**フック関数の契約**（`main.sh`）: `app_install`は設定ファイル反映後に呼ばれ、何度実行しても同じ結果になること。設定値は`. "$CONF_FILE"`で読め、`$DIR`は取得先。`app_uninstall`は`uninstall`の最初に呼ばれ、`$DIR`以外にある導入物（サービス停止・unit削除等）を片付ける。存在しない物があっても失敗しないこと。`app_purge`は`--purge`のときだけ`app_uninstall`の後に呼ばれ、`/etc/<アプリ名>`・データディレクトリ・導入メタ情報以外のもの（ユーザー等）を削除する。

**命名の原則**: 頒布される最終成果物のファイル名は常に`install.sh`で固定する。ひな形は`bootstrap.sh.tmpl`（取得して委譲するだけの層）、本体は`main.sh`と、役割の違う名前にして、同名・類似名による混同を避ける。`setup.sh`のような曖昧な名前は使わない。

## サブコマンドとオプション

| 実行 | 内容 |
|---|---|
| `install [--ref 名前] [--set KEY=VALUE …]` | 導入する。再実行しても同じ結果になる（冪等）。`--ref`なしは`install.sh`に埋め込まれたREF・コミット、`--ref`ありはそのブランチ・タグの先頭。 |
| `update [--ref 名前] [--set KEY=VALUE …]` | 導入中のREF（ブランチ・タグ）の最新を取得して再適用する。`--ref`でブランチ・タグを切り替え、以後は切り替え先に追従する。`install.sh`経由でも`<アプリ名>-ctl`経由でも同じ動作（`install.sh`は導入済みの常設コマンドへ委譲し、埋め込みコミットへは巻き戻さない）。新しい版の`main.sh`で再適用される。 |
| `refs` | 取得元のブランチとタグを`種別<TAB>名前`で1行ずつ表示する（`<アプリ名>-ctl`のみ）。 |
| `uninstall` | アプリ本体（`app_uninstall`の対象、常設コマンド、取得先ディレクトリ）を削除する。設定ファイル・データ・導入メタ情報は残す（再導入時にそのまま使える）。 |
| `uninstall --purge` | 上記に加えて、`/etc/<アプリ名>`・データディレクトリ・導入メタ情報・`app_purge`の対象も削除する。 |
| `status` | 導入先・参照（名前と種別）・コミット・取得元・更新日時を表示する（`<アプリ名>-ctl`のみ）。 |

`--uninstall`のようなフラグ形式は廃止した。アンインストールの削除範囲は`main.sh`の`cmd_uninstall`に一元化し、`install.sh`側では何も削除しない。

## ブランチ・タグの指定と切り替え（`--ref`）

- **名前は短縮形でよい**。`--ref main`・`--ref v1.2.0`・`--ref feat/x`のように、`refs/heads/`・`refs/tags/`を付けずに指定できる。`main.sh`の`resolve_ref`が`git ls-remote`で取得元を調べて解決する。
  - ブランチだけ・タグだけに存在 → その完全名に解決する。
  - 両方に存在 → 曖昧なのでエラー（`refs/heads/<名前>`か`refs/tags/<名前>`での指定を促す）。この場合だけ完全名が必要。
  - どちらにも無い → エラー。導入先・導入メタ情報は変更しない（解決は取得・チェックアウトより前に行う）。
- **導入メタ情報の`REF`は完全名**（`refs/heads/main`等）で保存する。`build-bootstrap.sh`の第1引数も完全名で、CIは`github.ref`を渡す（`github.ref_name`ではブランチとタグを区別できない）。`update`は常にこの完全名を取得し直すので、ブランチは最新へ追従し、タグは指すコミットに留まる。
- 実行の流れ: `--commit`なしの`install --ref`・`update`は、名前を解決して取得・チェックアウトし、**新しい版の`main.sh`を`--ref <完全名> --commit <コミット> --repo-url <URL>`付きで再実行**して適用する（`--commit`の有無で一次実行と再実行を区別する）。
- **ブランチ用のタグ・Pre-releaseは作らない**。ブランチ名と同名のタグを打つ運用は、ブランチとタグの名前衝突を招き、更新時に完全名での指定を強いる。ブランチの導入・切り替えは、Release（またはアーティファクト）の`install.sh`を実行して`--ref <ブランチ名>`で行う。

## 配置先と設定の扱い

| 種別 | パス | 備考 |
|---|---|---|
| ソース（取得先） | `{{DEFAULT_INSTALL_DIR}}`（環境変数`{{DIR_ENV_VAR}}`で変更。install時のみ） | gitリポジトリ。`uninstall`で削除 |
| 設定 | `/etc/<アプリ名>/<アプリ名>.env` | `KEY='VALUE'`形式（shの`source`とsystemdの`EnvironmentFile=`の両方で読める）。権限600。`--purge`で削除 |
| 導入メタ情報 | `/var/lib/<アプリ名>-installer/state` | REF・COMMIT・REPO_URL・更新日時。`update`が参照する。`--purge`で削除 |
| データ | `{{DATA_DIR}}`（既定`/var/lib/<アプリ名>`） | `--purge`で削除 |
| 常設コマンド | `/usr/local/bin/<アプリ名>-ctl` | `uninstall`で削除 |

**設定値の決まり方**（優先順位）: `--set` > 環境変数 > 既存の設定ファイル > 既定値。

- 既存の設定ファイルは**保持**する。`install`の再実行・`update`では、スキーマに新しく増えたキー（既定値）の追記と、`--set`・環境変数で明示したキーの上書きだけを行う。ユーザーが手で編集した値は変えない。
- 環境変数・`--set`から受け付けるのは、`config.schema`で宣言したキーのみ。未宣言キーの`--set`はエラー（タイプミスの防止）。環境変数は宣言済みキーと同名のものだけ見る。
- `required`で既定値が空のキーは、どの経路にも値が無ければ**何も変更せず**中止する（検証は変更の前に行う）。
- 値に`'`と改行は使えない。値はログに出さない（キー名と、どの経路で決まったかだけ出す）。
- `--set`の値は`ps`・シェル履歴に残る。パスワード等の秘匿値は、環境変数（`sudo -E`や`sudo env KEY=… sh …`で引き継ぐ）か、設定ファイルへの直接記入で渡すよう、READMEに書く。
- アプリからは`EnvironmentFile=/etc/<アプリ名>/<アプリ名>.env`（systemd）か、`. /etc/<アプリ名>/<アプリ名>.env`（sh）で読む。

## 着手前に確認する事項

ユーザーの作業方式（推測で進めず、不明点は着手前に解消する）に従い、以下が不明な場合は実装前に必ず確認する。

1. **リポジトリの取得元URL**（GitHub `owner/repo`。ワークフロー内では`github.repository`から組み立てられるため、通常は追加確認不要）。
2. **対象OS・パッケージマネージャ**（既定はDebian系＝`apt-get`。異なる場合はテンプレートの依存導入部を書き換える）。LXC / LXD コンテナへ配布する場合は、コンテナ内のOS（Ubuntu・Debian・Alpine等。Alpineはmuslのため、glibc前提のバイナリを導入するならUbuntu・Debianを選ぶ）と、systemdが使えるか（Ubuntu・Debianのイメージは使える）を確認する。コンテナ内ではroot実行になるため、`sudo`の有無も確認する。
3. **`bootstrap.sh.tmpl`が導入すべき最小限の依存**（git・ca-certificates以外に、取得後すぐに必要なものがあるか。アプリ用の依存は`app_install`で入れるのが基本で、ひな形側は「取得するために最低限必要なもの」に留める）。
4. **既定の取得先ディレクトリ**（例`/opt/<アプリ名>`）と、環境変数での上書き手段の名前（例`<APPNAME大文字>_DIR`）。
5. **設定キーの一覧**（キー名・既定値・必須か・説明）。秘匿値（パスワード・トークン等）がどれか。アプリが設定をどう読むか（systemdの`EnvironmentFile`・`source`・アプリ自身のパーサ）。設定を持たないアプリなら、`config.schema`は宣言ゼロでよい。
6. **導入物の一覧**（`$DIR`の外に置くもの: unit・ユーザー・データ等）と、`uninstall`で消す範囲・`--purge`でだけ消す範囲の線引き。
7. **CIで実行すべき検査**（シェル構文・shellcheck以外に、そのプロジェクト固有の単体テスト・lintがあるか。既存の`npm test`等のCIステップがあれば流用する）。
8. **アーティファクト名・Release資産名の命名規則**（既存プロジェクトに慣習があれば合わせる。無ければCIアーティファクト名は`installer-<ブランチ名を/→-に置換>`を既定とする。ブランチ用のタグ・Pre-releaseは作らない）。
9. **導入の権限**（root権限で`/usr/local/bin`・`/etc`に置くか、一般ユーザー権限で`$HOME`配下に置くか）。後者は下記「一般ユーザー権限で導入する場合」の差分を適用する。

## 作業手順

1. 上記「着手前に確認する事項」を解消する。
2. `templates/`の5ファイルを対象プロジェクトへコピーする（`bootstrap.sh.tmpl`・`build-bootstrap.sh`・`main.sh`・`config.schema`を`installer/`へ、`release-installer.yml`を`.github/workflows/`へ）。テンプレート内の`{{PLACEHOLDER}}`をすべて実値に置換する（一覧は下記）。`@@REF@@`・`@@COMMIT@@`・`@@REPO_URL@@`は`bootstrap.sh.tmpl`内に**置換せず残す**（`build-bootstrap.sh`がCI実行時・ローカル実行時に置換する対象のため）。
3. `main.sh`のフック3つ（`app_install`・`app_uninstall`・`app_purge`）に、プロジェクト固有の処理を書く。`app_install`は設定ファイル反映後に呼ばれ、何度実行しても同じ結果になること。`app_uninstall`は存在しない物があっても失敗しないこと。処理が無いフックには`:`を書く（空の関数は構文エラーになる）。
4. ローカルで生成を検証する: `sh installer/build-bootstrap.sh <REF> <40桁コミットハッシュ> <REPO_URL> > /tmp/install.sh && sh -n /tmp/install.sh`。可能なら`shellcheck -S warning installer/*.sh`も通す（フック内で`. "$CONF_FILE"`を使うと`SC1090`が出るため、その行に`# shellcheck source=/dev/null`を付ける）。
5. `.env`等の追跡外ファイルが無いクリーンな環境で、生成した`install.sh`を実際に実行し、次を確認する。LXC / LXD コンテナ向けは、使い捨てのコンテナ（例`lxc launch ubuntu:24.04 <名前>`。Ubuntuのコンテナ用イメージは`ubuntu:`リモートにあり、`images:`リモートのUbuntu 24.04はデスクトップ用VMのみ）を新規に作って実行し、検証後に`lxc delete -f <名前>`で破棄する。ローカルのソースを試す場合は、`build-bootstrap.sh`の`REPO_URL`に`file://`を指定し、`lxc file push -r`でソースをコンテナへ入れてから`lxc exec`で実行する。
   - 必須キー無しの`install`が、何も変更せず失敗する。
   - `install --set …`で設定ファイル（権限600）が作られ、`app_install`が動く。
   - 設定ファイルを手編集して`install`を再実行しても、値が保持される。環境変数・`--set`で上書きでき、優先順位どおりになる。
   - 未宣言キー・`'`を含む値の`--set`がエラーになる。
   - 新しいコミット（スキーマにキーを追加）を作り、`<アプリ名>-ctl update`で追従し、新キーが追記される。古い`install.sh`の`update`も、導入中のREFの最新へ追従する（埋め込みコミットへ戻らない）。
   - ブランチ・タグ: 取得元にブランチ`feat/x`とタグ`v1`を作り、`install --ref feat/x`でそのブランチの先頭が入る。`update --ref v1`でタグへ、`update --ref main`でブランチへ切り替わり、`status`の参照が変わる。存在しない名前の`--ref`は、導入先・導入メタ情報を変えずに失敗する。ブランチとタグが同名のときはエラーになり、完全名なら通る。`refs`で一覧が出る。
   - `uninstall`で本体・常設コマンド・取得先が消え、設定・データが残る。再`install`で設定が再利用される。`uninstall --purge`で設定・データ・メタ情報も消える。
   - 擬似コマンド（`systemctl`・`tmux`等）で代替できない処理は、検証サーバ等の実環境（systemdの`--user`、`sh`がdashの環境）でも1度は通す。`shellcheck -S warning`も実環境で通す。
6. ワークフローファイルの構文を確認する（`actionlint`があれば使う。無ければYAMLとしての構文だけでも確認する）。

## 各テンプレートのプレースホルダ

- `templates/bootstrap.sh.tmpl`: `{{APP_NAME}}`（アプリ識別子。ディレクトリ名・変数名・常設コマンド名`<アプリ名>-ctl`に使う）、`{{DEFAULT_INSTALL_DIR}}`（既定の取得先。例`/opt/{{APP_NAME}}`）、`{{DIR_ENV_VAR}}`（取得先を上書きする環境変数名）、`{{BOOTSTRAP_DEPS_INSTALL}}`（対象OS・パッケージマネージャに応じた依存導入コマンド）。
- `templates/build-bootstrap.sh`: プレースホルダなし（そのままコピーする）。
- `templates/main.sh`: `{{APP_NAME}}`、`{{DATA_DIR}}`（データディレクトリ。既定`/var/lib/{{APP_NAME}}`）、`{{APP_INSTALL_STEPS}}`・`{{APP_UNINSTALL_STEPS}}`・`{{APP_PURGE_STEPS}}`（各フック関数の本体。何もしないなら`:`）。
- `templates/config.schema`: `{{APP_NAME}}`、`{{CONFIG_SCHEMA_ENTRIES}}`（`KEY|既定値|required または optional|説明`を1行1キーで。設定を持たないなら空にしてよい）。
- `templates/release-installer.yml`: `{{PRECHECK_STEPS}}`（シェル構文検査・shellcheck以外の、プロジェクト固有の検査ステップ群）、`{{PRECHECK_STEPS_SUMMARY}}`（その一言要約。ヘッダコメント用）、`{{DIST_DIR}}`（既定`dist`）。

置換後、テンプレート由来である旨のコメント（例:「このスキルのテンプレートを元に生成」等の自己言及）は本文に残さないこと（README同様、成果物自体には執筆過程の注釈を書かない）。

## 一般ユーザー権限で導入する場合（root不要）

`templates/`はroot権限での導入（`/usr/local/bin`・`/etc`・`/var/lib`）を前提にしている。sudoを使わずに`$HOME`配下へ導入するアプリ（ユーザー単位のsystemd等）では、次の差分を加える。役割分担・サブコマンド・`--ref`の仕組みは同じ。

| 項目 | rootの場合 | 一般ユーザーの場合 |
|---|---|---|
| 実行権限の検査 | `bootstrap.sh.tmpl`・`main.sh`の`need_root`でroot必須 | 逆にroot（`id -u`が0）を拒否する。`HOME`未設定も拒否する。`need_root`は削除する |
| 取得先 | `/opt/<アプリ名>` | `$HOME/.local/share/<アプリ名>` |
| 設定 | `/etc/<アプリ名>/<アプリ名>.env` | `$HOME/.config/<アプリ名>/<アプリ名>.env` |
| 導入メタ情報 | `/var/lib/<アプリ名>-installer/state` | `$HOME/.local/state/<アプリ名>-installer/state` |
| 常設コマンド | `/usr/local/bin/<アプリ名>-ctl`（`install_ctl`が生成する薄いラッパー） | アプリ自身のコマンドを`$HOME/.local/bin`へシンボリックリンクし、`self <update\|uninstall\|status\|refs>`で`main.sh`へ委譲する（`install_ctl`は不要） |
| 依存の導入 | `BOOTSTRAP_DEPS_INSTALL`で`apt-get` | 昇格できないため導入せず、不足を知らせて終了する（`die "git が必要です"`） |
| `uninstall` | 取得先の削除前に`/`・`/usr`等を除外 | 加えて`$HOME`自体も除外する |
| 検証 | `sudo`で実行 | 昇格コマンドを失敗させても導入・更新・削除が成功することを確認する |

導入物が取得先内のファイルへのリンクなら、更新は取得先の入れ替えだけで反映される。コピーして配置するもの（systemdのunit等）は、更新のたびに`app_install`が上書きし、`daemon-reload`する。名前を変えた導入物がある場合は、`app_install`の先頭で旧名のものを無効化・削除して移行する。
