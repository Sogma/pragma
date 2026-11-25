// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GuidesChoice, NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import type { LutChoice } from "../../../web/lib/videoLut.ts";
import {
  createVideoPlayer,
  type FrameGrab,
  type LoopChoice,
  type PlayerLayout,
  timecode,
  type VolumeChoice,
} from "../../../web/lib/videoPlayer.ts";
import { memoryLook, memorySetting } from "../support/editorLayout.ts";

// jsdom ships no media pipeline, so the clip is stood in for: its length,
// where it stands, and whether it plays, each as the element reports them.
function clip(duration = 64) {
  const video = document.createElement("video");
  let at = 0;
  let paused = true;
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  Object.defineProperty(video, "currentTime", {
    get: () => at,
    set: (value: number) => {
      at = value;
    },
    configurable: true,
  });
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  video.play = vi.fn(async () => {
    paused = false;
    video.dispatchEvent(new Event("play"));
  });
  video.pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event("pause"));
  });
  return video;
}

const players: { dispose(): void }[] = [];
afterEach(() => {
  for (const player of players.splice(0)) player.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup(
  layout: PlayerLayout,
  options: {
    loop?: LoopChoice;
    volume?: VolumeChoice;
    guides?: GuidesChoice;
    lut?: LutChoice;
    rangeKey?: string;
    pictureClick?: () => void;
    moreOptions?: (anchor: HTMLElement, frame?: () => FrameGrab) => void;
  } = {},
) {
  const video = clip();
  const loop = options.loop ?? memorySetting(false);
  const volume = options.volume ?? memorySetting({ level: 1, muted: false });
  // `guides` or `lut` given outright as undefined is a player with none.
  const guides = Object.hasOwn(options, "guides") ? options.guides : memorySetting(NO_GUIDES);
  const lut = Object.hasOwn(options, "lut") ? options.lut : memoryLook();
  const frame = document.createElement("div");
  frame.append(video);
  document.body.append(frame);
  const { rangeKey, pictureClick, moreOptions = vi.fn() } = options;
  const player = createVideoPlayer(video, { layout, loop, volume, guides, lut, rangeKey, pictureClick, moreOptions });
  players.push(player);
  frame.append(player.element);
  const button = (name: string) => player.element.querySelector(`.video-player-${name}`) as HTMLButtonElement;
  const text = (selector: string) => player.element.querySelector(selector)?.textContent;
  return { video, loop, guides, player, button, text };
}

// The volume slider and a press on it, over a track 80px tall from y 100.
function volumeSlider(player: { element: HTMLElement }) {
  const slider = player.element.querySelector(".video-player-volume-slider") as HTMLElement;
  const track = player.element.querySelector(".video-player-volume-track") as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, width: 3, top: 100, height: 80 }) as DOMRect;
  const pointer = (type: string, y: number) =>
    slider.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y }));
  return { slider, pointer };
}

const volumeOpen = (player: { element: HTMLElement }) => player.element.classList.contains("is-volume-open");

const shown = (element: Element) => !(element as HTMLElement).hidden;

describe("timecode", () => {
  it("counts hours, minutes, seconds and frames", () => {
    expect(timecode(64.5, 24)).toBe("00:01:04:12");
    expect(timecode(3600 + 2 / 25, 25)).toBe("01:00:00:02");
  });

  // Non-drop: 23.976 counts 24 frames to its second, as an editor's does.
  it("counts a fractional rate's nominal frames", () => {
    expect(timecode(24 / 23.976, 23.976)).toBe("00:00:01:00");
  });
});

