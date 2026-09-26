/**
 * safe-zcode：@arms/rum-electron 的本地空实现（stub）。
 *
 * 存在原因：上游 ZCode 深度集成阿里云 ARMS RUM 遥测（约 30 个文件直接依赖该 SDK），
 * 逐文件删除会造成每次上游同步的大面积冲突。改为保留上游文件原样、只把依赖
 * 指向本空实现：API 兼容（init/sendCustom/sendEvent/setConfig/getConfig/client.useReporter），
 * 但所有上报调用都丢弃、不产生任何网络出站。阿里云 SDK 代码与运行时连接因此归零，
 * 上游遥测相关文件的后续改动也无需合并冲突处理。
 *
 * 上游若调用此处未覆盖的 API，会在 typecheck 阶段暴露，补一行空函数即可。
 */

export interface ArmsRumReporter {
  request: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

export interface ArmsRumConfig {
  /** SDK 侧语义：本实现不区分，恒返回 local。 */
  env?: string;
  [key: string]: unknown;
}

export interface ArmsRumClient {
  useReporter: (reporter: ArmsRumReporter) => void;
  [key: string]: unknown;
}

export interface ArmsRumStub {
  /** 上游在主进程启动时 await；空实现立即完成，不初始化任何采集器。 */
  init(config?: ArmsRumConfig): Promise<void>;
  /** 自定义事件上报：空实现直接丢弃。 */
  sendCustom(payload?: unknown): void;
  /** 事件上报：空实现直接丢弃。 */
  sendEvent(...args: unknown[]): void;
  /** 运行期配置：空实现仅记录最近一次调用参数，供 getConfig 返回。 */
  setConfig(config?: ArmsRumConfig): void;
  /** 读取配置；env 恒为 "local"，上游 "prod" 分支逻辑不会命中。 */
  getConfig(): ArmsRumConfig & { env: string };
  /** reporter 注册钩子：上游会包装 reporter.request；空实现保留参数即可。 */
  client: ArmsRumClient;
}

declare const armsRum: ArmsRumStub;
export default armsRum;
