import z from "zod"
import { randomBytes } from "crypto"

export namespace Identifier {
  const prefixes = {
    session: "ses",
    message: "msg",
    permission: "per",
    question: "que",
    user: "usr",
    part: "prt",
    pty: "pty",
    tool: "tool",
  } as const

  export function schema(prefix: keyof typeof prefixes) {
    // 对字符串进行校验，确保该字符串以指定前缀开头(ses, msg, per, que, usr ......)
    return z.string().startsWith(prefixes[prefix])
  }

  const LENGTH = 26

  // State for monotonic（单调） ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, true, given)
  }

  function generateID(prefix: keyof typeof prefixes, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(prefix: keyof typeof prefixes, descending: boolean, timestamp?: number): string {
    // 如果调用时没有传入 timestamp，就使用当前时间（毫秒）
    const currentTimestamp = timestamp ?? Date.now()

    // 检查是否是新的毫秒，如果是新毫秒则重置 counter
    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++ // 每次生成 ID，计数器 +1，保证同一毫秒内 ID 不重复

    // 1. js 左移运算符 << 会把操作数转换为32位有符号整数，然后再做左移
    // 2. BigInt 可以表示任意大小的整数，不会溢出
    // 3. BigInt(currentTimestamp) * BigInt(0x1000) 相当于让 currentTimestamp 左移 12 位，留出 2^12=4096个位置给 count
    // 4. BigInt(currentTimestamp) 会在数字后面添加一个 n 字符，代表这是 BigInt
    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    // 如果 descending 为 true，则按位取反，生成降序排序 ID
    now = descending ? ~now : now

    // 分配 6 字节 Buffer 来存储时间部分（48 位 = 6 * 8）
    // 由于上面生成的 now 是 BigInt，位数不固定（小数字可能只有几位，大数字很多位）
    // 为了生成固定长度的ID，需要把它固定为 6 字节（48位），这保证了：字典序（字节顺序）与时间排序一致

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      // 将 BigInt 分解为 6 个字节，存储到 Buffer 中
      // 高位在前，低位在后（大端存储）
      // now >> BigInt(40 - 8*i) 把 now 右移，把第 i 个字节移到最低位
      // & BigInt(0xff)) 取最低 8 位（一个字节）
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    // 最终 ID = 前缀 + "_" + 时间部分16进制 + 随机部分
    // LENGTH - 12 是随机部分长度（LENGTH 应该是总长度）
    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }

  /** Extract timestamp from an ascending ID. Does not work with descending IDs. */
  export function timestamp(id: string): number {
    const prefix = id.split("_")[0]
    const hex = id.slice(prefix.length + 1, prefix.length + 13)
    const encoded = BigInt("0x" + hex)
    return Number(encoded / BigInt(0x1000))
  }
}
