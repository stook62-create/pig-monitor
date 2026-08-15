import { useEffect, useMemo, useState } from "react"
import bundledJson from "@/data/state.json"
import type { MonitorState, Report, FactorStatus } from "@/types/report"
import { buildReport, todayStr, type Snapshot } from "@/lib/engine"
import { loadLocal, saveLocal, mergeState, toLocal, clearLocal } from "@/lib/store"
import DataEntryModal from "@/components/DataEntryModal"

const bundled = bundledJson as MonitorState

const STATUS_STYLE: Record<FactorStatus, { label: string; dot: string; chip: string }> = {
  positive: { label: "正向", dot: "bg-[#b3402a]", chip: "bg-[#fbeae5] text-[#b3402a] border-[#ecc9c0]" },
  negative: { label: "负向", dot: "bg-[#1f5c4d]", chip: "bg-[#e6f0ec] text-[#1f5c4d] border-[#c3d8cf]" },
  warning: { label: "预警", dot: "bg-[#b45309]", chip: "bg-[#fdf3e3] text-[#b45309] border-[#eedcbc]" },
  neutral: { label: "中性", dot: "bg-[#8a8578]", chip: "bg-[#f1efe8] text-[#6b675c] border-[#ddd8c9]" },
}

const SCENARIO_COLOR: Record<string, string> = {
  A: "#b3402a",
  B: "#b45309",
  C: "#4b5563",
}

type Selection = "current" | number

