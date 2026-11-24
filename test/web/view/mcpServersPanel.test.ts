// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  fetchMcpServers,
  type McpServerConnectResponse,
  type McpServerRow,
  postConnectMcpServer,
} from "../../../web/core/apiClient.ts";
import { must } from "../../../web/lib/dom.ts";
import { labelFromUrl, wireMcpServersPanel } from "../../../web/view/mcpServersPanel.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMcpServers: vi.fn(),
  fetchProviders: vi.fn(async () => ({ providers: [] })),
  postConnectMcpServer: vi.fn(),
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

describe("Settings → MCP Servers' form", () => {
  const server: McpServerRow = {
    id: "higgsfield",
    label: "Higgsfield",
    url: "https://mcp.higgsfield.ai/mcp",
    keySource: "none",
    signIn: { state: "signed-out" },
    copilot: true,
    flows: false,
    flowsAvailable: false,
  };

  async function openServer(): Promise<void> {
    vi.mocked(fetchMcpServers).mockResolvedValue({
      servers: [server],
      store: { kind: "plain-files", encrypted: false, available: true },
      signInAllowed: true,
    });
    document.body.innerHTML = must("#settings-body", new DOMParser().parseFromString(html, "text/html")).outerHTML;
    wireMcpServersPanel(must<HTMLElement>("#settings-body"), {
      openSettingsSubpage: vi.fn(),
      closeSettingsSubpage: vi.fn(),
      onServersChanged: vi.fn(),
      dialog: () => {
        throw new Error("no dialog here");
      },
    })();
    const row = () => document.querySelector<HTMLElement>("#mcp-server-list > .settings-open-row");
    await vi.waitFor(() => expect(row()).not.toBeNull());
    row()?.click();
  }

  it("notes connecting under the URL, and says what came of it at the top of the form", async () => {
    let answer: (result: McpServerConnectResponse) => void = () => {};
    vi.mocked(postConnectMcpServer).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openServer();
    const message = must<HTMLElement>("#mcp-form-message");
    const status = must<HTMLElement>("#mcp-form-status");

    must<HTMLButtonElement>("#mcp-form-test").click();
    expect(status.textContent).toBe("Connecting…");
    expect(message.hidden).toBe(true);

    answer({ state: "connected", tools: ["generate_image", "generate_video"] });
    await vi.waitFor(() => expect(message.hidden).toBe(false));
    expect(message.textContent).toBe("Connected. 2 tools: generate_image, generate_video.");
    expect(message.classList.contains("inline-success")).toBe(true);
    expect(status.hidden).toBe(true);

    vi.mocked(postConnectMcpServer).mockRejectedValueOnce(new Error("The server answered 502."));
    must<HTMLButtonElement>("#mcp-form-test").click();
    await vi.waitFor(() => expect(message.textContent).toBe("The server answered 502."));
    expect(message.classList.contains("inline-error")).toBe(true);
    expect(status.hidden).toBe(true);
  });
});
