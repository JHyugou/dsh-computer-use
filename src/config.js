/**
 * dsh-computer-use 配置与路径约定。
 *
 * 与 DSH 插件生态既有约定一致（见 dsh-remind / dsh-bigmodel-consume）：
 * 配置放 `<dsh home>/plugins/dsh-computer-use/config.json`，原子写入，
 * 损坏时回退默认值，不依赖任何 npm 包。
 *
 * 本插件的「数据」还包括截图产物：后端只回 base64，落盘由宿主端做，
 * 落在同一数据目录的 frames/ 下，便于用户直接打开或交给其它工具处理。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLUGIN_NAME = 'dsh-computer-use'

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  /** 总开关：false 时一个工具都不注册（模型完全看不到这套能力）。 */
  enabled: true,
  /**
   * 工具呈现方式：
   *  - `native`（默认）：注册 ZCode 同名的逐个动作工具（25 个），与上游 Computer Use 工具面一一对应；
   *  - `single`：只注册一个 `computer_use` 分发工具，参数里带 `action`。
   *    适合不想为 26 份 schema 付 token 成本的会话。
   */
  tools: 'native',
  /** 是否把截图栅格落盘（`frames/`），便于用户事后查看。 */
  saveFrames: true,
  /**
   * 是否把随包技能装到 `<dsh home>/skills/computer-use/SKILL.md`。
   * 该目录是 DSH 官方扫描根且被 watcher 监视，装好后新会话立即可见、无需重启。
   * 只会覆盖带本插件标记的文件；用户自己写过的同名技能不会被动。
   */
  installSkill: true,
  /**
   * 是否显示「DSH 正在操作电脑」的置顶指示器（对齐上游 ZCode 的操作浮层）。
   * 它是屏幕最前端、点击穿透、不抢焦点、且**不出现在截图里**的小卡片；
   * 关掉后插件不再拉起指示器进程。
   */
  indicator: true,
  /** 指示器文案语言：`auto`（按运行环境猜）/ `zh-CN` / `en-US`。 */
  indicatorLocale: 'auto',
  /** 是否在文案后带上当前动作（例如「DSH 正在操作电脑 · 点击」）。 */
  indicatorShowAction: true,
  /** 无操作活动多久后自动隐藏（毫秒）。上游同名常量也是 30s。 */
  indicatorAutoHideMs: 30000,
  /** 截图落盘保留数量，超出后删最旧的。 */
  keepFrames: 40,
  /** 单次调用的默认超时（毫秒）。截图/取界面树给更长预算。 */
  requestTimeoutMs: 30000,
  /** 截图（含 zoom）专用超时（毫秒）。 */
  screenshotTimeoutMs: 60000,
  /** 原生后端就绪等待上限（毫秒）。超时后工具会报告不可用而不是整个插件加载失败。 */
  startupTimeoutMs: 20000,
  /**
   * 是否在插件加载时预热后端（拉起 PowerShell 进程并 ping 一次）。
   * 关掉后后端改为首次调用时懒启动：加载更安静，但第一次动作会多等一次冷启动
   * （脚本要 Add-Type 编译 P/Invoke 与 UIA 绑定，实测约 1-2 秒）。
   */
  warmup: true,
  /** 后端崩溃后自动重启次数上限；超出后需要人工干预（工具会报错说明）。 */
  maxRestarts: 3,
  /** 把后端 stderr 诊断写进 DSH 日志。 */
  debug: false,
  /** 模型可见的截图默认长边上限（像素），超过则等比缩小。0 = 不缩放。 */
  screenshotMaxWidth: 1600,
  /**
   * 单张截图的字节预算。超过就按 png → jpeg → 更小分辨率 的阶梯降级。
   * 上游 ZCode 的结果投影同样有硬预算（单张内联图 256 KiB、合计 512 KiB、
   * 最多 4 张，见 `result-display.ts`）；这里取 512 KiB，既压住 token/带宽，
   * 又不至于把一张正常桌面压成糊图。
   */
  screenshotMaxBytes: 524288,
  /** 默认截图格式：`png`（无损，体积大）或 `jpeg`（体积小，有损）。 */
  screenshotFormat: 'png',
  /** jpeg 质量（1-100）。 */
  screenshotQuality: 80,
}

let cachedHome

