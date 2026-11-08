// A self-hosted browser site in one Cloudflare Worker: the page and its modules (static assets, with
// the cross-origin isolation headers the page needs), the online server of online/server (its
// /v1/ routes and Durable Objects, unchanged), and optionally the owner's own disc image streamed
// from R2 behind a private link. Deploy with port/web/host/deploy.mjs; README.md says how.
//
// The disc (finding 142): /disc/<KEY>/info answers the image's size, a version tag and the online
// check that disc_check.mjs worked out from the same image at deploy time (so a browser never has to
// download the whole disc to hash it), and /disc/<KEY>/<TAG>/<N> is the image's 256 KiB block N,
// immutable, so the browser's HTTP cache keeps it and the edge cache can too. KEY is the
// DISC_KEY secret: without it there is no disc route at all. The image may be kept in several R2
// buckets (one per region, the same object in each); a request reads the bucket nearest the
// Cloudflare location serving it, and the others if that one fails.
import server, { Room, LobbyIndex, TrackTimes, Leaderboard } from "../../../../online/server/src/index";

export { Room, LobbyIndex, TrackTimes, Leaderboard };

interface HostEnv extends Env {
  ASSETS: Fetcher;
  DISC_KEY?: string;
  /** The object's name in every disc bucket. */
  DISC_OBJECT?: string;
  /** The disc buckets' bindings by region, JSON: {"asia": "DISC_ASIA", "eu": "DISC_EU", ...}. */
  DISC_BUCKETS?: string;
  /** disc_check.mjs's answer for the image, JSON: {size, code, digest, note}. */
  DISC_CHECK?: string;
}

const BLOCK = 256 << 10;
const MAX_RUN = 16;  // the most blocks one request answers (4 MiB)

/** The object's size per bucket, looked up once per Worker instance (the last block is shorter). */
const sizes = new Map<R2Bucket, number>();
async function sizeOf(bucket: R2Bucket, object: string): Promise<number | null> {
  if (!sizes.has(bucket)) {
    const head = await bucket.head(object).catch(() => null);
    if (!head) return null;
    sizes.set(bucket, head.size);
  }
  return sizes.get(bucket)!;
}  // small: on a slow line a 1 MiB miss stalls the game for seconds
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Region names in the order a request from this continent tries them. */
function regionOrder(continent: string | undefined, regions: string[]): string[] {
  const first = continent === "EU" || continent === "AF" ? "eu" : continent === "NA" || continent === "SA" ? "us" : "asia";
  return [first, ...regions.filter((r) => r !== first)].filter((r) => regions.includes(r));
}

function buckets(request: Request, env: HostEnv): R2Bucket[] {
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(env.DISC_BUCKETS || "{}");
  } catch {
    names = {};
  }
  const continent = (request.cf as { continent?: string } | undefined)?.continent;
  return regionOrder(continent, Object.keys(names))
    .map((r) => (env as unknown as Record<string, R2Bucket | undefined>)[names[r]])
    .filter((b): b is R2Bucket => !!b);
}

/** The image's version tag: R2's etag, letters and digits only (it goes in the block URLs). */
const tagOf = (o: R2Object) => o.etag.replace(/[^0-9a-zA-Z]/g, "").slice(0, 32);

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

const discJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...ISOLATION, "Cache-Control": "no-store" } });

async function disc(request: Request, env: HostEnv, ctx: ExecutionContext, rest: string[]): Promise<Response> {
  const object = env.DISC_OBJECT || "";
  const from = buckets(request, env);
  if (!object || !from.length) return discJson({ error: "no disc on this site" }, 404);
  if (request.method !== "GET" && request.method !== "HEAD") return discJson({ error: "GET only" }, 405);

  if (rest.length === 1 && rest[0] === "info") {
    for (const bucket of from) {
      const head = await bucket.head(object).catch(() => null);
      if (!head) continue;
      let check: { size?: number } | null = null;
      try {
        check = env.DISC_CHECK ? JSON.parse(env.DISC_CHECK) : null;
      } catch {
        check = null;
      }
      // The deploy-time answer counts only for an image of the same size (another upload: none).
      if (check && check.size !== head.size) check = null;
      return discJson({ size: head.size, tag: tagOf(head), block: BLOCK, check });
    }
    return discJson({ error: "the disc object is missing" }, 404);
  }

  if (rest.length !== 2 || !/^[0-9a-zA-Z]{1,32}$/.test(rest[0]) || !/^\d{1,7}$/.test(rest[1]))
    return discJson({ error: "not found" }, 404);
  // Block N, or ?n= blocks from N in one answer (the browser's background fill: fewer requests).
  const [tag, first] = [rest[0], Number(rest[1])];
  const want = Math.max(1, Math.min(MAX_RUN, Number(new URL(request.url).searchParams.get("n")) || 1));
  const headers = {
    ...ISOLATION,
    "Content-Type": "application/octet-stream",
    // private: the browser keeps it (a replay of the same block costs nothing), no shared cache does
    "Cache-Control": "private, max-age=31536000, immutable",
  };
  const answer = (bytes: ArrayBuffer | null, cache: string) =>
    new Response(request.method === "HEAD" ? null : bytes, { headers: { ...headers, "X-Disc-Cache": cache } });
  const edge = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(new URL(`/disc-block/${tag}/${first}/${want}`, request.url).toString());
  const kept = await edge.match(cacheKey).catch(() => undefined);
  if (kept) return answer(await kept.arrayBuffer(), "HIT");
  for (const bucket of from) {
    const size = await sizeOf(bucket, object);
    if (size === null) continue;
    const offset = first * BLOCK, length = Math.min(want * BLOCK, size - offset);
    if (length <= 0) return discJson({ error: "past the end of the disc" }, 416);
    const got = await bucket.get(object, { range: { offset, length } }).catch(() => null);
    if (!got) continue;
    if (tagOf(got) !== tag) return discJson({ error: "the disc changed: reload the page" }, 409);
    const bytes = await got.arrayBuffer();
    if (bytes.byteLength !== length) continue;
    ctx.waitUntil(edge.put(cacheKey, new Response(bytes, { headers: { "Cache-Control": "public, max-age=2592000" } })).catch(() => {}));
    return answer(bytes, "MISS");
  }
  return discJson({ error: "the disc could not be read" }, 502);
}

export default {
  async fetch(request: Request, env: HostEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) return server.fetch(request, env);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "disc") {
      if (!env.DISC_KEY || parts.length < 2 || !sameKey(parts[1], env.DISC_KEY)) return discJson({ error: "not found" }, 404);
      return disc(request, env, ctx, parts.slice(2));
    }
    // site.json: what the page offers here (main.js). The server is this site itself.
    if (url.pathname === "/site.json")
      return discJson({ server: "same-origin", disc: !!env.DISC_KEY });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<HostEnv>;
