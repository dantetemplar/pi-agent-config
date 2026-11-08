/**
 * `cpa.belkov.su` serves responses with a content-encoding that Node's fetch
 * (undici) cannot decode: the body stream ends with `TypeError: terminated`
 * while the response is still labelled gzip/zstd. Pi's own model requests avoid
 * this through `headers: { "Accept-Encoding": "identity" }` in models.json, but
 * extensions that call fetch themselves (cliproxy-usage queries the management
 * API, pi-web-search calls the endpoint) never see those provider headers.
 *
 * This shim asks for the uncompressed body for that host only, leaving every
 * other request untouched.
 */

/** Hosts whose compressed responses undici fails to read. */
const AFFECTED_HOSTS = new Set(["cpa.belkov.su"]);

type FetchFn = typeof globalThis.fetch;

function hostOf(input: Parameters<FetchFn>[0]): string | undefined {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (typeof input === "object" && input !== null && "url" in input) return new URL((input as Request).url).hostname;
    return undefined;
  } catch {
    return undefined;
  }
}

function withIdentityEncoding(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  return { ...init, headers };
}

export default function () {
  const original = globalThis.fetch as FetchFn & { __cpaIdentity?: boolean };
  if (original.__cpaIdentity) return;

  const shimmed = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const host = hostOf(input);
    if (host && AFFECTED_HOSTS.has(host)) {
      // A Request carries its own headers, so rebuild it instead of passing init.
      if (typeof input === "object" && input !== null && "url" in input) {
        const headers = new Headers((input as Request).headers);
        if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
        return original(new Request(input as Request, { headers }), init);
      }
      return original(input, withIdentityEncoding(init));
    }
    return original(input, init);
  }) as FetchFn & { __cpaIdentity?: boolean };

  shimmed.__cpaIdentity = true;
  globalThis.fetch = shimmed;
}
