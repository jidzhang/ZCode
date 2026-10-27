import type { HttpClientPort } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderEndpointRoutingPort } from "../src/model/endpoint-routing-edition/index.js";
import { createProviderEndpointRoutingFetch } from "../src/model/provider-endpoint-routing-fetch.js";

// 本仓库 edition 契约（spec PER-031）：API Key 直连场景下任何模型请求都不改写，
// 尤其是上游静态网关会接管 open.bigmodel.cn / api.z.ai 的 /api/anthropic 请求，
// 在 z.ai 域名被部署网络封禁时会把请求引向不可达的 ultra 网关（误报 auth_failed 403）。

afterEach(() => vi.unstubAllGlobals());

function createEditionPort(): ReturnType<typeof createProviderEndpointRoutingPort> {
  return createProviderEndpointRoutingPort({
    endpointOrigin: "https://zcode.z.ai",
    httpClient: {} as HttpClientPort,
  });
}

describe("direct-connect endpoint routing edition", () => {
  it.each([
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
    "https://open.bigmodel.cn/api/anthropic/v1/messages?id=a%2Bb&empty=",
    "https://OPEN.BIGMODEL.CN:443/api/anthropic/v1/messages/",
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://provider.example.test/api/anthropic/v1/messages",
    "not a URL",
  ])("keeps %s unchanged and unrouted", async (url) => {
    const network = vi.fn(() => {
      throw new Error("unexpected configuration request");
    });
    vi.stubGlobal("fetch", network);
    await expect(createEditionPort().resolve(url)).resolves.toEqual({
      routed: false,
      url,
    });
    expect(network).not.toHaveBeenCalled();
  });

  // 组合行为只验证一点：真实 edition 端口经公共 wrapper 后请求发往原始地址。
  // string/URL/Request 三种输入形态的归一化已由 provider-endpoint-routing-fetch.test.ts 覆盖。
  it("sends the composed request to the original endpoint", async () => {
    const source = "https://open.bigmodel.cn/api/anthropic/v1/messages?stream=true";
    const init = {
      method: "POST",
      body: "request-body",
      headers: { Host: "open.bigmodel.cn", Authorization: "Bearer example" },
    };
    const response = new Response("data: complete\n\n", { status: 200 });
    let sent: Request | undefined;
    const transport = createProviderEndpointRoutingFetch({
      routingPort: createEditionPort(),
      fetch: async (input, options) => {
        sent = new Request(input, options);
        return response;
      },
    });
    expect(await transport(source, init)).toBe(response);
    expect(sent?.url).toBe(source);
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer example");
    await expect(sent?.text()).resolves.toBe("request-body");
    await expect(response.text()).resolves.toBe("data: complete\n\n");
  });
});
