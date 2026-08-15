# -*- coding: utf-8 -*-
"""
生猪行业双周监测 · 牧原持仓跟踪 —— 后端监测脚本（手动触发模式）
================================================================
工作模式：
  python monitor.py                或  python monitor.py --refresh
      拉取最新数据快照，重建"当前报告"（不存档为历史版本）
  python monitor.py --save [--date YYYY-MM-DD]
      把当前报告手动存档为一个历史版本（reports/ 目录，永不覆盖）
  python monitor.py --set-cost 38.5
      修正持仓成本，重建当前报告（市值参照、浮盈等联动调整）

数据流：
  settings.json           持仓成本等可编辑设置
  reports/*.json          手动存档的历史版本
  src/data/state.json     前端读取的统一状态（设置 + 当前报告 + 历史版本）
"""

import json
import re
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

# Windows 控制台默认 GBK，统一为 UTF-8 输出，避免特殊字符打印失败
for stream in (sys.stdout, sys.stderr):
    if stream.encoding and stream.encoding.lower() != "utf-8":
        stream.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent
REPORTS_DIR = ROOT / "reports"
SETTINGS_FILE = ROOT / "settings.json"
STATE_FILE = ROOT / "src" / "data" / "state.json"

# ---------- 常量锚点（来自研究框架，可随研究深入更新） ----------
DEFAULT_COST = 37.3           # 默认持仓成本（元）
SHARES = 54.4                 # 总股本（亿股，按 40元≈2185亿市值口径折算）
MUYUAN_FULL_COST = 11.6       # 牧原完全成本（元/公斤，2026年5月）
INDUSTRY_COST = 13.0          # 行业平均完全成本（元/公斤以上）
SOW_NORMAL_HOLDING = 3750     # 农业农村部正常保有量（万头，2026年5月下调后）
SOW_DEEP_TARGET = 3650        # 反转确认所需的母猪存栏水位（万头）
BASE_PROB = {"A": 40, "B": 45, "C": 15}  # 基准概率（%）

SCENARIOS = {
    "A": "2027H1 周期反转",
    "B": "微利中枢 + 小周期波动",
    "C": "严格十年微利 / 周期消失",
}


# ---------- 设置读写 ----------
def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    return {"position_cost": DEFAULT_COST}


def save_settings(s: dict):
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- 1. 数据采集 ----------
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def _http_get(url: str, encoding: str = "utf-8", timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers=UA)
    raw = urllib.request.urlopen(req, timeout=timeout).read()
    return raw.decode(encoding, errors="ignore")


def fetch_muyuan_close() -> float:
    """腾讯行情接口拉取牧原最新价（GBK编码，~分隔）。"""
    txt = _http_get("https://qt.gtimg.cn/q=sz002714", encoding="gbk")
    m = re.search(r'="([^"]+)"', txt)
    price = float(m.group(1).split("~")[3])
    if not (5 < price < 500):
        raise ValueError(f"股价异常: {price}")
    return price


def fetch_pig_price_spot() -> tuple:
    """抓取搜猪网生猪日报列表页标题中的全国瘦肉型出栏均价（按日期倒序，取最新一期）。"""
    html = _http_get("https://www.soozhu.com/article/")
    items = re.findall(r'href="(/article/\d+/)"[^>]*>([^<]*生猪日报[^<]*)</a>', html)
    for _link, title in items:
        m = re.search(r"(\d+)月(\d+)日生猪日报：今日全国瘦肉型猪出栏均价([\d.]+)元/公斤", title)
        if m:
            month, day, price = int(m.group(1)), int(m.group(2)), float(m.group(3))
            if 5 <= price <= 30:
                return price, f"{month}月{day}日"
    raise ValueError("未找到生猪日报标题")


# 人工维护的基准值（月度/研究性数据；自动采集失败的字段也回退到这里）
MANUAL_BASELINE = {
    "pig_price": 10.62,            # 搜猪网瘦肉型出栏均价（2026-08-14，自动采集会覆盖）
    "pig_price_low": 9.5,          # 本轮低点（2026年3-4月）
    "muyuan_june_avg_price": 9.69, # 牧原6月销售均价
    "piglet_trend": "low",         # 仔猪：农业农村部8月第1周均价22.42元/公斤，环比-2.5%，29省全部下跌（7月异动已逆转）
    "frozen_stock": "high",        # 冻品库存：high/normal/low
    "sow_stock": 3780,             # 能繁母猪存栏（万头，2026Q2末，月度数据）
    "sow_mom": -1.33,              # 最新月环比（%，2026年6月）
    "sow_mom_prev": -1.13,         # 上月环比（%，2026年5月）
    "muyuan_cost": MUYUAN_FULL_COST,
    "muyuan_q2_profit": -50,       # Q2单季预亏中枢（亿元，-45~-55）
    "industry_loss_per_head": 213, # 自繁自养头均亏损（元，2026-08-03钢联数据）
    "muyuan_close": 39.29,         # 2026-08-14收盘（自动采集会覆盖）
    "muyuan_year_low": 31.81,
    "muyuan_year_high": 51.29,
    "policy_supportive": True,     # 保有量下调+备案制
}


