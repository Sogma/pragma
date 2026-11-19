// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadEntryResponse } from "../../../web/core/apiClient.ts";
import type { DialogHandle, DialogOptions, DialogService } from "../../../web/services/dialog.ts";
import {
  type DroppedImportDeps,
  describeImportProblems,
  importDroppedFiles,
} from "../../../web/services/mediaImport.ts";

function file(name: string, size = 16, text = "# note\n"): File {
  return name.endsWith(".md") ? new File([text], name) : new File([new Uint8Array(size)], name);
}

// A dialog that mounts what it is given, so the progress line is readable,
// and takes it down again on close the way the real one does.
function fakeDialog() {
  const closes: number[] = [];
  let opened: DialogOptions | undefined;
  const dialog = {
    open: vi.fn((options: DialogOptions): DialogHandle => {
      opened = options;
      document.body.append(options.content);
      return {
        panel: options.content,
        close: () => {
          closes.push(1);
          options.content.remove();
        },
        closed: new Promise(() => undefined),
      };
    }),
  } as unknown as DialogService;
  return { dialog, closes, options: () => opened };
}

beforeEach(() => {
  document.body.replaceChildren();
});

function deps(overrides: Partial<DroppedImportDeps> = {}) {
  const { dialog, closes, options } = fakeDialog();
  return {
    dialog,
    closes,
    options,
    createEntry: vi.fn(async (dir: string, name: string) => ({ path: `${dir}/${name}`, type: "file" as const })),
    upload: vi.fn(
      async (dir: string, name: string, _file: Blob, o: { onProgress?: (a: number, b: number) => void }) => {
        o.onProgress?.(512, 1024);
        o.onProgress?.(1024, 1024);
        return { path: `${dir}/${name}`, name };
      },
    ),
    ...overrides,
  };
}

describe("importDroppedFiles", () => {
  it("routes notes to create, media and LUTs to upload, and refuses the rest by name", async () => {
    const d = deps();
    const result = await importDroppedFiles(
      [file("a.md"), file("take.mp4"), file("still.png"), file("paper.pdf"), file("Print.CUBE"), file("x.zip")],
      "lib:one/batch",
      d,
    );

    expect(d.createEntry).toHaveBeenCalledWith("lib:one/batch", "a.md", "file", "# note\n");
    expect(vi.mocked(d.upload).mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["lib:one/batch", "take.mp4"],
      ["lib:one/batch", "still.png"],
      ["lib:one/batch", "paper.pdf"],
      ["lib:one/batch", "Print.CUBE"],
    ]);
    expect(result).toEqual({
      imported: [
        "lib:one/batch/a.md",
        "lib:one/batch/take.mp4",
        "lib:one/batch/still.png",
        "lib:one/batch/paper.pdf",
        "lib:one/batch/Print.CUBE",
      ],
      refused: ["x.zip"],
      failed: [],
      cancelled: false,
    });
  });

  // A note alone needs no progress surface; a take does, and the dialog
  // closes itself once the batch has settled either way.
  it("opens the progress dialog only when there is media, and closes it after", async () => {
    const notesOnly = deps();
    await importDroppedFiles([file("a.md")], "", notesOnly);
    expect(notesOnly.dialog.open).not.toHaveBeenCalled();

    const withMedia = deps();
    await importDroppedFiles([file("take.mp4"), file("take2.mp4")], "", withMedia);
    expect(withMedia.dialog.open).toHaveBeenCalledTimes(1);
    expect(withMedia.closes).toHaveLength(1);
    // Backdrop clicks must not detach the person from an upload in flight.
    expect(withMedia.options()?.closeOnBackdrop).toBe(false);
  });

  it("reports which file is copying, and how far along it is", async () => {
    let seen: string[] = [];
    const d = deps({
      upload: vi.fn(async (dir: string, name: string, _f: Blob, o) => {
        o.onProgress?.(256, 1024);
        if (name === "take.mp4") {
          seen = [
            document.querySelector(".dialog-message")?.textContent ?? "",
            document.querySelector(".dialog-field-description")?.textContent ?? "",
            String((document.querySelector("progress") as HTMLProgressElement).value),
          ];
        }
        return { path: `${dir}/${name}`, name };
      }),
    });
    await importDroppedFiles([file("take.mp4", 1024), file("b.mp4")], "", d);
    expect(seen).toEqual(["Copying take.mp4 (1 of 2)", "256 B of 1.0 KB", "0.25"]);
  });

  it("keeps a failed upload's reason and carries on with the rest", async () => {
    const d = deps({
      upload: vi.fn(async (dir: string, name: string) => {
        if (name === "bad.mp4") throw new Error("No such folder");
        return { path: `${dir}/${name}`, name };
      }),
    });
    const result = await importDroppedFiles([file("bad.mp4"), file("good.mp4")], "", d);
    expect(result.failed).toEqual([{ name: "bad.mp4", reason: "No such folder" }]);
    expect(result.imported).toEqual(["/good.mp4"]);
  });

  // Cancel aborts the upload in flight and skips what had not started —
  // reported as cancelled, not as a string of failures.
  it("cancel aborts the current upload and skips the rest", async () => {
    let aborted = false;
    const d = deps({
      upload: vi.fn(
        (dir: string, name: string, _f: Blob, o: { signal?: AbortSignal }) =>
          new Promise<UploadEntryResponse>((resolve, reject) => {
            o.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("Upload cancelled", "AbortError"));
            });
            // The first upload never finishes on its own; the click below ends it.
            if (name !== "first.mp4") resolve({ path: `${dir}/${name}`, name });
          }),
      ),
    });
    const running = importDroppedFiles([file("first.mp4"), file("second.mp4")], "", d);
    await vi.waitFor(() => expect(document.querySelector(".dialog-actions button")).not.toBeNull());
    (document.querySelector(".dialog-actions button") as HTMLButtonElement).click();
    const result = await running;

    expect(aborted).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(d.upload).toHaveBeenCalledTimes(1);
  });
});

describe("describeImportProblems", () => {
  it("says nothing when everything landed", () => {
    expect(describeImportProblems({ imported: ["a"], refused: [], failed: [], cancelled: false })).toBeUndefined();
  });

  it("names every refusal, failure and a cancellation in one message", () => {
    const message = describeImportProblems({
      imported: [],
      refused: ["x.zip"],
      failed: [{ name: "bad.mp4", reason: "No such folder" }],
      cancelled: true,
    });
    expect(message).toContain("x.zip: not a note, image, video, PDF or LUT.");
    expect(message).toContain("bad.mp4: No such folder");
    expect(message).toContain("cancelled");
  });
});
