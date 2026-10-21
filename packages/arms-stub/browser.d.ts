/**
 * safe-zcode：@arms/rum-electron/browser 子路径的空实现类型。
 *
 * 上游 3.16.2 新增 renderer/preload 侧的 ArmsEventBridge 浏览器 SDK 初始化
 * （desktop/src/shared/armsBrowserInit.ts），只消费 init(config)。
 * 空实现立即完成、不注册任何采集器；形态与主入口同为 CJS export =，
 * 类型收进 namespace 以便与 export = 并存。
 */

declare namespace armsRumBrowserStub {
  interface ArmsRumBrowserStub {
    init(config?: unknown): Promise<void>;
  }
}

declare const armsRumBrowser: armsRumBrowserStub.ArmsRumBrowserStub;
export = armsRumBrowser;
