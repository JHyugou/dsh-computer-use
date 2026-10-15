#!/usr/bin/env node
/**
 * 在**真实 DSH** 里验证 Computer Use：让模型自己驱动一次 GUI 操作，然后用**外部观察**核验结果。
 *
 * 与 tools/e2e.mjs 的区别：
 *   - e2e 直接调本插件的工具定义（跳过 DSH 的注册表/提示词/agent 循环）；
 *   - 本脚本跑 `dsh --profile <verify-profile> --json "<task>"`，即**完整 DSH**：
 *     真实 loader → 真实工具注册表 → 真实模型 → 真实工具执行。
 *
 * 为什么可信：任务要求模型点击我们自己的 WPF 夹具按钮，但**结论不采信模型的自我汇报**——
 * 脚本在模型跑完后，用原生后端独立读一次那个窗口的标题（`list_windows`），
 * 只有标题真的变成 `CLICKED:<n>` 才算通过。
 *
 * 前置：
 *   1. `node tools/install-plugin.mjs --apply --install`（DSH_PROFILE=<verify-profile>）
 *   2. 有 `E:\deepseek-harness` 这样的 dsh 源码 checkout 可执行 `pnpm dsh`
 * 用法：
 *   node tools/verify-in-dsh.mjs [--profile=cu-verify] [--checkout=E:\deepseek-harness]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.replace(/^--/u, '').split('=')
    return [key, rest.join('=') || 'true']
  }),
)
const profile = args.get('profile') ?? process.env.DSH_VERIFY_PROFILE ?? 'cu-verify'
const checkout = args.get('checkout') ?? process.env.DSH_CHECKOUT ?? 'E:\\deepseek-harness'
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const fixtureScript = fileURLToPath(new URL('./e2e-fixture.ps1', import.meta.url))
const sourceIndex = fileURLToPath(new URL('../src/index.js', import.meta.url))
const sourceBridge = fileURLToPath(new URL('../src/bridge.js', import.meta.url))
const sourceNative = fileURLToPath(new URL('../src/native/cua.ps1', import.meta.url))

let pass = 0
let fail = 0
const failures = []
const check = (label, ok, detail) => {
  const shown = detail === undefined
    ? ''
    : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}${shown}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  FAIL  ${label}${shown}`)
  }
}
const section = (title) => console.log(`\n=== ${title} ===`)

/** 事件流落盘目录，便于事后复盘（模型跑偏时尤其需要）。 */
const artifactDir = join(process.env.TEMP ?? '.', 'dsh-cu-verify')

if (!existsSync(join(dshHome, 'profiles', profile, 'package.json'))) {
  console.error(`verify profile not found: ${join(dshHome, 'profiles', profile, 'package.json')}`)
  console.error(`create it with: dsh ${profile} --from-default-profile headless  (then install the plugin into it)`)
  process.exit(2)
}

/** 启动 WPF 夹具，返回 pid 与子进程。 */
async function startFixture() {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', fixtureScript], {
    windowsHide: false,
  })
  const pid = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('fixture did not report its pid in time')), 25000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const match = /FIXTURE_PID=(\d+)/u.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`fixture exited early (code=${code})`)))
  })
  return { child, pid }
}

/**
 * 跑一次 dsh headless，返回退出码与解析后的事件。
 *
 * **任务必须走 stdin，不能当位置参数拼进命令行。**
 * 曾经的写法是 `spawn('pnpm', ['dsh', ..., task], { shell: true })`：shell 会把参数
 * 拼成一条命令行，而 cmd.exe 在**第一个换行处就截断**——多行任务只送到第一行，
 * 模型收到「说了要执行步骤但没给步骤」的残句，于是正确地拒绝执行。
 * 那次看起来像「模型跑偏」，其实是参数传递 bug。
 * 现在直接调 CLI 入口（不经 shell），任务从 stdin 原样送入（headless 文档规定的 `-`）。
 */
async function runDsh(task) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, '--json', '-'],
      {
        cwd: checkout,
        env: { ...process.env, DSH_HOME: dshHome },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      const events = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter(Boolean)
      resolve({ code, events, stdout, stderr })
    })
    child.stdin.end(task, 'utf8')
  })
}

/** 用原生后端独立读一次夹具窗口标题（不采信模型汇报）。 */
async function readFixtureTitle(pid) {
  const { NativeBridge } = await import(`file://${sourceBridge.replace(/\\/gu, '/')}`)
  const bridge = new NativeBridge({ scriptPath: sourceNative, defaultTimeoutMs: 30000 })
  try {
    await bridge.ensureStarted()
    const listed = await bridge.call('list_windows', { pid }, { timeoutMs: 30000 })
    return listed.windows?.[0]?.title
  } finally {
    await bridge.dispose()
  }
}