def collect_snapshot() -> dict:
    """采集最新数据快照：能自动拉取的自动拉取，失败回退到人工基准值。

    自动源：牧原股价（腾讯行情）、生猪现货价（搜猪网日报标题）。
    人工维护：母猪存栏/环比（月度官方数据）、仔猪动向、冻品库存、成本、单季利润、政策。
    """
    snap = dict(MANUAL_BASELINE)
    sources = {}

    try:
        snap["muyuan_close"] = fetch_muyuan_close()
        sources["牧原股价"] = f"自动·腾讯行情（{snap['muyuan_close']:.2f}元）"
    except Exception as e:
        sources["牧原股价"] = f"人工基准（自动失败：{e}）"

    try:
        price, day = fetch_pig_price_spot()
        snap["pig_price"] = price
        sources["生猪均价"] = f"自动·搜猪网日报（{day}：{price}元/公斤）"
    except Exception as e:
        sources["生猪均价"] = f"人工基准（自动失败：{e}）"

    sources["母猪存栏"] = "人工·月度官方数据"
    sources["仔猪/库存/成本/利润"] = "人工·研究底稿"
    snap["_sources"] = sources
    return snap


# ---------- 2. 指标引擎 ----------
def evaluate(s: dict) -> list:
    """八项指征因子。status: positive / negative / warning / neutral"""
    factors = []

    p = s["pig_price"]
    if p >= 12.5:
        st, note = "positive", "站上反转确认线12.5元"
    elif p < MUYUAN_FULL_COST:
        st, note = "negative", f"低于牧原完全成本{MUYUAN_FULL_COST}元，行业深亏出清中"
    else:
        st, note = "neutral", "介于现金成本与完全成本之间"
    factors.append({
        "name": "生猪现货价格", "value": f"{p:.2f} 元/公斤",
        "threshold": "反转确认：连续4-6周站稳12.5元",
        "status": st, "note": note,
    })

    sow, mom = s["sow_stock"], s["sow_mom"]
    if mom > 0:
        st, note = "warning", "环比转正——去化中断警报！"
    elif sow <= SOW_DEEP_TARGET:
        st, note = "positive", f"降至{SOW_DEEP_TARGET}万头附近，反转条件达成"
    elif mom <= -1.0:
        st, note = "positive", f"环比{mom:.2f}%，加速去化（需持续至{SOW_DEEP_TARGET}万头）"
    elif mom < 0:
        st, note = "neutral", "温和去化中"
    else:
        st, note = "neutral", "持平"
    factors.append({
        "name": "能繁母猪存栏", "value": f"{sow} 万头（环比 {mom:+.2f}%）",
        "threshold": f"政策保有量 {SOW_NORMAL_HOLDING} 万头；反转目标 {SOW_DEEP_TARGET} 万头",
        "status": st, "note": note,
    })

    piglet_map = {
        "surge": ("warning", "仔猪价格快速上涨——补栏情绪回暖，警惕去化中断"),
        "slow_up": ("neutral", "温和回升，属健康信号"),
        "flat": ("neutral", "平稳"),
        "low": ("positive", "低迷=补栏冰点=去化持续"),
    }
    st, note = piglet_map.get(s["piglet_trend"], ("neutral", ""))
    factors.append({
        "name": "仔猪价格动向", "value": {"surge": "快速上涨", "slow_up": "温和回升", "flat": "平稳", "low": "低迷"}[s["piglet_trend"]],
        "threshold": "暴涨=去化中断警报；低迷=去化持续",
        "status": st, "note": note,
    })

    gap = INDUSTRY_COST - s["muyuan_cost"]
    factors.append({
        "name": "牧原完全成本", "value": f"{s['muyuan_cost']:.1f} 元/公斤",
        "threshold": "行业平均约 13 元/公斤",
        "status": "positive" if gap >= 1.0 else "neutral",
        "note": f"领先行业约 {gap:.1f} 元/公斤，全行业最低，且仍在下降",
    })

    q2 = s["muyuan_q2_profit"]
    if q2 > 0:
        st, note = "positive", "单季转正——最硬的右侧信号！"
    elif q2 > -20:
        st, note = "neutral", "减亏至盈亏平衡线附近"
    else:
        st, note = "negative", f"Q2预亏{-q2:.0f}亿上下，大概率是本轮亏损峰值"
    factors.append({
        "name": "牧原单季利润", "value": f"Q2 约 {q2:.0f} 亿元",
        "threshold": "单季转正 = 最硬右侧信号",
        "status": st, "note": note,
    })

    frozen_map = {
        "high": ("warning", "冻品库存高企，压制鲜品价格反弹高度"),
        "normal": ("neutral", "正常水位"),
        "low": ("positive", "低库存，价格弹性充足"),
    }
    st, note = frozen_map.get(s["frozen_stock"], ("neutral", ""))
    factors.append({
        "name": "冻品库存", "value": {"high": "偏高", "normal": "正常", "low": "偏低"}[s["frozen_stock"]],
        "threshold": "高库存=反弹压制器",
        "status": st, "note": note,
    })

    if s["policy_supportive"]:
        st, note = "positive", "保有量下调至3750万头+大型集团备案制，政策在帮助去化"
    else:
        st, note = "warning", "政策转向宽松"
    factors.append({
        "name": "政策动向", "value": "产能调控收紧",
        "threshold": "备案制执行力度",
        "status": st, "note": note,
    })

    factors.append({
        "name": "猪价波动率", "value": "磨底拉锯",
        "threshold": "连续12个月11-14元窄幅 = 微利均衡警报",
        "status": "neutral",
        "note": "尚处大周期底部形态，未进入微利均衡；需持续跟踪",
    })

    return factors