describe("createVideoPlayer", () => {
  it("lays the pill out in one row, out of the tab order", () => {
    const { player } = setup("pill");
    const bar = player.element.querySelector(".video-player-bar") as HTMLElement;
    expect(player.element.classList.contains("is-pill")).toBe(true);
    expect([...bar.children].map((child) => child.className)).toEqual([
      "icon-button video-player-play",
      "video-player-time",
      "video-player-seek",
      "video-player-time is-total",
      "icon-button video-player-loop",
      "video-player-volume",
      "icon-button video-player-full-screen",
      "icon-button video-player-more",
    ]);
    for (const button of bar.querySelectorAll("button")) expect(button.tabIndex).toBe(-1);
    expect(player.element.querySelector(".video-player-speed")).toBeNull();
    expect(player.element.textContent).toContain("0:00");
    expect(player.element.textContent).toContain("1:04");
  });

  it("lays the review layout out with the counters beside the bar and the keys in the hints", () => {
    const { player, button } = setup("review");
    const counters = player.element.querySelector(".video-player-counters") as HTMLElement;
    expect([...counters.children].map((child) => child.className)).toEqual([
      "video-player-time",
      "video-player-seek",
      "video-player-time is-total",
    ]);
    const labels = (selector: string) =>
      [...(player.element.querySelector(selector) as HTMLElement).children].map(
        (child) => child.getAttribute("aria-label") ?? child.className,
      );
    // How it plays on the left, the transport between, its sound, screen and
    // menu on the right.
    expect(labels(".video-player-start")).toEqual(["Loop", "In & Out", "Playback speed 1×"]);
    expect(labels(".video-player-transport")).toEqual([
      "Set In point",
      "Previous frame",
      "Play",
      "Next frame",
      "Set Out point",
    ]);
    expect(labels(".video-player-end")).toEqual(["video-player-volume", "Full screen", "More options"]);
    expect(button("play").dataset.tooltip).toBe("Play (Space)");
    expect(button("mark.is-in").dataset.tooltip).toBe("Set In point (I)");
    expect(button("step.is-next").dataset.tooltip).toBe("Next frame (→)");
    // Its hint is its label.
    expect(button("range-toggle").getAttribute("aria-label")).toBe("In & Out");
    // Nothing to turn on until a mark is set.
    button("range-toggle").click();
    expect(button("range-toggle").getAttribute("aria-disabled")).toBe("true");
    expect(button("range-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("plays and pauses from its button and from the picture", () => {
    const { video, player, button } = setup("pill");
    button("play").click();
    expect(video.play).toHaveBeenCalled();
    expect(button("play").getAttribute("aria-label")).toBe("Pause");
    expect(player.element.classList.contains("is-playing")).toBe(true);

    video.click();
    expect(video.pause).toHaveBeenCalled();
    expect(button("play").getAttribute("aria-label")).toBe("Play");
    expect(player.element.classList.contains("is-playing")).toBe(false);
  });

  // A Flow result's picture opens the file's preview; its buttons still play.
  it("hands a click on the picture to its caller, and fills the screen only from its button", () => {
    const pictureClick = vi.fn();
    const { video, button } = setup("pill", { pictureClick });
    const frame = video.parentElement as HTMLElement;
    frame.requestFullscreen = vi.fn(async () => undefined);

    video.click();
    video.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(pictureClick).toHaveBeenCalledTimes(1);
    expect(video.play).not.toHaveBeenCalled();
    expect(frame.requestFullscreen).not.toHaveBeenCalled();

    button("play").click();
    expect(video.play).toHaveBeenCalled();
    button("full-screen").click();
    expect(frame.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  // One choice for every player: on in the preview, on in the tab.
  it("shares one Loop between players", () => {
    const loop = memorySetting(false);
    const first = setup("pill", { loop });
    const second = setup("review", { loop });
    expect(first.video.loop).toBe(false);

    first.button("loop").click();
    expect(loop.get()).toBe(true);
    expect(first.button("loop").getAttribute("aria-pressed")).toBe("true");
    expect(second.button("loop").getAttribute("aria-pressed")).toBe("true");
    expect(first.video.loop).toBe(true);
    expect(second.video.loop).toBe(true);
  });

  it("seeks to the pointer, and follows it while the press lasts", () => {
    const { video, player, text } = setup("pill");
    const seek = player.element.querySelector(".video-player-seek") as HTMLElement;
    seek.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 32 }) as DOMRect;
    const pointer = (type: string, x: number) =>
      seek.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x }));

    pointer("pointerdown", 150);
    expect(video.currentTime).toBe(16);
    expect(text(".video-player-time")).toBe("0:16");
    // Off the bar's end it holds at the clip's.
    pointer("pointermove", 400);
    expect(video.currentTime).toBe(64);
    pointer("pointerup", 400);
    pointer("pointermove", 200);
    expect(video.currentTime).toBe(64);
  });

  it("counts and steps in the clip's own frames once its rate is known", () => {
    const { video, player, text } = setup("review");
    player.setFrameRate(25);
    video.currentTime = 1;
    expect(player.key("ArrowRight")).toBe(true);
    expect(video.pause).toHaveBeenCalled();
    expect(text(".video-player-time")).toBe("00:00:01:01");
    player.key("ArrowLeft");
    player.key("ArrowLeft");
    expect(text(".video-player-time")).toBe("00:00:00:24");
  });

  it("sets In and Out where the clip stands, and turns them off and on", () => {
    const loop = memorySetting(true);
    const { video, player, button } = setup("review", { loop });
    const range = player.element.querySelector(".video-player-range") as HTMLElement;
    const seek = player.element.querySelector(".video-player-seek") as HTMLElement;
    expect(video.loop).toBe(true);

    video.currentTime = 16;
    player.key("i");
    video.currentTime = 48;
    player.key("O");
    expect(shown(range)).toBe(true);
    expect(seek.style.getPropertyValue("--range-start")).toBe("0.25");
    expect(seek.style.getPropertyValue("--range-end")).toBe("0.75");
    expect(button("loop").getAttribute("aria-label")).toBe("Loop In to Out");
    expect(button("range-toggle").getAttribute("aria-pressed")).toBe("true");
    // The range wraps by hand; the element's own loop would wrap the clip.
    expect(video.loop).toBe(false);

    // Off, the marks stay, dimmed, and Loop wraps the whole clip.
    button("range-toggle").click();
    expect(button("range-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(shown(range)).toBe(true);
    expect(range.classList.contains("is-off")).toBe(true);
    expect(button("loop").getAttribute("aria-label")).toBe("Loop");
    expect(video.loop).toBe(true);

    // A new mark puts them back in force.
    video.currentTime = 40;
    player.key("o");
    expect(button("range-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(range.classList.contains("is-off")).toBe(false);
    expect(video.loop).toBe(false);
  });

  // Without Loop, In & Out plays the range once: it stops on Out, and Play
  // from there starts it over from In.
  it("stops on Out without Loop, and plays the range again from In", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => frames.push(frame));
    const frame = () => frames.shift()?.(0);
    const { video, player, button } = setup("review");
    video.currentTime = 16;
    player.key("i");
    video.currentTime = 48;
    player.key("o");

    button("play").click();
    expect(video.currentTime).toBe(16);
    video.currentTime = 47.9;
    frame();
    expect(video.paused).toBe(false);
    video.currentTime = 48.05;
    frame();
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(48);

    // Off, playback runs past Out.
    button("range-toggle").click();
    video.currentTime = 40;
    button("play").click();
    expect(video.currentTime).toBe(40);
    frame();
    video.currentTime = 48.05;
    frame();
    expect(video.paused).toBe(false);
    vi.restoreAllMocks();
  });

  it("drops an In past a new Out, and an Out before a new In", () => {
    const { video, player } = setup("review");
    const seek = player.element.querySelector(".video-player-seek") as HTMLElement;
    video.currentTime = 32;
    player.key("i");
    video.currentTime = 16;
    player.key("o");
    expect(seek.style.getPropertyValue("--range-start")).toBe("0");
    expect(seek.style.getPropertyValue("--range-end")).toBe("0.25");

    video.currentTime = 48;
    player.key("i");
    expect(seek.style.getPropertyValue("--range-start")).toBe("0.75");
    expect(seek.style.getPropertyValue("--range-end")).toBe("1");
  });

  // Session only: a tab switched away from and back finds its range, and
  // nothing is written anywhere.
  it("keeps a clip's In and Out for the session, by its key", () => {
    const stored = localStorage.length;
    const first = setup("review", { rangeKey: "takes/a.mp4" });
    first.video.currentTime = 16;
    first.player.key("i");
    first.button("range-toggle").click();
    first.player.dispose();

    // Its marks, and whether they were in force.
    const again = setup("review", { rangeKey: "takes/a.mp4" });
    expect(again.button("range-toggle").getAttribute("aria-disabled")).toBe("false");
    expect(again.button("range-toggle").getAttribute("aria-pressed")).toBe("false");
    const other = setup("review", { rangeKey: "takes/b.mp4" });
    expect(other.button("range-toggle").getAttribute("aria-disabled")).toBe("true");
    expect(localStorage.length).toBe(stored);
  });

  it("takes keys only in the review layout", () => {
    const volume = memorySetting({ level: 0.5, muted: false });
    const { video, player } = setup("pill", { volume });
    expect(player.key(" ")).toBe(false);
    expect(player.key("i")).toBe(false);
    expect(player.key("m")).toBe(false);
    expect(player.key("ArrowUp")).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
    expect(volume.get()).toEqual({ level: 0.5, muted: false });

    const review = setup("review");
    expect(review.player.key(" ")).toBe(true);
    expect(review.video.play).toHaveBeenCalled();
    expect(review.player.key("x")).toBe(false);
  });

  it("cycles its speed and mutes", () => {
    const { video, button } = setup("review");
    button("speed").click();
    expect(video.playbackRate).toBe(1.5);
    expect(button("speed").textContent).toBe("1.5×");
    expect(button("speed").getAttribute("aria-label")).toBe("Playback speed 1.5×");
    button("mute").click();
    expect(video.muted).toBe(true);
    expect(button("mute").getAttribute("aria-label")).toBe("Unmute");
  });

  // One volume for every player, which each clip takes before it plays.
  it("shares one volume between players, and starts each clip at it", () => {
    const volume = memorySetting({ level: 0.4, muted: false });
    const first = setup("pill", { volume });
    const second = setup("review", { volume });
    expect(first.video.volume).toBe(0.4);
    expect(second.video.volume).toBe(0.4);
    expect(second.button("mute").dataset.tooltip).toBe("Mute (M)");

    first.button("mute").click();
    expect(volume.get()).toEqual({ level: 0.4, muted: true });
    expect(second.video.muted).toBe(true);
    expect(second.button("mute").getAttribute("aria-label")).toBe("Unmute");
    expect(second.button("mute").dataset.tooltip).toBe("Unmute (M)");
    // Muted, the slider keeps the level it comes back to.
    const { slider } = volumeSlider(second.player);
    expect(slider.classList.contains("is-muted")).toBe(true);
    expect(slider.style.getPropertyValue("--level")).toBe("0.4");
    expect(slider.getAttribute("aria-valuetext")).toBe("40%, muted");

    second.button("mute").click();
    expect(first.video.muted).toBe(false);
    expect(first.video.volume).toBe(0.4);
    expect(slider.getAttribute("aria-valuenow")).toBe("40");
  });

  it("sets the volume from its slider, unmuted, following the pointer while the press lasts", () => {
    const volume = memorySetting({ level: 1, muted: true });
    const { video, player } = setup("pill", { volume });
    const { pointer } = volumeSlider(player);

    pointer("pointerdown", 160);
    expect(volume.get()).toEqual({ level: 0.25, muted: false });
    expect(video.volume).toBe(0.25);
    expect(video.muted).toBe(false);
    expect(volumeOpen(player)).toBe(true);
    // Past the track's top it holds at full.
    pointer("pointermove", 20);
    expect(volume.get().level).toBe(1);
    pointer("pointerup", 20);
    expect(volumeOpen(player)).toBe(false);
    pointer("pointermove", 160);
    expect(volume.get().level).toBe(1);
  });

  // Unmuting at nothing would leave the clip silent.
  it("brings back the level a drag down to nothing began at", () => {
    const volume = memorySetting({ level: 0.6, muted: false });
    const { video, player, button } = setup("pill", { volume });
    const { pointer } = volumeSlider(player);
    pointer("pointerdown", 160);
    pointer("pointermove", 200);
    pointer("pointerup", 200);
    expect(volume.get()).toEqual({ level: 0, muted: false });
    expect(button("mute").classList.contains("is-muted")).toBe(true);
    expect(button("mute").getAttribute("aria-label")).toBe("Unmute");

    button("mute").click();
    expect(volume.get()).toEqual({ level: 0.6, muted: false });
    expect(video.volume).toBe(0.6);
    expect(button("mute").classList.contains("is-muted")).toBe(false);
  });

  it("draws none, one or two waves by the level, and the X while silent", () => {
    const volume = memorySetting({ level: 1, muted: false });
    const { button } = setup("pill", { volume });
    const glyphAt = (level: number, muted = false) => {
      volume.set({ level, muted });
      return button("mute").classList.contains("is-muted") ? "x" : button("mute").dataset.waves;
    };
    expect([0.05, 0.32, 0.33, 0.66, 0.67, 1].map((level) => glyphAt(level))).toEqual(["0", "0", "1", "1", "2", "2"]);
    expect(glyphAt(0)).toBe("x");
    expect(glyphAt(0.5, true)).toBe("x");
    expect(button("mute").dataset.waves).toBeUndefined();
  });

  it("steps the volume and mutes from the keys, showing the slider a moment", () => {
    vi.useFakeTimers();
    const volume = memorySetting({ level: 0.1, muted: false });
    const { player } = setup("review", { volume });
    expect(player.key("ArrowUp")).toBe(true);
    expect(volume.get().level).toBe(0.15);
    expect(volumeOpen(player)).toBe(true);
    for (let press = 0; press < 4; press++) player.key("ArrowDown");
    expect(volume.get().level).toBe(0);

    // At nothing, M brings back the last level the keys left sounding.
    expect(player.key("m")).toBe(true);
    expect(volume.get()).toEqual({ level: 0.05, muted: false });
    player.key("M");
    expect(volume.get()).toEqual({ level: 0.05, muted: true });
    // A step unmutes, as a drag does.
    player.key("ArrowUp");
    expect(volume.get()).toEqual({ level: 0.1, muted: false });

    vi.advanceTimersByTime(999);
    expect(volumeOpen(player)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(volumeOpen(player)).toBe(false);
  });

  // A pick from the menu hands focus back to its button; it goes on to the
  // surface that held it, whose keys the player takes.
  it("opens More options from its button, and passes on the focus a pick hands back", async () => {
    const moreOptions = vi.fn();
    const { button } = setup("pill", { moreOptions });
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    document.body.append(surface);
    surface.focus();

    button("more").click();
    // No frame is decoded yet, so none is offered.
    expect(moreOptions).toHaveBeenCalledWith(button("more"), undefined);
    // As the menu does when a row is picked.
    button("more").focus();
    expect(document.activeElement).toBe(surface);

    // Closed with no pick, nothing comes back: a later focus stays.
    button("more").click();
    button("more").setAttribute("aria-expanded", "true");
    button("more").setAttribute("aria-expanded", "false");
    await new Promise((resolve) => setTimeout(resolve, 0));
    button("more").focus();
    expect(document.activeElement).toBe(button("more"));
  });

  it("opens More options at a point, with the frame on screen, as a right-click on the clip does", () => {
    const moreOptions = vi.fn();
    const { player, button } = setup("review", { moreOptions });
    player.openMenuAt({ x: 30, y: 40 });
    expect(moreOptions).toHaveBeenCalledWith(button("more"), undefined, { x: 30, y: 40 });
  });

  // Save frame takes it as the item is picked, not as the menu opens, and
  // leaves the clip paused on the frame it saves.
  it("offers More options the frame on screen once one is decoded, taken at the clip's own size", () => {
    const moreOptions = vi.fn();
    const { video, button } = setup("review", { moreOptions });
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA, configurable: true },
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 360, configurable: true },
    });
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    void video.play();
    video.currentTime = 2.5;

    button("more").click();
    const take = moreOptions.mock.lastCall?.[1] as () => FrameGrab;
    expect(drawImage).not.toHaveBeenCalled();
    const frame = take();
    expect(video.paused).toBe(true);
    expect([frame.canvas.width, frame.canvas.height, frame.seconds]).toEqual([640, 360, 2.5]);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
    getContext.mockRestore();
  });

  it("stops following the shared Loop and volume once disposed", () => {
    const loop = memorySetting(false);
    const volume = memorySetting({ level: 1, muted: false });
    const { video, player } = setup("pill", { loop, volume });
    player.dispose();
    loop.set(true);
    volume.set({ level: 0.2, muted: true });
    expect(video.loop).toBe(false);
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
  });
});

