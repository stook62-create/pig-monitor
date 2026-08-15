/**
 * 监测引擎（前端移植版）
 * 与 monitor.py 保持逻辑同步：修改判定规则/概率权重时两边都要改。
 * 输入数据快照 + 持仓成本 → 输出完整报告（与后端 Report 同构）。
 */
import type { Report, Factor, ScenarioTargets, PositionZone } from "@/types/report"

export interface Snapshot {
  pig_price: number
  pig_price_low: number
  muyuan_june_avg_price: number
  piglet_trend: "surge" | "slow_up" | "flat" | "low"
  frozen_stock: "high" | "normal" | "low"
  sow_stock: number
  sow_mom: number
  sow_mom_prev: number
  muyuan_cost: number
  muyuan_q2_profit: number
  industry_loss_per_head: number
  muyuan_close: number
  muyuan_year_low: number
  muyuan_year_high: number
  policy_supportive: boolean
  [k: string]: unknown
}

export const SHARES = 54.4
export const MUYUAN_FULL_COST = 11.6
export const INDUSTRY_COST = 13.0
export const SOW_NORMAL_HOLDING = 3750
export const SOW_DEEP_TARGET = 3650
export const BASE_PROB = { A: 40, B: 45, C: 15 }

const SCENARIOS = {
  A: "2027H1 周期反转",
  B: "微利中枢 + 小周期波动",
  C: "严格十年微利 / 周期消失",
}

const PIGLET_LABEL = { surge: "快速上涨", slow_up: "温和回升", flat: "平稳", low: "低迷" } as const
const FROZEN_LABEL = { high: "偏高", normal: "正常", low: "偏低" } as const

function evaluate(s: Snapshot): Factor[] {
  const factors: Factor[] = []

  let st: Factor["status"]
  let note: string
  if (s.pig_price >= 12.5) {
    st = "positive"; note = "站上反转确认线12.5元"
  } else if (s.pig_price < MUYUAN_FULL_COST) {
    st = "negative"; note = `低于牧原完全成本${MUYUAN_FULL_COST}元，行业深亏出清中`
  } else {
    st = "neutral"; note = "介于现金成本与完全成本之间"
  }
  factors.push({
    name: "生猪现货价格", value: `${s.pig_price.toFixed(2)} 元/公斤`,
    threshold: "反转确认：连续4-6周站稳12.5元", status: st, note,
  })

  if (s.sow_mom > 0) {
    st = "warning"; note = "环比转正——去化中断警报！"
  } else if (s.sow_stock <= SOW_DEEP_TARGET) {
    st = "positive"; note = `降至${SOW_DEEP_TARGET}万头附近，反转条件达成`
  } else if (s.sow_mom <= -1.0) {
    st = "positive"; note = `环比${s.sow_mom.toFixed(2)}%，加速去化（需持续至${SOW_DEEP_TARGET}万头）`
  } else if (s.sow_mom < 0) {
    st = "neutral"; note = "温和去化中"
  } else {
    st = "neutral"; note = "持平"
  }
  factors.push({
    name: "能繁母猪存栏", value: `${s.sow_stock} 万头（环比 ${s.sow_mom >= 0 ? "+" : ""}${s.sow_mom.toFixed(2)}%）`,
    threshold: `政策保有量 ${SOW_NORMAL_HOLDING} 万头；反转目标 ${SOW_DEEP_TARGET} 万头`,
    status: st, note,
  })

  const pigletMap: Record<Snapshot["piglet_trend"], [Factor["status"], string]> = {
    surge: ["warning", "仔猪价格快速上涨——补栏情绪回暖，警惕去化中断"],
    slow_up: ["neutral", "温和回升，属健康信号"],
    flat: ["neutral", "平稳"],
    low: ["positive", "低迷=补栏冰点=去化持续"],
  }
  ;[st, note] = pigletMap[s.piglet_trend]
  factors.push({
    name: "仔猪价格动向", value: PIGLET_LABEL[s.piglet_trend],
    threshold: "暴涨=去化中断警报；低迷=去化持续", status: st, note,
  })

  const gap = INDUSTRY_COST - s.muyuan_cost
  factors.push({
    name: "牧原完全成本", value: `${s.muyuan_cost.toFixed(1)} 元/公斤`,
    threshold: "行业平均约 13 元/公斤",
    status: gap >= 1.0 ? "positive" : "neutral",
    note: `领先行业约 ${gap.toFixed(1)} 元/公斤，全行业最低，且仍在下降`,
  })

  const q2 = s.muyuan_q2_profit
  if (q2 > 0) {
    st = "positive"; note = "单季转正——最硬的右侧信号！"
  } else if (q2 > -20) {
    st = "neutral"; note = "减亏至盈亏平衡线附近"
  } else {
    st = "negative"; note = `Q2预亏${(-q2).toFixed(0)}亿上下，大概率是本轮亏损峰值`
  }
  factors.push({
    name: "牧原单季利润", value: `Q2 约 ${q2.toFixed(0)} 亿元`,
    threshold: "单季转正 = 最硬右侧信号", status: st, note,
  })

  const frozenMap: Record<Snapshot["frozen_stock"], [Factor["status"], string]> = {
    high: ["warning", "冻品库存高企，压制鲜品价格反弹高度"],
    normal: ["neutral", "正常水位"],
    low: ["positive", "低库存，价格弹性充足"],
  }
  ;[st, note] = frozenMap[s.frozen_stock]
  factors.push({
    name: "冻品库存", value: FROZEN_LABEL[s.frozen_stock],
    threshold: "高库存=反弹压制器", status: st, note,
  })

  factors.push({
    name: "政策动向", value: s.policy_supportive ? "产能调控收紧" : "政策转松",
    threshold: "备案制执行力度",
    status: s.policy_supportive ? "positive" : "warning",
    note: s.policy_supportive
      ? "保有量下调至3750万头+大型集团备案制，政策在帮助去化"
      : "政策转向宽松",
  })

  factors.push({
    name: "猪价波动率", value: "磨底拉锯",
    threshold: "连续12个月11-14元窄幅 = 微利均衡警报",
    status: "neutral",
    note: "尚处大周期底部形态，未进入微利均衡；需持续跟踪",
  })

  return factors
}