# ---------- 3. 概率引擎 ----------
def probabilities(s: dict) -> dict:
    prob = dict(BASE_PROB)
    reasons = []

    if s["sow_mom"] <= -1.0 and s["sow_mom"] < s["sow_mom_prev"]:
        prob["A"] += 2
        prob["C"] -= 2
        reasons.append(f"能繁母猪去化加速（环比{s['sow_mom']:+.2f}%，降幅连续扩大）→ A+2 / C-2")

    if s["piglet_trend"] == "surge":
        prob["A"] -= 3
        prob["B"] += 3
        reasons.append("仔猪价格快速上涨，补栏情绪回暖，去化存在中断风险 → A-3 / B+3")

    if s["sow_mom"] > 0:
        prob["A"] -= 5
        prob["C"] += 5
        reasons.append("母猪环比转正，去化中断警报触发 → A-5 / C+5")

    if s["muyuan_q2_profit"] > 0:
        prob["A"] += 5
        prob["C"] -= 5
        reasons.append("牧原单季利润转正，右侧信号确认 → A+5 / C-5")

    total = sum(prob.values())
    prob = {k: round(v * 100 / total) for k, v in prob.items()}
    diff = 100 - sum(prob.values())
    if diff:
        prob["B"] += diff

    return {"prob": prob, "reasons": reasons, "base": dict(BASE_PROB)}


# ---------- 4. 信号 / 持仓区域 / 盯防清单 ----------
def build_signals() -> dict:
    return {
        "positive": [
            "能繁母猪去化加速：4月-0.71% → 5月-1.13% → 6月-1.33%，降幅逐月扩大",
            "仔猪警报解除：8月第1周仔猪均价22.42元/公斤、环比-2.5%，29省全部下跌——7月的补栏异动已逆转",
            "政策双轮驱动：保有量下调至3750万头 + 大型集团生产备案制",
            "牧原现金流修复：H股募资净额118.65亿港元到账，高管增持4-5亿+H股回购",
        ],
        "watch": [
            "8月出栏计划环比普增（卓创+6.24%、钢联+3.74%）——供给压力未减，反弹高度受限",
            "冻品库存偏高，将持续压制鲜品价格反弹高度",
            "PSY效率革命（行业24头+、牧原29-32头）正在吞噬数量去化的成果",
        ],
        "risk": [
            "立秋后猪价小幅反弹（10.2→10.6元），若回到成本线附近，补栏情绪可能复燃、去化停滞",
            "Q3财报若亏损超预期，股价可能二次探底",
        ],
    }


