// The controls every surface that plays a video lays over it, in place of
// the browser's own: one seek bar, one set of buttons, one Loop, one volume,
// one set of guides and one LUT, in two layouts (web/styles/video-player.css).
// The preview takes the pill, a quick look's few controls; the video tab
// takes the review layout, with a timecode, frame steps and an In/Out range.
//
// They lie in the media's frame with its hud (mediaHud.ts), so they cover
// the picture's own box and never size it.
import { DisposableStore, listen } from "./disposable.ts";
import { formatDuration } from "./dom.ts";
import { moreOptionsButton } from "./moreOptionsButton.ts";
import { createGuidesOverlay, type GuidesChoice, toggleGuides } from "./videoGuides.ts";
import { createLutLayer, type LutChoice, toggleLook } from "./videoLut.ts";

export type PlayerLayout = "pill" | "review";

/** The Loop every player shares: on in one, it is on in all. */
export interface LoopChoice {
  get(): boolean;
  set(on: boolean): void;
  subscribe(listener: (on: boolean) => void): () => void;
}

/** A level from 0 to 1, and whether it is muted: a mute keeps the level to
 * come back to. */
export interface Volume {
  level: number;
  muted: boolean;
}

/** The volume every player shares: changed in one, it changes in all. */
export interface VolumeChoice {
  get(): Volume;
  set(volume: Volume): void;
  subscribe(listener: (volume: Volume) => void): () => void;
}

export interface VideoPlayerOptions {
  layout: PlayerLayout;
  loop: LoopChoice;
  volume: VolumeChoice;
  /** The guides drawn over the picture, under the controls. Given only where
   * a clip is looked at for itself: a Flow's clip shows the file plain, as a
   * run hands it on, and the preview it opens draws them. */
  guides?: GuidesChoice;
  /** The look the picture shows through, under the guides. Given only where
   * a LOOK badge says it is on and turns it off: a picture graded with no
   * badge reads as the file's own colors. */
  lut?: LutChoice;
  /** Names the clip's In/Out range for the rest of the page's life, so a
   * tab switched away from and back finds it again. Never saved. */
  rangeKey?: string;
  /** What a click on the picture does, in place of play and pause, where
   * the picture opens the clip somewhere bigger. Its double-click then goes
   * nowhere, the click having acted already; the buttons still play. */
  pictureClick?: () => void;
  /** Opens the More options menu under its button, or closes it there.
   * `frame` takes the frame on screen; absent until one is decoded. */
  moreOptions(anchor: HTMLElement, frame?: () => FrameGrab): void;
}

/** The frame a player showed, drawn at the clip's own size, and where in the
 * clip it stands. */
export interface FrameGrab {
  canvas: HTMLCanvasElement;
  seconds: number;
}

export interface VideoPlayer {
  /** Goes in the media's frame, after its hud. */
  readonly element: HTMLElement;
  /** The clip's frames per second, once its header read names them: what
   * the review layout's timecode counts and its steps move by. */
  setFrameRate(fps: number | null): void;
  /** A key pressed on the surface that holds the player: true when it took it. */
  key(key: string): boolean;
  dispose(): void;
}

const SPEEDS = [0.5, 1, 1.5, 2];
// What a timecode counts and a step moves by until the header read names
// the clip's own rate, or where it names none.
export const FALLBACK_FPS = 30;
// A volume key's step, and how long its change shows the slider.
const VOLUME_STEP = 0.05;
const VOLUME_SHOWN_MS = 1000;

const ranges = new Map<string, { in?: number; out?: number; on: boolean }>();
// Where the level stood before a drag or a key took it down to nothing:
// what the speaker's click brings back, where unmuting at nothing would
// leave the clip silent.
let audibleLevel = 1;

const toLevel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

/** `00:01:04:12`: hours, minutes, seconds and frames. A fractional rate
 * counts its nominal frames per second, as a non-drop timecode counts
 * 23.976 as 24. */
export function timecode(seconds: number, fps: number): string {
  const nominal = Math.max(1, Math.round(fps));
  const frames = Math.floor(seconds * fps + 1e-6);
  const whole = Math.floor(frames / nominal);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames % nominal)}`;
}

function controlButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${className}`;
  button.setAttribute("aria-label", label);
  return button;
}

