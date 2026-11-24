// A clip on a Flow card or App Mode tile, a Generate Video's result or a
// Load Video's file: the file under the player every video plays under
// (lib/videoPlayer.ts), asking for only its header until it plays. A click
// on the picture opens the file's preview, while the player's buttons play
// it where it is.
import type { ClipFacts } from "../../src/protocol/api.ts";
import { rawFileUrl } from "../core/apiClient.ts";
import { mediaFrame, type ThumbnailHud, thumbnailHud } from "../lib/mediaHud.ts";
import { createVideoPlayer, type VideoPlayer } from "../lib/videoPlayer.ts";
import type { ContextMenuService } from "../services/menus.ts";
import { videoLoop, videoVolume } from "../services/settings.ts";
import { moreOptionsMenu } from "../services/videoMenu.ts";

export interface ResultClip {
  el: HTMLDivElement;
  /** The clip at a tree path, or none. */
  show(path: string | undefined): void;
  /** Lays the clip's size and frame rate along its top on hover, as a
   * gallery tile does, or takes them away. */
  showFacts(facts: Pick<ClipFacts, "width" | "height" | "frameRate" | "variableFrameRate"> | undefined): void;
  dispose(): void;
}

/** `preview` opens the clip's file, by tree path, over the pane; the
 * player's More options menu opens in `contextMenu`, in the context the
 * Flow's tab is seen in. */
export function createResultClip(
  className: string,
  preview: (path: string) => void,
  contextMenu: ContextMenuService,
  context: () => string,
): ResultClip {
  const video = document.createElement("video");
  video.preload = "metadata";
  // The player's overlay stays empty; a clip whose facts a caller knows gets
  // a gallery tile's hover bars instead, made when they first come: a result
  // knows only its path.
  const hud = document.createElement("div");
  hud.className = "media-hud";
  hud.hidden = true;
  const frame = mediaFrame(video, hud, className);
  let bars: ThumbnailHud | undefined;
  // A press on the controls plays the clip; on the canvas it would drag the node.
  frame.classList.add("nodrag");
  frame.hidden = true;
  let player: VideoPlayer | undefined;

  // Dropping the source is what releases the decoder and the connection.
  function stop(): void {
    player?.dispose();
    player?.element.remove();
    player = undefined;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  return {
    el: frame,
    show(path) {
      stop();
      frame.hidden = path === undefined;
      if (path === undefined) return;
      video.src = rawFileUrl(path);
      // Paused first, so the preview's copy is the only one playing.
      const pictureClick = () => {
        video.pause();
        preview(path);
      };
      // No look or guides, and neither row in its ⋮: the clip shows the file
      // plain, as a run hands it on, with no LOOK badge to say a look is on.
      // The preview it opens shows both.
      player = createVideoPlayer(video, {
        layout: "pill",
        loop: videoLoop,
        volume: videoVolume,
        pictureClick,
        moreOptions: moreOptionsMenu(contextMenu, path, { looks: false, guides: false, context }),
      });
      frame.append(player.element);
    },
    showFacts(facts) {
      if (!facts) {
        bars?.fill({});
        return;
      }
      const { width, height, frameRate, variableFrameRate } = facts;
      bars ??= thumbnailHud(frame);
      bars.fill({
        width: width ?? undefined,
        height: height ?? undefined,
        clip: { codec: null, frameRate, variableFrameRate },
      });
    },
    dispose: stop,
  };
}
