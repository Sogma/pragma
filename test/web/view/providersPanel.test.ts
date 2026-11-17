// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchProviderSignInStatus,
  fetchProviders,
  type ProviderRow,
  type ProviderSignInStatus,
  postDeleteProvider,
  postDiscoverProviderModels,
  postProviderSignIn,
  postProviderSignOut,
  postSaveProvider,
  postSaveProviderModels,
} from "../../../web/core/apiClient.ts";
import type { ConfirmOptions, DialogService } from "../../../web/services/dialog.ts";
import { type ProvidersPanelDeps, wireProvidersPanel } from "../../../web/view/providersPanel.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchProviders: vi.fn(),
  fetchMcpServers: vi.fn(async () => ({ servers: [] })),
  postDeleteProvider: vi.fn(async () => ({})),
  postSaveProvider: vi.fn(async () => undefined),
  postDiscoverProviderModels: vi.fn(async () => ({ models: [], imageModels: [] })),
  postSaveProviderModels: vi.fn(async () => undefined),
  postProviderSignIn: vi.fn(async () => "https://auth.openai.com/api/accounts/authorize?state=s"),
  postProviderSignOut: vi.fn(async () => ({ revoked: true })),
  fetchProviderSignInStatus: vi.fn(async () => ({ state: "pending" })),
}));

const row = (fields: Partial<ProviderRow> & Pick<ProviderRow, "id" | "label" | "kind">): ProviderRow => ({
  baseURL: "",
  textModels: [],
  imageModels: [],
  keySource: "stored",
  ...fields,
});

// Settings → AI Models as web/index.html has it, trimmed to what the panel reads.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProviders).mockResolvedValue({
    providers: [
      row({
        id: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        vendor: "anthropic",
        textModels: ["claude-sonnet-5"],
      }),
      row({ id: "lmstudio", label: "LM Studio", kind: "openai", baseURL: "http://localhost:1234/v1" }),
      row({ id: "my-ollama", label: "My Ollama", kind: "openai", baseURL: "http://localhost:11434/v1" }),
    ],
    store: { kind: "plain-files", encrypted: false, available: true },
    signInAllowed: true,
  });
  document.body.innerHTML = `
    <div id="settings-body">
      <p id="providers-storage-note"></p>
      <div id="providers-list"></div>
      <button id="providers-add"></button>
      <h3 id="providers-form-title"></h3>
      <form id="providers-form">
        <div class="settings-field"><button id="providers-form-preset"></button></div>
        <input id="providers-form-name" /><p id="providers-form-name-hint"></p>
        <input id="providers-form-baseurl" />
        <div id="providers-form-key-row"><input id="providers-form-key" /><button id="providers-form-set"></button></div>
        <div id="providers-form-sign-in-row" hidden>
          <span id="providers-form-account"></span><button id="providers-form-continue" type="button"></button>
          <button id="providers-form-allow-plan" type="button"></button><button id="providers-form-sign-out" type="button"></button>
        </div>
        <p id="providers-form-sign-in-status"></p>
        <div id="providers-form-models"><div id="providers-form-models-list"></div><input id="providers-form-model-add" /></div>
        <div id="providers-form-image-models">
          <div id="providers-form-image-models-list"></div><input id="providers-form-image-model-add" />
        </div>
        <button id="providers-form-refresh" type="button"></button><p id="providers-form-message"></p>
      </form>
      <button id="providers-form-remove" hidden></button>
    </div>`;
});

function wire(overrides: Partial<ProvidersPanelDeps> = {}) {
  const deps: ProvidersPanelDeps = {
    openSettingsSubpage: vi.fn(),
    closeSettingsSubpage: vi.fn(),
    onProvidersChanged: vi.fn(),
    dialog: () => {
      throw new Error("no dialog here");
    },
    contextMenu: fakeContextMenu(),
    ...overrides,
  };
  wireProvidersPanel(document.querySelector("#settings-body") as HTMLElement, deps)();
  return deps;
}

