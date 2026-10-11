import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { installFixture, makeEnv } from "./helpers.mjs"

const setup = () => {
  const e = makeEnv()
  const f = installFixture(e)
  assert.equal(f.res.status, 0, f.res.err)
  const ctl = join(e.home, ".local", "bin", "claude-rc-ctl")
  const state = join(e.home, ".local/state/claude-rc-ctl-installer/state")
  return { e, ...f, ctl, state }
}

test("claude-rc-ctl/AC-15: 取得元に新しいコミットがあるとき更新すると導入先がそのコミットになる", () => {
  const { e, repo, ctl, state, dir } = setup()
  const next = repo.commit()
  const r = e.run(ctl, ["self", "update"])
  assert.equal(r.status, 0, r.err)
  assert.equal(e.run("git", ["-C", dir, "rev-parse", "HEAD"]).out.trim(), next)
  assert.match(readFileSync(state, "utf8"), new RegExp(`COMMIT='${next}'`))
})

test("claude-rc-ctl/AC-16: 削除すると本体とサービス定義が消え、登録情報は残る", () => {
  const { e, ctl, dir } = setup()
  e.register("keep", "/work/keep")
  const r = e.run(ctl, ["self", "uninstall"])
  assert.equal(r.status, 0, r.err)
  assert.ok(!existsSync(dir))
  assert.ok(!existsSync(join(e.home, ".local/bin/claude-rc-ctl")))
  assert.ok(!existsSync(join(e.home, ".local/bin/claude-rc-run")))
  assert.ok(
    !existsSync(join(e.home, ".config/systemd/user/claude-rc@.service")),
  )
  assert.ok(existsSync(join(e.confDir, "keep.env")))
  assert.ok(e.calls().includes("systemctl --user stop claude-rc@keep.service"))
})

test("claude-rc-ctl/AC-17: パージ付きで削除すると登録情報と設定も消える", () => {
  const { e, ctl, state } = setup()
  e.register("keep", "/work/keep")
  const r = e.run(ctl, ["self", "uninstall", "--purge"])
  assert.equal(r.status, 0, r.err)
  assert.ok(!existsSync(e.confDir))
  assert.ok(!existsSync(join(e.home, ".config/claude-rc-ctl")))
  assert.ok(!existsSync(state))
})

test("claude-rc-ctl/AC-18: 導入情報の表示で導入先・取得元・コミット・更新日時が表示される", () => {
  const { e, repo, ctl, dir } = setup()
  const r = e.run(ctl, ["self", "status"])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, new RegExp(`導入先:\\s+${dir}`))
  assert.match(r.out, new RegExp(`取得元:\\s+${repo.url}`))
  assert.match(r.out, new RegExp(`コミット:\\s+${repo.head()}`))
  assert.match(r.out, /更新日時:\s+\d{4}-\d\d-\d\dT/)
})

test("claude-rc-ctl/AC-21: 昇格コマンドが失敗する環境で導入・更新・削除がすべて成功する", () => {
  const { e, repo, ctl } = setup()
  repo.commit()
  assert.equal(e.run(ctl, ["self", "update"]).status, 0)
  assert.equal(e.run(ctl, ["self", "uninstall", "--purge"]).status, 0)
  assert.ok(!e.calls().some((c) => c.startsWith("sudo")))
})
