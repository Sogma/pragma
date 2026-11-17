import { vi } from "vitest";
import { createMetadataProperties } from "../../../web/view/metadataProperties.ts";
import { createPropertyEditor } from "../../../web/view/propertyEditor.ts";

// The real Properties section a pane builds, over a menu that draws nothing
// and an empty tag vocabulary.
export function testMetadataProperties() {
  return () =>
    createMetadataProperties({
      createPropertyEditor,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      tags: { known: () => [], read: async () => [] },
    });
}