/** DSH home 目录；优先用官方 dsh-home-paths，取不到再回退环境变量与 ~/.dsh。 */
export async function dshHome() {
  if (cachedHome !== undefined) return cachedHome
  let home
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    home = typeof mod.dshHomePath === 'function' ? mod.dshHomePath() : undefined
  } catch {
    home = undefined
  }
  if (typeof home !== 'string' || home.length === 0) {
    home = process.env.DSH_HOME || join(homedir(), '.dsh')
  }
  cachedHome = home
  return home
}

/** 插件数据目录。 */
export async function dataDir() {
  return join(await dshHome(), 'plugins', PLUGIN_NAME)
}

/**
 * 仅供测试：清掉 home 缓存，让后续 `dshHome()` 重新读取 `DSH_HOME`。
 * 生产语义是「进程内 home 不变」，测试需要在一个进程里切多个 home，
 * 所以给一个显式入口，而不是让生产路径每次都重新解析。
 */
export function resetHomeCacheForTesting() {
  cachedHome = undefined
}

/** 截图落盘目录。 */
export async function framesDir() {
  return join(await dataDir(), 'frames')
}

/** 配置文件路径。 */
export async function configPath() {
  return join(await dataDir(), 'config.json')
}

/** 原生后端脚本路径（相对本文件定位，不依赖 cwd）。 */
export function nativeScriptPath() {
  return new URL('./native/cua.ps1', import.meta.url)
}

/** 操作指示器脚本路径。 */
export function indicatorScriptPath() {
  return new URL('./native/indicator.ps1', import.meta.url)
}

function clampNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 归一化外部输入，永远返回一份合法配置。
 * @param raw 待校验的对象
 * @param base 缺省基线；读文件用 DEFAULT_CONFIG，运行时改配置用当前配置，
 *             这样调用方只传要改的字段。
 */
export function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const cfg = { ...base }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return cfg
  if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled
  cfg.tools = oneOf(raw.tools, ['native', 'single'], cfg.tools)
  if (typeof raw.saveFrames === 'boolean') cfg.saveFrames = raw.saveFrames
  if (typeof raw.installSkill === 'boolean') cfg.installSkill = raw.installSkill
  if (typeof raw.indicator === 'boolean') cfg.indicator = raw.indicator
  cfg.indicatorLocale = oneOf(raw.indicatorLocale, ['auto', 'zh-CN', 'en-US'], cfg.indicatorLocale)
  if (typeof raw.indicatorShowAction === 'boolean') cfg.indicatorShowAction = raw.indicatorShowAction
  cfg.indicatorAutoHideMs = clampNumber(raw.indicatorAutoHideMs, cfg.indicatorAutoHideMs, 1000, 600000)
  cfg.keepFrames = clampNumber(raw.keepFrames, cfg.keepFrames, 0, 2000)
  cfg.requestTimeoutMs = clampNumber(raw.requestTimeoutMs, cfg.requestTimeoutMs, 1000, 600000)
  cfg.screenshotTimeoutMs = clampNumber(raw.screenshotTimeoutMs, cfg.screenshotTimeoutMs, 1000, 600000)
  cfg.startupTimeoutMs = clampNumber(raw.startupTimeoutMs, cfg.startupTimeoutMs, 1000, 120000)
  if (typeof raw.warmup === 'boolean') cfg.warmup = raw.warmup
  cfg.maxRestarts = clampNumber(raw.maxRestarts, cfg.maxRestarts, 0, 50)
  if (typeof raw.debug === 'boolean') cfg.debug = raw.debug
  cfg.screenshotMaxWidth = clampNumber(raw.screenshotMaxWidth, cfg.screenshotMaxWidth, 0, 8192)
  cfg.screenshotMaxBytes = clampNumber(raw.screenshotMaxBytes, cfg.screenshotMaxBytes, 65536, 20971520)
  cfg.screenshotFormat = oneOf(raw.screenshotFormat, ['png', 'jpeg'], cfg.screenshotFormat)
  cfg.screenshotQuality = clampNumber(raw.screenshotQuality, cfg.screenshotQuality, 1, 100)
  return cfg
}

/** 读取配置；文件缺失或损坏时返回默认值。 */
export async function readConfig() {
  try {
    const text = await readFile(await configPath(), 'utf8')
    // 去掉 UTF-8 BOM：记事本另存会写 BOM，而 JSON.parse 会因此抛错，
    // 那会让用户手改的配置被静默忽略。
    return normalizeConfig(JSON.parse(text.replace(/^\uFEFF/u, '')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 原子写入配置。 */
export async function writeConfig(cfg) {
  const path = await configPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(normalizeConfig(cfg), null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