const rows = () => [...document.querySelectorAll<HTMLElement>("#providers-list > .settings-open-row")];
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe("Settings → AI Models' provider list", () => {
  it("puts each provider's mark beside its name, its vendor's only where the server names one", async () => {
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    const marks = rows().map((el) => el.querySelector<HTMLElement>(".providers-row-lead > .provider-mark"));
    expect(marks.map((mark) => mark?.dataset.vendor)).toEqual(["anthropic", "", ""]);
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(rows()[0].querySelector(".providers-row-name")?.textContent).toBe("Anthropic");
  });

  it("opens a provider's subpage from its whole row, named for it and offering Remove", async () => {
    const deps = wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[0].tagName).toBe("BUTTON");
    expect(rows()[0].dataset.settingsItem).toBe("anthropic");
    rows()[0].click();
    expect(deps.openSettingsSubpage).toHaveBeenCalledWith("provider");
    expect(byId("providers-form-title").textContent).toBe("Anthropic");
    expect(byId("providers-form-remove").hidden).toBe(false);
  });

  it("offers no Remove while adding a provider", async () => {
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    rows()[0].click();
    byId("providers-add").click();
    expect(byId("providers-form-title").textContent).toBe("Add provider");
    expect(byId("providers-form-remove").hidden).toBe(true);
  });

  it("removes the provider inside the confirmation, then goes back to the list", async () => {
    const confirm = vi.fn(async (options: ConfirmOptions) => {
      await options.action?.();
      return true;
    });
    const deps = wire({ dialog: () => ({ confirm }) as unknown as DialogService });
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    rows()[1].click();
    byId("providers-form-remove").click();
    await vi.waitFor(() => expect(deps.closeSettingsSubpage).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].message).toContain("“LM Studio”");
    expect(postDeleteProvider).toHaveBeenCalledWith("lmstudio");
    expect(deps.onProvidersChanged).toHaveBeenCalled();
  });

  it("stays on the subpage when the removal is declined", async () => {
    const deps = wire({ dialog: () => ({ confirm: async () => false }) as unknown as DialogService });
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    rows()[1].click();
    byId("providers-form-remove").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postDeleteProvider).not.toHaveBeenCalled();
    expect(deps.closeSettingsSubpage).not.toHaveBeenCalled();
  });

  it("saves a custom provider at a preset's address under its own id and name", async () => {
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    rows()[2].click();
    expect(byId<HTMLInputElement>("providers-form-name").value).toBe("My Ollama");
    byId<HTMLFormElement>("providers-form").requestSubmit();
    await vi.waitFor(() => expect(postSaveProvider).toHaveBeenCalled());
    expect(postSaveProvider).toHaveBeenCalledWith({
      id: "my-ollama",
      kind: "openai",
      label: "My Ollama",
      baseURL: "http://localhost:11434/v1",
    });
  });
});

describe("Settings → AI Models' Set", () => {
  const line = () => byId("providers-form-message");
  const store = { kind: "plain-files", encrypted: false, available: true } as const;

  async function setOn(index: number) {
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(index));
    rows()[index].click();
    byId<HTMLFormElement>("providers-form").requestSubmit();
    await vi.waitFor(() => expect(line().hidden).toBe(false));
  }

  it("confirms a key that lists models, in green over the checkboxes", async () => {
    vi.mocked(postDiscoverProviderModels).mockResolvedValueOnce({
      textModels: ["claude-sonnet-5", "claude-opus-5"],
      imageModels: [],
    });
    wire();
    await setOn(0);
    expect(line().textContent).toBe(
      "Key works. Anthropic offers 2 text models, and Pragma lists the ticked ones wherever you choose a model.",
    );
    expect(line().classList.contains("inline-success")).toBe(true);
    expect(line().classList.contains("inline-error")).toBe(false);
  });

  it("says Connected for a connection with no key, and asks for a tick when none is", async () => {
    vi.mocked(fetchProviders).mockResolvedValue({
      providers: [row({ id: "lmstudio", label: "LM Studio", kind: "openai", keySource: "none" })],
      store,
      signInAllowed: true,
    });
    vi.mocked(postDiscoverProviderModels).mockResolvedValueOnce({ textModels: ["qwen3"], imageModels: [] });
    wire();
    await setOn(0);
    expect(line().textContent).toBe(
      "Connected. LM Studio offers 1 text model: tick the ones Pragma should list wherever you choose a model.",
    );
  });

  it("turns the line red when the next attempt fails", async () => {
    vi.mocked(postDiscoverProviderModels)
      .mockResolvedValueOnce({ textModels: ["claude-sonnet-5"], imageModels: [] })
      .mockRejectedValueOnce(new Error('Provider "anthropic" answered 401.'));
    wire();
    await setOn(0);
    expect(line().classList.contains("inline-success")).toBe(true);
    byId("providers-form-refresh").click();
    await vi.waitFor(() => expect(line().textContent).toBe('Provider "anthropic" answered 401.'));
    expect(line().classList.contains("inline-error")).toBe(true);
    expect(line().classList.contains("inline-success")).toBe(false);
  });
});

