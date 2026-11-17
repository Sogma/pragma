/** What a refusal needs set up before the same request can succeed: the
 * thing missing, never where the app keeps it, so each host leads to its
 * own setting for it (docs/architecture.md, Feedback and interaction). Set where
 * the refusal is made, never read back out of its message. */
export type SetupNeed =
  // No model named, and no default set for that kind of output.
  | { kind: "defaultModel"; output: "text" | "image" | "video" }
  // A provider with no API key, one it rejects, or a sign-in that lapsed.
  | { kind: "providerKey"; provider: string }
  // No configured provider serves the model named.
  | { kind: "provider"; model: string }
  // No publisher configured, or not the one a site names.
  | { kind: "publisher" }
  // A publisher with no API key.
  | { kind: "publisherKey"; publisher: string };

/** An error a setting fixes. */
export class SetupError extends Error {
  readonly need: SetupNeed;
  constructor(message: string, need: SetupNeed) {
    super(message);
    this.name = "SetupError";
    this.need = need;
  }
}

const OUTPUTS: readonly unknown[] = ["text", "image", "video"];

// Checked field by field, since a need also arrives in a reply's body.
function isSetupNeed(value: unknown): value is SetupNeed {
  if (typeof value !== "object" || value === null) return false;
  const need = value as Record<string, unknown>;
  if (need.kind === "defaultModel") return OUTPUTS.includes(need.output);
  if (need.kind === "providerKey") return typeof need.provider === "string";
  if (need.kind === "provider") return typeof need.model === "string";
  if (need.kind === "publisherKey") return typeof need.publisher === "string";
  return need.kind === "publisher";
}

/** The need `error` carries, whether thrown as a SetupError or rebuilt from a
 * refused request's body. */
export function setupNeedOf(error: unknown): SetupNeed | undefined {
  const need = error instanceof Error ? (error as { need?: unknown }).need : undefined;
  return isSetupNeed(need) ? need : undefined;
}

/** `error`, carrying `need` when it is one: how a client keeps the need a
 * refused request's body named. */
export function withSetupNeed<E extends Error>(error: E, need: unknown): E {
  if (isSetupNeed(need)) Object.assign(error, { need });
  return error;
}
