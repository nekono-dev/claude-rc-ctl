import assert from "node:assert/strict"
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  ROOT,
  buildInstaller,
  installFixture,
  makeEnv,
  makeRepo,
} from "./helpers.mjs"

const snapshot = (e, dir) => {
  const bin = join(e.home, ".local", "bin")
  return JSON.stringify({
    ctl: readlinkSync(join(bin, "claude-rc-ctl")),
    run: readlinkSync(join(bin, "claude-rc-run")),
    unit: readFileSync(
      join(e.home, ".config/systemd/user/claude-rc@.service"),
      "utf8",
    ),
    conf: readFileSync(
      join(e.home, ".config/claude-rc-ctl/claude-rc-ctl.env"),
      "utf8",
    ),
    head: readFileSync(join(dir, ".git", "HEAD"), "utf8"),
  })
}

test("claude-rc-ctl/AC-13: コマンドとサービス定義が配置され、2回実行しても結果が変わらない", () => {
  const e = makeEnv()
  const { script, res, dir } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  const bin = join(e.home, ".local", "bin")
  assert.ok(lstatSync(join(bin, "claude-rc-ctl")).isSymbolicLink())
  assert.equal(
    readlinkSync(join(bin, "claude-rc-ctl")),
    join(dir, "src", "claude-rc-ctl"),
  )
  assert.equal(
    readlinkSync(join(bin, "claude-rc-run")),
    join(dir, "src", "claude-rc-run"),
  )
  assert.equal(
    readFileSync(
      join(e.home, ".config/systemd/user/claude-rc@.service"),
      "utf8",
    ),
    readFileSync(join(ROOT, "src", "claude-rc@.service"), "utf8"),
  )
  assert.equal(
    statSync(join(e.home, ".config/claude-rc-ctl/claude-rc-ctl.env")).mode &
      0o777,
    0o600,
  )
  assert.ok(e.calls().includes("systemctl --user daemon-reload"))

  const first = snapshot(e, dir)
  const again = e.run("sh", [script, "install"])
  assert.equal(again.status, 0, again.err)
  assert.equal(snapshot(e, dir), first)
})

test("claude-rc-ctl/AC-14: 管理者として実行すると何も変更せずに失敗する", () => {
  const e = makeEnv()
  const repo = makeRepo(e)
  const script = buildInstaller(e, repo)
  const r = e.run("sh", [script, "install"], { STUB_UID: "0" })
  assert.notEqual(r.status, 0)
  assert.match(r.err, /一般ユーザー/)
  assert.ok(!existsSync(join(e.home, ".local")))
  assert.ok(!existsSync(join(e.home, ".config")))
})
