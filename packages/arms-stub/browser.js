"use strict";
// safe-zcode：@arms/rum-electron/browser 空实现，类型见 browser.d.ts；零网络出站。
// 上游 renderer 侧只调用 init(config)；真实 SDK 会在 dom-ready 后注入 Browser SDK
// 采集器，本实现不注册任何东西，init 立即完成。

const armsRumBrowser = {
  init() {
    return Promise.resolve();
  },
};

module.exports = armsRumBrowser;
module.exports.default = armsRumBrowser;