function nowHM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`
}

function SectionTitle({ no, title, sub }: { no: string; title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-3 border-b-2 border-[#1c1917] pb-2 mb-4">
      <span className="font-serif text-sm tracking-widest text-[#b3402a]">{no}</span>
      <h2 className="font-serif text-lg font-bold text-[#1c1917]">{title}</h2>
      {sub && <span className="text-xs text-[#8a8578] ml-auto">{sub}</span>}
    </div>
  )
}

function DeltaBadge({ cur, prev }: { cur: number; prev?: number }) {
  if (prev === undefined || prev === cur) return <span className="text-xs text-[#8a8578]">—</span>
  const d = cur - prev
  const up = d > 0
  return (
    <span className={`text-xs font-semibold ${up ? "text-[#b3402a]" : "text-[#1f5c4d]"}`}>
      {up ? "▲" : "▼"} {Math.abs(d)}pct vs 上期
    </span>
  )
}

export default function Home() {
  const [state, setState] = useState<MonitorState>(() => mergeState(bundled, loadLocal()))
  const [apiOnline, setApiOnline] = useState(false)
  const [selected, setSelected] = useState<Selection>("current")
  const [busy, setBusy] = useState<"refresh" | "save" | "cost" | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editingCost, setEditingCost] = useState(false)
  const [costInput, setCostInput] = useState("")
  const [showEntry, setShowEntry] = useState(false)

  // 版本列表：新→旧
  const versions = useMemo(() => state.versions.slice().reverse(), [state.versions])

  const report: Report | null =
    selected === "current" ? state.current : versions[selected] ?? null
  const prevReport: Report | undefined =
    selected === "current" ? versions[0] : versions[selected + 1]

  const prevProb = useMemo(() => {
    const m = new Map<string, number>()
    prevReport?.scenarios.forEach((s) => m.set(s.key, s.prob))
    return m
  }, [prevReport])

  // 离线模式下持久化到浏览器
  function persist(next: MonitorState) {
    setState(next)
    saveLocal(toLocal(next, bundled))
  }

  useEffect(() => {
    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (d?.ok && d.state?.current) {
          setState(d.state)
          setApiOnline(true)
        }
      })
      .catch(() => setApiOnline(false))
  }, [])

  function flash(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 4000)
  }

  async function callApi(path: string, body?: unknown, kind: "refresh" | "save" | "cost" = "refresh") {
    setBusy(kind)
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await r.json()
      if (d?.ok && d.state) {
        setState(d.state)
        return d.log as string
      }
      flash(`操作失败：${d?.error ?? "未知错误"}`)
    } catch {
      flash("无法连接本地监测服务")
    } finally {
      setBusy(null)
    }
    return null
  }

  // 刷新：在线走本地服务；离线打开数据录入面板
  async function onRefresh() {
    if (apiOnline) {
      const log = await callApi("/api/refresh", undefined, "refresh")
      if (log) flash("已拉取最新数据并重建当前报告（未存档）")
    } else {
      setShowEntry(true)
    }
  }

  function onApplySnapshot(snap: Snapshot) {
    const asOf = todayStr()
    const rebuilt = buildReport(snap, state.settings.position_cost, asOf, `R${asOf.replaceAll("-", "")}`)
    persist({ ...state, current: rebuilt })
    setSelected("current")
    setShowEntry(false)
    flash("监测引擎已用新数据重建当前快照（未存档）")
  }

  // 保存版本：在线走本地服务；离线存档到浏览器
  async function onSave() {
    if (apiOnline) {
      const log = await callApi("/api/save-version", undefined, "save")
      if (log) flash(log.replace(/^✓\s*/, ""))
      return
    }
    if (!state.current) return
    const date = todayStr()
    let version = `R${date.replaceAll("-", "")}`
    const existing = new Set(state.versions.map((v) => v.version))
    if (existing.has(version)) version = `${version}-${nowHM()}`
    const archived: Report = { ...state.current, as_of: date, version }
    persist({ ...state, versions: [...state.versions, archived] })
    flash(`已存档版本 ${version}（保存在本浏览器）`)
  }

  // 修改成本：在线走本地服务；离线用前端引擎重建
  async function onCostSubmit() {
    const v = Number(costInput)
    setEditingCost(false)
    if (!Number.isFinite(v) || v <= 0 || v === state.settings.position_cost) return
    if (apiOnline) {
      const log = await callApi("/api/settings", { position_cost: v }, "cost")
      if (log) flash(`持仓成本已修正为 ${v.toFixed(2)} 元，市值参照已联动调整`)
      return
    }
    if (!state.current) return
    const rebuilt = buildReport(state.current.snapshot as Snapshot, v, state.current.as_of, state.current.version)
    persist({ settings: { position_cost: v }, current: rebuilt, versions: state.versions })
    flash(`持仓成本已修正为 ${v.toFixed(2)} 元，市值参照已联动调整`)
  }

  function onReset() {
    clearLocal()
    setState(bundled)
    setSelected("current")
    flash("已恢复为网站打包时的初始数据")
  }

  if (!report) return null
  const isCurrent = selected === "current"
  const cost = report.position_cost
  const hasLocal = !!loadLocal()

  return (
    <div className="min-h-screen bg-[#f6f2ea] text-[#1c1917] antialiased">
      {/* 顶栏 */}
      <header className="border-b border-[#e0d8c4] bg-[#faf7f0]">
        <div className="mx-auto max-w-6xl px-4 py-5 flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <h1 className="font-serif text-2xl font-black tracking-wide">生猪行业监测台</h1>
            <p className="text-sm text-[#8a8578] mt-1">牧原股份（002714.SZ）持仓跟踪 · 手动触发模式</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            {/* 持仓成本（可编辑） */}
            {editingCost ? (
              <span className="rounded-full border border-[#b3402a] bg-white px-3 py-1 flex items-center gap-1.5">
                持仓成本
                <input
                  autoFocus
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  onBlur={onCostSubmit}
                  onKeyDown={(e) => e.key === "Enter" && onCostSubmit()}
                  className="w-16 font-mono font-bold text-[#b3402a] outline-none border-b border-[#b3402a] bg-transparent text-right"
                />
                元
              </span>
            ) : (
              <button
                onClick={() => {
                  setCostInput(state.settings.position_cost.toFixed(2))
                  setEditingCost(true)
                }}
                title="点击修正持仓成本，市值参照联动调整"
                className="rounded-full border border-[#d8cfba] bg-white px-3 py-1 hover:border-[#b3402a] transition-colors"
              >
                持仓成本 <b className="text-[#b3402a]">{state.settings.position_cost.toFixed(2)} 元</b>
                <span className="ml-1 text-[#b3402a]">✎</span>
              </button>
            )}
            {/* 刷新数据 */}
            <button
              onClick={onRefresh}
              disabled={busy !== null}
              title={apiOnline ? "通过本地服务拉取最新数据" : "手动录入最新行业数据，引擎自动重建报告"}
              className="rounded-full px-3.5 py-1 font-semibold bg-[#1c1917] text-[#faf7f0] hover:bg-[#b3402a] transition-colors"
            >
              {busy === "refresh" ? "刷新中…" : apiOnline ? "⟳ 刷新数据" : "⟳ 录入数据"}
            </button>
            {/* 保存版本 */}
            <button
              onClick={onSave}
              disabled={busy !== null}
              title={apiOnline ? "存档到项目 reports/ 目录" : "存档到本浏览器（localStorage）"}
              className="rounded-full px-3.5 py-1 font-semibold border border-[#1c1917] text-[#1c1917] hover:bg-[#1c1917] hover:text-[#faf7f0] transition-colors"
            >
              {busy === "save" ? "存档中…" : "⬇ 保存版本"}
            </button>
          </div>
        </div>
        {/* 状态条 */}
        <div className="mx-auto max-w-6xl px-4 pb-2.5 flex flex-wrap gap-x-4 text-[11px] text-[#8a8578]">
          <span>
            {apiOnline
              ? "● 本地监测服务已连接（存档写入项目 reports/ 目录）"
              : "○ 静态模式 · 引擎在浏览器内运行，改动与存档保存在本浏览器"}
          </span>
          {state.current?.refreshed_at && <span>最近刷新：{state.current.refreshed_at}</span>}
          {toast && <span className="text-[#b3402a] font-semibold">{toast}</span>}
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 lg:flex lg:gap-6">
        {/* 历史版本存档 */}
        <aside className="lg:w-56 shrink-0 mb-6 lg:mb-0">
          <div className="lg:sticky lg:top-6 rounded-lg border border-[#e0d8c4] bg-[#faf7f0] p-3">
            <h3 className="font-serif text-sm font-bold tracking-widest text-[#6b675c] mb-2 px-1">版本存档</h3>
            <ul className="space-y-1">
              {/* 当前快照 */}
              <li>
                <button
                  onClick={() => setSelected("current")}
                  className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${
                    isCurrent ? "bg-[#b3402a] text-white" : "hover:bg-[#efe9da] text-[#44403a]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">当前快照</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${isCurrent ? "bg-white/20" : "bg-[#e8e0cc] text-[#6b675c]"}`}>
                      未存档
                    </span>
                  </div>
                  <div className={`text-xs mt-0.5 ${isCurrent ? "text-[#f3ddd6]" : "text-[#8a8578]"}`}>
                    {state.current?.refreshed_at ?? "—"}
                  </div>
                </button>
              </li>
              {/* 历史版本 */}
              {versions.map((r, i) => (
                <li key={`${r.as_of}-${r.version}`}>
                  <button
                    onClick={() => setSelected(i)}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${
                      !isCurrent && selected === i ? "bg-[#1c1917] text-[#faf7f0]" : "hover:bg-[#efe9da] text-[#44403a]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs">{r.version}</span>
                      <span className={`text-xs ${!isCurrent && selected === i ? "text-[#d8cfba]" : "text-[#8a8578]"}`}>
                        成本 {r.position_cost.toFixed(1)}
                      </span>
                    </div>
                    <div className={`text-xs mt-0.5 ${!isCurrent && selected === i ? "text-[#d8cfba]" : "text-[#8a8578]"}`}>
                      {r.as_of}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-relaxed text-[#8a8578] mt-3 px-1">
              刷新/录入只更新当前快照；点击「保存版本」才会存档为历史版本，永不覆盖。
            </p>
            {!apiOnline && hasLocal && (
              <button
                onClick={onReset}
                className="mt-2 w-full text-[11px] text-[#8a8578] hover:text-[#b3402a] border border-dashed border-[#d8cfba] rounded px-2 py-1.5 transition-colors"
              >
                恢复初始数据（清除本浏览器的改动）
              </button>
            )}
          </div>
        </aside>

        {/* 主报告区 */}
        <main className="flex-1 min-w-0 space-y-8">
          {/* 本期核心结论 */}
          <section className="rounded-lg border-l-4 border-[#b3402a] bg-white border border-[#e0d8c4] p-5 shadow-sm">
            <div className="text-xs tracking-widest text-[#b3402a] font-semibold mb-2">
              {isCurrent ? "当前核心结论" : `存档结论 · ${report.version}`}
              {!isCurrent && <span className="ml-2 text-[#8a8578]">（该期持仓成本 {cost.toFixed(1)} 元）</span>}
            </div>
            <p className="font-serif text-[15px] leading-7 text-[#292524]">{report.conclusion}</p>
          </section>

          {/* 01 关键指标 */}
          <section>
            <SectionTitle no="01" title="关键指标" sub={`截至 ${report.as_of}`} />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              {report.key_metrics.map((m) => (
                <div key={m.name} className="rounded-lg border border-[#e0d8c4] bg-white p-4 shadow-sm">
                  <div className="text-xs text-[#8a8578]">{m.name}</div>
                  <div className="font-serif text-lg font-bold mt-1 leading-tight">{m.value}</div>
                  <div className={`text-xs mt-1.5 flex items-center gap-1 ${
                    m.dir === "up" ? "text-[#b3402a]" : m.dir === "down" ? "text-[#1f5c4d]" : "text-[#8a8578]"
                  }`}>
                    {m.dir === "up" ? "▲" : m.dir === "down" ? "▼" : "—"} {m.delta}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 02 走向概率判断 */}
          <section>
            <SectionTitle no="02" title="走向概率判断" sub="概率引擎：基准 + 规则调整" />
            <div className="rounded-lg border border-[#e0d8c4] bg-white p-5 shadow-sm space-y-4">
              {report.scenarios.map((s) => (
                <div key={s.key}>
                  <div className="flex flex-wrap items-baseline gap-x-3 mb-1.5">
                    <span className="font-serif font-bold">情景 {s.key}</span>
                    <span className="text-sm text-[#44403a]">{s.name}</span>
                    <span className="ml-auto font-serif text-xl font-black" style={{ color: SCENARIO_COLOR[s.key] }}>
                      {s.prob}%
                    </span>
                    <DeltaBadge cur={s.prob} prev={prevProb.get(s.key)} />
                  </div>
                  <div className="h-3 rounded-full bg-[#f1ede2] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${s.prob}%`, backgroundColor: SCENARIO_COLOR[s.key] }}
                    />
                  </div>
                </div>
              ))}
              {report.prob_reasons.length > 0 && (
                <div className="border-t border-dashed border-[#ddd6c2] pt-3 mt-2">
                  <div className="text-xs font-semibold text-[#6b675c] mb-1.5">本期调整理由</div>
                  <ul className="space-y-1">
                    {report.prob_reasons.map((r, i) => (
                      <li key={i} className="text-xs text-[#57534a] leading-relaxed flex gap-2">
                        <span className="text-[#b3402a]">◆</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          {/* 03 情景目标市值参考 */}
          {report.scenario_targets && (
            <section>
              <SectionTitle no="03" title="情景目标市值参考" sub={`当前市值约 ${report.scenario_targets.current_mcap} 亿`} />
              <div className="rounded-lg border border-[#e0d8c4] bg-white p-5 shadow-sm space-y-5">
                <div className="space-y-3">
                  {report.scenario_targets.targets.map((t) => {
                    const sc = report.scenarios.find((s) => s.key === t.key)
                    const color = SCENARIO_COLOR[t.key]
                    const max = report.scenario_targets!.scale_max
                    const costMcap = report.scenario_targets!.cost_mcap
                    return (
                      <div key={t.key}>
                        <div className="flex flex-wrap items-baseline gap-x-2 mb-1 text-sm">
                          <span className="font-serif font-bold">情景 {t.key}</span>
                          <span className="text-xs text-[#8a8578]">{sc?.name}</span>
                          {sc && (
                            <span className="text-xs font-semibold" style={{ color }}>概率 {sc.prob}%</span>
                          )}
                          <span className="ml-auto font-mono text-xs font-bold" style={{ color }}>
                            {t.lo}-{t.hi} 亿 · {t.price}
                          </span>
                        </div>
                        <div className="relative h-6 rounded bg-[#f6f3ec] border border-[#ece5d2]">
                          <div
                            className="absolute top-1 bottom-1 rounded opacity-80"
                            style={{
                              left: `${(t.lo / max) * 100}%`,
                              width: `${((t.hi - t.lo) / max) * 100}%`,
                              backgroundColor: color,
                            }}
                          />
                          {/* 当前市值标线 */}
                          <div
                            className="absolute -top-1 -bottom-1 w-0.5 bg-[#1c1917]"
                            style={{ left: `${(report.scenario_targets!.current_mcap / max) * 100}%` }}
                          />
                          {/* 成本市值标记 */}
                          <div
                            className="absolute -top-1 -bottom-1"
                            style={{ left: `${(costMcap / max) * 100}%` }}
                          >
                            <div className="w-2 h-2 rounded-full border-2 border-[#b3402a] bg-white -translate-x-1 translate-y-2" />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#6b675c] pt-1">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-0.5 bg-[#1c1917]" />
                      当前市值 ≈ {report.scenario_targets.current_mcap} 亿（{report.snapshot.muyuan_close.toFixed(2)} 元）
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full border-2 border-[#b3402a] bg-white" />
                      持仓成本 {cost.toFixed(1)} 元 ≈ {report.scenario_targets.cost_mcap} 亿
                    </span>
                    <span className="ml-auto">横轴单位：亿元，满刻度 {report.scenario_targets.scale_max} 亿</span>
                  </div>
                </div>
                <div className="grid md:grid-cols-3 gap-3 border-t border-dashed border-[#ddd6c2] pt-4">
                  {report.scenario_targets.targets.map((t) => (
                    <div key={t.key} className="rounded-md bg-[#faf8f2] border border-[#ece5d2] p-3.5">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: SCENARIO_COLOR[t.key] }} />
                        <span className="font-serif text-sm font-bold">情景 {t.key} 估值锚</span>
                      </div>
                      <div className="text-[11px] leading-relaxed text-[#57534a] space-y-1.5">
                        <p><span className="text-[#8a8578]">测算依据：</span>{t.basis}</p>
                        <p><span className="text-[#8a8578]">持仓含义：</span>{t.note}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[#a39e8f] leading-relaxed">
                  注：股价区间按总股本约 54.4 亿股由市值折算；情景 B / C 的市值锚接近，区别在于利润波动率与持续时间。
                  目标市值为研究框架输出，非投资承诺。
                </p>
              </div>
            </section>
          )}

          {/* 04 指征因子矩阵 */}
          <section>
            <SectionTitle no="04" title="指征因子矩阵" sub="八项因子 · 阈值自动判定" />
            <div className="rounded-lg border border-[#e0d8c4] bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="bg-[#f3eee2] text-xs text-[#6b675c]">
                      <th className="text-left font-semibold px-4 py-2.5">指标</th>
                      <th className="text-left font-semibold px-4 py-2.5">当前值</th>
                      <th className="text-left font-semibold px-4 py-2.5">关键阈值</th>
                      <th className="text-left font-semibold px-4 py-2.5">状态</th>
                      <th className="text-left font-semibold px-4 py-2.5">解读</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.factors.map((f) => (
                      <tr key={f.name} className="border-t border-[#efe9da] align-top">
                        <td className="px-4 py-3 font-semibold whitespace-nowrap">{f.name}</td>
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{f.value}</td>
                        <td className="px-4 py-3 text-xs text-[#6b675c]">{f.threshold}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${STATUS_STYLE[f.status].chip}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLE[f.status].dot}`} />
                            {STATUS_STYLE[f.status].label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-[#57534a] leading-relaxed">{f.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* 05 本期信号 */}
          <section>
            <SectionTitle no="05" title="本期信号" />
            <div className="grid md:grid-cols-3 gap-3">
              {(
                [
                  { key: "positive", title: "积极信号", cls: "border-[#b3402a]", text: "text-[#b3402a]", icon: "＋" },
                  { key: "watch", title: "警惕信号", cls: "border-[#b45309]", text: "text-[#b45309]", icon: "！" },
                  { key: "risk", title: "风险信号", cls: "border-[#1f5c4d]", text: "text-[#1f5c4d]", icon: "×" },
                ] as const
              ).map((g) => (
                <div key={g.key} className={`rounded-lg border border-[#e0d8c4] border-t-4 ${g.cls} bg-white p-4 shadow-sm`}>
                  <h4 className={`font-serif font-bold text-sm mb-2.5 ${g.text}`}>{g.icon} {g.title}</h4>
                  <ul className="space-y-2">
                    {report.signals[g.key].map((s, i) => (
                      <li key={i} className="text-xs leading-relaxed text-[#44403a] flex gap-1.5">
                        <span className="text-[#c9c0a9] shrink-0">—</span>{s}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {/* 06 持仓区域 */}
          <section>
            <SectionTitle no="06" title="持仓区域" sub={`对照成本 ${cost.toFixed(1)} 元`} />
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {report.position_zones.map((z) => (
                <div
                  key={z.range}
                  className={`rounded-lg border p-4 shadow-sm transition-all ${
                    z.active
                      ? "border-[#b3402a] bg-[#fbeae5] ring-1 ring-[#b3402a]"
                      : "border-[#e0d8c4] bg-white opacity-75"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold">{z.range}</span>
                    {z.active && <span className="text-[10px] bg-[#b3402a] text-white rounded px-1.5 py-0.5">当前</span>}
                  </div>
                  <div className={`font-serif font-bold mt-1.5 ${z.active ? "text-[#b3402a]" : "text-[#1c1917]"}`}>{z.action}</div>
                  <p className="text-[11px] leading-relaxed text-[#6b675c] mt-1">{z.logic}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 07 下期重点盯防 */}
          <section>
            <SectionTitle no="07" title="下期重点盯防" />
            <div className="rounded-lg border border-[#e0d8c4] bg-white shadow-sm divide-y divide-[#efe9da]">
              {report.next_watch.map((w, i) => (
                <div key={i} className="flex items-baseline gap-4 px-5 py-3.5">
                  <span className="font-serif font-black text-[#c9c0a9] text-lg shrink-0">{String(i + 1).padStart(2, "0")}</span>
                  <span className="font-mono text-xs text-[#b3402a] font-semibold shrink-0 w-24">{w.time}</span>
                  <span className="text-sm text-[#44403a] leading-relaxed">{w.item}</span>
                </div>
              ))}
            </div>
          </section>

          <footer className="text-[11px] text-[#a39e8f] leading-relaxed border-t border-[#e0d8c4] pt-4 pb-8">
            手动触发模式：本地运行时「刷新数据」调用 monitor.py；线上静态模式下监测引擎直接在浏览器内运行，
            可手动录入数据、修正成本、保存版本（保存在本浏览器 localStorage，换设备/清缓存后重置）。
            仅供研究跟踪使用，不构成投资建议。
          </footer>
        </main>
      </div>

      {/* 数据录入面板（静态模式） */}
      {showEntry && state.current && (
        <DataEntryModal
          initial={state.current.snapshot as Snapshot}
          onApply={onApplySnapshot}
          onClose={() => setShowEntry(false)}
        />
      )}
    </div>
  )
}
