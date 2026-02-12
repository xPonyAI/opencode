// AsyncLocalStorage 来自 Node.js 的 async_hooks，它解决的是一个老大难问题：
// 在 async / await、Promise、回调、事件等异步边界之间，怎么安全地“传递上下文”？
import { AsyncLocalStorage } from "async_hooks"

// 这个类，当前只在 instance.ts 中使用
export namespace Context {
  export class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  export function create<T>(name: string) {
    const storage = new AsyncLocalStorage<T>()
    return {
      use() {
        const result = storage.getStore()
        if (!result) {
          throw new NotFound(name)
        }
        return result
      },
      provide<R>(value: T, fn: () => R) {
        return storage.run(value, fn)
      },
    }
  }
}
