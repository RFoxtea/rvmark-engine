/**
 * types/video.ts
 *
 * Embeds a video in the node body. Five sources are supported:
 *
 *   1. YouTube videos and playlists (embedded via the IFrame Player API):
 *        {= video} https://www.youtube.com/watch?v=...
 *        {= video} dQw4w9WgXcQ          (bare 11-char video ID)
 *        {= video} https://www.youtube.com/playlist?list=...
 *        {= video} PLxxxxxxxxxxxxxxxxx  (bare 13+ char playlist ID)
 *
 *   2. Odysee videos (embedded via an iframe to odysee.com/$/embed/...):
 *        {= video} https://odysee.com/@channel:c/video-name:a
 *
 *   3. Vimeo videos (embedded via an iframe to player.vimeo.com, driven by the
 *      Player SDK's postMessage protocol):
 *        {= video} https://vimeo.com/76979871
 *        {= video} https://vimeo.com/76979871/abc123def4   (unlisted, private hash)
 *
 *   4. Instagram reels and posts (embedded via an iframe to instagram.com/…/embed):
 *        {= video} https://www.instagram.com/reel/C8QltIDsWTG/
 *
 *   5. Direct video files (embedded via a native <video> element):
 *        {= video} ./clip.mp4
 *        {= video} https://example.com/clip.webm
 *        {type: video; src: ./clip.mp4}
 *
 * YouTube, Odysee, Vimeo and direct files accept a start offset, so a node can
 * cite one passage of a long video. A timestamp already present in the source URL
 * is honoured:
 *
 *        {= video} https://www.youtube.com/watch?v=KtQ9nt2ZeGM&t=4216s
 *        {= video} https://odysee.com/@channel:c/video-name:a?t=90
 *        {= video} https://vimeo.com/76979871#t=90s
 *        {= video} ./clip.mp4#t=30
 *
 * and `start` / `end` attributes override it — the only way to timestamp a bare
 * ID, and the only way to set an end cutoff (no watch-URL param expresses one).
 * Only YouTube and direct files honour an end cutoff; Odysee and Vimeo express
 * no such parameter, so `end` is ignored there:
 *
 *        {= video; start: 4216} KtQ9nt2ZeGM
 *        {= video; start: 1h10m16s; end: 4300} https://www.youtube.com/watch?v=...
 *
 * Offsets are written as seconds (`4216`, `4216s`) or colon/unit clock time
 * (`1:10:16`, `1h10m16s`); anything unparseable is ignored rather than passed on.
 *
 * Instagram takes no offset: its embed exposes no such parameter, so `start`/`end`
 * are ignored on a reel and the clip always starts from the top.
 *
 * For YouTube embeds the IFrame Player API (enablejsapi=1 + postMessage) is used
 * to toggle play/pause from the tree row via Enter or Space; Vimeo is toggled the
 * same way over its own postMessage protocol. For native files the <video>
 * element is toggled directly. Neither Odysee nor Instagram exposes a documented
 * player API, so Enter/Space is a no-op there — use the embed's own native
 * controls.
 *
 * Player state constants (from YT IFrame API):
 *   -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 video cued
 */

import type { NodeTypeFactory, RenderNode } from '../client/render-node.js';
import { factoryRegister } from '../client/render-node.js';
import { treeNavKeydown, actionKeydown, copyPermalink, resolveBox, applyBox } from '../client/handler-utils.js';
import { ToggleSet } from '../client/toggle-set.js';
import { BaseTypeHandler } from '../client/base-handler.js';
import { resolveMediaOn } from '../client/origin-host.js';

import { wireSelectThenAction } from '../client/interaction.js';

/** Which player protocol an iframe speaks, if any. */
type PlayerApi = 'yt' | 'vimeo';

const YT_ORIGIN    = 'https://www.youtube-nocookie.com';
const VIMEO_ORIGIN = 'https://player.vimeo.com';

// Tracks play state per iframe from the player's own state messages: YouTube's
// onStateChange over the IFrame API, Vimeo's play/pause/ended events over the
// Player SDK protocol. May not work in Firefox due to storage partitioning; in
// that case Enter/Space will always send play (no toggle).
const _playing = new WeakMap<HTMLIFrameElement, boolean>();

