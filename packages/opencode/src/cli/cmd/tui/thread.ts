import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"

declare global {
  const OPENCODE_WORKER_PATH: string
}

// 通过 ReturnType 定义 Rpc.client<> 返回的类型 RpcClient
type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

// 创建 RPC Worker fetch 函数，用来覆盖 rpc 中的默认 fetch 函数
// rpc 默认的 fetch 函数（http接口调用） ------------->  worker fetch 函数（rpc 本地方法调用）
function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

// 创建监听 RPC Worker "event" 事件的的事件源
function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
  }
}

// 打开 TUI
//// opencode [你的项目]
export const TuiThreadCommand = cmd({
  command: "$0 [project]", // $0 表示这是默认命令（当不指定其他命令时执行）
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      // project 可选参数
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      // 指定使用的 AI 模型，可选参数
      // --model / -m
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      // 继续上次会话，可选参数
      // --continue / -c
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
      if (await Bun.file(distWorker).exists()) return distWorker
      return localWorker
    })
    try {
      // 切换到项目目录
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    // 创建工作线程（Worker）
    const worker = new Worker(workerPath, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    worker.onerror = (e) => {
      Log.Default.error(e)
    }
    // 通过 RPC 与 Worker 通信
    const client = Rpc.client<typeof rpc>(worker)
    // 捕获所有 "没有被try/catch" 捕获的同步异常
    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    // 捕获 Promise 被 reject，但没有 .catch() 的情况
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })
    // 信号处理，操作系统信号（Unix Signal）
    // SIGUSR2 = User-defined signal 2
    // 常用于：
    //  进程控制
    //  热重载
    //  通知程序"干点事"
    process.on("SIGUSR2", async () => {
      await client.call("reload", undefined) // 支持热重载
    })

    // 处理提示输入
    const prompt = await iife(async () => {
      // 支持管道输入: echo "hello" | opencode
      // isTTY 代表你是否真的连接到终端？
      // - 如果是的，返回 undefined
      // - 如果不是，等待输入
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // 网络配置决策
    // Check if server should be started (port or hostname explicitly set in CLI or config)
    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      // 服务器模式
      // 启动HTTP服务器，可以通过浏览器访问
      // 支持远程访问、多客户端连接
      // Start HTTP server for external access
      const server = await client.call("server", networkOpts)
      url = server.url
    } else {
      // 本地模式（本地直接RPC模式） RPC直接通信，性能更好
      // Use direct RPC communication (no HTTP)
      url = "http://opencode.internal"
      customFetch = createWorkerFetch(client)
      events = createEventSource(client)
    }

    // 启动 TUI 界面
    const tuiPromise = tui({
      url,
      // tui 中通过 fetch 实际调用的是 RPC Worker 中的 fetch 方法
      fetch: customFetch,
      // tui 中对 events on 监听的是 "event" 事件名的事件处理器
      events,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
      },
      onExit: async () => {
        await client.call("shutdown", undefined)
      },
    })

    // 后台检查更新
    setTimeout(() => {
      client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)

    await tuiPromise
  },
})
