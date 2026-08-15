/**
 * 本地存档层（浏览器 localStorage）
 * 静态模式（GitHub Pages）下：设置、当前快照、手动保存的版本都存在浏览器里；
 * 本地 dev 模式检测到 API 在线时，以服务端 state 为准。
 */
import type { MonitorState, Report } from "@/types/report"

const KEY = "pig-monitor-state-v1"

export interface LocalState {
  settings: { position_cost: number }
  current: Report | null
  localVersions: Report[] // 浏览器里手动保存的版本（追加在打包版本之后）
}

export function loadLocal(): LocalState | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as LocalState) : null
  } catch {
    return null
  }
}

export function saveLocal(s: LocalState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // 存储空间不足或被禁用时静默失败
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

/** 合并打包进网站的基准数据 + 浏览器本地改动 */
export function mergeState(bundled: MonitorState, local: LocalState | null): MonitorState {
  if (!local) return bundled
  const seen = new Set(bundled.versions.map((v) => `${v.as_of}|${v.version}`))
  const extra = local.localVersions.filter((v) => !seen.has(`${v.as_of}|${v.version}`))
  return {
    settings: local.settings,
    current: local.current ?? bundled.current,
    versions: [...bundled.versions, ...extra],
  }
}

/** 把合并后的状态回写为本地层（打包版本不重复存储） */
export function toLocal(state: MonitorState, bundled: MonitorState): LocalState {
  const seen = new Set(bundled.versions.map((v) => `${v.as_of}|${v.version}`))
  return {
    settings: state.settings,
    current: state.current,
    localVersions: state.versions.filter((v) => !seen.has(`${v.as_of}|${v.version}`)),
  }
}
