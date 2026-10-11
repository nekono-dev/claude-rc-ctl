import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ROOT, RUN, makeEnv } from "./helpers.mjs"

const unit = readFileSync(join(ROOT, "src", "claude-rc@.service"), "utf8")

const runWith = (extraEnvLines) => {
  const e = makeEnv()
  const dir = join(e.home, "work")
  mkdirSync(dir)
  mkdirSync(e.confDir, { recursive: true })
  writeFileSync(
    join(e.confDir, "w.env"),
    `CLAUDE_RC_DIR=${dir}\n${extraEnvLines}`,
  )
  const r = e.run(RUN, ["w"])
  assert.equal(r.status, 0, r.err)
  return {
    args: readFileSync(join(e.home, "claude.args"), "utf8").trim().split("\n"),
    dir,
  }
}

test("claude-rc-ctl/AC-8: 登録情報に値がないとき same-dir と auto で remote-control が起動される", () => {
  const { args, dir } = runWith("")
  assert.equal(args[0], dir)
  assert.deepEqual(args.slice(1), [
    "remote-control",
    "--spawn",
    "same-dir",
    "--permission-mode",
    "auto",
    "--remote-control-session-name-prefix",
    `${hostname()}-w`,
  ])
})

test("claude-rc-ctl/AC-9: 登録情報の起動方式と権限モードで remote-control が起動される", () => {
  const { args } = runWith(
    "CLAUDE_RC_SPAWN=same-dir\nCLAUDE_RC_PERMISSION_MODE=plan\n",
  )
  assert.deepEqual(args.slice(2, 6), [
    "--spawn",
    "same-dir",
    "--permission-mode",
    "plan",
  ])
})

test("claude-rc-ctl/AC-10: サービス定義は tmux の専用ソケット内でセッションを作成して起動する", () => {
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/tmux -L claude-rc-%i new-session -d -s %i %h\/\.local\/bin\/claude-rc-run %i$/m,
  )
  assert.match(unit, /^ExecStop=\/usr\/bin\/tmux -L claude-rc-%i kill-server$/m)
})

test("claude-rc-ctl/AC-19: サービス定義は常に再起動し、待ち時間が10秒である", () => {
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^RestartSec=10$/m)
})
