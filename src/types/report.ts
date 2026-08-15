export type FactorStatus = "positive" | "negative" | "warning" | "neutral"

export interface KeyMetric {
  name: string
  value: string
  delta: string
  dir: "up" | "down" | "flat"
}

export interface Scenario {
  key: "A" | "B" | "C"
  name: string
  prob: number
  base: number
}

export interface Factor {
  name: string
  value: string
  threshold: string
  status: FactorStatus
  note: string
}

export interface PositionZone {
  range: string
  action: string
  logic: string
  active: boolean
}

export interface WatchItem {
  time: string
  item: string
}

export interface ScenarioTarget {
  key: "A" | "B" | "C"
  lo: number
  hi: number
  price: string
  basis: string
  note: string
}

export interface ScenarioTargets {
  current_mcap: number
  cost_mcap: number
  scale_max: number
  targets: ScenarioTarget[]
}

export interface Report {
  as_of: string
  version: string
  refreshed_at?: string
  position_cost: number
  conclusion: string
  snapshot: {
    pig_price: number
    sow_stock: number
    sow_mom: number
    muyuan_cost: number
    muyuan_close: number
    muyuan_year_low: number
    muyuan_year_high: number
    [k: string]: unknown
  }
  key_metrics: KeyMetric[]
  scenarios: Scenario[]
  prob_reasons: string[]
  scenario_targets?: ScenarioTargets
  factors: Factor[]
  signals: {
    positive: string[]
    watch: string[]
    risk: string[]
  }
  position_zones: PositionZone[]
  next_watch: WatchItem[]
  sources?: Record<string, string>
}

export interface MonitorState {
  settings: { position_cost: number }
  current: Report | null
  versions: Report[]
}
