// テスト用の擬似コマンドと実行補助。systemd・tmux・claude を実機なしで検証する。
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const STUBS = {
  // 呼び出しを $HOME/calls.log へ記録する。is-active は STUB_INACTIVE で指定した名前以外 active を返す
  systemctl: `echo "systemctl $*" >> "$HOME/calls.log"
case "$*" in *is-active*)
  case "$*" in *"claude-rc@\${STUB_INACTIVE:-NONE}.service"*) echo inactive; exit 3 ;; esac
  echo active ;;
esac
exit 0`,
  tmux: `echo "tmux $*" >> "$HOME/calls.log"
case "$*" in
  *capture-pane*) echo PANE_OUTPUT ;;
  *display-message*) printenv "STUB_PANE_PID_$6" ;;
esac
exit 0`,
  journalctl: `echo "journalctl $*" >> "$HOME/calls.log"
echo JOURNAL_OUTPUT`,
  loginctl: `echo yes`,
  // 昇格コマンドは失敗させ、呼ばれたことを記録する
  sudo: `echo "sudo $*" >> "$HOME/calls.log"
exit 99`,
  claude: `{ pwd; for a in "$@"; do echo "$a"; done; } > "$HOME/claude.args"
echo "$CLAUDE_CODE_EFFORT_LEVEL" > "$HOME/claude.effort"`,
  // 待ち時間を省き、呼び出しだけを記録する
  sleep: `echo "sleep $*" >> "$HOME/calls.log"`,
  // STUB_UID が設定されていれば id -u の結果を差し替える
  id: `if [ "\${1:-}" = "-u" ] && [ -n "\${STUB_UID:-}" ]; then echo "$STUB_UID"; exit 0; fi
exec /usr/bin/id "$@"`,
}

/** 一時ホームと擬似コマンド群を持つ実行環境を作る */
export function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "rc"))
  const bin = join(home, "stubs")
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
  }
  const run = (cmd, args = [], extra = {}) => {
    const t0 = Date.now()
    const r = spawnSync(cmd, args, {
      env: { ...env, ...extra },
      encoding: "utf8",
      cwd: home,
    })
    return {
      status: r.status,
      out: r.stdout,
      err: r.stderr,
      ms: Date.now() - t0,
    }
  }
  const calls = () => {
    const f = join(home, "calls.log")
    return existsSync(f)
      ? readFileSync(f, "utf8").split("\n").filter(Boolean)
      : []
  }
  const confDir = join(home, ".config", "claude-rc")
  const register = (name, dir) => {
    mkdirSync(confDir, { recursive: true })
    writeFileSync(join(confDir, `${name}.env`), `CLAUDE_RC_DIR=${dir}\n`)
  }
  return { home, bin, env, run, calls, confDir, register }
}

export const CTL = join(ROOT, "src", "claude-rc-ctl")
export const RUN = join(ROOT, "src", "claude-rc-run")

/** 取得元となる一時 git リポジトリ（src と installer のコピー）を作る */
export function makeRepo(e) {
  const dir = mkdtempSync(join(tmpdir(), "rcrepo"))
  for (const d of ["src", "installer"])
    cpSync(join(ROOT, d), join(dir, d), { recursive: true })
  const git = (...a) => e.run("git", ["-C", dir, ...a])
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
  const head = () => git("rev-parse", "HEAD").out.trim()
  const commit = () => {
    writeFileSync(join(dir, "src", "marker"), `${Date.now()}${Math.random()}\n`)
    git("add", "-A")
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "next")
    return head()
  }
  /** 現在のコミットからブランチを作る（作成後は main に戻る）。新しいコミットを積んで返す */
  const branch = (name) => {
    git("checkout", "-q", "-b", name)
    const c = commit()
    git("checkout", "-q", "main")
    return c
  }
  const tag = (name) => git("tag", name)
  return { dir, git, head, commit, branch, tag, url: `file://${dir}` }
}

/** 取得元の現在のコミットに固定した install.sh を生成して返す（ref は参照の完全名） */
export function buildInstaller(e, repo, ref = "refs/heads/main") {
  const r = e.run("sh", [
    join(ROOT, "installer", "build-bootstrap.sh"),
    ref,
    repo.head(),
    repo.url,
  ])
  if (r.status !== 0) throw new Error(`生成に失敗: ${r.err}`)
  const path = join(e.home, "install.sh")
  writeFileSync(path, r.out)
  return path
}

/** 取得元・install.sh を用意して install を実行する */
export function installFixture(e, extra = {}, installArgs = []) {
  const repo = makeRepo(e)
  const script = buildInstaller(e, repo)
  const res = e.run("sh", [script, "install", ...installArgs], extra)
  return {
    repo,
    script,
    res,
    dir: join(e.home, ".local", "share", "claude-rc-ctl"),
  }
}
