import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedMcpServer } from "../../src/config/loadConfig.ts";
import { collectMcpTools, type McpConnector, mcpToolName } from "../../src/server/mcpTools.ts";

// The copilot's handling of external tool sources, with a fake connector in
// place of a real MCP client: namespacing, failure isolation, and closing
// every connection that opened. What a real server answers is the SDK's to
// test.

function server(id: string): ResolvedMcpServer {
  return { id, label: id, url: `http://${id}.test/mcp`, copilot: true, flows: false };
}

const search = tool({
  description: "Search things",
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => `found ${q}`,
});

describe("mcpToolName", () => {
  it("prefixes with the server id and folds unsafe characters", () => {
    expect(mcpToolName("linear", "search")).toBe("mcp_linear_search");
    expect(mcpToolName("my server", "issues.list")).toBe("mcp_my_server_issues_list");
  });
});

describe("collectMcpTools", () => {
  it("re-keys every server's tools so two `search` tools coexist", async () => {
    const connect: McpConnector = async () => ({ tools: { search }, close: async () => {} });
    const surface = await collectMcpTools([server("linear"), server("notion")], connect);

    expect(Object.keys(surface.tools).sort()).toEqual(["mcp_linear_search", "mcp_notion_search"]);
    expect(surface.described).toEqual([
      { name: "mcp_linear_search", server: "linear", description: "Search things" },
      { name: "mcp_notion_search", server: "notion", description: "Search things" },
    ]);
    expect(surface.failures).toEqual([]);
  });

  it("drops a server that fails to connect, with a note, and keeps the rest", async () => {
    const connect: McpConnector = async (target) => {
      if (target.id === "down") throw new Error("ECONNREFUSED");
      return { tools: { search }, close: async () => {} };
    };
    const surface = await collectMcpTools([server("down"), server("up")], connect);

    expect(Object.keys(surface.tools)).toEqual(["mcp_up_search"]);
    expect(surface.failures).toEqual([{ server: "down", message: "ECONNREFUSED" }]);
  });

  it("close() closes every connection that opened, even if one close throws", async () => {
    const closes = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    closes[1].mockRejectedValueOnce(new Error("already gone"));
    let index = 0;
    const connect: McpConnector = async () => ({ tools: {}, close: closes[index++] });
    const surface = await collectMcpTools([server("a"), server("b"), server("c")], connect);

    await expect(surface.close()).resolves.toBeUndefined();
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("is empty for no servers", async () => {
    const surface = await collectMcpTools([]);
    expect(surface.tools).toEqual({});
    expect(surface.described).toEqual([]);
    expect(surface.failures).toEqual([]);
  });
});
