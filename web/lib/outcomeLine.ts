// The place under a control that says how its last attempt went
// (docs/architecture.md, Feedback and interaction). An attempt clears what the
// last one left before it starts, so a failure can't outlast a later success
// that shows nothing here, such as a proposal drawn in the editor.
//
// An outcome lands only while its line is on the page and its surface still
// wants it. A line its surface dropped (a panel redrawn for another document,
// a closed dialog) shows nothing, and brings nothing into view.
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";
import { createInlineError } from "./inlineError.ts";

export interface OutcomeLineOptions {
  /** What a failure says when its error has no message fit to show. */
  fallback: string;
  /** Whether an error's own message is fit to show; any Error's when omitted. */
  showsMessage?: (error: Error) => boolean;
  /** Brings the line's surface back into view: an outcome can land after the
   * person moved elsewhere. */
  reveal?: () => void;
}

export interface AttemptOptions<T> {
  /** False once the attempt's outcome is no longer wanted, a cancelled run's. */
  current?: () => boolean;
  /** What a success shows; nothing when it returns nothing. */
  result?: (value: T) => readonly (Node | string)[];
  /** What a failure is titled: what failed, where several controls report
   * into one line. */
  title?: string;
}

export interface OutcomeLine {
  /** Runs one attempt. A failure shows as an inline error, with the setting
   * that fixes it. Resolves with the attempt's value, or undefined when it
   * failed. */
  run<T>(attempt: () => Promise<T>, options?: AttemptOptions<T>): Promise<T | undefined>;
  /** Shows what no attempt produced, such as a refused field or what was
   * published before, in place of what the line held. */
  show(...content: (Node | string)[]): void;
  clear(): void;
}

/** Makes `el` a line: from here on the line owns its children and its
 * `hidden`. */
export function createOutcomeLine(el: HTMLElement, options: OutcomeLineOptions): OutcomeLine {
  function draw(content: readonly (Node | string)[]): void {
    el.replaceChildren(...content);
    el.hidden = content.length === 0;
  }
  const clear = () => draw([]);
  clear();

  return {
    async run<T>(
      attempt: () => Promise<T>,
      { current, result, title }: AttemptOptions<T> = {},
    ): Promise<T | undefined> {
      clear();
      const lands = () => el.isConnected && (current?.() ?? true);
      let value: T;
      try {
        value = await attempt();
      } catch (error) {
        if (lands()) {
          const told = error instanceof Error && (options.showsMessage?.(error) ?? true) ? error.message : undefined;
          draw([createInlineError({ title, message: told ?? options.fallback, need: setupNeedOf(error) })]);
          options.reveal?.();
        }
        return undefined;
      }
      const content = result && lands() ? result(value) : [];
      if (content.length) {
        draw(content);
        options.reveal?.();
      }
      return value;
    },
    show: (...content) => draw(content),
    clear,
  };
}
