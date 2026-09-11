/**
 * GMN Universal Video Summarizer — Main World Script
 * Scoped video harvester for React Fiber, Relay GraphQL, Vue, Web Components, and platform players.
 */
(function() {
  'use strict';

  if (window.__GVC_MAIN_WORLD_INJECTED__) return;
  window.__GVC_MAIN_WORLD_INJECTED__ = true;

  // Cache: tweetId -> video_info object
  const VIDEO_CACHE = new Map();
  const M3U8_CACHE = new Map();

  // ── Harvest Video Info from Twitter / X GraphQL & API payloads ──────────────
  function harvestVideos(json) {
    if (!json || typeof json !== 'object') return;

    function walk(node, currentId, depth) {
      if (!node || depth > 25 || typeof node !== 'object') return;

      // Extract tweet ID if present
      let tweetId = null;
      if (node.rest_id && /^\d+$/.test(String(node.rest_id))) {
        tweetId = String(node.rest_id);
      } else if (node.id_str && /^\d+$/.test(String(node.id_str))) {
        tweetId = String(node.id_str);
      } else if (node.tweet && (node.tweet.rest_id || node.tweet.id_str)) {
        tweetId = String(node.tweet.rest_id || node.tweet.id_str);
      } else {
        tweetId = currentId;
      }

      // Extract video_info if present
      let videoInfo = null;
      if (node.video_info && Array.isArray(node.video_info.variants)) {
        videoInfo = node.video_info;
      } else if (node.legacy && node.legacy.extended_entities && Array.isArray(node.legacy.extended_entities.media)) {
        const found = node.legacy.extended_entities.media.find(m => m && m.video_info && Array.isArray(m.video_info.variants));
        if (found) videoInfo = found.video_info;
      } else if (Array.isArray(node.media)) {
        const found = node.media.find(m => m && m.video_info && Array.isArray(m.video_info.variants));
        if (found) videoInfo = found.video_info;
      }

      if (tweetId && videoInfo) {
        if (VIDEO_CACHE.size >= 150) {
          const oldestKey = VIDEO_CACHE.keys().next().value;
          VIDEO_CACHE.delete(oldestKey);
        }
        VIDEO_CACHE.set(String(tweetId), videoInfo);
      }

      // Continue traversing
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          walk(node[i], restId, depth + 1);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) {
          const val = node[keys[i]];
          if (val && typeof val === 'object') {
            walk(val, restId, depth + 1);
          }
        }
      }
    }

    try { walk(json, null, 0); } catch (_) {}
  }

  const isTwitter = window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com');

  // ── Universal HLS.js Interceptor ─────────────────────────────────────────────
  function hookHls(HlsClass) {
    if (!HlsClass || HlsClass.__gvcHooked) return;
    HlsClass.__gvcHooked = true;

    const origLoadSource = HlsClass.prototype.loadSource;
    if (typeof origLoadSource === 'function') {
      HlsClass.prototype.loadSource = function(url) {
        if (url && typeof url === 'string') {
          M3U8_CACHE.set(url, { url, time: Date.now() });
          this.__gvc_m3u8 = url;
          if (this.media) this.media.__gvc_m3u8 = url;
          window.postMessage({ type: 'GVC_M3U8_CAPTURED', url }, '*');
        }
        return origLoadSource.apply(this, arguments);
      };
    }

    const origAttachMedia = HlsClass.prototype.attachMedia;
    if (typeof origAttachMedia === 'function') {
      HlsClass.prototype.attachMedia = function(media) {
        if (media) {
          media.__gvc_hls = this;
          if (this.__gvc_m3u8) media.__gvc_m3u8 = this.__gvc_m3u8;
        }
        return origAttachMedia.apply(this, arguments);
      };
    }
  }

  try {
    let _Hls = window.Hls;
    if (_Hls) {
      hookHls(_Hls);
    } else {
      Object.defineProperty(window, 'Hls', {
        configurable: true,
        enumerable: true,
        get() { return _Hls; },
        set(val) {
          _Hls = val;
          try { hookHls(val); } catch (_) {}
        }
      });
    }
  } catch (_) {}

  // ── Hook Fetch & XMLHttpRequest for Playlists & Twitter GraphQL ─────────────
  try {
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (url && (url.includes('.m3u8') || url.includes('/hls/'))) {
          M3U8_CACHE.set(url, { url, time: Date.now() });
          window.postMessage({ type: 'GVC_M3U8_CAPTURED', url }, '*');
        } else if (isTwitter && url && (url.includes('/graphql/') || url.includes('/i/api/'))) {
          p.then(res => {
            res.clone().json().then(harvestVideos).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(...args) {
      this._gvcUrl = args[1];
      try {
        const url = args[1];
        if (url && (url.includes('.m3u8') || url.includes('/hls/'))) {
          M3U8_CACHE.set(url, { url, time: Date.now() });
          window.postMessage({ type: 'GVC_M3U8_CAPTURED', url }, '*');
        }
      } catch (_) {}
      return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      if (isTwitter) {
        this.addEventListener('load', function() {
          try {
            if (this._gvcUrl && (this._gvcUrl.includes('/graphql/') || this._gvcUrl.includes('/i/api/'))) {
              const json = JSON.parse(this.responseText);
              harvestVideos(json);
            }
          } catch (_) {}
        });
      }
      return origSend.apply(this, args);
    };
  } catch (_) {}

  // ── High-Performance Cyclic Safe Video Extractor ──────────────────────────────
  function extractVideosFromObject(root) {
    if (!root || typeof root !== 'object') return [];
    const results = [];
    const seen = new Set();

    function walk(node, depth) {
      if (!node || depth > 18 || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      // 1. Facebook / Meta / Instagram Direct Keys
      if (typeof node.browser_native_hd_url === 'string' && node.browser_native_hd_url) {
        results.push({ url: node.browser_native_hd_url, label: 'HD Quality', badge: 'HD', bitrate: 3000000 });
      }
      if (typeof node.browser_native_sd_url === 'string' && node.browser_native_sd_url) {
        results.push({ url: node.browser_native_sd_url, label: 'SD Quality', badge: 'SD', bitrate: 900000 });
      }
      if (typeof node.playable_url_quality_hd === 'string' && node.playable_url_quality_hd) {
        results.push({ url: node.playable_url_quality_hd, label: 'HD Quality', badge: 'HD', bitrate: 3000000 });
      }
      if (typeof node.playable_url === 'string' && node.playable_url) {
        results.push({ url: node.playable_url, label: 'Standard Stream', bitrate: 1200000 });
      }
      if (typeof node.hd_src === 'string' && node.hd_src) {
        results.push({ url: node.hd_src, label: 'HD Quality', badge: 'HD', bitrate: 3000000 });
      }
      if (typeof node.sd_src === 'string' && node.sd_src) {
        results.push({ url: node.sd_src, label: 'SD Quality', badge: 'SD', bitrate: 900000 });
      }
      if (typeof node.hd_src_no_ratelimit === 'string' && node.hd_src_no_ratelimit) {
        results.push({ url: node.hd_src_no_ratelimit, label: 'HD Quality', badge: 'HD', bitrate: 3000000 });
      }
      if (typeof node.sd_src_no_ratelimit === 'string' && node.sd_src_no_ratelimit) {
        results.push({ url: node.sd_src_no_ratelimit, label: 'SD Quality', badge: 'SD', bitrate: 900000 });
      }
      if (typeof node.playbackUrl === 'string' && node.playbackUrl) {
        results.push({ url: node.playbackUrl });
      }
      if (typeof node.dash_manifest === 'string' && node.dash_manifest) {
        results.push({ url: node.dash_manifest, content_type: 'application/dash+xml' });
      }

      // 2. TikTok Keys
      if (typeof node.playAddr === 'string' && node.playAddr) {
        results.push({ url: node.playAddr, label: 'TikTok HD', badge: 'HD' });
      }
      if (typeof node.downloadAddr === 'string' && node.downloadAddr) {
        results.push({ url: node.downloadAddr, label: 'TikTok Original' });
      }

      // 3. Reddit Keys
      if (typeof node.fallback_url === 'string' && node.fallback_url) {
        results.push({ url: node.fallback_url, bitrate: node.bitrate_kbps ? node.bitrate_kbps * 1000 : 0 });
      }
      if (typeof node.hls_url === 'string' && node.hls_url) {
        results.push({ url: node.hls_url, content_type: 'application/x-mpegURL' });
      }

      // 4. YouTube Streaming Data
      if (node.streamingData) {
        const formats = [...(node.streamingData.formats || []), ...(node.streamingData.adaptiveFormats || [])];
        formats.forEach(f => {
          if (f && f.url && f.mimeType && f.mimeType.startsWith('video/')) {
            results.push({
              url: f.url,
              bitrate: f.bitrate,
              width: f.width,
              height: f.height,
              label: f.qualityLabel || `${f.height}p`
            });
          }
        });
      }

      // 5. Variants Array (Twitter / X / Instagram)
      if (Array.isArray(node.video_versions)) {
        node.video_versions.forEach(v => { if (v && v.url) results.push(v); });
      }
      if (Array.isArray(node.variants)) {
        node.variants.forEach(v => { if (v && v.url) results.push(v); });
      }

      // Safe child property traversal (skipping parent/circular pointers)
      if (Array.isArray(node)) {
        for (let i = 0; i < Math.min(node.length, 50); i++) {
          walk(node[i], depth + 1);
        }
      } else {
        // Specific fiber traversal keys
        if (node.memoizedProps) walk(node.memoizedProps, depth + 1);
        if (node.memoizedState) walk(node.memoizedState, depth + 1);
        if (node.pendingProps)  walk(node.pendingProps, depth + 1);
        if (node.stateNode && typeof node.stateNode === 'object') walk(node.stateNode, depth + 1);
        if (node.child)         walk(node.child, depth + 1);
        if (node.sibling)       walk(node.sibling, depth + 1);

        // General object keys
        const keys = Object.keys(node);
        for (let i = 0; i < Math.min(keys.length, 50); i++) {
          const k = keys[i];
          if (k === 'return' || k === 'alternate' || k === '_owner' || k === 'parent' || k === 'children') continue;
          const val = node[k];
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      }
    }

    try { walk(root, 0); } catch (_) {}
    return results;
  }

  // ── Scoped Post & Fiber Inspector ─────────────────────────────────────────────
  function harvestScopedElement(el) {
    if (!el) return [];
    const results = [];

    // 1. Direct Video element sources & HTML5 source children
    if (el.tagName === 'VIDEO') {
      const src = el.currentSrc || el.src;
      if (src && typeof src === 'string' && !src.startsWith('blob:')) {
        results.push({
          url: src,
          content_type: src.includes('.webm') ? 'video/webm' : (src.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4'),
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          duration: el.duration || 0,
          badge: src.includes('.m3u8') ? 'HLS' : 'Direct'
        });
      }

      // Check <source> child elements
      try {
        const sources = el.querySelectorAll('source');
        sources.forEach(s => {
          const sSrc = s.src || s.getAttribute('src');
          if (sSrc && typeof sSrc === 'string' && !sSrc.startsWith('blob:')) {
            results.push({
              url: sSrc,
              content_type: s.type || (sSrc.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4'),
              badge: sSrc.includes('.m3u8') ? 'HLS' : 'Direct'
            });
          }
        });
      } catch (_) {}

      // Check custom player attributes (Hls.js, Video.js, JWPlayer, Plyr)
      const hlsUrl = el.hls?.url || el._hls?.url || el.__hls?.url || el.__gvc_m3u8 || el.__gvc_hls?.url || el.dataset?.hls || el.dataset?.src || el.dataset?.stream;
      if (hlsUrl && typeof hlsUrl === 'string' && !hlsUrl.startsWith('blob:')) {
        results.push({ url: hlsUrl, content_type: 'application/x-mpegURL', badge: 'HLS' });
      }

      // If video has no direct source but M3U8_CACHE has cached playlists, attach them
      if (!results.length && M3U8_CACHE.size > 0) {
        for (const [mUrl] of M3U8_CACHE.entries()) {
          results.push({
            url: mUrl,
            content_type: 'application/x-mpegURL',
            width: el.videoWidth || 0,
            height: el.videoHeight || 0,
            duration: el.duration || 0,
            badge: 'HLS'
          });
        }
      }
    }

    // 2. Climb up the DOM tree to inspect React/Vue instances on the clicked post
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 15) {
      depth++;
      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.startsWith('__reactProps') || k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__vue')) {
          try {
            const harvested = extractVideosFromObject(cur[k]);
            if (harvested.length) results.push(...harvested);
          } catch (_) {}
        }
      }

      // Check Reddit custom component attributes
      if (cur.tagName === 'SHREDDIT-PLAYER') {
        const pkg = cur.getAttribute('packaged-media-json');
        if (pkg) try { results.push(...extractVideosFromObject(JSON.parse(pkg))); } catch (_) {}
        const hls = cur.getAttribute('hls-url');
        if (hls) results.push({ url: hls, content_type: 'application/x-mpegURL' });
        const stream = cur.getAttribute('stream-url');
        if (stream) results.push({ url: stream });
      }

      // Stop climbing once we reach the enclosing article/feed card
      if (cur.getAttribute('role') === 'article' ||
          cur.getAttribute('data-pagelet')?.includes('FeedUnit') ||
          cur.classList.contains('userContentWrapper')) {
        break;
      }

      cur = cur.parentElement;
    }

    // Method 3: Inspect Global JWPlayer, Hls.js, DPlayer, and ArtPlayer instances
    if (typeof window.jwplayer === 'function') {
      try {
        const jw = window.jwplayer();
        if (jw) {
          const item = jw.getPlaylistItem ? jw.getPlaylistItem() : null;
          const levels = jw.getQualityLevels ? jw.getQualityLevels() : [];
          const currentIdx = jw.getCurrentQuality ? jw.getCurrentQuality() : 0;
          const activeLevel = levels[currentIdx];

          if (item && Array.isArray(item.sources)) {
            item.sources.forEach((s, sIdx) => {
              if (s.file && typeof s.file === 'string' && !s.file.startsWith('blob:')) {
                results.push({
                  url: s.file,
                  label: s.label || (s.height ? `${s.height}p` : `Quality ${sIdx + 1}`),
                  height: s.height || (s.label ? parseInt(s.label) : 0),
                  width: s.width || 0,
                  isHls: s.file.includes('.m3u8') || s.type === 'hls',
                  badge: sIdx === currentIdx ? 'Active' : ''
                });
              }
            });
          }

          if (item && item.file && typeof item.file === 'string' && !item.file.startsWith('blob:')) {
            results.push({
              url: item.file,
              label: activeLevel ? (activeLevel.label || `${activeLevel.height}p`) : 'JWPlayer Stream',
              height: activeLevel ? activeLevel.height : 0,
              width: activeLevel ? activeLevel.width : 0,
              isHls: item.file.includes('.m3u8'),
              badge: 'Active'
            });
          }

          if (levels.length > 1 && item && (item.file || item.sources)) {
            const masterUrl = item.file || (item.sources && item.sources[0]?.file);
            if (masterUrl) {
              levels.forEach((lvl, lIdx) => {
                results.push({
                  url: masterUrl,
                  label: lvl.label || (lvl.height ? `${lvl.height}p` : `Level ${lIdx + 1}`),
                  height: lvl.height || 0,
                  width: lvl.width || 0,
                  bitrate: lvl.bitrate || 0,
                  isHls: true,
                  badge: lIdx === currentIdx ? 'Active' : ''
                });
              });
            }
          }
        }
      } catch (_) {}
    }

    if (window.hls && window.hls.levels && window.hls.url) {
      try {
        const curLevel = window.hls.currentLevel;
        window.hls.levels.forEach((lvl, idx) => {
          results.push({
            url: lvl.url || window.hls.url,
            label: lvl.name || (lvl.height ? `${lvl.height}p` : `Level ${idx + 1}`),
            height: lvl.height || 0,
            width: lvl.width || 0,
            bitrate: lvl.bitrate || 0,
            isHls: true,
            badge: idx === curLevel ? 'Active' : ''
          });
        });
      } catch (_) {}
    }

    return results;
  }

  // ── Auto-Hook JWPlayer Events ───────────────────────────────────────────────
  function tryHookJWPlayer() {
    if (typeof window.jwplayer !== 'function') return;
    try {
      const player = window.jwplayer();
      if (!player || typeof player.on !== 'function') return;
      if (player._gvcHooked) return;
      player._gvcHooked = true;

      player.on('levelsChanged', (e) => {
        const lvls = player.getQualityLevels ? player.getQualityLevels() : [];
        const chosen = lvls[e.currentQuality] || {};
        window.postMessage({
          type: 'GVC_JWPLAYER_QUALITY_CHANGED',
          qualityIndex: e.currentQuality,
          label: chosen.label || (chosen.height ? `${chosen.height}p` : ''),
          height: chosen.height || 0,
          width: chosen.width || 0
        }, '*');
      });

      player.on('levels', (e) => {
        window.postMessage({
          type: 'GVC_JWPLAYER_LEVELS_LOADED',
          levels: e.levels
        }, '*');
      });
    } catch (_) {}
  }

  setInterval(tryHookJWPlayer, 2000);
  tryHookJWPlayer();

  // ── React Fiber & Props Extractor (Dedicated for Twitter / X) ───────────────
  function findVideoInfoInObj(obj, depth = 0, seen = new WeakSet()) {
    if (!obj || depth > 25 || typeof obj !== 'object') return null;
    if (seen.has(obj)) return null;
    seen.add(obj);

    if (obj.video_info && Array.isArray(obj.video_info.variants) && obj.video_info.variants.length > 0) {
      return obj.video_info;
    }
    if (Array.isArray(obj.variants) && obj.variants.some(v => v && v.content_type && v.url)) {
      return obj;
    }

    if (obj.legacy && obj.legacy.extended_entities && Array.isArray(obj.legacy.extended_entities.media)) {
      for (const m of obj.legacy.extended_entities.media) {
        if (m && m.video_info && Array.isArray(m.video_info.variants)) return m.video_info;
      }
    }

    if (Array.isArray(obj.media)) {
      for (const m of obj.media) {
        if (m && m.video_info && Array.isArray(m.video_info.variants)) return m.video_info;
      }
    }

    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === 'stateNode' && depth > 5) continue;
      try {
        const val = obj[k];
        if (val && typeof val === 'object') {
          const found = findVideoInfoInObj(val, depth + 1, seen);
          if (found) return found;
        }
      } catch (_) {}
    }
    return null;
  }

  function extractTwitterFromDOM(el) {
    if (!el) return null;
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.startsWith('__reactProps') || k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')) {
          const found = findVideoInfoInObj(cur[k]);
          if (found) return found;

          // If it's fiber, walk upwards
          if (k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')) {
            let fiber = cur[k];
            let steps = 0;
            while (fiber && steps < 50) {
              if (fiber.memoizedProps) {
                const res = findVideoInfoInObj(fiber.memoizedProps);
                if (res) return res;
              }
              if (fiber.memoizedState) {
                const res = findVideoInfoInObj(fiber.memoizedState);
                if (res) return res;
              }
              fiber = fiber.return;
              steps++;
            }
          }
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // ── Handle Scoped Queries from content.js ────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === 'GVC_CLEAR_CACHE_REQ') {
      try {
        VIDEO_CACHE.clear();
        M3U8_CACHE.clear();
      } catch (_) {}
      return;
    }

    if (e.data.type !== 'GVC_GET_VIDEO_INFO_REQ') return;

    const { queryId, tweetId } = e.data;
    let variants = [];

    // Method 1: Check Twitter GraphQL Cache by Tweet ID
    if (tweetId && VIDEO_CACHE.has(String(tweetId))) {
      const cached = VIDEO_CACHE.get(String(tweetId));
      if (cached && Array.isArray(cached.variants)) {
        variants.push(...cached.variants);
      }
    }

    // Method 2 (Twitter/X): Deep React Fiber upward inspection
    if (!variants.length && (isTwitter || tweetId)) {
      if (queryId) {
        const elements = document.querySelectorAll(`[data-gvc-qid="${queryId}"]`);
        for (const el of elements) {
          const vInfo = extractTwitterFromDOM(el);
          if (vInfo && Array.isArray(vInfo.variants) && vInfo.variants.length > 0) {
            variants.push(...vInfo.variants);
            break;
          }
        }
      }
      if (!variants.length) {
        let targetEl = null;
        if (tweetId) {
          const links = document.querySelectorAll(`article a[href*="/status/${tweetId}"]`);
          for (const l of links) {
            const art = l.closest('article') || l.closest('[data-testid="tweet"]');
            if (art) { targetEl = art; break; }
          }
        }
        if (!targetEl) {
          const videos = Array.from(document.querySelectorAll('video'));
          const playing = videos.find(v => !v.paused && !v.ended && v.currentTime > 0);
          targetEl = playing || videos.find(v => {
            const r = v.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight && r.width > 120 && r.height > 120;
          }) || videos[0];
        }
        if (targetEl) {
          const vInfo = extractTwitterFromDOM(targetEl);
          if (vInfo && Array.isArray(vInfo.variants) && vInfo.variants.length > 0) {
            variants.push(...vInfo.variants);
          }
        }
      }
    }

    // Method 3 (Universal): Inspect Scoped Element from target query ID
    if (!variants.length && queryId) {
      const elements = document.querySelectorAll(`[data-gvc-qid="${queryId}"]`);
      for (const el of elements) {
        const harvested = harvestScopedElement(el);
        if (harvested.length) {
          variants.push(...harvested);
          break;
        }
      }
    }

    // Method 4 (Universal Fallback): Fallback search on all candidate video containers on page
    if (!variants.length) {
      const candidateElements = document.querySelectorAll('video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="previewInterstitial"], [data-testid="tweetPhoto"], [role="dialog"], article');
      for (const el of candidateElements) {
        if (el.dataset && el.dataset.gvcHlsUrl) {
          variants.push({
            url: el.dataset.gvcHlsUrl,
            label: 'HLS Master Stream (Player Source)',
            isHls: true
          });
        }
        const harvested = harvestScopedElement(el);
        if (harvested.length) {
          variants.push(...harvested);
          break;
        }
      }
    }

    // Method 5 (Universal Fallback): If no variants found, attach any recently captured m3u8 playlists
    if (!variants.length && typeof M3U8_CACHE !== 'undefined' && M3U8_CACHE && M3U8_CACHE.size > 0) {
      for (const [mUrl, mData] of M3U8_CACHE.entries()) {
        variants.push({
          url: mUrl,
          label: 'HLS Stream (Intercepted Manifest)',
          isHls: true
        });
      }
    }

    // Filter valid URLs (reject blob: URLs)
    const valid = variants.filter(v => v && v.url && typeof v.url === 'string' && !v.url.startsWith('blob:'));

    window.postMessage({
      type: 'GVC_GET_VIDEO_INFO_RES',
      queryId: queryId,
      success: valid.length > 0,
      variants: valid
    }, '*');
  });

  // ── YouTube Native Player & Metadata Prober ──────────────────────────────────
  function probeYouTube() {
    if (!window.location.hostname.includes('youtube.com')) return null;

    let player = document.getElementById('movie_player');
    let videoData = null;
    let duration = 0;
    let currentTime = 0;
    let playerResponse = null;

    if (player) {
      if (typeof player.getVideoData === 'function') {
        try { videoData = player.getVideoData(); } catch (_) {}
      }
      if (typeof player.getDuration === 'function') {
        try { duration = player.getDuration() || 0; } catch (_) {}
      }
      if (typeof player.getCurrentTime === 'function') {
        try { currentTime = player.getCurrentTime() || 0; } catch (_) {}
      }
      if (typeof player.getPlayerResponse === 'function') {
        try { playerResponse = player.getPlayerResponse(); } catch (_) {}
      }
    }

    if (!playerResponse && window.ytInitialPlayerResponse) {
      playerResponse = window.ytInitialPlayerResponse;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const videoId = (videoData && videoData.video_id) || urlParams.get('v') || (window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/) || [])[1];
    if (!videoId) return null;

    if (!duration && playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.lengthSeconds) {
      duration = parseInt(playerResponse.videoDetails.lengthSeconds, 10) || 0;
    }

    const title = (videoData && videoData.title) || (playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.title) || document.title.replace(' - YouTube', '');

    // Extract formats from streamingData
    let audioStreams = [];
    let videoStreams = [];
    if (playerResponse && playerResponse.streamingData) {
      const allFormats = (playerResponse.streamingData.formats || []).concat(playerResponse.streamingData.adaptiveFormats || []);
      for (const f of allFormats) {
        let streamUrl = f.url;
        if (streamUrl) {
          if (f.mimeType && f.mimeType.includes('audio/')) {
            audioStreams.push({
              url: streamUrl,
              mimeType: f.mimeType,
              bitrate: f.bitrate,
              contentLength: f.contentLength,
              label: `Audio (${Math.round((f.bitrate || 128000) / 1000)} kbps)`
            });
          } else if (f.mimeType && f.mimeType.includes('video/')) {
            videoStreams.push({
              url: streamUrl,
              mimeType: f.mimeType,
              bitrate: f.bitrate,
              qualityLabel: f.qualityLabel || `${f.height || 360}p`,
              contentLength: f.contentLength,
              label: `Video (${f.qualityLabel || `${f.height || 360}p`})`
            });
          }
        }
      }
    }

    let availableQualityLevels = [];
    if (player && typeof player.getAvailableQualityLevels === 'function') {
      try { availableQualityLevels = player.getAvailableQualityLevels() || []; } catch (_) {}
    }

    const progressiveFormats = (playerResponse && playerResponse.streamingData && playerResponse.streamingData.formats) || [];
    const progressiveQualities = progressiveFormats
      .map(f => f.qualityLabel || (f.height ? `${f.height}p` : (f.itag === 18 ? '360p' : (f.itag === 22 ? '720p' : null))))
      .filter(Boolean);
    if (progressiveQualities.length === 0) {
      progressiveQualities.push('360p');
    }

    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      duration: Math.round(duration),
      currentTime: Math.round(currentTime),
      audioStreams,
      videoStreams,
      availableQualityLevels,
      progressiveQualities
    };
  }

  // Broadcast YouTube data when requested or on video navigation
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'GVC_REQ_YOUTUBE_DATA') {
      const ytData = probeYouTube();
      window.postMessage({
        type: 'GVC_YOUTUBE_DATA_RES',
        queryId: e.data.queryId,
        data: ytData
      }, '*');
    } else if (e.data.type === 'GVC_SET_YOUTUBE_QUALITY') {
      const q = e.data.quality;
      const player = document.getElementById('movie_player');
      if (player) {
        const qMap = {
          '1080p': 'hd1080',
          '720p': 'hd720',
          '480p': 'large',
          '360p': 'medium',
          '240p': 'small',
          '144p': 'tiny'
        };
        const ytQ = qMap[q] || 'auto';
        try {
          if (typeof player.setPlaybackQualityRange === 'function') {
            player.setPlaybackQualityRange(ytQ, ytQ);
          }
          if (typeof player.setPlaybackQuality === 'function') {
            player.setPlaybackQuality(ytQ);
          }
        } catch (_) {}
      }
    } else if (e.data.type === 'GVC_SEEK_PLAYER') {
      const sec = parseFloat(e.data.seconds);
      if (!isNaN(sec) && sec >= 0) {
        const player = document.getElementById('movie_player');
        if (player && typeof player.seekTo === 'function') {
          try { player.seekTo(sec, true); } catch (_) {}
        }
        const v = document.querySelector('video');
        if (v) {
          try { v.currentTime = sec; v.play(); } catch (_) {}
        }
      }
    } else if (e.data.type === 'GVC_RESOLVE_YOUTUBE_STREAM') {
      const { videoId, quality = '360p', mediaType = 'video', queryId, cookies: passedCookies } = e.data;
      (async () => {
        try {
          let InnertubeClass = window.Innertube || globalThis.Innertube;
          if (!InnertubeClass) {
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 100));
              InnertubeClass = window.Innertube || globalThis.Innertube;
              if (InnertubeClass) break;
            }
          }

          let formats = [];
          let videoTitle = document.title.replace(' - YouTube', '').trim();
          let inPagePlayerResponse = null;

          // 1. Check in-page player response first (0ms latency, genuine session)
          try {
            const playerEl = document.getElementById('movie_player');
            if (playerEl && typeof playerEl.getPlayerResponse === 'function') {
              inPagePlayerResponse = playerEl.getPlayerResponse();
            }
          } catch (_) {}

          if (!inPagePlayerResponse && typeof window.ytInitialPlayerResponse === 'object' && window.ytInitialPlayerResponse) {
            inPagePlayerResponse = window.ytInitialPlayerResponse;
          }

          if (inPagePlayerResponse && inPagePlayerResponse.streamingData) {
            const sd = inPagePlayerResponse.streamingData;
            const inPageFormats = (sd.formats || []).concat(sd.adaptiveFormats || []);
            if (inPageFormats.length > 0) {
              formats = inPageFormats;
              if (inPagePlayerResponse.videoDetails?.title) {
                videoTitle = inPagePlayerResponse.videoDetails.title;
              }
            }
          }

          // 1b. If in-page formats exist from active authorized session, decipher their signatureCipher directly
          if (formats.length > 0) {
            let player = null;
            if (InnertubeClass) {
              try {
                const ytDec = await InnertubeClass.create({ generate_session_locally: true });
                player = ytDec.session?.player;
              } catch (_) {}
            }

            for (const f of formats) {
              if (!f.url) {
                const cipher = f.signatureCipher || f.signature_cipher || f.cipher;
                if (cipher) {
                  try {
                    if (player && typeof player.decipher === 'function') {
                      f.url = await player.decipher(cipher);
                    } else {
                      const params = new URLSearchParams(cipher);
                      const rawUrl = params.get('url');
                      const s = params.get('s');
                      const sp = params.get('sp') || 'sig';
                      if (rawUrl) {
                        f.url = s ? `${rawUrl}&${sp}=${encodeURIComponent(s)}` : rawUrl;
                      }
                    }
                  } catch (e) {
                    console.warn('[GVC Main] Error deciphering in-page format:', e);
                  }
                }
              }
            }
          }

          // 1c. If active tab is already playing the video, sniff the active googlevideo stream from performance entries
          if (!formats.length || !formats.some(f => f.url)) {
            try {
              const resEntries = (window.performance && typeof window.performance.getEntriesByType === 'function')
                ? window.performance.getEntriesByType('resource')
                : [];
              const gvEntries = (resEntries || []).filter(r => r.name && r.name.includes('googlevideo.com/videoplayback'));
              if (gvEntries.length > 0) {
                for (let i = gvEntries.length - 1; i >= 0; i--) {
                  const entryUrl = gvEntries[i].name;
                  try {
                    const u = new URL(entryUrl);
                    u.searchParams.delete('range');
                    const streamUrl = u.toString();
                    const itag = parseInt(u.searchParams.get('itag'), 10) || 18;
                    const isAudio = itag === 140 || itag === 251 || itag === 250 || itag === 249;
                    formats.push({
                      itag,
                      url: streamUrl,
                      quality_label: itag === 18 ? '360p' : (itag === 22 ? '720p' : 'Auto'),
                      has_video: !isAudio,
                      has_audio: itag === 18 || itag === 22 || isAudio
                    });
                  } catch (_) {}
                }
              }
            } catch (_) {}
          }

          // 2. If in-page formats not available or lack direct urls, resolve via Innertube waterfall with cookies
          let info = null;
          let lastPlayabilityStatus = inPagePlayerResponse?.playabilityStatus || null;

          if (!formats.length || !formats.some(f => f.url)) {
            if (!InnertubeClass) {
              throw new Error('YouTube.js engine not loaded in page');
            }
            const activeCookie = passedCookies || document.cookie || undefined;
            const primaryClient = activeCookie ? 'MWEB' : 'ANDROID';
            const yt = await InnertubeClass.create({
              client_type: primaryClient,
              cookie: activeCookie
            });

            const clientList = activeCookie
              ? ['MWEB', 'WEB', 'ANDROID', 'IOS']
              : ['ANDROID', 'IOS', 'MWEB', 'WEB'];

            for (const c of clientList) {
              try {
                const candInfo = await yt.getBasicInfo(videoId, { client: c });
                const candFormats = (candInfo.streaming_data?.formats || []).concat(candInfo.streaming_data?.adaptive_formats || []);
                if (candFormats.length > 0) {
                  for (const f of candFormats) {
                    if (!f.url && (f.signature_cipher || f.cipher)) {
                      try {
                        const u = await f.decipher(yt.session?.player);
                        if (u) f.url = u;
                      } catch (_) {}
                    }
                  }
                  if (candFormats.some(f => f.url)) {
                    formats = candFormats;
                    info = candInfo;
                    if (candInfo.basic_info?.title) videoTitle = candInfo.basic_info.title;
                    break;
                  }
                  if (!formats.length) formats = candFormats;
                }
                if (candInfo.playability_status) {
                  lastPlayabilityStatus = candInfo.playability_status;
                }
              } catch (_) {}
            }
          }

          let selectedFormat = null;
          const isAudioOnly = mediaType === 'audio';

          if (!isAudioOnly) {
            if (quality === '1080p') {
              selectedFormat = formats.find(f => f.quality_label?.includes('1080') && f.url);
            } else if (quality === '720p') {
              selectedFormat = formats.find(f => (f.itag === 22 || f.quality_label?.includes('720')) && f.url);
            } else if (quality === '480p') {
              selectedFormat = formats.find(f => f.quality_label?.includes('480') && f.url);
            } else if (quality === '360p') {
              selectedFormat = formats.find(f => f.itag === 18 && f.url);
            }

            // Fallback hierarchy if requested resolution lacks a direct combined stream
            if (!selectedFormat) {
              if (quality === '720p' || quality === '480p' || quality === '1080p') {
                selectedFormat = formats.find(f => (f.itag === 22 || f.quality_label?.includes('720')) && f.url);
              }
              if (!selectedFormat) {
                selectedFormat = formats.find(f => f.itag === 18 && f.url) ||
                                 formats.find(f => (f.itag === 18 || f.itag === 22) && f.url) ||
                                 formats.find(f => f.has_video && f.url);
              }
            }
          } else {
            selectedFormat = formats.find(f => f.has_audio && !f.has_video && f.url) ||
                             formats.find(f => f.itag === 18 && f.url);
          }

          if (!selectedFormat || !selectedFormat.url) {
            if (lastPlayabilityStatus?.status === 'LOGIN_REQUIRED') {
              const reason = lastPlayabilityStatus.reason || 'This video is age-restricted or requires sign-in.';
              throw new Error(`Age-Restricted Video: ${reason} Please use Mode 1 (Cloud Direct).`);
            }
            throw new Error('No direct stream URL available on YouTube.js. Please use Mode 1 (Cloud Direct).');
          }

          const cpn = info?.cpn || Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
          const streamUrl = `${selectedFormat.url}&cpn=${cpn}`;
          const totalLength = parseInt(selectedFormat.content_length, 10) || 0;
          const actualQuality = selectedFormat.quality_label || (selectedFormat.itag === 18 ? '360p' : (isAudioOnly ? 'Audio' : 'SD'));
          const isQualityFallback = !isAudioOnly && Boolean(quality && quality !== 'auto' && quality !== actualQuality);

          window.postMessage({
            type: 'GVC_RESOLVE_YOUTUBE_STREAM_RES',
            queryId,
            success: true,
            streamUrl,
            totalLength,
            actualQuality,
            requestedQuality: quality,
            isQualityFallback,
            videoTitle,
            itag: selectedFormat.itag
          }, '*');
        } catch (err) {
          window.postMessage({
            type: 'GVC_RESOLVE_YOUTUBE_STREAM_RES',
            queryId,
            success: false,
            error: err.message
          }, '*');
        }
      })();
    }
  });

  // Periodically detect YouTube video changes (SPA navigation)
  if (window.location.hostname.includes('youtube.com')) {
    let lastYtVideoId = null;
    setInterval(() => {
      const ytData = probeYouTube();
      if (ytData && ytData.videoId !== lastYtVideoId) {
        lastYtVideoId = ytData.videoId;
        window.postMessage({ type: 'GVC_YOUTUBE_DATA_AUTO', data: ytData }, '*');
      }
    }, 1500);
  }

})();