function box(className: string, ...children: HTMLElement[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = className;
  div.append(...children);
  return div;
}

export function createVideoPlayer(video: HTMLVideoElement, options: VideoPlayerOptions): VideoPlayer {
  const { layout, loop, volume, rangeKey } = options;
  const review = layout === "review";
  const store = new DisposableStore();

  const play = controlButton("video-player-play", "Play");
  const loopButton = controlButton("video-player-loop", "Loop");
  const speed = controlButton("video-player-speed", "Playback speed");
  const mute = controlButton("video-player-mute", "Mute");
  const volumeTrack = box(
    "video-player-volume-track",
    box("video-player-volume-fill"),
    box("video-player-volume-knob"),
  );
  const volumeSlider = box("video-player-volume-slider", volumeTrack);
  volumeSlider.setAttribute("role", "slider");
  volumeSlider.setAttribute("aria-label", "Volume");
  volumeSlider.setAttribute("aria-orientation", "vertical");
  volumeSlider.setAttribute("aria-valuemin", "0");
  volumeSlider.setAttribute("aria-valuemax", "100");
  const volumeBox = box("video-player-volume", mute, box("video-player-volume-popup", volumeSlider));
  const more = store.add(
    moreOptionsButton("video-player-more", (anchor) => options.moreOptions(anchor, frameGrab())),
  ).element;
  const fullScreen = controlButton("video-player-full-screen", "Full screen");
  const markIn = controlButton("video-player-mark is-in", "Set In point");
  const markOut = controlButton("video-player-mark is-out", "Set Out point");
  const previous = controlButton("video-player-step is-previous", "Previous frame");
  const next = controlButton("video-player-step is-next", "Next frame");
  const rangeToggle = controlButton("video-player-range-toggle", "In & Out");
  const current = document.createElement("span");
  current.className = "video-player-time";
  const total = document.createElement("span");
  total.className = "video-player-time is-total";
  const range = box("video-player-range");
  const seek = box("video-player-seek", range, box("video-player-fill"), box("video-player-knob"));
  seek.setAttribute("role", "slider");
  seek.setAttribute("aria-label", "Seek");
  seek.setAttribute("aria-valuemin", "0");

  const bar = box("video-player-bar");
  const guides = options.guides === undefined ? undefined : createGuidesOverlay(options.guides);
  const lut = options.lut === undefined ? undefined : createLutLayer(video, options.lut);
  const element = box(`video-player is-${layout}`, bar);
  if (guides) element.prepend(guides.element);
  if (lut) element.prepend(lut.element);
  if (review) {
    bar.append(
      box("video-player-counters", current, seek, total),
      box(
        "video-player-buttons",
        box("video-player-start", loopButton, rangeToggle, speed),
        box("video-player-transport", markIn, previous, play, next, markOut),
        box("video-player-end", volumeBox, fullScreen, more),
      ),
    );
    const keys: [HTMLButtonElement, string][] = [
      [markIn, "I"],
      [previous, "←"],
      [next, "→"],
      [markOut, "O"],
    ];
    for (const [button, key] of keys) button.dataset.tooltip = `${button.getAttribute("aria-label")} (${key})`;
  } else {
    // The preview's own keys step it from file to file, so its controls
    // never take focus from the pane those keys go to.
    for (const button of [play, loopButton, mute, more, fullScreen]) button.tabIndex = -1;
    bar.append(play, current, seek, total, loopButton, volumeBox, fullScreen, more);
  }
  // A press leaves focus where it was, on the surface whose keys the player
  // takes; the click still presses the button.
  store.add(listen(bar, "mousedown", (event) => event.preventDefault()));

  let fps: number | null = null;
  let speedIndex = SPEEDS.indexOf(1);
  const kept = rangeKey === undefined ? undefined : ranges.get(rangeKey);
  let inPoint = kept?.in;
  let outPoint = kept?.out;
  // Off, the marks stay but the clip plays and loops as if unmarked.
  let rangeOn = kept?.on ?? false;
  let scrubbing = false;
  // The level a drag on the volume slider began at, while it lasts.
  let volumeDragFrom: number | undefined;
  let volumeTimer = 0;
  let frameRequest = 0;
  // Where playback stood at the last frame drawn. A loop turns back at Out
  // only when playback reaches it from before, so a seek past Out plays on.
  let lastTime = video.currentTime;

  // Taking the frame pauses on it, so the picture left on screen is the one
  // taken, not one a few frames on.
  const frameGrab = (): (() => FrameGrab) | undefined => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return undefined;
    return () => {
      video.pause();
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      return { canvas, seconds: video.currentTime };
    };
  };

  const rate = () => fps ?? FALLBACK_FPS;
  const length = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
  const clock = (seconds: number) => (review ? timecode(seconds, rate()) : formatDuration(seconds));
  const hasRange = () => inPoint !== undefined || outPoint !== undefined;
  const rangeActive = () => rangeOn && hasRange();
  const inFullScreen = () => document.fullscreenElement !== null && document.fullscreenElement === video.parentElement;

  function drawTime(): void {
    const duration = length();
    const at = duration ? Math.min(video.currentTime, duration) : video.currentTime;
    current.textContent = clock(at);
    total.textContent = duration ? clock(duration) : "";
    seek.style.setProperty("--played", String(duration ? at / duration : 0));
    seek.setAttribute("aria-valuemax", String(Math.round(duration)));
    seek.setAttribute("aria-valuenow", String(Math.round(at)));
    seek.setAttribute("aria-valuetext", duration ? `${clock(at)} of ${clock(duration)}` : clock(at));
  }

  function drawState(): void {
    const playing = !video.paused;
    element.classList.toggle("is-playing", playing);
    play.classList.toggle("is-playing", playing);
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (review) play.dataset.tooltip = `${playing ? "Pause" : "Play"} (Space)`;
    loopButton.setAttribute("aria-pressed", String(loop.get()));
    loopButton.setAttribute("aria-label", rangeActive() ? "Loop In to Out" : "Loop");
    const shownSpeed = `${SPEEDS[speedIndex] ?? 1}×`;
    speed.textContent = shownSpeed;
    speed.setAttribute("aria-label", `Playback speed ${shownSpeed}`);
    fullScreen.setAttribute("aria-label", inFullScreen() ? "Exit full screen" : "Full screen");
    rangeToggle.setAttribute("aria-pressed", String(rangeActive()));
    rangeToggle.setAttribute("aria-disabled", String(!hasRange()));
    const duration = length();
    range.hidden = !hasRange() || !duration;
    range.classList.toggle("is-off", !rangeOn);
    if (duration) {
      seek.style.setProperty("--range-start", String((inPoint ?? 0) / duration));
      seek.style.setProperty("--range-end", String((outPoint ?? duration) / duration));
    }
  }

  function draw(): void {
    drawTime();
    drawState();
  }

  // A level of nothing reads as muted, and the speaker's click unmutes it.
  // Any other level shows none, one or two waves, cut at Video.js's thirds.
  function drawVolume(): void {
    const { level, muted } = volume.get();
    const silent = muted || level === 0;
    mute.classList.toggle("is-muted", silent);
    if (silent) delete mute.dataset.waves;
    else mute.dataset.waves = String(level < 0.33 ? 0 : level < 0.67 ? 1 : 2);
    mute.setAttribute("aria-label", silent ? "Unmute" : "Mute");
    if (review) mute.dataset.tooltip = `${silent ? "Unmute" : "Mute"} (M)`;
    const percent = Math.round(level * 100);
    volumeSlider.style.setProperty("--level", String(level));
    volumeSlider.classList.toggle("is-muted", muted);
    volumeSlider.setAttribute("aria-valuenow", String(percent));
    volumeSlider.setAttribute("aria-valuetext", muted ? `${percent}%, muted` : `${percent}%`);
  }

  function setLevel(level: number): void {
    volume.set({ level: toLevel(level), muted: false });
  }

  function toggleMute(): void {
    const { level, muted } = volume.get();
    if (level === 0) volume.set({ level: audibleLevel, muted: false });
    else volume.set({ level, muted: !muted });
  }

  // The slider rises clear of the bar, from its top edge: in the review
  // layout the counters row lies between that edge and the button.
  function liftVolume(): void {
    const lift = mute.getBoundingClientRect().top - bar.getBoundingClientRect().top;
    volumeBox.style.setProperty("--volume-lift", `${Math.max(0, lift)}px`);
  }

  // A key's change shows the slider a moment, and the bar with it, where a
  // playing clip has hidden them.
  function volumeKey(key: string): boolean {
    const { level } = volume.get();
    if (key === "m" || key === "M") toggleMute();
    else if (key === "ArrowUp" || key === "ArrowDown") {
      const next = toLevel(level + (key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP));
      if (next === 0 && level > 0) audibleLevel = level;
      setLevel(next);
    } else return false;
    liftVolume();
    element.classList.add("is-volume-open");
    window.clearTimeout(volumeTimer);
    volumeTimer = window.setTimeout(() => {
      if (volumeDragFrom === undefined) element.classList.remove("is-volume-open");
    }, VOLUME_SHOWN_MS);
    return true;
  }

  const levelAt = (event: PointerEvent) => {
    const bounds = volumeTrack.getBoundingClientRect();
    return bounds.height > 0 ? (bounds.top + bounds.height - event.clientY) / bounds.height : volume.get().level;
  };

  // G hides the guides and brings them back, keeping what they show.
  // The element's own loop wraps the whole clip; a range wraps by hand.
  function applyLoop(): void {
    video.loop = loop.get() && !rangeActive();
  }

  function seekTo(seconds: number): void {
    const duration = length();
    if (!duration) return;
    const to = Math.min(duration, Math.max(0, seconds));
    video.currentTime = to;
    lastTime = to;
    drawTime();
  }

  // A refused play or one a pause cuts short rejects; the button stays Play.
  function toggle(): void {
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }

  // A step lands mid-frame: on a frame's very start, rounding can leave the
  // decoder showing the one before.
  function step(frames: number): void {
    video.pause();
    seekTo((Math.floor(video.currentTime * rate() + 1e-6) + frames + 0.5) / rate());
  }

  function keepRange(): void {
    if (rangeKey !== undefined) {
      if (hasRange()) ranges.set(rangeKey, { in: inPoint, out: outPoint, on: rangeOn });
      else ranges.delete(rangeKey);
    }
    applyLoop();
    drawState();
  }

  // Setting a mark puts the range in force again.
  function setIn(): void {
    const at = video.currentTime;
    inPoint = at;
    if (outPoint !== undefined && outPoint <= at) outPoint = undefined;
    rangeOn = true;
    keepRange();
  }

  function setOut(): void {
    const at = video.currentTime;
    outPoint = at;
    if (inPoint !== undefined && inPoint >= at) inPoint = undefined;
    rangeOn = true;
    keepRange();
  }

  function toggleFullScreen(): void {
    const frame = video.parentElement;
    if (inFullScreen()) document.exitFullscreen().catch(() => undefined);
    else frame?.requestFullscreen().catch(() => undefined);
  }

  const onOut = (at: number) => outPoint !== undefined && Math.abs(at - outPoint) < 0.5 / rate();

  // Playback reaching Out wraps to In under Loop and stops there without.
  // Starting on Out counts as reaching it, or a range set and played from its
  // end would run past it.
  function tick(): void {
    frameRequest = 0;
    if (video.paused) return;
    const at = video.currentTime;
    if (rangeActive() && outPoint !== undefined && lastTime < outPoint + 0.5 / rate() && at >= outPoint) {
      if (loop.get()) seekTo(inPoint ?? 0);
      else {
        video.pause();
        seekTo(outPoint);
      }
    } else {
      lastTime = at;
      drawTime();
    }
    frameRequest = requestAnimationFrame(tick);
  }

  function scrubTo(event: PointerEvent): void {
    const bounds = seek.getBoundingClientRect();
    if (bounds.width > 0) seekTo(((event.clientX - bounds.left) / bounds.width) * length());
  }

  const on = (target: EventTarget, type: string, handler: (event: Event) => void) =>
    store.add(listen(target, type, handler));
  on(seek, "pointerdown", (event) => {
    const press = event as PointerEvent;
    if (press.button !== 0) return;
    press.preventDefault();
    seek.setPointerCapture?.(press.pointerId);
    scrubbing = true;
    scrubTo(press);
  });
  on(seek, "pointermove", (event) => {
    if (scrubbing) scrubTo(event as PointerEvent);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    on(seek, type, () => {
      scrubbing = false;
    });
  }

  on(play, "click", toggle);
  on(loopButton, "click", () => loop.set(!loop.get()));
  on(speed, "click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIndex] ?? 1;
    drawState();
  });
  on(mute, "click", toggleMute);
  on(volumeBox, "pointerenter", liftVolume);
  // A drag unmutes, as any change of level does. One that ends at nothing
  // leaves where it began for the speaker's click to bring back.
  on(volumeSlider, "pointerdown", (event) => {
    const press = event as PointerEvent;
    if (press.button !== 0) return;
    press.preventDefault();
    volumeSlider.setPointerCapture?.(press.pointerId);
    volumeDragFrom = volume.get().level;
    element.classList.add("is-volume-open");
    setLevel(levelAt(press));
  });
  on(volumeSlider, "pointermove", (event) => {
    if (volumeDragFrom !== undefined) setLevel(levelAt(event as PointerEvent));
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    on(volumeSlider, type, () => {
      if (volumeDragFrom === undefined) return;
      if (volume.get().level === 0 && volumeDragFrom > 0) audibleLevel = volumeDragFrom;
      volumeDragFrom = undefined;
      element.classList.remove("is-volume-open");
    });
  }
  on(fullScreen, "click", toggleFullScreen);
  on(markIn, "click", setIn);
  on(markOut, "click", setOut);
  on(previous, "click", () => step(-1));
  on(next, "click", () => step(1));
  on(rangeToggle, "click", () => {
    if (!hasRange()) return;
    rangeOn = !rangeOn;
    keepRange();
  });

  if (options.pictureClick) on(video, "click", options.pictureClick);
  else {
    on(video, "click", toggle);
    on(video, "dblclick", toggleFullScreen);
  }
  // Played again from where a range stopped it, the range starts over.
  on(video, "play", () => {
    if (rangeActive() && onOut(video.currentTime)) seekTo(inPoint ?? 0);
    if (frameRequest === 0) frameRequest = requestAnimationFrame(tick);
    drawState();
  });
  on(video, "ended", () => {
    if (loop.get() && rangeActive()) {
      seekTo(inPoint ?? 0);
      video.play().catch(() => undefined);
    }
    draw();
  });
  for (const type of ["pause", "loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
    on(video, type, draw);
  }
  // Sized by the clip's header, and again when a stream changes its frame size mid-clip.
  if (guides) {
    const sizeGuides = () => guides.setSize(video.videoWidth, video.videoHeight);
    on(video, "loadedmetadata", sizeGuides);
    on(video, "resize", sizeGuides);
    sizeGuides();
    store.add(() => guides.dispose());
  }
  store.add(() => lut?.dispose());
  on(document, "fullscreenchange", drawState);
  store.add(() => cancelAnimationFrame(frameRequest));
  store.add(() => window.clearTimeout(volumeTimer));
  store.add(
    loop.subscribe(() => {
      applyLoop();
      drawState();
    }),
  );
  // The clip takes the shared volume before its first frame, so none plays
  // a moment at the browser's own.
  store.add(
    volume.subscribe(({ level, muted }) => {
      video.volume = level;
      video.muted = muted;
      drawVolume();
    }),
  );
  draw();

  return {
    element,
    setFrameRate(rateNow) {
      fps = rateNow !== null && rateNow > 0 ? rateNow : null;
      drawTime();
    },
    key(key) {
      if (!review) return false;
      if (key === " ") toggle();
      else if (key === "ArrowLeft") step(-1);
      else if (key === "ArrowRight") step(1);
      else if (key === "i" || key === "I") setIn();
      else if (key === "o" || key === "O") setOut();
      else if ((key === "g" || key === "G") && options.guides) toggleGuides(options.guides);
      // D, not L: L is the shuttle's.
      else if ((key === "d" || key === "D") && options.lut) toggleLook(options.lut);
      else return volumeKey(key);
      return true;
    },
    dispose() {
      if (inFullScreen()) document.exitFullscreen().catch(() => undefined);
      store.dispose();
    },
  };
}
