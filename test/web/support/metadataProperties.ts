import { vi } from "vitest";
import type { DialogService } from "../../../web/services/dialog.ts";
import { createMetadataProperties } from "../../../web/view/metadataProperties.ts";
import { createPropertyEditor } from "../../../web/view/propertyEditor.ts";

// The real Properties section a pane builds, over a menu that draws nothing,
// a dialog that asks nothing and an empty tag vocabulary.
export function testMetadataProperties() {
  return () =>
    createMetadataProperties({
      createPropertyEditor,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      tags: { known: () => [], read: async () => [] },
      dialog: { prompt: vi.fn(async () => null) } as unknown as DialogService,
    });
}