describe("the guides", () => {
  // jsdom decodes nothing, so the clip's header is stood in for.
  function sized(video: HTMLVideoElement, width: number, height: number) {
    Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
    video.dispatchEvent(new Event("loadedmetadata"));
  }

  it("lie under the bar in the player's box, over the LUT's picture, drawn in the clip's pixels once its header names them", () => {
    const { video, player } = setup("review", { guides: memorySetting({ ...NO_GUIDES, title: true }) });
    const overlay = player.element.querySelector(".video-guides") as HTMLElement;
    const svg = overlay.querySelector("svg") as SVGSVGElement;
    expect(overlay.previousElementSibling?.classList.contains("video-lut")).toBe(true);
    expect(overlay.nextElementSibling?.classList.contains("video-player-bar")).toBe(true);
    expect(overlay.hasAttribute("hidden")).toBe(true);

    sized(video, 1920, 1080);
    expect(overlay.hasAttribute("hidden")).toBe(false);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1920 1080");
    sized(video, 1080, 1920);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1080 1920");
  });

  it("follow the shared choice, which G in the video tab hides and shows, keeping the picks", () => {
    const guides = memorySetting(NO_GUIDES);
    const { video, player } = setup("review", { guides });
    sized(video, 1920, 1080);
    const svg = player.element.querySelector(".video-guides") as HTMLElement;
    expect(svg.hasAttribute("hidden")).toBe(true);
    guides.set({ ...NO_GUIDES, center: true });
    expect(svg.hasAttribute("hidden")).toBe(false);

    expect(player.key("g")).toBe(true);
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, shown: false });
    expect(svg.hasAttribute("hidden")).toBe(true);
    expect(player.key("G")).toBe(true);
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true });
    expect(svg.hasAttribute("hidden")).toBe(false);
  });

  it("leave G alone in the pill, whose keys belong to the preview", () => {
    const guides = memorySetting(NO_GUIDES);
    const { player } = setup("pill", { guides });
    expect(player.key("g")).toBe(false);
    expect(guides.get()).toEqual(NO_GUIDES);
  });

  // A Flow's clip, which shows the file plain.
  it("are left out of a player given none, which leaves G alone", () => {
    const { video, player } = setup("review", { guides: undefined });
    sized(video, 1920, 1080);
    expect(player.element.querySelector(".video-guides")).toBeNull();
    expect(player.element.firstElementChild?.classList.contains("video-lut")).toBe(true);
    expect(player.key("g")).toBe(false);
  });

  it("stop following the shared choice once disposed", () => {
    const guides = memorySetting(NO_GUIDES);
    const { video, player } = setup("pill", { guides });
    sized(video, 1920, 1080);
    const svg = player.element.querySelector(".video-guides") as SVGSVGElement;
    player.dispose();
    guides.set({ ...NO_GUIDES, title: true });
    expect(svg.hasAttribute("hidden")).toBe(true);
  });
});

