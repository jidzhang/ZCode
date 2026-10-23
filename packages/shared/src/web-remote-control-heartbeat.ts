// V1 免登录配对 transport 的心跳基准常量（10s/30s/2s）。V2 relay 的同名抖动函数与
// 重连 jitter 常量统一由 ./web-remote-relay/domain/heartbeatTiming.js 提供（实现一致、
// 参数化基准），这里只保留 V1 专属常量避免与 web-remote-relay 的导出冲突。
export const WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS = 10_000;
export const WEB_REMOTE_CONTROL_HEARTBEAT_JITTER_MS = 2_000;
export const WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
