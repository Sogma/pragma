// The desktop app's About window (electron/aboutWindow.ts). It carries no
// bridge, so the version comes in the page's address.
import { must } from "./lib/dom.ts";

// about.html set the first paint's theme; this keeps it with the OS.
const systemDark = matchMedia("(prefers-color-scheme: dark)");
systemDark.addEventListener("change", () => {
  document.documentElement.setAttribute("data-theme", systemDark.matches ? "dark" : "light");
});

const version = new URLSearchParams(location.search).get("version");
if (version) {
  const line = must<HTMLElement>(".about-version");
  line.textContent = `version ${version}`;
  line.hidden = false;
}
