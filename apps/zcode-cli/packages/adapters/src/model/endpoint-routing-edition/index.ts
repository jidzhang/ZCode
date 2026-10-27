import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

// Bugfix：上游静态网关会把 open.bigmodel.cn / api.z.ai 的模型请求改写到 zcode.z.ai
// 的 ultra 网关做套餐管控；部署网络封禁 z.ai 时请求在几毫秒内收到 403，被误分类为
// auth_failed（2026-10-27 排查，TraceID 9ec81dbc-1277-45b0-afce-f5d06437969b）。
// 本仓库 API Key 直连不需要该管控，故本 edition 恒不路由；换回静态实现装配即可恢复
// 官方网关（spec：docs/design/v2/model/provider-endpoint-routing.md，PER-031）。
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
