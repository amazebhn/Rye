import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  video?: string;
  videoType?: string;
  favicon?: string;
}

export class LinkPreviewError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
  }
}

const MAX_REDIRECTS = 4;
// Some pages (e.g. YouTube) put their meta tags ~850KB in, after inline scripts.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_ERROR_TTL_MS = 10 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; RyeLinkPreview/1.0)";

// ---------------------------------------------------------------------------
// Address checks: previews only ever fetch public internet hosts.
// ---------------------------------------------------------------------------

function isPublicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const v4 = dotted.slice(2).map(Number);
    if (v4.some((n) => n > 255)) return null;
    s = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPublicV4(ip.split(".").map(Number));
  if (kind !== 6) return false;
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const embedsV4 =
    (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) ||
    (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0));
  if (embedsV4) return isPublicV4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  if (h[0] === 0x2002) return isPublicV4([h[1] >> 8, h[1] & 0xff, h[2] >> 8, h[2] & 0xff]);
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8)) return false;
  return (h[0] & 0xe000) === 0x2000;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkPreviewError("Only http and https links can be previewed", 400);
  if (url.username || url.password) throw new LinkPreviewError("Links with credentials can't be previewed", 400);
  if (url.port && url.port !== "80" && url.port !== "443") throw new LinkPreviewError("Only standard ports can be previewed", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new LinkPreviewError("Host not found", 502);
    }
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new LinkPreviewError("Private and local addresses can't be previewed", 400);
}

// ---------------------------------------------------------------------------
// HTML metadata
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function clean(s: string | undefined, max: number): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function absolute(href: string | undefined, base: URL): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseLinkPreview(html: string, pageUrl: URL): LinkPreview {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(tag);
    const key = (a.property ?? a.name ?? a.itemprop)?.toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }

  let icon: string | undefined;
  let touchIcon: string | undefined;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(tag);
    const rel = a.rel?.toLowerCase().split(/\s+/) ?? [];
    if (!icon && rel.includes("icon")) icon = a.href;
    else if (!touchIcon && rel.includes("apple-touch-icon")) touchIcon = a.href;
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const video = meta.get("og:video:secure_url") ?? meta.get("og:video:url") ?? meta.get("og:video");
  const videoType = meta.get("og:video:type");

  return {
    url: pageUrl.href,
    title: clean(meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTag ? decodeEntities(titleTag) : undefined), 200),
    description: clean(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), 300),
    siteName: clean(meta.get("og:site_name") ?? meta.get("application-name"), 80),
    image: absolute(meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src"), pageUrl),
    video: absolute(video, pageUrl),
    videoType: video ? clean(videoType, 80) : undefined,
    favicon: absolute(icon ?? touchIcon ?? "/favicon.ico", pageUrl),
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchPublic(start: URL, signal: AbortSignal): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return { res, url };
  }
  throw new LinkPreviewError("Too many redirects", 502);
}

async function readHead(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const latin1 = new TextDecoder("latin1");
  let size = 0;
  let tail = "";
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    const text = tail + latin1.decode(value);
    if (/<\/head\s*>/i.test(text)) break;
    tail = text.slice(-8);
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function loadLinkPreview(target: URL): Promise<LinkPreview> {
  let fetched: { res: Response; url: URL };
  try {
    fetched = await fetchPublic(target, AbortSignal.timeout(TIMEOUT_MS));
  } catch (err) {
    if (err instanceof LinkPreviewError) throw err;
    throw new LinkPreviewError("Couldn't reach the page", 502);
  }
  const { res, url } = fetched;
  const type = res.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.startsWith("image/")) {
    await res.body?.cancel();
    return { url: url.href, image: url.href };
  }
  if (type.startsWith("video/")) {
    await res.body?.cancel();
    return { url: url.href, video: url.href, videoType: type.split(";")[0] };
  }
  if (!res.ok || !(type.includes("html") || type === "")) {
    await res.body?.cancel();
    return { url: url.href, favicon: absolute("/favicon.ico", url) };
  }
  const html = decodeHtml(await readHead(res, MAX_BODY_BYTES), type);
  return parseLinkPreview(html, url);
}

const cache = new Map<string, { expires: number; value: Promise<LinkPreview> }>();

export function getLinkPreview(raw: string): Promise<LinkPreview> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return Promise.reject(new LinkPreviewError("Invalid URL", 400));
  }
  target.hash = "";
  const key = target.href;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  cache.delete(key);

  const value = loadLinkPreview(target);
  const entry = { expires: Date.now() + CACHE_TTL_MS, value };
  value.catch(() => {
    entry.expires = Date.now() + CACHE_ERROR_TTL_MS;
  });
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}
