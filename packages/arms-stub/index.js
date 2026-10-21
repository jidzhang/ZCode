"use strict";
// safe-zcode：@arms/rum-electron 空实现，API 与类型见 index.d.ts；零网络出站。

const state = { env: "local" };

const armsRum = {
  init() {
    return Promise.resolve();
  },
  sendCustom() {
    /* 上报丢弃：safe-zcode 零遥测语义 */
  },
  sendEvent() {
    /* 上报丢弃：safe-zcode 零遥测语义 */
  },
  setConfig(configOrKey, value) {
    // 上游两种形态：整包 setConfig(config) 与部分更新 setConfig("properties", {...})。
    if (typeof configOrKey === "string") {
      state[configOrKey] = value;
    } else if (configOrKey && typeof configOrKey === "object") {
      Object.assign(state, configOrKey, { env: "local" });
    }
  },
  getConfig() {
    return { ...state, env: "local" };
  },
  client: {
    useReporter() {
      /* reporter 不会收到任何事件：safe-zcode 零遥测语义 */
    },
  },
};

module.exports = armsRum;
module.exports.default = armsRum;