function probabilities(s: Snapshot) {
  const prob = { ...BASE_PROB }
  const reasons: string[] = []

  if (s.sow_mom <= -1.0 && s.sow_mom < s.sow_mom_prev) {
    prob.A += 2; prob.C -= 2
    reasons.push(`能繁母猪去化加速（环比${s.sow_mom >= 0 ? "+" : ""}${s.sow_mom.toFixed(2)}%，降幅连续扩大）→ A+2 / C-2`)
  }
  if (s.piglet_trend === "surge") {
    prob.A -= 3; prob.B += 3
    reasons.push("仔猪价格快速上涨，补栏情绪回暖，去化存在中断风险 → A-3 / B+3")
  }
  if (s.sow_mom > 0) {
    prob.A -= 5; prob.C += 5
    reasons.push("母猪环比转正，去化中断警报触发 → A-5 / C+5")
  }
  if (s.muyuan_q2_profit > 0) {
    prob.A += 5; prob.C -= 5
    reasons.push("牧原单季利润转正，右侧信号确认 → A+5 / C-5")
  }

  const total = prob.A + prob.B + prob.C
  const out = {
    A: Math.round((prob.A * 100) / total),
    B: Math.round((prob.B * 100) / total),
    C: Math.round((prob.C * 100) / total),
  }
  const diff = 100 - (out.A + out.B + out.C)
  if (diff) out.B += diff
  return { prob: out, reasons, base: { ...BASE_PROB } }
}

function buildSignals() {
  return {
    positive: [
      "能繁母猪去化加速：4月-0.71% → 5月-1.13% → 6月-1.33%，降幅逐月扩大",
      "仔猪警报解除：8月第1周仔猪均价22.42元/公斤、环比-2.5%，29省全部下跌——7月的补栏异动已逆转",
      "政策双轮驱动：保有量下调至3750万头 + 大型集团生产备案制",
      "牧原现金流修复：H股募资净额118.65亿港元到账，高管增持4-5亿+H股回购",
    ],
    watch: [
      "8月出栏计划环比普增（卓创+6.24%、钢联+3.74%）——供给压力未减，反弹高度受限",
      "冻品库存偏高，将持续压制鲜品价格反弹高度",
      "PSY效率革命（行业24头+、牧原29-32头）正在吞噬数量去化的成果",
    ],
    risk: [
      "立秋后猪价小幅反弹（10.2→10.6元），若回到成本线附近，补栏情绪可能复燃、去化停滞",
      "Q3财报若亏损超预期，股价可能二次探底",
    ],
  }
}

function buildPositionZones(s: Snapshot, cost: number): PositionZone[] {
  const price = s.muyuan_close
  return [
    { range: "< 35 元", action: "加仓区", logic: "接近悲观定价下沿，用宝丰减仓资金加仓", active: price < 35 },
    { range: "35 - 37 元", action: "小幅加仓", logic: `接近持仓成本${cost.toFixed(1)}元附近，市场给的第二次机会`, active: price >= 35 && price < 37 },
    { range: "38 - 42 元", action: "底仓躺平", logic: "亏损现实与反转预期的均衡箱体，不操作就是最好的操作", active: price >= 38 && price <= 42 },
    { range: "> 45 元", action: "兑现部分", logic: "进入年内套牢盘核心区，可兑现一部分", active: price > 45 },
    { range: "去化证伪", action: "止损纪律", logic: "母猪环比转正/仔猪暴涨 → 纪律优先于成本锚", active: false },
  ]
}

function buildNextWatch() {
  return [
    { time: "8月底-9月", item: "开学+双节备货旺季猪价表现——旺季拉不动则拉锯延长" },
    { time: "9月底", item: "Q3能繁母猪存栏数据——环比再降1%以上则去化逻辑强化" },
    { time: "10月底", item: "牧原三季报——单季是否减亏至盈亏平衡线附近（第一个硬验证点）" },
    { time: "2027年Q1", item: "单季转正+猪价站稳13元——趋势资金进场的真正发令枪" },
  ]
}

