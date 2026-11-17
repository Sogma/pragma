// The e2e fixture's port. Its own rather than EDITOR_PORT, so the suite can
// run beside a `pragma dev` or `pragma start`, and well clear of Vite's
// fallback-to-next-free-port ladder (5174, 5175, ...), where a second dev
// server on the machine lands.
//
// Fixed rather than probed, so a fixture leaked by a crashed run still fails
// loudly under strictPort instead of being silently sidestepped.
// playwright.config.ts and globalSetup.ts both read it from here so the two
// can't drift apart.
export const E2E_PORT = 15173;