let fixture
try {
  section('准备：启动我们自己的 WPF 夹具窗口（零用户数据风险）')
  fixture = await startFixture()
  check('夹具进程已启动', Number.isFinite(fixture.pid), { pid: fixture.pid })
  const titleBefore = await readFixtureTitle(fixture.pid)
  check('夹具窗口可被原生后端读到', titleBefore === 'DSH CUA Fixture', titleBefore)

  section(`在真实 DSH 里运行任务（profile=${profile}）`)
  const task = [
    '这是一个受控的自动化验证任务。请严格按下面的步骤执行，不要探索代码库、不要运行命令、不要读取文件。',
    '只允许使用这些工具：skill、get_app_state、left_click、wait、stop_computer_control。',
    '禁止使用：pwsh、glob、grep、read、screenshot、type、key、set_value、perform_action、list_apps。',
    '',
    `目标应用是一个 PowerShell 进程，pid=${fixture.pid}，窗口标题 "DSH CUA Fixture"，里面有一个名为 FixtureButton 的按钮。`,
    '步骤 1：调用 skill，name 传 computer-use。',
    `步骤 2：调用 get_app_state，参数 app=${fixture.pid}，读它的元素列表，找到 name 为 FixtureButton 的元素，记下 element_index 与返回的 state_id。`,
    '步骤 3：调用 left_click，参数 element_index 用上一步的值，state_id 用上一步返回的值。只点这一个按钮。',
    `步骤 4：调用 wait（duration_ms 传 500），然后再次调用 get_app_state（app=${fixture.pid}），报告窗口标题。`,
    '步骤 5：调用 stop_computer_control。',
    '',
    '最后用不超过 4 行中文汇报：每一步调用了什么、返回的关键字段是什么。',
  ].join('\n')

  const run = await runDsh(task)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(join(artifactDir, 'in-dsh-events.jsonl'), run.stdout, 'utf8')
  await writeFile(join(artifactDir, 'in-dsh-stderr.log'), run.stderr, 'utf8')
  console.log(`  events saved -> ${join(artifactDir, 'in-dsh-events.jsonl')}`)
  check('dsh 退出码为 0', run.code === 0, run.code)

  const calls = run.events.filter((event) => event.type === 'tool_call')
  const results = run.events.filter((event) => event.type === 'tool_result')
  const calledNames = calls.map((event) => event.tool)
  // 轮次结束是 status 事件的 phase，而不是独立的 type（曾经按 type 找 → 永远找不到）。
  const turnEnd = run.events.find((event) => event.type === 'status' && event.phase === 'turn_end')
  const textOutput = run.events.filter((event) => event.type === 'text').map((event) => event.text).join('\n')
  console.log(`  tools 调用序列: ${calledNames.join(' → ')}`)
  check('模型加载了 computer-use 技能', calledNames.includes('skill'), calledNames[0])
  check('模型调用了 get_app_state', calledNames.includes('get_app_state'))
  check('模型调用了 left_click', calledNames.includes('left_click'))
  check('模型调用了 stop_computer_control', calledNames.includes('stop_computer_control'))
  const forbidden = ['pwsh', 'glob', 'grep', 'read', 'type', 'key', 'screenshot', 'set_value', 'perform_action', 'list_apps']
  check(
    '没有越界使用被禁工具',
    !calledNames.some((name) => forbidden.includes(name)),
    calledNames.filter((name) => forbidden.includes(name)).join(','),
  )
  check('轮次正常结束', turnEnd?.reason?.kind === 'completed', turnEnd?.reason)

  const clickCall = calls.find((event) => event.tool === 'left_click')
  check(
    'left_click 带了 element_index + state_id（元素寻址纪律）',
    typeof clickCall?.input?.element_index === 'number' && typeof clickCall?.input?.state_id === 'string',
    clickCall?.input,
  )
  const clickResult = results.find((event) => event.callId === clickCall?.callId)
  check('left_click 执行状态为 completed', clickResult?.status === 'completed', clickResult?.status)
  const failed = results.filter((event) => event.status !== 'completed')
  check('本次运行没有任何失败的 tool_result', failed.length === 0, failed.length)
  for (const event of failed) {
    const call = calls.find((entry) => entry.callId === event.callId)
    const text = typeof event.result === 'string' ? event.result.slice(0, 400) : JSON.stringify(event.result)?.slice(0, 400)
    console.log(`  failed tool: ${call?.tool}  input=${JSON.stringify(call?.input)}`)
    console.log(`    -> ${text}`)
  }

  section('独立核验：窗口标题是否真的变了（不采信模型汇报）')
  const titleAfter = await readFixtureTitle(fixture.pid)
  check(
    '夹具窗口标题变成 CLICKED:1（点击真的生效）',
    titleAfter === 'DSH CUA Fixture CLICKED:1',
    { before: titleBefore, after: titleAfter },
  )
  const modelClaim = run.events.filter((event) => event.type === 'text').map((event) => event.text).join('\n')
  check('模型汇报里也提到了 CLICKED', /CLICKED/iu.test(modelClaim), modelClaim.slice(-120))
} catch (error) {
  fail += 1
  failures.push(`uncaught: ${error instanceof Error ? error.message : String(error)}`)
  console.log(`  FAIL  uncaught: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  if (fixture !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(fixture.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('exit', () => resolve(undefined))
      killer.on('error', () => resolve(undefined))
    })
    console.log(`\n  cleaned up fixture pid=${fixture.pid}`)
  }
  console.log(`\n${'='.repeat(72)}`)
  console.log(`PASS ${pass}   FAIL ${fail}`)
  if (failures.length > 0) console.log(`failed: ${failures.join(' | ')}`)
  console.log('='.repeat(72))
  process.exitCode = fail === 0 ? 0 : 1
}

// 让 linter 看到这两个只在动态导入中使用的路径常量。
void sourceIndex