function buildScenarioTargets(s: Snapshot, cost: number): ScenarioTargets {
  const p = (v: number) => `${Math.round(v / SHARES)}`
  return {
    current_mcap: Math.round(s.muyuan_close * SHARES),
    cost_mcap: Math.round(cost * SHARES),
    scale_max: 5000,
    targets: [
      {
        key: "A", lo: 3500, hi: 4600,
        price: `${p(3500)}-${p(4600)} 元`,
        basis: "峰值利润 × 6-8 倍周期顶部纪律（猪价18元情景峰值利润约575亿）",
        note: "市场疯狂阶段可能透支此区间（2020年剧本）；80元上方逐步兑现，不把超涨当计划内收益",
      },
      {
        key: "B", lo: 1300, hi: 1900,
        price: `${p(1300)}-${p(1900)} 元`,
        basis: "净利中枢90-130亿（头均130-180元 × 出栏7000-7500万头）× 12-15倍PE",
        note: `回报主要靠分红（50-75亿/年）；你的成本（${cost.toFixed(1)}元）接近该情景定价上沿，赚的是类债券+期权的钱`,
      },
      {
        key: "C", lo: 1000, hi: 1500,
        price: `${p(1000)}-${p(1500)} 元`,
        basis: "红利股定价：年分红50-75亿，4-5%股息率，叠加估值逻辑切换的情绪超调",
        note: "周期消失的真实底部约20元上下（与雪球热帖独立测算吻合）；逻辑切换有2-3年渐变窗口",
      },
    ],
  }
}

function buildConclusion(s: Snapshot, probInfo: ReturnType<typeof probabilities>, cost: number): string {
  const p = probInfo.prob
  const adj = probInfo.reasons.length ? probInfo.reasons.join("；") : "本期无触发调整规则"
  const pnl = ((s.muyuan_close / cost - 1) * 100).toFixed(1)
  return (
    `价格底已现（3-4月9.5-10元大概率是本轮低点），但时间底未走完：磨底预计持续到2026年底，` +
    `趋势性回升窗口在2027年上半年。牧原亏损峰值（2026Q2）大概率已过，接下来是` +
    `“减亏+修复资产负债表+吃下退出者份额”的半年。本期概率引擎：${adj}。` +
    `当前判断——情景A（2027H1反转）${p.A}%、情景B（微利中枢+小周期）${p.B}%、` +
    `情景C（十年微利）${p.C}%。对照持仓成本${cost.toFixed(1)}元：现价${s.muyuan_close.toFixed(2)}元` +
    `（浮盈${Number(pnl) >= 0 ? "+" : ""}${pnl}%）处于38-42元拉锯箱体，策略为底仓躺平、破位加仓、证伪止损。`
  )
}

function nowStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function todayStr(): string {
  return nowStr().slice(0, 10)
}

/** 由数据快照 + 持仓成本构建完整报告（与 monitor.py build_report 同构） */
export function buildReport(snapshot: Snapshot, cost: number, asOf: string, version: string): Report {
  const factors = evaluate(snapshot)
  const probInfo = probabilities(snapshot)
  const pnl = ((snapshot.muyuan_close / cost - 1) * 100).toFixed(1)
  return {
    as_of: asOf,
    version,
    refreshed_at: nowStr(),
    position_cost: cost,
    snapshot,
    conclusion: buildConclusion(snapshot, probInfo, cost),
    key_metrics: [
      { name: "生猪均价", value: `${snapshot.pig_price.toFixed(2)} 元/公斤`, delta: "低点9.5元已现", dir: "down" },
      { name: "能繁母猪", value: `${snapshot.sow_stock} 万头`, delta: `环比 ${snapshot.sow_mom >= 0 ? "+" : ""}${snapshot.sow_mom.toFixed(2)}%`, dir: "down" },
      { name: "牧原完全成本", value: `${snapshot.muyuan_cost.toFixed(1)} 元/公斤`, delta: "行业最低", dir: "up" },
      { name: "牧原Q2单季", value: `约 ${snapshot.muyuan_q2_profit.toFixed(0)} 亿元`, delta: "亏损峰值大概率已过", dir: "down" },
      {
        name: "牧原股价", value: `${snapshot.muyuan_close.toFixed(2)} 元`,
        delta: `成本${cost.toFixed(1)}元 浮盈${Number(pnl) >= 0 ? "+" : ""}${pnl}%`,
        dir: snapshot.muyuan_close >= cost ? "up" : "down",
      },
    ],
    scenarios: (["A", "B", "C"] as const).map((k) => ({
      key: k, name: SCENARIOS[k], prob: probInfo.prob[k], base: probInfo.base[k],
    })),
    prob_reasons: probInfo.reasons,
    scenario_targets: buildScenarioTargets(snapshot, cost),
    factors,
    signals: buildSignals(),
    position_zones: buildPositionZones(snapshot, cost),
    next_watch: buildNextWatch(),
    sources: { 数据来源: "浏览器手动录入（本地运行时会自动拉取行情）" },
  }
}