window.addEventListener('message', (e) => {
  const api: PlayerApi | null =
    e.origin === YT_ORIGIN    ? 'yt'    :
    e.origin === VIMEO_ORIGIN ? 'vimeo' : null;
  if (!api) return;

  let data: any;
  try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }

  let playing: boolean;
  if (api === 'yt') {
    if (data.event !== 'infoDelivery' || data.info?.playerState == null) return;
    playing = data.info.playerState === 1 || data.info.playerState === 3;
  } else {
    // Vimeo reports each transition as its own event rather than a state code.
    if (data.event !== 'play' && data.event !== 'pause' && data.event !== 'ended') return;
    playing = data.event === 'play';
  }

  for (const iframe of document.querySelectorAll<HTMLIFrameElement>('.video-wrap iframe')) {
    if (iframe.contentWindow === e.source) {
      _playing.set(iframe, playing);
      break;
    }
  }
});

// Extensions we treat as direct video files (native <video>).
const FILE_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:[?#]|$)/i;

class VideoTypeHandler extends BaseTypeHandler {
  private _canonicalHref:  string | null = null;
  private _iframe:                  HTMLIFrameElement | null = null;
  // Which player protocol _iframe speaks, or null when it speaks none.
  // Odysee and Instagram iframes have no player API, so their toggle is a no-op.
  private _api:                     PlayerApi | null = null;
  private _video:                   HTMLVideoElement | null = null;

  constructor(renderNode: RenderNode) {
    super(renderNode, 'iframe, video');
    const sourceNode = renderNode.sourceNode;
    const attrs = sourceNode.attrs;
    const rawUrl = attrs.get('src') ?? (sourceNode.label || null);

    const content = this.content;
    content.classList.add('node-content--video');

    // ── Click wiring ──────────────────────────────────────────────────────────

    // No re-click action at all — the embed handles its own clicks — so a
    // double-click here is just the reader selecting text.
    wireSelectThenAction(content, () => {}, content, undefined, () => false);

    const li = renderNode.li;

    // Explicit start/end attrs; each embed builder falls back to a timestamp
    // carried by the source URL when `start` is absent.
    const clip = resolveClip(attrs, null);

    // Author box overrides; each branch applies them to its own wrap, which the
    // stylesheet has already given a default ratio.
    const box = resolveBox(attrs, 'video');

    // Decide between a direct video file and a YouTube embed. Only the file
    // branch needs the origin — an embed URL names its own host — so the whole
    // body waits on one resolution rather than two paths racing.
    void (async () => {
      const fileUrl = rawUrl && isFileSource(rawUrl)
        ? safeMediaUrl(await resolveMediaOn(sourceNode, rawUrl) ?? '')
        : null;

      if (fileUrl) {
        this._canonicalHref = fileUrl;
        const wrap = document.createElement('div');
        wrap.className = 'video-wrap';
        applyBox(wrap, box);
        const video = document.createElement('video');
        // `#t=` is honoured natively by the browser; no seek script needed.
        video.src = withMediaFragment(fileUrl, clip);
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        // Don't leak the visitor's Referer to third-party video hosts.
        video.setAttribute('referrerpolicy', 'no-referrer');
        wrap.appendChild(video);
        content.appendChild(wrap);
        this._video = video;
      } else {
        const yt = rawUrl ? ytEmbed(rawUrl, clip) : null;
        const odysee = !yt && rawUrl ? odyseeEmbed(rawUrl, clip) : null;
        const vimeo = !yt && !odysee && rawUrl ? vimeoEmbed(rawUrl, clip) : null;
        const insta = !yt && !odysee && !vimeo && rawUrl ? instagramEmbed(rawUrl) : null;
        this._canonicalHref = yt?.href ?? odysee?.href ?? vimeo?.href ?? insta?.href ?? null;
        if (yt) {
          const wrap = document.createElement('div');
          wrap.className = 'video-wrap';
          applyBox(wrap, box);
          wrap.innerHTML = `<iframe
            src="${yt.src}&enablejsapi=1"
            allowfullscreen
            loading="lazy"
          ></iframe>`;
          content.appendChild(wrap);

          this._iframe = wrap.querySelector('iframe')!;
          this._api = 'yt';
          this._iframe.addEventListener('load', () => {
            this._iframe!.contentWindow!.postMessage(
              JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
              YT_ORIGIN
            );
          });
        } else if (odysee) {
          const wrap = document.createElement('div');
          wrap.className = 'video-wrap';
          applyBox(wrap, box);
          wrap.innerHTML = `<iframe
            src="${odysee.src}"
            allowfullscreen
            loading="lazy"
          ></iframe>`;
          content.appendChild(wrap);
          this._iframe = wrap.querySelector('iframe')!;
        } else if (vimeo) {
          const wrap = document.createElement('div');
          wrap.className = 'video-wrap';
          applyBox(wrap, box);
          wrap.innerHTML = `<iframe
            src="${vimeo.src}"
            allowfullscreen
            loading="lazy"
          ></iframe>`;
          content.appendChild(wrap);

          this._iframe = wrap.querySelector('iframe')!;
          this._api = 'vimeo';
          // Unlike YouTube, Vimeo sends nothing until each event is subscribed to
          // by name, so the toggle needs all three transitions requested here.
          this._iframe.addEventListener('load', () => {
            for (const value of ['play', 'pause', 'ended']) {
              this._iframe!.contentWindow!.postMessage(
                JSON.stringify({ method: 'addEventListener', value }),
                VIMEO_ORIGIN
              );
            }
          });
        } else if (insta) {
          const wrap = document.createElement('div');
          wrap.className = 'video-wrap video-wrap--portrait';
          applyBox(wrap, box);
          wrap.innerHTML = `<iframe
            src="${insta.src}"
            allowfullscreen
            loading="lazy"
          ></iframe>`;
          content.appendChild(wrap);
          this._iframe = wrap.querySelector('iframe')!;
        }
      }
    })();

    content.addEventListener('keydown', (e) => {
      if (e.target !== content) return;
      if (actionKeydown(e, renderNode)) return;
      switch (e.key) {
        case 'Enter':
        case ' ':
          this._togglePlayback();
          e.preventDefault();
          return;
        case 'c':
          if (e.ctrlKey || e.metaKey) {
            if (!window.getSelection()?.toString()) {
              navigator.clipboard.writeText(this._canonicalHref ?? '').catch(() => {});
              e.preventDefault();
            }
          } else {
            copyPermalink(renderNode);
            e.preventDefault();
          }
          return;
      }
      treeNavKeydown(e, content, li);
    });

    new ToggleSet(renderNode, attrs, { alwaysOpen: true }).mountOnce();
  }

  private _togglePlayback(): void {
    if (this._video) {
      if (this._video.paused) void this._video.play();
      else this._video.pause();
      return;
    }
    // Odysee and Instagram embeds have no documented player API.
    if (!this._iframe || !this._api) return;
    const playing = _playing.get(this._iframe) ?? false;
    const [msg, origin] = this._api === 'yt'
      ? [{ event: 'command', func: playing ? 'pauseVideo' : 'playVideo', args: [] }, YT_ORIGIN]
      : [{ method: playing ? 'pause' : 'play' }, VIMEO_ORIGIN];
    this._iframe.contentWindow!.postMessage(JSON.stringify(msg), origin);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const videoFactory: NodeTypeFactory = {
  create(renderNode) {
    return new VideoTypeHandler(renderNode);
  },
  staticRenderBody(node, ctx) {
    const rawUrl = node.attrs.get('src') ?? (node.label || null);
    if (!rawUrl) return null;
    const clip = resolveClip(node.attrs, null);
    if (isFileSource(rawUrl)) {
      const url = safeMediaUrl(ctx.resolveMedia(node, rawUrl));
      if (!url) return null;
      return `<video src="${esc(withMediaFragment(url, clip))}" controls preload="metadata" playsinline referrerpolicy="no-referrer"></video>`;
    }
    const embed = ytEmbed(rawUrl, clip) ?? odyseeEmbed(rawUrl, clip)
      ?? vimeoEmbed(rawUrl, clip) ?? instagramEmbed(rawUrl);
    if (!embed) return null;
    return `<p><a href="${esc(embed.href)}" target="_blank" rel="noopener noreferrer">${embed.label}</a></p>`;
  },
};

factoryRegister('video', videoFactory);

/**
 * Defence-in-depth scheme allowlist for direct video files, mirroring image.ts:
 * relative paths and http(s) URLs are allowed; anything else (file:, blob:,
 * javascript:, data:, …) is rejected before it reaches a <video src>. The CSP
 * `media-src 'self' https:` blocks such loads at runtime regardless, but we
 * don't rely on CSP alone.
 */
function safeMediaUrl(resolved: string): string | null {
  const proto = (resolved.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/) ?? [])[1]?.toLowerCase();
  return (!proto || proto === 'http' || proto === 'https') ? resolved : null;
}

/** True when the source points at a direct video file rather than a YouTube/Odysee link. */
function isFileSource(url: string): boolean {
  if (/(?:youtube\.com|youtu\.be|odysee\.com|vimeo\.com|instagram\.com)/i.test(url)) return false;
  return FILE_EXT_RE.test(url);
}

/**
 * Applies a clip window to a direct video file URL as a Media Fragments URI
 * (`#t=start,end`), which browsers honour natively on a <video src> — no script
 * needed, and it survives into the no-JS static output.
 *
 * A fragment already on the URL supplies the start when no attr overrode it; we
 * strip it either way so we never emit two `#t=` fragments.
 */
function withMediaFragment(url: string, clip: Clip): string {
  const hash    = url.match(/#t=([^#]*)$/);
  const bare    = hash ? url.slice(0, -hash[0].length) : url;
  const [h0]    = hash ? decodeURIComponent(hash[1]).split(',') : [];
  const start   = clip.start ?? parseTimestamp(h0);
  const end     = clip.end;

  if (start == null && end == null) return bare;
  // `#t=,end` is the valid spec form for an end-only window.
  return `${bare}#t=${start ?? ''}${end != null ? ',' + end : ''}`;
}

// ── Timestamps ─────────────────────────────────────────────────────────────

/** A start/end offset pair in whole seconds. Either end may be absent. */
interface Clip { start: number | null; end: number | null }

const NO_CLIP: Clip = { start: null, end: null };

/**
 * Parses one timestamp into whole seconds, accepting the forms that appear in
 * YouTube URLs and that a person would plausibly type:
 *
 *   4216  4216s  1h10m16s  70m16s  1:10:16  10:16
 *
 * Returns null for anything else — an unparseable offset is dropped rather than
 * forwarded, so a typo can never put `start=NaN` into an embed URL. Fractional
 * and negative values are rejected for the same reason; YouTube's `start`/`end`
 * are integer seconds, and a media fragment counts from zero.
 */
export function parseTimestamp(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  let secs: number | null = null;

  // Bare seconds: "4216" or "4216s".
  if (/^\d+s?$/.test(s)) {
    secs = parseInt(s, 10);
  } else if (/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(s)) {
    // Unit form: at least one of h/m/s. The regex above also matches the empty
    // string, which the `!s` guard already rejected.
    const h = /(\d+)h/.exec(s), m = /(\d+)m/.exec(s), sec = /(\d+)s/.exec(s);
    secs = (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (sec ? +sec[1] : 0);
  } else if (/^\d+(?::[0-5]?\d){1,2}$/.test(s)) {
    // Clock form: "mm:ss" or "hh:mm:ss".
    secs = s.split(':').reduce((acc, part) => acc * 60 + parseInt(part, 10), 0);
  }

  return secs != null && Number.isSafeInteger(secs) && secs >= 0 ? secs : null;
}

/**
 * Resolves the clip window for a node: explicit `start`/`end` attrs win, and
 * `start` falls back to whatever timestamp the source URL already carried.
 * `urlStart` is the provider-specific extraction (YouTube `t=`, Odysee `t=`,
 * media fragment `#t=`), passed in by the caller that knows the URL shape.
 *
 * An end at or before the start would produce a zero/negative window that
 * YouTube renders as an immediately-ending video, so it is discarded.
 */
function resolveClip(attrs: { get(k: string): string | undefined }, urlStart: number | null): Clip {
  const start = parseTimestamp(attrs.get('start')) ?? urlStart;
  const end   = parseTimestamp(attrs.get('end'));
  return { start, end: end != null && (start == null || end > start) ? end : null };
}

/** Appends `start`/`end` query params to an embed src that already has a query string. */
function withClipParams(src: string, clip: Clip): string {
  let out = src;
  if (clip.start != null) out += `&start=${clip.start}`;
  if (clip.end   != null) out += `&end=${clip.end}`;
  return out;
}

/** Extracts a YouTube watch-URL timestamp (`t=` or `start=`). */
function ytUrlStart(url: string): number | null {
  const m = url.match(/[?&](?:t|start)=([^&#]+)/);
  return m ? parseTimestamp(decodeURIComponent(m[1])) : null;
}

function ytPlaylistId(url: string): string | null {
  const bare = bareId(url, 13, true);
  if (bare) return bare;
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function ytVideoId(url: string): string | null {
  const bare = bareId(url, 11, false);
  if (bare) return bare;
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Matches a bare YouTube ID, optionally followed by a query tail — so a node can
 * be written as `KtQ9nt2ZeGM&t=4216s` or `KtQ9nt2ZeGM?t=4216s`, the natural thing
 * to write once you know the bare-ID form works. The tail is left for
 * `ytUrlStart` to read; only the ID is returned.
 *
 * `len` is the ID length (11 for a video, 13+ for a playlist) and `open` allows
 * the length to run over, as playlist IDs do.
 */
function bareId(url: string, len: number, open: boolean): string | null {
  const re = new RegExp(`^([A-Za-z0-9_-]{${len}${open ? ',' : ''}})(?:[?&].*)?$`);
  const m = url.match(re);
  return m ? m[1] : null;
}

function ytEmbed(url: string, clip: Clip = NO_CLIP): { src: string; href: string; label: string } | null {
  // A timestamp in the URL applies unless an attr already overrode it.
  const c = clip.start == null ? { ...clip, start: ytUrlStart(url) } : clip;

  // A bare 11-char video ID (with or without a query tail) is a video, not a
  // playlist — check that first so `{13,}` can't swallow one.
  if (url.includes('list=') || (!bareId(url, 11, false) && bareId(url, 13, true))) {
    const list = ytPlaylistId(url);
    if (list) return {
      src:   withClipParams(`https://www.youtube-nocookie.com/embed/videoseries?list=${list}&rel=0`, c),
      href:  `https://www.youtube.com/playlist?list=${list}`,
      label: 'View playlist on YouTube',
    };
  }
  const vid = ytVideoId(url);
  if (vid) return {
    src:   withClipParams(`https://www.youtube-nocookie.com/embed/${vid}?rel=0`, c),
    // Keep the offset on the fallback link too, so the no-JS path lands in the
    // same place the embed would have.
    href:  `https://www.youtube.com/watch?v=${vid}` + (c.start != null ? `&t=${c.start}` : ''),
    label: 'Watch on YouTube',
  };
  return null;
}

/**
 * Maps an odysee.com video page URL to its iframe embed URL.
 *
 * The rule is simply to insert `$/embed/` after the host:
 *   https://odysee.com/@channel:c/video-name:a
 *     → https://odysee.com/$/embed/@channel:c/video-name:a
 *
 * We only accept absolute https URLs whose host is exactly odysee.com (or a
 * subdomain of it) and whose path is not already an `/$/...` app route, so a
 * crafted `src`/label can't redirect the embed elsewhere. Odysee exposes no
 * documented player API, so there is no equivalent of YouTube's enablejsapi.
 *
 * The embed takes a start offset as `?t=` in seconds — the same param the watch
 * URL uses, so a pasted timestamped link carries over. There is no end param.
 */
function odyseeEmbed(url: string, clip: Clip = NO_CLIP): { src: string; href: string; label: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/^(?:[a-z0-9-]+\.)*odysee\.com$/i.test(parsed.hostname)) return null;

  const path = parsed.pathname.replace(/^\/+/, '');
  // Reject app routes (`/$/...`, including an already-embed URL) and empty paths.
  if (!path || path.startsWith('$/')) return null;

  const start = clip.start ?? parseTimestamp(parsed.searchParams.get('t'));

  return {
    src:   `https://odysee.com/$/embed/${path}` + (start != null ? `?t=${start}` : ''),
    href:  url,
    label: 'Watch on Odysee',
  };
}

/**
 * Maps a vimeo.com video URL to its player embed URL.
 *
 * A public video is just its numeric ID:
 *   https://vimeo.com/76979871
 *     → https://player.vimeo.com/video/76979871
 *
 * An unlisted video carries a private hash as a second path segment, which the
 * embed needs as `?h=` or it answers 403:
 *   https://vimeo.com/76979871/abc123def4
 *     → https://player.vimeo.com/video/76979871?h=abc123def4
 *
 * A `/channels/…/ID` or `/groups/…/videos/ID` URL names the same video by a
 * longer route, and an already-`player.vimeo.com/video/ID` URL is accepted and
 * normalised, so pasting the embed link works too. We accept only absolute https
 * URLs on vimeo.com (or a subdomain), and require the ID to be numeric and the
 * hash a plain hex-ish token, so a crafted `src`/label can't point the iframe
 * elsewhere.
 *
 * The player takes a start offset as a `#t=` fragment (not a query param, unlike
 * every other embed here), and exposes no end parameter — so `end` does not
 * apply, as with Odysee.
 */
function vimeoEmbed(url: string, clip: Clip = NO_CLIP): { src: string; href: string; label: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/^(?:[a-z0-9-]+\.)*vimeo\.com$/i.test(parsed.hostname)) return null;

  // Accept only the routes that actually name a video: a bare ID at the root,
  // the player's `/video/ID`, and the channel/group forms. Matching any trailing
  // number instead would take `/groups/12345` — a group, not a video — and build
  // a dead embed from it.
  const m = parsed.pathname.match(
    /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d+)(?:\/([A-Za-z0-9]+))?\/?$/
  );
  if (!m) return null;
  const [, id, pathHash] = m;
  const hash = pathHash ?? parsed.searchParams.get('h');

  const start = clip.start ?? parseTimestamp(parsed.hash.replace(/^#t=/, ''));

  const query = hash && /^[A-Za-z0-9]+$/.test(hash) ? `?h=${hash}` : '';
  return {
    src:   `https://player.vimeo.com/video/${id}${query}` + (start != null ? `#t=${start}s` : ''),
    href:  `https://vimeo.com/${id}${hash ? '/' + hash : ''}` + (start != null ? `#t=${start}s` : ''),
    label: 'Watch on Vimeo',
  };
}

/**
 * Maps an instagram.com reel or post URL to its iframe embed URL.
 *
 * The rule is to append `embed/` to the canonical media path:
 *   https://www.instagram.com/reel/C8QltIDsWTG/
 *     → https://www.instagram.com/reel/C8QltIDsWTG/embed/
 *
 * `/reel/`, `/reels/`, `/p/` and `/tv/` all name the same kind of object and all
 * embed the same way. A profile-scoped reel URL
 * (`/username/reel/CODE/`) is accepted too; the leading segment carries no
 * meaning for the embed and is dropped.
 *
 * An already-`/embed/` URL is accepted and normalised, so pasting the embed link
 * works too. Any query tail is discarded — a shared reel arrives with a tracking
 * `?igsh=` that the embed endpoint has no use for. We accept only absolute https URLs on
 * instagram.com (or a subdomain), and require the shortcode to be a plain
 * base64url token, so a crafted `src`/label can't point the iframe elsewhere.
 *
 * The embed takes no start offset — there is no documented parameter for one —
 * so `start`/`end` do not apply here and no clip is threaded through.
 */
function instagramEmbed(url: string): { src: string; href: string; label: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/^(?:[a-z0-9-]+\.)*instagram\.com$/i.test(parsed.hostname)) return null;

  const m = parsed.pathname.match(/(?:^|\/)(reels?|p|tv)\/([A-Za-z0-9_-]+)(?:\/embed)?\/?$/);
  if (!m) return null;
  // `/reels/CODE/` is a valid share form but only `/reel/` embeds.
  const kind = m[1] === 'reels' ? 'reel' : m[1];

  return {
    src:   `https://www.instagram.com/${kind}/${m[2]}/embed/`,
    href:  `https://www.instagram.com/${kind}/${m[2]}/`,
    label: 'Watch on Instagram',
  };
}
