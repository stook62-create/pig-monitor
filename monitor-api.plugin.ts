/**
 * Vite dev-server 插件：为网页按钮提供本地 API
 *   GET  /api/state          读取当前状态（设置 + 当前报告 + 历史版本）
 *   POST /api/refresh        运行 monitor.py --refresh（拉取最新数据，不存档）
 *   POST /api/save-version   运行 monitor.py --save（手动存档历史版本）
 *   POST /api/settings       运行 monitor.py --set-cost <value>（修正持仓成本）
 * 仅在 npm run dev 时可用；生产构建（dist）为纯静态页，按钮自动禁用。
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(ROOT, "src", "data", "state.json")

const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  "python",
  "py",
  "C:\\Users\\Tingxuan Song\\AppData\\Roaming\\kimi-desktop\\daimon-share\\daimon\\runtime\\python\\.venv\\Scripts\\python.exe",
].filter(Boolean) as string[]

let resolvedPython: string | null = null
function pythonBin(): string {
  if (resolvedPython) return resolvedPython
  for (const c of PYTHON_CANDIDATES) {
    const r = spawnSync(c, ["--version"], { encoding: "utf-8" })
    if (!r.error && r.status === 0) {
      resolvedPython = c
      return c
    }
  }
  throw new Error("未找到可用的 Python 解释器")
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
}

function runMonitor(args: string[]): { ok: boolean; log: string; state?: unknown } {
  const r = spawnSync(pythonBin(), [path.join(ROOT, "monitor.py"), ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  })
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  if (r.error || r.status !== 0) return { ok: false, log: log || String(r.error) }
  return { ok: true, log, state: readState() }
}

function send(res: import("node:http").ServerResponse, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => resolve(data))
  })
}

export default function monitorApi(): Plugin {
  return {
    name: "monitor-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? "").split("?")[0]

        if (url === "/api/state" && req.method === "GET") {
          try {
            send(res, 200, { ok: true, state: readState() })
          } catch (e) {
            send(res, 500, { ok: false, error: String(e) })
          }
          return
        }

        if (url === "/api/refresh" && req.method === "POST") {
          const r = runMonitor(["--refresh"])
          send(res, r.ok ? 200 : 500, r.ok ? r : { ok: false, error: r.log })
          return
        }

        if (url === "/api/save-version" && req.method === "POST") {
          const r = runMonitor(["--save"])
          send(res, r.ok ? 200 : 500, r.ok ? r : { ok: false, error: r.log })
          return
        }

        if (url === "/api/settings" && req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}")
          const cost = Number(body.position_cost)
          if (!Number.isFinite(cost) || cost <= 0) {
            send(res, 400, { ok: false, error: "position_cost 必须为正数" })
            return
          }
          const r = runMonitor(["--set-cost", String(cost)])
          send(res, r.ok ? 200 : 500, r.ok ? r : { ok: false, error: r.log })
          return
        }

        next()
      })
    },
  }
}
