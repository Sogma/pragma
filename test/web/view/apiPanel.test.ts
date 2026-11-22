// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchApiSettings, postApiSettings } from "../../../web/core/apiClient.ts";
import type { DialogService } from "../../../web/services/dialog.ts";
import { wireApiPanel } from "../../../web/view/apiPanel.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchApiSettings: vi.fn(),
  postApiSettings: vi.fn(),
}));

// Settings → API as web/index.html has it, trimmed to what the panel reads.
beforeEach(() => {
  vi.mocked(fetchApiSettings).mockReset().mockResolvedValue({ enabled: false, port: 14320, tokens: [] });
  vi.mocked(postApiSettings).mockReset();
  document.body.innerHTML = `
    <button id="api-enabled" type="button" role="switch" aria-checked="false"></button>
    <input id="api-port" />
    <p id="api-restart-note" hidden></p>
    <div id="api-token-list"></div>
    <button id="api-add-token" type="button"></button>
    <p id="api-error" hidden></p>
    <section data-settings-subpage="api-token">
      <form id="api-token-form">
        <input id="api-token-name" />
        <button id="api-token-read-only" type="button" role="switch" aria-checked="true"></button>
        <button id="api-token-create" type="submit"></button>
        <p id="api-token-error" hidden></p>
      </form>
    </section>`;
});

describe("the API panel", () => {
  // The read back that puts the switch back clears the line, so a failure
  // shown before it would vanish at once.
  it("keeps a failed save's message after reading the settings back", async () => {
    vi.mocked(postApiSettings).mockRejectedValue(new Error("Port 80 needs privileges."));
    const refresh = wireApiPanel(document.body, {
      dialog: {} as DialogService,
      openSettingsSubpage: vi.fn(),
      closeSettingsSubpage: vi.fn(),
    });
    refresh();
    await vi.waitFor(() => expect(fetchApiSettings).toHaveBeenCalledTimes(1));

    document.querySelector<HTMLButtonElement>("#api-enabled")?.click();
    const line = document.querySelector<HTMLElement>("#api-error");
    await vi.waitFor(() => expect(line?.hidden).toBe(false));
    expect(fetchApiSettings).toHaveBeenCalledTimes(2);
    expect(line?.textContent).toBe("Port 80 needs privileges.");
    expect(document.querySelector("#api-enabled")?.getAttribute("aria-checked")).toBe("false");
  });
});
