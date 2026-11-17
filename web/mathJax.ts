// MathJax 4, set up so math written in other Markdown note apps looks the
// same here: TeX in, HTML out in the TeX font, the usual packages on, and
// `physics` and `colorv2` on only once a formula asks with `\usepackage` or
// `\require`. A package asked for stays on for the session.
//
// Nothing here loads anything: every package and the font are bundled, and
// web/styles/math.css declares the font's faces from the package's files, so
// MathJax is kept from writing @font-face rules that would name a CDN.
import { MathJaxMhchemFontExtension } from "@mathjax/mathjax-mhchem-font-extension/js/chtml.js";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/chtml.js";
import { browserAdaptor } from "@mathjax/src/js/adaptors/browserAdaptor.js";
import type { Property } from "@mathjax/src/js/core/Tree/Node.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { Configuration, type ParserConfiguration } from "@mathjax/src/js/input/tex/Configuration.js";
import { ConfigurationType, HandlerType } from "@mathjax/src/js/input/tex/HandlerTypes.js";
import TexError from "@mathjax/src/js/input/tex/TexError.js";
import { CommandMap } from "@mathjax/src/js/input/tex/TokenMap.js";
import type { ParseMethod } from "@mathjax/src/js/input/tex/Types.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { CHTML } from "@mathjax/src/js/output/chtml.js";
import { SafeHandler, type SafeMathDocument } from "@mathjax/src/js/ui/safe/SafeHandler.js";
import type { FilterFunction } from "@mathjax/src/js/ui/safe/safe.js";
import "@mathjax/src/js/input/tex/action/ActionConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/bbox/BboxConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/bussproofs/BussproofsConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/colortbl/ColortblConfiguration.js";
import "@mathjax/src/js/input/tex/colorv2/ColorV2Configuration.js";
import "@mathjax/src/js/input/tex/empheq/EmpheqConfiguration.js";
import "@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js";
import "@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js";
import "@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js";
import "@mathjax/src/js/input/tex/html/HtmlConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/noerrors/NoErrorsConfiguration.js";
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js";
import "@mathjax/src/js/input/tex/tagformat/TagFormatConfiguration.js";
import "@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import "@mathjax/src/js/input/tex/unicode/UnicodeConfiguration.js";
import "@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js";
import "@mathjax/src/js/input/tex/verb/VerbConfiguration.js";

const PACKAGES = [
  "base",
  "ams",
  "newcommand",
  "noundefined",
  "textmacros",
  "action",
  "amscd",
  "bbox",
  "boldsymbol",
  "braket",
  "bussproofs",
  "cancel",
  "cases",
  "centernot",
  "color",
  "colortbl",
  "empheq",
  "enclose",
  "extpfeil",
  "gensymb",
  "html",
  "mathtools",
  "mhchem",
  "noerrors",
  "tagformat",
  "textcomp",
  "unicode",
  "upgreek",
  "verb",
];

// Off until asked for: physics redefines `\div`, `\Re` and `\Im`, and colorv2
// takes `\color`'s old meaning.
const ON_REQUEST = new Set(["physics", "colorv2"]);

// Links in math leave the app, as a page's web links do; any other address
// is dropped, so a relative one can't navigate the window. MathJax drops an
// attribute its filter returns null for, though the type names a value.
const WEB_URL = /^(https?:|mailto:)/i;
const keepWebURL = ((_safe: unknown, url: Property) =>
  WEB_URL.test(String(url).trim()) ? url : null) as FilterFunction<HTMLElement, Text, Document>;

class BundledTexFont extends MathJaxTexFont {
  static addFontURLs(): void {}
}
BundledTexFont.addExtension(MathJaxMhchemFontExtension);

const on = new Set(PACKAGES);
let generation = 0;
let jax: TeX<HTMLElement, Text, Document> | undefined;

// `\usepackage[options]{a,b}`, `\RequirePackage` and `\require`: a package on
// already is no change, an unknown one is an error, as LaTeX's would be.
const usePackage: ParseMethod = (parser, name) => {
  const command = String(name);
  if (command !== "\\require") parser.GetBrackets(command);
  for (const id of parser
    .GetArgument(command)
    .split(",")
    .map((part) => part.trim())) {
    if (!id || on.has(id)) continue;
    if (!ON_REQUEST.has(id) || !jax) throw new TexError("UnknownPackage", "Unknown package %1", id);
    // The jax keeps its configuration protected; MathJax's own `\require`
    // reaches it the same way.
    (jax as unknown as { configuration: ParserConfiguration }).configuration.add(id, jax);
    on.add(id);
    generation++;
  }
};

new CommandMap("pragma-packages", { require: usePackage, usepackage: usePackage, RequirePackage: usePackage });
Configuration.create("pragma-packages", { [ConfigurationType.HANDLER]: { [HandlerType.MACRO]: ["pragma-packages"] } });

export interface MathEngine {
  /** Counts the packages turned on since the start, since math typeset
   * before one may read differently after it. */
  readonly generation: number;
  /** `tex` typeset, a TeX error shown in place by the noerrors package. */
  render(tex: string, display: boolean): HTMLElement;
  /** Brings MathJax's stylesheet up to date with what it has typeset, adding
   * it to the page the first time. */
  updateStyles(): void;
}

let engine: MathEngine | undefined;

export function mathEngine(): MathEngine {
  engine ??= createEngine();
  return engine;
}

function createEngine(): MathEngine {
  SafeHandler(RegisterHTMLHandler(browserAdaptor()));
  const tex = new TeX<HTMLElement, Text, Document>({ packages: [...PACKAGES, "pragma-packages"] });
  jax = tex;
  const chtml = new CHTML<HTMLElement, Text, Document>({ fontData: BundledTexFont, displayOverflow: "scroll" });
  const html = mathjax.document(document, { InputJax: tex, OutputJax: chtml }) as SafeMathDocument<
    HTMLElement,
    Text,
    Document
  >;
  html.safe.filterMethods.filterURL = keepWebURL;
  let sheet: HTMLStyleElement | undefined;

  return {
    get generation() {
      return generation;
    },
    render(source, display) {
      const node = html.convert(source, { display }) as HTMLElement;
      for (const link of node.querySelectorAll("a[href]")) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
      // An error's message, or a `\texttip`, shows as the app's own hover
      // hint (web/lib/tooltip.ts), never the browser's on top of it.
      for (const hinted of node.querySelectorAll<HTMLElement>("[title]")) {
        hinted.dataset.tooltip = hinted.getAttribute("title") ?? "";
        hinted.removeAttribute("title");
      }
      return node;
    },
    updateStyles() {
      if (sheet) {
        chtml.styleSheet(html);
        return;
      }
      sheet = chtml.styleSheet(html) as HTMLStyleElement;
      document.head.append(sheet);
    },
  };
}
