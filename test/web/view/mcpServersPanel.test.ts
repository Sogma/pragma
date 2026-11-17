// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchMcpServers } from "../../../web/core/apiClient.ts";
import { must } from "../../../web/lib/dom.ts";
import { labelFromUrl, wireMcpServersPanel } from "../../../web/view/mcpServersPanel.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMcpServers: vi.fn(),
  fetchProviders: vi.fn(async () => ({ providers: [] })),
}));

// Node's URL: under jsdom the global one is jsdom's, which Node's fs refuses.
const html = readFileSync(new NodeURL("../../../web/index.html", import.meta.url), "utf8");

describe("labelFromUrl", () => {
  it("names a server after its domain, past an endpoint label", () => {
    expect(labelFromUrl("https://mcp.higgsfield.ai/mcp")).toBe("Higgsfield");
    expect(labelFromUrl("https://mcp.linear.app/sse")).toBe("Linear");
    expect(labelFromUrl("https://api.example.com/v1/mcp")).toBe("Example");
    expect(labelFromUrl("https://notion.com/mcp")).toBe("Notion");
  });

  it("skips a second-level suffix in front of a country code", () => {
    expect(labelFromUrl("https://api.example.co.uk/mcp")).toBe("Example");
  });

  it("keeps an IP address or a single-label host whole", () => {
    expect(labelFromUrl("http://127.0.0.1:9000/mcp")).toBe("127.0.0.1");
    expect(labelFromUrl("http://localhost:3000/mcp")).toBe("localhost");
  });

  it("has no name for something that isn't a URL", () => {
    expect(labelFromUrl("higgsfield")).toBe("");
  });
});

describe("Settings → MCP Servers' list", () => {
  it("says why the list couldn't load", async () => {
    vi.mocked(fetchMcpServers).mockRejectedValue(new Error("config.json: mcpServers[0] has no url"));
    document.body.innerHTML = must("#settings-body", new DOMParser().parseFromString(html, "text/html")).outerHTML;
    wireMcpServersPanel(must<HTMLElement>("#settings-body"), {
      openSettingsSubpage: vi.fn(),
      closeSettingsSubpage: vi.fn(),
      onServersChanged: vi.fn(),
      dialog: () => {
        throw new Error("no dialog here");
      },
    })();

    const note = must<HTMLElement>("#mcp-storage-note");
    await vi.waitFor(() => expect(note.hidden).toBe(false));
    expect(note.textContent).toBe("config.json: mcpServers[0] has no url");
  });
});