describe("the LUT", () => {
  // The layer's drawing is videoLut.test.ts's; here, only that the player
  // holds one and lets it go.
  it("follows the shared choice until the player is disposed", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
    const lut = memoryLook();
    const { video, player } = setup("pill", { lut });
    video.requestVideoFrameCallback = vi.fn(() => 1);
    lut.set({ lut: "panchromatic", on: true });
    expect(getContext).toHaveBeenCalledTimes(1);

    player.dispose();
    lut.set({ lut: "panchromatic", on: false });
    lut.set({ lut: "panchromatic", on: true });
    expect(getContext).toHaveBeenCalledTimes(1);
    getContext.mockRestore();
  });

  it("turns off and back on with D in the video tab, keeping the look, and leaves D to the preview in the pill", () => {
    const lut = memoryLook({ lut: "orthochromatic", on: true });
    const { player } = setup("review", { lut });
    expect(player.key("d")).toBe(true);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: false });
    expect(player.key("D")).toBe(true);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: true });

    const pill = setup("pill", { lut });
    expect(pill.player.key("d")).toBe(false);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: true });
  });

  // A player with no LOOK badge beside it, as on a Flow's card.
  it("is left out of a player given no look, which leaves D alone", () => {
    const { player } = setup("review", { lut: undefined });
    expect(player.element.querySelector(".video-lut")).toBeNull();
    expect(player.element.firstElementChild?.classList.contains("video-guides")).toBe(true);
    expect(player.key("d")).toBe(false);
  });
});
