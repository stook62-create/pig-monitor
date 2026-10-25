import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { PricePoint, Report } from "@/types/report"

const AXIS = { fontSize: 10, fill: "#8a8578", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }
const TOOLTIP_STYLE = {
  background: "#faf7f0",
  border: "1px solid #d8cfba",
  borderRadius: 6,
  boxShadow: "0 4px 16px rgba(28,25,23,.08)",
  fontSize: 12,
}

function shortDate(value: string) {
  return value.slice(5).replace("-", "/")
}

function wowText(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`
}

function domain(points: PricePoint[], key: "pig_price" | "piglet_price", references: number[]): [number, number] {
  const values = [...points.map((p) => p[key]), ...references]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const padding = Math.max((hi - lo) * 0.12, 0.6)
  return [Math.max(0, Math.floor((lo - padding) * 2) / 2), Math.ceil((hi + padding) * 2) / 2]
}

function ChartHeader({ title, latest, wow, high, low }: {
  title: string
  latest: number
  wow: number
  high: number
  low: number
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-[#efe9da] px-4 py-3.5">
      <div>
        <h3 className="font-serif text-sm font-bold">{title}</h3>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold tracking-tight">{latest.toFixed(2)}</span>
          <span className="text-[11px] text-[#8a8578]">元/公斤</span>
          <span className={`font-mono text-xs font-semibold ${wow > 0 ? "text-[#b3402a]" : wow < 0 ? "text-[#1f5c4d]" : "text-[#8a8578]"}`}>
            周环比 {wowText(wow)}
          </span>
        </div>
      </div>
      <div className="ml-auto flex gap-4 text-[11px] text-[#8a8578]">
        <span>年内高点 <b className="font-mono font-semibold text-[#57534a]">{high.toFixed(2)}</b></span>
        <span>年内低点 <b className="font-mono font-semibold text-[#57534a]">{low.toFixed(2)}</b></span>
      </div>
    </div>
  )
}

function PriceChart({ points, kind }: { points: PricePoint[]; kind: "pig" | "piglet" }) {
  const isPig = kind === "pig"
  const key = isPig ? "pig_price" : "piglet_price"
  const name = isPig ? "全国生猪平均价格" : "全国仔猪平均价格"
  const color = isPig ? "#b3402a" : "#b45309"
  const latest = points.at(-1)!
  const values = points.map((p) => p[key])
  const high = Math.max(...values)
  const low = Math.min(...values)
  const references = isPig ? [12.5, 11.6] : [high]

  return (
    <article className="min-w-0 rounded-lg border border-[#e0d8c4] bg-white shadow-sm overflow-hidden">
      <ChartHeader title={name} latest={latest[key]} wow={isPig ? latest.pig_wow : latest.piglet_wow} high={high} low={low} />
      <div className="h-[290px] px-1 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 12, right: 18, left: 0, bottom: 2 }}>
            <CartesianGrid vertical={false} stroke="#ece5d2" strokeDasharray="2 4" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: "#d8cfba" }}
              minTickGap={34}
              padding={{ left: 6, right: 6 }}
            />
            <YAxis
              domain={domain(points, key, references)}
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={(v: number) => v.toFixed(1)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(label) => `采集日 ${label}`}
              formatter={(value) => [`${Number(value).toFixed(2)} 元/公斤`, isPig ? "生猪周均价" : "仔猪周均价"]}
              cursor={{ stroke: "#c9c0a9", strokeDasharray: "3 3" }}
            />
            {isPig && (
              <ReferenceLine
                y={12.5}
                stroke="#b3402a"
                strokeDasharray="5 4"
                label={{ value: "反转确认线 12.5", position: "insideTopRight", fill: "#b3402a", fontSize: 10 }}
              />
            )}
            {isPig && (
              <ReferenceLine
                y={11.6}
                stroke="#1f5c4d"
                strokeDasharray="3 4"
                label={{ value: "牧原完全成本 11.6", position: "insideBottomRight", fill: "#1f5c4d", fontSize: 10 }}
              />
            )}
            {!isPig && (
              <ReferenceLine
                y={high}
                stroke="#b45309"
                strokeDasharray="4 4"
                label={{ value: `年内高点 ${high.toFixed(2)}`, position: "insideTopRight", fill: "#b45309", fontSize: 10 }}
              />
            )}
            <Line
              type="monotone"
              dataKey={key}
              stroke={color}
              strokeWidth={2.2}
              dot={false}
              activeDot={{ r: 4, fill: color, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-[#efe9da] px-4 py-2.5 text-[11px] leading-relaxed text-[#8a8578]">
        最新采集日 {latest.date} · 农业农村部周度数据
      </div>
    </article>
  )
}

export default function PriceCharts({ report }: { report: Report }) {
  const points = report.price_history ?? report.snapshot.price_history ?? []
  if (!points.length) {
    return (
      <div className="rounded-lg border border-dashed border-[#d8cfba] bg-[#faf7f0] px-5 py-10 text-center text-sm text-[#8a8578]">
        该版本尚未包含价格历史；刷新或录入最新周度价格后即可生成监测图。
      </div>
    )
  }

  return (
    <div>
      <div className="grid gap-4 xl:grid-cols-2">
        <PriceChart points={points} kind="pig" />
        <PriceChart points={points} kind="piglet" />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[11px] leading-relaxed text-[#8a8578]">
        <span>共 {points.length} 个周度锚点，刷新与手动录入均按采集日去重追加。</span>
        {report.snapshot.pig_price_daily !== undefined && (
          <span>
            日报辅助锚点：搜猪网瘦肉型出栏均价 {report.snapshot.pig_price_daily.toFixed(2)} 元/公斤
            {report.snapshot.pig_price_daily_date ? `（${report.snapshot.pig_price_daily_date}）` : ""}
          </span>
        )}
        <span className="ml-auto">主图统一采用农业农村部周度口径，不与日报混线。</span>
      </div>
    </div>
  )
}
