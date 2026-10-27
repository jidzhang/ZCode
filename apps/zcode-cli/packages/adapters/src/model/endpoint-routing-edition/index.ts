import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

// Bugfix：本仓库面向自带 Provider API Key 的直连场景，且部署网络封禁 z.ai 域名。
// 上游静态网关（official-coding-plan-gateway.ts）会把 open.bigmodel.cn / api.z.ai 的
// /api/anthropic 模型请求改写到 zcode.z.ai 的 ultra 网关做套餐管控；API Key 用户不需要
// 该管控，网关域名被代理封禁时请求在几毫秒内收到 403，并被误分类为
// "Provider authentication failed."（2026-10-27 排查，TraceID 9ec81dbc-1277-45b0-afce-f5d06437969b）。
// 因此本 edition 对任何请求固定不路由；需要官方网关时把本目录换回静态实现装配，
// 契约与公共测试不变（spec：docs/design/v2/model/provider-endpoint-routing.md）。
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