// A ChatGPT plan signs in where every other provider takes a key.
describe("Settings → AI Models' ChatGPT plan", () => {
  function listChatGpt(signIn: ProviderSignInStatus, signInAllowed = true): void {
    vi.mocked(fetchProviders).mockResolvedValue({
      providers: [
        row({ id: "chatgpt", label: "ChatGPT plan", kind: "chatgpt", vendor: "chatgpt", keySource: "none", signIn }),
      ],
      store: { kind: "plain-files", encrypted: false, available: true },
      signInAllowed,
    });
  }
  const text = (id: string) => byId(id).textContent ?? "";

  it("puts Continue with ChatGPT where the key would be, and signs in in the browser", async () => {
    const menu = fakeContextMenu();
    wire({ contextMenu: menu });
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    byId("providers-add").click();
    byId("providers-form-preset").click();
    menu.pick("ChatGPT plan");

    expect(byId("providers-form-key-row").hidden).toBe(true);
    expect(byId("providers-form-sign-in-row").hidden).toBe(false);
    expect(text("providers-form-account")).toBe("Not signed in");

    vi.mocked(fetchProviderSignInStatus).mockResolvedValue({
      state: "signed-in",
      email: "writer@example.com",
      planUsage: true,
    });
    vi.mocked(postDiscoverProviderModels).mockResolvedValue({
      textModels: ["gpt-6.1-sol", "gpt-6-mini"],
      imageModels: [],
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    byId("providers-form-continue").click();

    await vi.waitFor(() => expect(postProviderSignIn).toHaveBeenCalledWith("chatgpt", { planUsage: false }));
    expect(postSaveProvider).toHaveBeenCalledWith({ id: "chatgpt", kind: "chatgpt", label: "ChatGPT plan" });
    expect(open).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/authorize?state=s", "_blank", "noopener");
    expect(text("providers-form-sign-in-status")).toContain("Finish signing in in your browser.");

    await vi.waitFor(() => expect(text("providers-form-account")).toBe("writer@example.com"), { timeout: 4000 });
    expect(text("providers-form-sign-in-status")).toContain("You're using your ChatGPT plan");
    expect(byId("providers-form-sign-in-status").querySelector("a")?.href).toBe("https://chatgpt.com/settings/usage");
    await vi.waitFor(() =>
      expect(postSaveProviderModels).toHaveBeenCalledWith("chatgpt", { textModels: ["gpt-6.1-sol", "gpt-6-mini"] }),
    );
    // A plan covers text only.
    expect(byId("providers-form-image-models").hidden).toBe(true);
    open.mockRestore();
  });

  it("shows the signed-in account, and says when ChatGPT didn't confirm a sign-out", async () => {
    listChatGpt({ state: "signed-in", email: "writer@example.com", planUsage: true });
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    rows()[0].click();

    expect(text("providers-form-account")).toBe("writer@example.com");
    expect(byId("providers-form-continue").hidden).toBe(true);
    expect(byId("providers-form-sign-out").hidden).toBe(false);
    expect(text("providers-form-sign-in-status")).toContain("Manage usage");

    vi.mocked(postProviderSignOut).mockResolvedValue({ revoked: false });
    byId("providers-form-sign-out").click();
    await vi.waitFor(() => expect(text("providers-form-account")).toBe("Not signed in"));
    expect(text("providers-form-sign-in-status")).toContain("didn't confirm");
  });

  it("asks for plan use again when the person signed in without it", async () => {
    listChatGpt({ state: "signed-in", email: "writer@example.com", planUsage: false });
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    rows()[0].click();

    expect(text("providers-form-sign-in-status")).toContain("isn't allowed to use your ChatGPT plan");
    vi.spyOn(window, "open").mockReturnValue(null);
    byId("providers-form-allow-plan").click();
    await vi.waitFor(() => expect(postProviderSignIn).toHaveBeenCalledWith("chatgpt", { planUsage: true }));
  });

  it("offers no sign-in on a host whose browser can't reach the sign-in's return", async () => {
    listChatGpt({ state: "signed-out" }, false);
    wire();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    rows()[0].click();

    expect(byId<HTMLButtonElement>("providers-form-continue").disabled).toBe(true);
  });
});
