import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { CTL, ROOT, installFixture, makeEnv } from "./helpers.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 擬似サーバー（sh）と、指定ディレクトリを cwd とする子プロセス（セッション）を起動する。セッションが0件のサーバーは子を持たない。
 * busy が真の子は、実行中状態の孫プロセスを持つ。
 */
async function makeServer(e, sessions) {
  const files = sessions.map((_, i) => join(e.home, `pid${i}-${Date.now()}`))
  const body = sessions
    .map(({ dir, busy }, i) => {
      const tail = busy
        ? `sh -c "while :; do :; done" & wait`
        : "exec sleep 300"
      return `(cd '${dir}' && exec sh -c 'echo $$ > ${files[i]}; ${tail}') &`
    })
    .join("\n")
  const script = sessions.length ? `${body}\nwait` : "exec sleep 300"
  const server = spawn("sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  })
  for (let n = 0; n < 100 && !files.every((f) => existsSync(f)); n++)
    await sleep(50)
  await sleep(100)
  const pids = files.map((f) => Number(readFileSync(f, "utf8").trim()))
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGKILL")
    } catch {}
  }
  return { pid: server.pid, pids, stop }
}

/** プロジェクトディレクトリと、更新時刻を minutes 分前にした transcript を作る */
function makeProject(e, name, minutes, { reminder } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `rcproj-${name}-`)))
  const proj = join(
    e.home,
    ".claude",
    "projects",
    dir.replace(/[^A-Za-z0-9]/g, "-"),
  )
  mkdirSync(proj, { recursive: true })
  const f = join(proj, "00000000-0000-0000-0000-000000000000.jsonl")
  writeFileSync(f, "{}\n")
  const t = new Date(Date.now() - minutes * 60_000)
  utimesSync(f, t, t)
  if (reminder !== undefined) {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "scheduled_tasks.json"), reminder)
  }
  return dir
}

const RESTART = (n) => `systemctl --user restart claude-rc@${n}.service`

/** 1インスタンスに対して archive を実行し、再起動されたかを返す */
async function scenario(sessions, { idle, args = ["archive", "inst"] } = {}) {
  const e = makeEnv()
  e.register("inst", "/x")
  if (idle !== undefined)
    writeFileSync(
      join(e.confDir, "inst.env"),
      `CLAUDE_RC_DIR=/x\nCLAUDE_RC_ARCHIVE_MINUTES=${idle}\n`,
    )
  const dirs = sessions.map((s) =>
    makeProject(e, "s", s.minutes, { reminder: s.reminder }),
  )
  const srv = await makeServer(
    e,
    sessions.map((s, i) => ({ dir: dirs[i], busy: s.busy })),
  )
  try {
    const r = e.run(CTL, args, { STUB_PANE_PID_inst: String(srv.pid) })
    return { e, r, srv, restarted: e.calls().includes(RESTART("inst")) }
  } finally {
    srv.stop()
  }
}

test("claude-rc-archive/AC-1: 全セッションが閾値を超えて更新されていないとき、サーバーが再起動される", async () => {
  const { r, restarted } = await scenario([
    { minutes: 20000 },
    { minutes: 15000 },
  ])
  assert.equal(r.status, 0, r.err)
  assert.ok(restarted)
  assert.match(r.out, /\[inst\] セッション=- アイドル=20000分 判定=アーカイブ/)
  assert.match(r.out, /\[inst\] アーカイブ: サーバーを再起動する/)
})

test("claude-rc-archive/AC-2: 未登録の名前を指定すると、何も再起動せずに失敗する", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["archive", "nothing"])
  assert.equal(r.status, 1)
  assert.match(r.err, /未登録です: nothing/)
  assert.ok(!e.calls().some((c) => c.includes("restart")))
})

test("claude-rc-archive/AC-3: 閾値内に更新のあるセッションが1つでもあれば、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 5 }, { minutes: 20000 }])
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
  assert.match(r.out, /判定=保持\(アイドル不足\)/)
})

test("claude-rc-archive/AC-4: 更新が古くても、実行中の子プロセスを持つセッションがあれば、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([
    { minutes: 20000, busy: true },
    { minutes: 20000 },
  ])
  assert.ok(!restarted)
  assert.match(r.out, /判定=保持\(実行中\)/)
})

test("claude-rc-archive/AC-5: 更新が古くても、作業ディレクトリにリマインダーが1件以上あれば、サーバーは再起動されない", async () => {
  const withTask = JSON.stringify({
    tasks: [{ id: "a", cron: "0 9 * * *", prompt: "x", createdAt: 1 }],
  })
  const kept = await scenario([{ minutes: 20000, reminder: withTask }])
  assert.ok(!kept.restarted)
  assert.match(kept.r.out, /判定=保持\(リマインダー\)/)
  const broken = await scenario([{ minutes: 20000, reminder: "{" }])
  assert.ok(!broken.restarted, "壊れた定義は保持側に倒す")
  const empty = await scenario([
    { minutes: 20000, reminder: JSON.stringify({ tasks: [] }) },
  ])
  assert.ok(empty.restarted, "タスクが0件なら再起動される")
})

