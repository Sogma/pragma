// Handing a space file to the system's default app, which the desktop app
// offers for a file Pragma can't open. The system runs a program rather than
// showing it, so a file that could be one never goes: a risky type below, a
// type the platform's PATHEXT runs, a file set to run as a program, or one
// whose first bytes are a program's. A space nobody trusted hands over none.
//
// The type is read as the system reads it: the last extension, in any case,
// after the trailing dots and spaces Windows ignores. Linux picks the app by
// a file's contents when its name gives no type, so a file with no extension
// never goes there.
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import { isLibraryRoot } from "../protocol/rootedPath.ts";
import { noFileAt } from "../protocol/types.ts";
import { PathAccessError, resolveRootedPath } from "./rootedFiles.ts";

// Every type Chromium's download protection treats as dangerous on Windows,
// macOS or Linux (download_file_types.asciipb, version 69), and Outlook's
// blocked attachments, then what neither lists: macro-enabled Office
// formats, script runners, app and extension installers, certificates and
// remote desktop files. A type is never taken off to let one file open.
const RISKY_EXTENSIONS: ReadonlySet<string> = new Set(
  `
  a3x accda accdb accde accdr action ad ade adp ahk apk app appcontent-ms appimage appinstaller
  applescript application appref-ms appx appxbundle as asp aspx asx atloc au3 bas bash bat bgi cab
  caction cdr cdxml cer cfg chi chm class cmd cnt com command configprofile cpgz cpi cpl crt crx csh dart
  dc42 deb definition der desktop diagcab diagcfg diagpkg diskcopy42 dll dmg dmgpart docm dotm drv dvdr
  dylib efi elf eml exe fileloc fish flatpakref flatpakrepo fon ftploc fxp gadget grp hlp hpj hta htc htt
  img imgpart inetloc inf ini ins internetconnect inx iqy iso isp isu its jar jnlp job js jse ksh
  library-ms lnk local mad maf mag mam manifest maq mar mas mat mau mav maw mcf mda mdb mde mdt mdw mdz
  mht mhtml mmc mobileconfig mof mpkg msc msg msh msh1 msh1xml msh2 msh2xml mshxml msi msix msixbundle
  msp mst msu ndif networkconnect ocx ops osas osax osd out oxt p12 p7b p7c paf partial pax pcd pet pfx
  pif pkg pl plg potm ppa ppam ppsm pptm prf prg printerexport ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 psdm1
  psm1 pssc pst pup py pyc pyd pyo pyw pyz pyzw rb rdp reg rels rgs rpm run scf scpt scptd scr sct
  search-ms searchconnector-ms seplugin service settingcontent-ms sh shar shb shs sldm slk slp smi snap
  sparsebundle sparseimage spl swf sys tcsh terminal theme tmp toast tool u3p udif udl url vb vbe vbp vbs
  vbscript vdx vhd vhdx vsd vsdm vsdx vsix vsmacros vss vssm vssx vst vstm vstx vsw vsx vtx webloc webpnp
  website wflow wll workflow ws wsb wsc wsf wsh xbap xip xla xlam xll xlm xlsb xlsm xltm xml xnk xpi
  xrm-ms xsd xsl zsh
  `
    .split(/\s+/)
    .filter(Boolean),
);

/** The extension the system picks an app by, lower-cased without its dot:
 * "" for a name with none. */
export function systemExtension(name: string): string {
  const trimmed = name.replace(/[. ]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  return dot <= 0 ? "" : trimmed.slice(dot + 1).toLowerCase();
}

/** What the host says about itself for the checks below. */
export interface DefaultAppHost {
  /** Whether the open space is trusted, which git asks too. */
  trusted: boolean;
  /** `process.platform`: Windows keeps no execute bits, so it is the one
   * platform where a file's mode says nothing. */
  platform: NodeJS.Platform;
  /** The platform's PATHEXT, the types Windows runs as programs. */
  pathExt?: string;
}

/** Why a file named `name` never goes to the default app, or undefined. */
export function riskyTypeRefusal(name: string, pathExt = ""): string | undefined {
  const extension = systemExtension(name);
  if (!extension) return undefined;
  const runs = pathExt.split(";").map((entry) => entry.trim().replace(/^\./, "").toLowerCase());
  return RISKY_EXTENSIONS.has(extension) || runs.includes(extension)
    ? `Blocked: .${extension} files can run code`
    : undefined;
}

export type SystemTarget = { file: string; stats: Stats } | { refusal: string };

/** The space entry at `input`, a space path, for the system's own file
 * manager: never a library's, a hidden one, or one that isn't there. */
export async function systemTarget(spaceRoot: string, input: string): Promise<SystemTarget> {
  try {
    const resolved = resolveRootedPath(spaceRoot, input, "read");
    if (isLibraryRoot(resolved.rooted.root) || isHiddenPath(resolved.rooted.path)) return { refusal: noFileAt(input) };
    const stats = await lstat(resolved.filePath).catch(() => undefined);
    return stats ? { file: resolved.filePath, stats } : { refusal: noFileAt(input) };
  } catch (error) {
    return { refusal: error instanceof PathAccessError ? error.message : noFileAt(input) };
  }
}

// The first bytes of a program, which a system choosing an app by contents
// runs whatever the file is called: Windows and DOS, Linux and AppImage,
// macOS (single and universal), a script, and a Windows shortcut. A desktop
// launcher is text, so it is matched by its first section instead.
const PROGRAM_HEADS: readonly (readonly number[])[] = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xca, 0xfe, 0xba, 0xbf],
  [0x23, 0x21],
  [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00],
];
const DESKTOP_ENTRY = /^\s*(?:#[^\n]*\n\s*)*\[Desktop Entry\]/;

/** Whether `head`, the first bytes of a file, are a program's. */
export function isProgramHead(head: Uint8Array): boolean {
  if (PROGRAM_HEADS.some((magic) => magic.every((byte, index) => head[index] === byte))) return true;
  return DESKTOP_ENTRY.test(Buffer.from(head).toString("latin1"));
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const head = new Uint8Array(1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The file at `input` if it may go to the default app, or why not, worded
 * for the menu that offers it. Asked again right before each open, since
 * the file can change while the menu is up. */
export async function defaultAppTarget(spaceRoot: string, input: string, host: DefaultAppHost): Promise<SystemTarget> {
  const target = await systemTarget(spaceRoot, input);
  if ("refusal" in target) return target;
  if (!target.stats.isFile()) return { refusal: noFileAt(input) };
  const risky = riskyTypeRefusal(path.basename(target.file), host.pathExt);
  if (risky) return { refusal: risky };
  if (host.platform !== "win32" && (target.stats.mode & 0o111) !== 0) {
    return { refusal: "Blocked: this file is set to run as a program" };
  }
  if (host.platform === "linux" && !systemExtension(path.basename(target.file))) {
    return { refusal: "Blocked: on Linux, a file without an extension can run code" };
  }
  if (isProgramHead(await readHead(target.file))) return { refusal: "Blocked: this file holds a program" };
  if (!host.trusted) return { refusal: "Only in a trusted space" };
  return target;
}
