/**
 * types/video.ts
 *
 * Embeds a video in the node body. Two sources are supported:
 *
 *   1. YouTube videos and playlists (embedded via the IFrame Player API):
 *        {= video} https://www.youtube.com/watch?v=...
 *        {= video} dQw4w9WgXcQ          (bare 11-char video ID)
 *        {= video} https://www.youtube.com/playlist?list=...
 *        {= video} PLxxxxxxxxxxxxxxxxx  (bare 13+ char playlist ID)
 *
 *   2. Direct video files (embedded via a native <video> element):
 *        {= video} ./clip.mp4
 *        {= video} https://example.com/clip.webm
 *        {type: video; src: ./clip.mp4}
 *
 * For YouTube embeds the IFrame Player API (enablejsapi=1 + postMessage) is used
 * to toggle play/pause from the tree row via Enter or Space. For native files the
 * <video> element is toggled directly.
 *
 * Player state constants (from YT IFrame API):
 *   -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 video cued
 */

import type { TypeHandler, NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { resolveAttrs, treeNavKeydown, actionKeydown, copyPermalink, applyExhibit, expandNode, wireFocusGating } from '../handler-utils.js';
import type { FocusGating } from '../handler-utils.js';
import { resolveTagDef } from '../tags.js';

import { wireSelectThenToggle } from '../interaction.js';

// Tracks play state per YouTube iframe via onStateChange messages from the IFrame API.
// May not work in Firefox due to storage partitioning; in that case
// Enter/Space will always send playVideo (no toggle).
const _ytPlaying = new WeakMap<HTMLIFrameElement, boolean>();

window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.youtube-nocookie.com') return;
  let data: any;
  try { data = JSON.parse(e.data); } catch { return; }
  if (data.event !== 'infoDelivery' || data.info?.playerState == null) return;
  for (const iframe of document.querySelectorAll<HTMLIFrameElement>('.video-wrap iframe')) {
    if (iframe.contentWindow === e.source) {
      _ytPlaying.set(iframe, data.info.playerState === 1 || data.info.playerState === 3);
      break;
    }
  }
});

// Extensions we treat as direct video files (native <video>).
const FILE_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:[?#]|$)/i;

class VideoTypeHandler implements TypeHandler {
  readonly content:    HTMLElement;
  readonly selectable: boolean = true;

  private readonly _canonicalHref:  string | null;
  private _iframe:                  HTMLIFrameElement | null = null;
  private _video:                   HTMLVideoElement | null = null;
  private _gating!: FocusGating;

  constructor(renderNode: RenderNode) {
    const sourceNode = renderNode.sourceNode;
    const attrs = resolveAttrs(sourceNode);
    const rawUrl = attrs.get('src') ?? (sourceNode.label || null);

    const content = document.createElement('div');
    this.content = content;

    // ── Classes ──────────────────────────────────────────────────────────────
    content.classList.add('node-content--video');

    for (const { name, props } of sourceNode.tags) {
      const def = resolveTagDef(name, props, sourceNode.sourceFile.tagDefs);
      for (const cls of def.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));
    }
    for (const cls of attrs.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));


    // ── ARIA / selection ─────────────────────────────────────────────────────
    content.setAttribute('role', 'treeitem');

    renderNode.selectable = true;
    renderNode.meta = sourceNode.meta;

    this._gating = wireFocusGating(
      content,
      () => content.querySelectorAll<HTMLElement>('iframe, video'),
    );

    // ── Click wiring ──────────────────────────────────────────────────────────
    applyExhibit(renderNode, attrs);

    wireSelectThenToggle(content, () => {});

    const li = renderNode.li;

    // Decide between a direct video file and a YouTube embed.
    const fileUrl = rawUrl && isFileSource(rawUrl)
      ? safeMediaUrl(sourceNode.sourceFile.resolveMediaUrl(rawUrl))
      : null;

    if (fileUrl) {
      this._canonicalHref = fileUrl;
      const wrap = document.createElement('div');
      wrap.className = 'video-wrap';
      const video = document.createElement('video');
      video.src = fileUrl;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      // Don't leak the visitor's Referer to third-party video hosts.
      video.setAttribute('referrerpolicy', 'no-referrer');
      wrap.appendChild(video);
      content.appendChild(wrap);
      this._video = video;
    } else {
      const embed = rawUrl ? ytEmbed(rawUrl) : null;
      this._canonicalHref = embed?.href ?? null;
      if (embed) {
        const wrap = document.createElement('div');
        wrap.className = 'video-wrap';
        wrap.innerHTML = `<iframe
          src="${embed.src}&enablejsapi=1"
          allowfullscreen
          loading="lazy"
        ></iframe>`;
        content.appendChild(wrap);

        this._iframe = wrap.querySelector('iframe')!;
        this._iframe.addEventListener('load', () => {
          this._iframe!.contentWindow!.postMessage(
            JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
            'https://www.youtube-nocookie.com'
          );
        });
      }
    }

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

    void expandNode(renderNode);
  }

  get modeActive(): boolean { return this._gating.modeActive; }
  activate():   void { this._gating.activate(); }
  deactivate(): void { this._gating.deactivate(); }
  onSelect(): void {}
  onDeselect(): void {}

  private _togglePlayback(): void {
    if (this._video) {
      if (this._video.paused) void this._video.play();
      else this._video.pause();
      return;
    }
    if (!this._iframe) return;
    const playing = _ytPlaying.get(this._iframe) ?? false;
    this._iframe.contentWindow!.postMessage(
      JSON.stringify({ event: 'command', func: playing ? 'pauseVideo' : 'playVideo', args: [] }),
      'https://www.youtube-nocookie.com'
    );
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const videoFactory: NodeTypeFactory = {
  create(renderNode) {
    return new VideoTypeHandler(renderNode);
  },
  staticRenderBody(node) {
    const rawUrl = node.attrs.get('src') ?? (node.label || null);
    if (!rawUrl) return null;
    if (isFileSource(rawUrl)) {
      const url = safeMediaUrl(node.sourceFile.resolveMediaUrl(rawUrl));
      if (!url) return null;
      return `<video src="${esc(url)}" controls preload="metadata" playsinline referrerpolicy="no-referrer"></video>`;
    }
    const embed = ytEmbed(rawUrl);
    if (!embed) return null;
    return `<p><a href="${embed.href}" target="_blank" rel="noopener noreferrer">${embed.label}</a></p>`;
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

/** True when the source points at a direct video file rather than a YouTube link. */
function isFileSource(url: string): boolean {
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return false;
  return FILE_EXT_RE.test(url);
}

function ytPlaylistId(url: string): string | null {
  if (/^[A-Za-z0-9_-]{13,}$/.test(url)) return url;
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function ytVideoId(url: string): string | null {
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function ytEmbed(url: string): { src: string; href: string; label: string } | null {
  if (url.includes('list=') || /^[A-Za-z0-9_-]{13,}$/.test(url)) {
    const list = ytPlaylistId(url);
    if (list) return {
      src:   `https://www.youtube-nocookie.com/embed/videoseries?list=${list}&rel=0`,
      href:  `https://www.youtube.com/playlist?list=${list}`,
      label: 'View playlist on YouTube',
    };
  }
  const vid = ytVideoId(url);
  if (vid) return {
    src:   `https://www.youtube-nocookie.com/embed/${vid}?rel=0`,
    href:  `https://www.youtube.com/watch?v=${vid}`,
    label: 'Watch on YouTube',
  };
  return null;
}