def build_position_zones(s: dict, cost: float) -> list:
    price = s["muyuan_close"]
    return [
        {"range": "< 35 元", "action": "加仓区", "logic": "接近悲观定价下沿，用宝丰减仓资金加仓", "active": price < 35},
        {"range": "35 - 37 元", "action": "小幅加仓", "logic": f"接近持仓成本{cost:.1f}元附近，市场给的第二次机会", "active": 35 <= price < 37},
        {"range": "38 - 42 元", "action": "底仓躺平", "logic": "亏损现实与反转预期的均衡箱体，不操作就是最好的操作", "active": 38 <= price <= 42},
        {"range": "> 45 元", "action": "兑现部分", "logic": "进入年内套牢盘核心区，可兑现一部分", "active": price > 45},
        {"range": "去化证伪", "action": "止损纪律", "logic": "母猪环比转正/仔猪暴涨 → 纪律优先于成本锚", "active": False},
    ]


def build_next_watch() -> list:
    return [
        {"time": "8月底-9月", "item": "开学+双节备货旺季猪价表现——旺季拉不动则拉锯延长"},
        {"time": "9月底", "item": "Q3能繁母猪存栏数据——环比再降1%以上则去化逻辑强化"},
        {"time": "10月底", "item": "牧原三季报——单季是否减亏至盈亏平衡线附近（第一个硬验证点）"},
        {"time": "2027年Q1", "item": "单季转正+猪价站稳13元——趋势资金进场的真正发令枪"},
    ]


# ---------- 4.5 情景目标市值 ----------
def build_scenario_targets(s: dict, cost: float) -> dict:
    """三情景的最终目标市值锚（估值框架来自研究底稿，股价按总股本约54.4亿股折算）。"""
    targets = [
        {
            "key": "A", "lo": 3500, "hi": 4600,
            "price": f"{3500/SHARES:.0f}-{4600/SHARES:.0f} 元",
            "basis": "峰值利润 × 6-8 倍周期顶部纪律（猪价18元情景峰值利润约575亿）",
            "note": "市场疯狂阶段可能透支此区间（2020年剧本）；80元上方逐步兑现，不把超涨当计划内收益",
        },
        {
            "key": "B", "lo": 1300, "hi": 1900,
            "price": f"{1300/SHARES:.0f}-{1900/SHARES:.0f} 元",
            "basis": "净利中枢90-130亿（头均130-180元 × 出栏7000-7500万头）× 12-15倍PE",
            "note": f"回报主要靠分红（50-75亿/年）；你的成本（{cost:.1f}元）接近该情景定价上沿，赚的是类债券+期权的钱",
        },
        {
            "key": "C", "lo": 1000, "hi": 1500,
            "price": f"{1000/SHARES:.0f}-{1500/SHARES:.0f} 元",
            "basis": "红利股定价：年分红50-75亿，4-5%股息率，叠加估值逻辑切换的情绪超调",
            "note": "周期消失的真实底部约20元上下（与雪球热帖独立测算吻合）；逻辑切换有2-3年渐变窗口",
        },
    ]
    return {
        "current_mcap": round(s["muyuan_close"] * SHARES),
        "cost_mcap": round(cost * SHARES),
        "scale_max": 5000,
        "targets": targets,
    }


# ---------- 5. 报告组装 ----------
def build_conclusion(s: dict, prob_info: dict, cost: float) -> str:
    p = prob_info["prob"]
    adj = "；".join(prob_info["reasons"]) if prob_info["reasons"] else "本期无触发调整规则"
    return (
        f"价格底已现（3-4月9.5-10元大概率是本轮低点），但时间底未走完：磨底预计持续到2026年底，"
        f"趋势性回升窗口在2027年上半年。牧原亏损峰值（2026Q2）大概率已过，接下来是"
        f"“减亏+修复资产负债表+吃下退出者份额”的半年。本期概率引擎：{adj}。"
        f"当前判断——情景A（2027H1反转）{p['A']}%、情景B（微利中枢+小周期）{p['B']}%、"
        f"情景C（十年微利）{p['C']}%。对照持仓成本{cost:.1f}元：现价{s['muyuan_close']:.2f}元"
        f"（浮盈{(s['muyuan_close']/cost-1)*100:+.1f}%）处于38-42元拉锯箱体，策略为底仓躺平、破位加仓、证伪止损。"
    )