test("claude-rc-archive/AC-6: 閾値が未指定のとき、10079分前の更新は残り、10081分前の更新は再起動される", async () => {
  assert.ok(!(await scenario([{ minutes: 10079 }])).restarted)
  assert.ok((await scenario([{ minutes: 10081 }])).restarted)
})

test("claude-rc-archive/AC-7: 閾値を指定すると、その分数で判定される", async () => {
  assert.ok(!(await scenario([{ minutes: 5 }], { idle: 10 })).restarted)
  assert.ok((await scenario([{ minutes: 20 }], { idle: 10 })).restarted)
})

test("claude-rc-archive/AC-8: 閾値が0のとき、古いセッションがあっても再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 90000 }], { idle: 0 })
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
})

test("claude-rc-archive/AC-9: 停止中のインスタンスと、セッションがないインスタンスは、再起動されない", async () => {
  const e = makeEnv()
  e.register("down", "/x")
  e.register("empty", "/x")
  const srv = await makeServer(e, [])
  try {
    const r = e.run(CTL, ["archive", "--all"], {
      STUB_INACTIVE: "down",
      STUB_PANE_PID_down: String(srv.pid),
      STUB_PANE_PID_empty: String(srv.pid),
    })
    assert.equal(r.status, 0, r.err)
    assert.ok(!e.calls().some((c) => c.includes("restart")))
  } finally {
    srv.stop()
  }
})

test("claude-rc-archive/AC-10: 一括判定を指示すると、条件を満たす複数のインスタンスが再起動され、満たさないものは飛ばされる", async () => {
  const e = makeEnv()
  const names = ["aa", "bb", "cc", "dd"]
  const srvs = []
  const extra = { STUB_INACTIVE: "cc" }
  const minutes = { aa: 20000, bb: 20000, cc: 20000, dd: 5 }
  try {
    for (const n of names) {
      e.register(n, "/x")
      const s = await makeServer(e, [{ dir: makeProject(e, n, minutes[n]) }])
      srvs.push(s)
      extra[`STUB_PANE_PID_${n}`] = String(s.pid)
    }
    const r = e.run(CTL, ["archive", "--all"], extra)
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(
      names.filter((n) => e.calls().includes(RESTART(n))),
      ["aa", "bb"],
    )
  } finally {
    srvs.forEach((s) => s.stop())
  }
})

const UNITS = ["claude-rc-archive.service", "claude-rc-archive.timer"]

test("claude-rc-archive/AC-11: インストーラを実行すると、定期実行のユニットが配置されて有効化される", () => {
  const e = makeEnv()
  const unitDir = join(e.home, ".config/systemd/user")
  // 旧名のユニットが残っている環境からの導入でも、旧ユニットは撤去される
  mkdirSync(unitDir, { recursive: true })
  for (const u of ["claude-rc-reap.service", "claude-rc-reap.timer"])
    writeFileSync(join(unitDir, u), "old\n")
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  for (const u of UNITS)
    assert.equal(
      readFileSync(join(unitDir, u), "utf8"),
      readFileSync(join(ROOT, "src", u), "utf8"),
    )
  assert.ok(
    e.calls().includes("systemctl --user enable --now claude-rc-archive.timer"),
  )
  assert.ok(
    e.calls().includes("systemctl --user disable --now claude-rc-reap.timer"),
  )
  assert.ok(!existsSync(join(unitDir, "claude-rc-reap.timer")))
  assert.match(
    readFileSync(join(unitDir, "claude-rc-archive.timer"), "utf8"),
    /OnUnitActiveSec=10min/,
  )
  assert.match(
    readFileSync(join(unitDir, "claude-rc-archive.service"), "utf8"),
    /ExecStart=%h\/\.local\/bin\/claude-rc-ctl archive --all/,
  )
})

test("claude-rc-archive/AC-12: 削除を指示すると、定期実行のユニットが無効化されて撤去される", () => {
  const e = makeEnv()
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  // 導入先のコマンドで実行する（リポジトリ内のコマンドは取得先として自身を削除してしまう）
  const ctl = join(e.home, ".local", "bin", "claude-rc-ctl")
  const r = e.run(ctl, ["self", "uninstall"])
  assert.equal(r.status, 0, r.err)
  assert.ok(
    e
      .calls()
      .includes("systemctl --user disable --now claude-rc-archive.timer"),
  )
  const unitDir = join(e.home, ".config/systemd/user")
  for (const u of UNITS) assert.ok(!existsSync(join(unitDir, u)))
})

test("claude-rc-archive/AC-13: 確認のみを指定すると、対象と理由が表示され、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 20000 }], {
    args: ["archive", "--dry-run", "inst"],
  })
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /判定=アーカイブ/)
  assert.match(r.out, /\[inst\] 対象: サーバーを再起動して/)
  assert.ok(!restarted)
})

test("claude-rc-archive/AC-15: 登録済みインスタンスが10件のとき、一括判定が5秒以内に終わる", () => {
  const e = makeEnv()
  for (let i = 0; i < 10; i++) e.register(`n${i}`, "/x")
  const r = e.run(CTL, ["archive", "--all"])
  assert.equal(r.status, 0, r.err)
  assert.ok(r.ms < 5000, `${r.ms}ms`)
})
