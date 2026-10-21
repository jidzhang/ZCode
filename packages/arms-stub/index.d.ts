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
 *
 * 类型形态：tsconfig 为 nodenext，本包无 "type": "module"（CJS）。2026-10-21 上游 3.16.2
 * 合并后默认导入曾被解析成模块命名空间（export default 在 nodenext CJS 下指向
 * module.exports.default 而非整体导出），改为 export = 让 esModuleInterop 默认导入
 * 直接拿到本对象，与 index.js 的 module.exports = armsRum 运行时形态一致。
 * export = 不能与其他导出并存，类型统一收进 namespace。
 */

declare namespace armsRumStub {
  interface ArmsRumReporter {
    request: (...args: never[]) => Promise<unknown>;
    [key: string]: unknown;
  }

  interface ArmsRumConfig {
    /** SDK 侧语义：本实现不区分，恒返回 local。 */
    env?: string;
    [key: string]: unknown;
  }

  interface ArmsRumClient {
    useReporter: (reporter: ArmsRumReporter) => void;
    [key: string]: unknown;
  }

  interface ArmsRumStub {
    /** 上游在主进程启动时 await；空实现立即完成，不初始化任何采集器。 */
    init(config?: ArmsRumConfig): Promise<void>;
    /** 自定义事件上报：空实现直接丢弃。 */
    sendCustom(payload?: unknown): void;
    /** 事件上报：空实现直接丢弃。 */
    sendEvent(...args: unknown[]): void;
    /** 运行期配置：上游有整包 setConfig(config) 与部分更新 setConfig(key, value) 两种形态，空实现均只记录。 */
    setConfig(configOrKey?: ArmsRumConfig | string, value?: unknown): void;
    /** 读取配置；env 恒为 "local"，上游 "prod" 分支逻辑不会命中。 */
    getConfig(): ArmsRumConfig & { env: string };
    /** reporter 注册钩子：上游会包装 reporter.request；空实现保留参数即可。 */
    client: ArmsRumClient;
  }
}

declare const armsRum: armsRumStub.ArmsRumStub;
export = armsRum;