def build_report(snapshot: dict, settings: dict, as_of: str, version: str) -> dict:
    cost = settings["position_cost"]
    factors = evaluate(snapshot)
    prob_info = probabilities(snapshot)
    return {
        "as_of": as_of,
        "version": version,
        "refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "position_cost": cost,
        "snapshot": snapshot,
        "conclusion": build_conclusion(snapshot, prob_info, cost),
        "key_metrics": [
            {"name": "生猪均价", "value": f"{snapshot['pig_price']:.2f} 元/公斤", "delta": "低点9.5元已现", "dir": "down"},
            {"name": "能繁母猪", "value": f"{snapshot['sow_stock']} 万头", "delta": f"环比 {snapshot['sow_mom']:+.2f}%", "dir": "down"},
            {"name": "牧原完全成本", "value": f"{snapshot['muyuan_cost']:.1f} 元/公斤", "delta": "行业最低", "dir": "up"},
            {"name": "牧原Q2单季", "value": f"约 {snapshot['muyuan_q2_profit']:.0f} 亿元", "delta": "亏损峰值大概率已过", "dir": "down"},
            {"name": "牧原股价", "value": f"{snapshot['muyuan_close']:.2f} 元",
             "delta": f"成本{cost:.1f}元 浮盈{(snapshot['muyuan_close']/cost-1)*100:+.1f}%",
             "dir": "up" if snapshot["muyuan_close"] >= cost else "down"},
        ],
        "scenarios": [
            {"key": k, "name": SCENARIOS[k], "prob": prob_info["prob"][k], "base": prob_info["base"][k]}
            for k in ("A", "B", "C")
        ],
        "prob_reasons": prob_info["reasons"],
        "scenario_targets": build_scenario_targets(snapshot, cost),
        "factors": factors,
        "signals": build_signals(),
        "position_zones": build_position_zones(snapshot, cost),
        "next_watch": build_next_watch(),
        "sources": snapshot.get("_sources", {}),
    }


# ---------- 6. 状态读写 ----------
def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"settings": load_settings(), "current": None, "versions": []}


def write_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def archived_versions() -> list:
    REPORTS_DIR.mkdir(exist_ok=True)
    return sorted(
        (json.loads(p.read_text(encoding="utf-8")) for p in REPORTS_DIR.glob("*.json")),
        key=lambda r: (r["as_of"], r.get("refreshed_at", "")),
    )


# ---------- 7. 三种工作模式 ----------
def do_refresh():
    """拉取最新数据，重建当前报告（不存档）。"""
    settings = load_settings()
    snapshot = collect_snapshot()
    as_of = date.today().isoformat()
    current = build_report(snapshot, settings, as_of, f"R{as_of.replace('-', '')}")
    state = {"settings": settings, "current": current, "versions": archived_versions()}
    write_state(state)
    print(f"✓ 数据已刷新（{current['refreshed_at']}），当前报告已重建，未存档")


def do_save(as_of: str = None):
    """把当前报告手动存档为一个历史版本。"""
    state = load_state()
    current = state.get("current")
    if current is None:
        # 还没有当前报告，先刷新一次
        do_refresh()
        state = load_state()
        current = state["current"]

    save_date = as_of or date.today().isoformat()
    REPORTS_DIR.mkdir(exist_ok=True)
    out = REPORTS_DIR / f"{save_date}.json"
    if out.exists():
        out = REPORTS_DIR / f"{save_date}_{datetime.now().strftime('%H%M')}.json"

    versioned = dict(current)
    versioned["as_of"] = save_date
    suffix = "" if out.stem == save_date else f"-{out.stem.split('_')[1]}"
    versioned["version"] = f"R{save_date.replace('-', '')}{suffix}"
    out.write_text(json.dumps(versioned, ensure_ascii=False, indent=2), encoding="utf-8")

    state = {"settings": load_settings(), "current": current, "versions": archived_versions()}
    write_state(state)
    print(f"✓ 已手动存档版本 {versioned['version']} → {out}（共 {len(state['versions'])} 期）")


def do_set_cost(cost: float):
    """修正持仓成本，重建当前报告（市值参照、浮盈联动调整）。"""
    settings = load_settings()
    settings["position_cost"] = round(cost, 2)
    save_settings(settings)

    state = load_state()
    if state.get("current"):
        current = build_report(state["current"]["snapshot"], settings,
                               date.today().isoformat(), state["current"]["version"])
    else:
        snapshot = collect_snapshot()
        as_of = date.today().isoformat()
        current = build_report(snapshot, settings, as_of, f"R{as_of.replace('-', '')}")
    write_state({"settings": settings, "current": current, "versions": archived_versions()})
    print(f"✓ 持仓成本已更新为 {cost:.2f} 元，当前报告已联动重建")


def main():
    args = sys.argv[1:]
    if "--save" in args:
        as_of = None
        for i, a in enumerate(args):
            if a == "--date" and i + 1 < len(args):
                as_of = args[i + 1]
        do_save(as_of)
    elif "--set-cost" in args:
        i = args.index("--set-cost")
        do_set_cost(float(args[i + 1]))
    else:
        do_refresh()


if __name__ == "__main__":
    main()
