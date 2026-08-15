import { useState } from "react"
import type { Snapshot } from "@/lib/engine"

interface Props {
  initial: Snapshot
  onApply: (s: Snapshot) => void
  onClose: () => void
}

const inputCls =
  "w-full rounded border border-[#d8cfba] bg-white px-2.5 py-1.5 text-sm font-mono outline-none focus:border-[#b3402a]"

function NumField({ label, value, onChange, step = "0.01" }: {
  label: string; value: number; onChange: (v: number) => void; step?: string
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#6b675c]">{label}</span>
      <input
        type="number" step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputCls}
      />
    </label>
  )
}

export default function DataEntryModal({ initial, onApply, onClose }: Props) {
  const [s, setS] = useState<Snapshot>({ ...initial })
  const set = <K extends keyof Snapshot>(k: K, v: Snapshot[K]) => setS((p) => ({ ...p, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg bg-[#faf7f0] border border-[#e0d8c4] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#faf7f0] border-b border-[#e0d8c4] px-5 py-3.5 flex items-center">
          <h3 className="font-serif font-bold">录入最新行业数据</h3>
          <button onClick={onClose} className="ml-auto text-[#8a8578] hover:text-[#1c1917] text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[11px] leading-relaxed text-[#8a8578]">
            填入你查到的最新数据，提交后监测引擎会自动重跑指标判定、概率规则和市值参照，重建当前快照。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumField label="生猪均价（元/公斤）" value={s.pig_price} onChange={(v) => set("pig_price", v)} />
            <NumField label="牧原股价（元）" value={s.muyuan_close} onChange={(v) => set("muyuan_close", v)} />
            <NumField label="能繁母猪存栏（万头）" value={s.sow_stock} onChange={(v) => set("sow_stock", v)} step="1" />
            <NumField label="母猪月环比（%）" value={s.sow_mom} onChange={(v) => set("sow_mom", v)} />
            <NumField label="上月环比（%）" value={s.sow_mom_prev} onChange={(v) => set("sow_mom_prev", v)} />
            <NumField label="牧原完全成本（元/公斤）" value={s.muyuan_cost} onChange={(v) => set("muyuan_cost", v)} />
            <NumField label="牧原最近单季利润（亿元）" value={s.muyuan_q2_profit} onChange={(v) => set("muyuan_q2_profit", v)} step="1" />
            <label className="block">
              <span className="text-xs text-[#6b675c]">仔猪价格动向</span>
              <select value={s.piglet_trend} onChange={(e) => set("piglet_trend", e.target.value as Snapshot["piglet_trend"])} className={inputCls}>
                <option value="surge">快速上涨</option>
                <option value="slow_up">温和回升</option>
                <option value="flat">平稳</option>
                <option value="low">低迷</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-[#6b675c]">冻品库存</span>
              <select value={s.frozen_stock} onChange={(e) => set("frozen_stock", e.target.value as Snapshot["frozen_stock"])} className={inputCls}>
                <option value="high">偏高</option>
                <option value="normal">正常</option>
                <option value="low">偏低</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-1.5">
              <input
                type="checkbox" checked={s.policy_supportive}
                onChange={(e) => set("policy_supportive", e.target.checked)}
                className="w-4 h-4 accent-[#b3402a]"
              />
              <span className="text-xs text-[#6b675c]">产能调控政策仍在收紧</span>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => onApply(s)}
              className="flex-1 rounded-md bg-[#1c1917] text-[#faf7f0] py-2 text-sm font-semibold hover:bg-[#b3402a] transition-colors"
            >
              重跑引擎并更新
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-[#d8cfba] px-4 py-2 text-sm text-[#6b675c] hover:bg-white transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
