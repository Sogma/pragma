// A value's canonical form, and a short digest of it, shared by the
// capability digest and a run's fingerprints. Isomorphic, unlike the Flow
// file module: the canvas runs Flows in the browser.

// Recursive key-sorted projection, so a digest depends on a value's content
// and never on the order a key happens to sit in. A node's `config` is an
// unvalidated bag whose keys arrive in whatever order its editor wrote them,
// so without this a pure re-serialization would change a capability digest
// and re-prompt, or make a repeated run look new.
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

// 64 bits of a cyrb53-style hash over the canonical JSON: enough to tell one
// node's runs apart, not to stand up to an attacker. Not Web Crypto:
// crypto.subtle exists only in a secure context, which a page served over
// plain http from another machine isn't.
export function shortDigest(value: unknown): string {
  const text = JSON.stringify(canonicalize(value)) ?? "";
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
