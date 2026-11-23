// Settings → Files → Sharing: the bucket Pragma shares files from when a
// provider fetches them by link. Its secret goes to the credential store and
// never comes back, only whether one is saved.
import type { Hono } from "hono";
import {
  canonicalEndpointOrUndefined,
  credentialStore,
  credentialStoreDescription,
  saveCredential,
  sharingKey,
  sharingKeyStatus,
} from "../../config/credentials.ts";
import {
  loadGlobalConfig,
  type ResolvedSharing,
  removeSharingConfig,
  resolveSharing,
  type SharingConfig,
  saveSharingConfig,
  sharingInputProblem,
  withConfigMutationLock,
} from "../../config/loadConfig.ts";
import type { SaveSharingRequestBody, SharingResponse } from "../../protocol/api.ts";
import { checkSharing, clientFor } from "../sharing.ts";

const SHARING_KIND = "s3";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mountSharingRoutes(app: Hono): void {
  // GET answers the setup, POST saves one. A save is kept only once a file
  // has gone into the bucket, out by its link and been deleted again, with
  // the secret it names or, left out, the one already saved.
  app.all("/api/sharing", async (c) => {
    try {
      if (c.req.method === "POST") {
        const body = (await c.req.json()) as Partial<SaveSharingRequestBody>;
        const fields: SharingConfig = {
          endpoint: text(body.endpoint).replace(/\/+$/, ""),
          bucket: text(body.bucket),
          region: text(body.region) || undefined,
          accessKeyId: text(body.accessKeyId),
        };
        const problem = sharingInputProblem(fields);
        if (problem) return c.json({ message: problem }, 400);
        const sharing = resolveSharing({ sharing: { kind: SHARING_KIND, ...fields } }) as ResolvedSharing;
        const secret = text(body.secretAccessKey);
        if (secret) {
          const saved = await saveCredential({
            kind: "sharing-keys",
            id: SHARING_KIND,
            endpoint: canonicalEndpointOrUndefined(sharing.endpoint),
            secret,
            verify: async () => {
              try {
                await checkSharing(clientFor(sharing, secret));
                return undefined;
              } catch (error) {
                return messageOf(error);
              }
            },
            publish: () => saveSharingConfig(fields),
          });
          if (!saved.ok) return c.json({ message: saved.message }, saved.status);
          return c.body(null, 204);
        }
        const found = await sharingKey(sharing);
        if (!found.found) return c.json({ message: found.problem ?? "Enter the secret key." }, 400);
        try {
          await checkSharing(clientFor(sharing, found.key));
        } catch (error) {
          return c.json({ message: messageOf(error) }, 400);
        }
        await withConfigMutationLock(async () => saveSharingConfig(fields));
        return c.body(null, 204);
      }
      if (c.req.method !== "GET") return c.body(null, 405);
      const sharing = resolveSharing(loadGlobalConfig());
      if (!sharing) return c.json<SharingResponse>({ sharing: null, store: credentialStoreDescription() });
      const key = await sharingKeyStatus(sharing);
      return c.json<SharingResponse>({
        sharing: {
          kind: sharing.kind,
          endpoint: sharing.endpoint,
          bucket: sharing.bucket,
          region: sharing.region ?? "",
          accessKeyId: sharing.accessKeyId,
          keySource: key.source === "env" ? "none" : key.source,
          ...(key.problem ? { keyProblem: key.problem } : {}),
        },
        store: credentialStoreDescription(),
      });
    } catch (error) {
      return c.json({ message: messageOf(error) }, 400);
    }
  });

  // Runs the same round trip a save does, on the saved setup.
  app.all("/api/sharing/check", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    let sharing: ResolvedSharing | undefined;
    try {
      sharing = resolveSharing(loadGlobalConfig());
    } catch (error) {
      return c.json({ message: messageOf(error) }, 400);
    }
    if (!sharing) return c.json({ message: "Sharing isn't set up." }, 400);
    const found = await sharingKey(sharing);
    if (!found.found) return c.json({ message: found.problem ?? "No secret key is saved." }, 400);
    try {
      await checkSharing(clientFor(sharing, found.key));
    } catch (error) {
      // The bucket's answer, not a Pragma fault.
      return c.json({ message: messageOf(error) }, 502);
    }
    return c.body(null, 204);
  });

  // Removes the setup and its saved secret. Files a job still has shared stay
  // in the bucket: with no setup left, nothing deletes them.
  app.all("/api/sharing/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    await credentialStore().clear({ kind: "sharing-keys", id: SHARING_KIND });
    await withConfigMutationLock(async () => removeSharingConfig());
    return c.body(null, 204);
  });
}
