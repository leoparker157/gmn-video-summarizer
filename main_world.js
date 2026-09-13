/**
 * GMN Universal Video Summarizer — Main World Script
 * Scoped video harvester for React Fiber, Relay GraphQL, Vue, Web Components, and platform players.
 */
(function() {
  'use strict';
  const isYouTube = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');
  if (isYouTube && (window.self !== window.top || (window.location.hostname !== 'www.youtube.com' && window.location.hostname !== 'm.youtube.com') || window.location.pathname.startsWith('/live_chat') || window.location.pathname.startsWith('/embed') || window.location.hostname === 'accounts.youtube.com')) {
    return;
  }
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
        VIDEO_CACHE.set(tweetId, videoInfo);
      }

      for (const key of Object.keys(node)) {
        walk(node[key], tweetId, depth + 1);
      }
    }

    try {
      walk(json, null, 0);
    } catch (_) {}
  }

  const isTwitter = window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com');
  const isFacebook = window.location.hostname.includes('facebook.com') || window.location.hostname.includes('messenger.com');

  // ── Hook HLS.js attachMedia to Capture Master Manifests ─────────────────────
  function hookHls(HlsClass) {
    if (!HlsClass || !HlsClass.prototype || HlsClass.prototype._gvcHooked) return;
    HlsClass.prototype._gvcHooked = true;

    const origLoadSource = HlsClass.prototype.loadSource;
    if (typeof origLoadSource === 'function') {
      HlsClass.prototype.loadSource = function(url) {
        if (url && typeof url === 'string') {
          M3U8_CACHE.set(url, { url, time: Date.now() });
          window.postMessage({ type: 'GVC_M3U8_CAPTURED', url }, '*');
        }
        return origLoadSource.apply(this, arguments);
      };
    }

    const origAttachMedia = HlsClass.prototype.attachMedia;
    if (typeof origAttachMedia === 'function') {
      HlsClass.prototype.attachMedia = function(media) {
        if (this.url) {
          M3U8_CACHE.set(this.url, { url: this.url, time: Date.now() });
          window.postMessage({ type: 'GVC_M3U8_CAPTURED', url: this.url }, '*');
        }
        return origAttachMedia.apply(this, arguments);
      };
    }
  }

  if (!isYouTube && !isFacebook) {
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
  }

  // ── Hook Fetch & XMLHttpRequest for Playlists & Twitter GraphQL ─────────────
  // STRICT GUARD: NEVER hook fetch or XMLHttpRequest on YouTube or Facebook!
  // YouTube relies on delicate authentication and cookie rotation handshakes.
  // Facebook relies on Relay GraphQL and typing autosave/analytics.
  if (!isYouTube && !isFacebook) {
    try {
      const isPlaylistUrl = (u) => {
        if (!u || typeof u !== 'string') return false;
        const lower = u.toLowerCase();
        return lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('.mpd') ||
               lower.includes('format=m3u8') || lower.includes('m3u8=') || lower.includes('/dash/') ||
               lower.includes('playlist.m3u8') || lower.includes('master.m3u8');
      };

      const origFetch = window.fetch;
      window.fetch = function(...args) {
        const p = origFetch.apply(this, args);
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
          if (isPlaylistUrl(url)) {
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
          if (isPlaylistUrl(url)) {
            M3U8_CACHE.set(url, { url, time: Date.now() });
            window.postMessage({ type: 'GVC_M3U8_CAPTURED', url }, '*');
          }
        } catch (_) {}
        return origOpen.apply(this, args);
      };
      if (isTwitter) {
        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener('load', function() {
            try {
              if (this._gvcUrl && (this._gvcUrl.includes('/graphql/') || this._gvcUrl.includes('/i/api/'))) {
                const json = JSON.parse(this.responseText);
                harvestVideos(json);
              }
            } catch (_) {}
          });
          return origSend.apply(this, args);
        };
      }
    } catch (_) {}

    // ── Hook MediaSource & SourceBuffer for MSE Stream Sniffing ───────────────
    try {
      if (typeof window.MediaSource === 'function') {
        const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        if (typeof origAddSourceBuffer === 'function') {
          MediaSource.prototype.addSourceBuffer = function(mimeType) {
            const sb = origAddSourceBuffer.apply(this, arguments);
            try {
              if (mimeType && typeof mimeType === 'string') {
                window.postMessage({
                  type: 'GVC_MSE_STREAM_DETECTED',
                  mimeType,
                  duration: this.duration || 0,
                  time: Date.now()
                }, '*');
              }
            } catch (_) {}
            return sb;
          };
        }
      }
    } catch (_) {}
  }

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

  function ensureInnertubeTrustedEvaluator() {
    let policy = globalThis.__GVC_TRUSTED_POLICY__ || globalThis.trustedTypes?.defaultPolicy || null;
    if (!policy && globalThis.trustedTypes?.createPolicy) {
      for (const name of ['gvc-eval', 'youtube-eval', 'default', 'youtube']) {
        try {
          policy = globalThis.trustedTypes.createPolicy(name, { createScript: s => s });
          if (policy) {
            globalThis.__GVC_TRUSTED_POLICY__ = policy;
            break;
          }
        } catch (_) {}
      }
    }
    const shim = globalThis.YouTubeJS?.Platform?.shim;
    if (shim) {
      shim.eval = async (data) => {
        const rawCode = (typeof data === 'object' && data !== null && data.output) ? data.output : String(data || '');
        const code = `(() => {\n${rawCode}\n})()`;
        const script = policy ? policy.createScript(code) : code;
        return eval(script);
      };
    }
    return policy;
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
        // 1. YouTube Player API (#movie_player, .html5-video-player, ytd-player, #shorts-player)
        try {
          const ytPlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player, ytd-player #movie_player, #shorts-player');
          if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(sec, true);
            if (typeof ytPlayer.playVideo === 'function') {
              ytPlayer.playVideo();
            }
          }
        } catch (_) {}

        // 2. Video.js API
        try {
          if (window.videojs) {
            if (typeof window.videojs.getAllPlayers === 'function') {
              window.videojs.getAllPlayers().forEach(p => {
                try { p.currentTime(sec); p.play(); } catch (_) {}
              });
            } else if (window.videojs.players && typeof window.videojs.players === 'object') {
              Object.values(window.videojs.players).forEach(p => {
                try { if (p && typeof p.currentTime === 'function') { p.currentTime(sec); p.play(); } } catch (_) {}
              });
            }
          }
        } catch (_) {}

        // 3. JW Player API
        try {
          if (typeof window.jwplayer === 'function') {
            const jw = window.jwplayer();
            if (jw && typeof jw.seek === 'function') {
              jw.seek(sec);
              if (typeof jw.play === 'function') jw.play();
            }
          }
        } catch (_) {}

        // 4. Plyr API
        try {
          document.querySelectorAll('.plyr').forEach(el => {
            if (el.plyr && typeof el.plyr.currentTime !== 'undefined') {
              try { el.plyr.currentTime = sec; el.plyr.play(); } catch (_) {}
            }
          });
        } catch (_) {}

        // 5. Vimeo API (if player object is bound to window or iframe)
        try {
          if (window.Vimeo && window.Vimeo.Player) {
            document.querySelectorAll('iframe[src*="vimeo.com"]').forEach(f => {
              try {
                const vp = new window.Vimeo.Player(f);
                vp.setCurrentTime(sec).then(() => vp.play()).catch(() => {});
              } catch (_) {}
            });
          }
        } catch (_) {}

        // 6. Deep Scan for all HTML5 <video> elements on page (including inside open Shadow DOMs)
        try {
          const findVideosDeep = (root = document) => {
            const found = [];
            try {
              found.push(...Array.from(root.querySelectorAll('video')));
              const allEls = root.querySelectorAll('*');
              for (let i = 0; i < allEls.length; i++) {
                if (allEls[i].shadowRoot) {
                  found.push(...findVideosDeep(allEls[i].shadowRoot));
                }
              }
            } catch (_) {}
            return found;
          };

          const videos = findVideosDeep();
          if (videos.length > 0) {
            // Sort videos: currently playing first, then largest visible in viewport
            videos.sort((a, b) => {
              const aPlay = (!a.paused && a.currentTime > 0) ? 1 : 0;
              const bPlay = (!b.paused && b.currentTime > 0) ? 1 : 0;
              if (aPlay !== bPlay) return bPlay - aPlay;
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return (rb.width * rb.height) - (ra.width * ra.height);
            });

            const targetV = videos[0];
            if (targetV) {
              if (typeof targetV.fastSeek === 'function') {
                try { targetV.fastSeek(sec); } catch (_) { targetV.currentTime = sec; }
              } else {
                targetV.currentTime = sec;
              }
              try {
                targetV.dispatchEvent(new Event('seeking', { bubbles: true }));
                targetV.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                targetV.dispatchEvent(new Event('seeked', { bubbles: true }));
              } catch (_) {}
              const p = targetV.play();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }
          }
        } catch (_) {}
      }
    } else if (e.data.type === 'GVC_RESOLVE_YOUTUBE_STREAM') {
      if (window.self !== window.top || window.location.hostname !== 'www.youtube.com') return;
      const { videoId, quality = '360p', mediaType = 'video', queryId } = e.data;
      (async () => {
        try {
          const isAudioOnly = mediaType === 'audio';

          // ── Priority 0: Use the page's own authenticated player data ──────
          // The YouTube player already obtained streaming URLs through its
          // legitimate BotGuard flow. These URLs have valid tokens baked in.
          let playerStreamUrl = null;
          let playerFormat = null;
          let playerTitle = document.title.replace(' - YouTube', '');

          const tryExtractFromPlayerResponse = (pr, source) => {
            if (!pr || !pr.streamingData) return null;
            const allFormats = (pr.streamingData.formats || []).concat(pr.streamingData.adaptiveFormats || []);
            if (!allFormats.length) return null;

            let fmt = null;
            const hasUrl = (f) => !!(f.url || f.signatureCipher || f.cipher);
            if (!isAudioOnly) {
              // Prefer combined audio+video formats from streamingData.formats first
              const combinedFormats = pr.streamingData.formats || [];
              if (quality === '720p') fmt = combinedFormats.find(f => hasUrl(f) && (f.itag === 22 || (f.qualityLabel && f.qualityLabel.includes('720'))));
              if (!fmt && quality === '360p') fmt = combinedFormats.find(f => hasUrl(f) && f.itag === 18);
              if (!fmt) {
                fmt = combinedFormats.find(f => hasUrl(f) && (f.itag === 18 || f.itag === 22)) ||
                      combinedFormats.find(f => hasUrl(f) && f.hasVideo !== false && !f.mimeType?.includes('audio/only'));
              }
              // Fallback to adaptive if no combined format
              if (!fmt) {
                const videoAdaptive = (pr.streamingData.adaptiveFormats || []).filter(f => hasUrl(f) && f.mimeType && f.mimeType.includes('video/'));
                if (quality === '1080p') fmt = videoAdaptive.find(f => f.qualityLabel?.includes('1080'));
                if (!fmt && quality === '720p') fmt = videoAdaptive.find(f => f.qualityLabel?.includes('720'));
                if (!fmt && quality === '480p') fmt = videoAdaptive.find(f => f.qualityLabel?.includes('480'));
                if (!fmt && quality === '360p') fmt = videoAdaptive.find(f => f.qualityLabel?.includes('360'));
                if (!fmt) fmt = videoAdaptive[0] || null;
              }
            } else {
              // Audio only
              const audioFormats = allFormats.filter(f => hasUrl(f) && f.mimeType && f.mimeType.includes('audio/'));
              fmt = audioFormats.find(f => f.audioQuality === 'AUDIO_QUALITY_MEDIUM') || audioFormats[0] || null;
            }
            if (fmt) {
              console.log(`[GVC] Found format from ${source}: itag=${fmt.itag}, quality=${fmt.qualityLabel || fmt.audioQuality || 'N/A'}`);
            }
            return fmt;
          };

          // Try 1: movie_player API on page
          const player = document.getElementById('movie_player');
          if (player && typeof player.getPlayerResponse === 'function') {
            const pr = player.getPlayerResponse();
            playerFormat = tryExtractFromPlayerResponse(pr, 'movie_player');
            if (playerFormat && pr && pr.videoDetails && pr.videoDetails.title) {
              playerTitle = pr.videoDetails.title;
            }
          }

          // Try 2: Intercepted v1/player response
          if (!playerFormat && window.__GVC_LAST_PLAYER_RESPONSE__) {
            playerFormat = tryExtractFromPlayerResponse(window.__GVC_LAST_PLAYER_RESPONSE__, 'intercepted v1/player');
            if (playerFormat && window.__GVC_LAST_PLAYER_RESPONSE__.videoDetails && window.__GVC_LAST_PLAYER_RESPONSE__.videoDetails.title) {
              playerTitle = window.__GVC_LAST_PLAYER_RESPONSE__.videoDetails.title;
            }
          }

          // Try 3: ytInitialPlayerResponse on window
          if (!playerFormat && window.ytInitialPlayerResponse) {
            playerFormat = tryExtractFromPlayerResponse(window.ytInitialPlayerResponse, 'ytInitialPlayerResponse');
            if (playerFormat && window.ytInitialPlayerResponse.videoDetails && window.ytInitialPlayerResponse.videoDetails.title) {
              playerTitle = window.ytInitialPlayerResponse.videoDetails.title;
            }
          }

          // If still no format, wait up to 1.5s in case player/interceptor is in flight
          if (!playerFormat) {
            for (let attempt = 0; attempt < 5; attempt++) {
              await new Promise(r => setTimeout(r, 300));
              const mp = document.getElementById('movie_player');
              if (mp && typeof mp.getPlayerResponse === 'function') {
                const pr = mp.getPlayerResponse();
                playerFormat = tryExtractFromPlayerResponse(pr, 'movie_player (retry)');
                if (playerFormat) {
                  if (pr && pr.videoDetails && pr.videoDetails.title) playerTitle = pr.videoDetails.title;
                  break;
                }
              }
              if (window.__GVC_LAST_PLAYER_RESPONSE__) {
                playerFormat = tryExtractFromPlayerResponse(window.__GVC_LAST_PLAYER_RESPONSE__, 'intercepted v1/player (retry)');
                if (playerFormat) break;
              }
            }
          }

          if (playerFormat) {
            let streamUrl = playerFormat.url;
            const cipherStr = playerFormat.signatureCipher || playerFormat.cipher;

            // Decipher signatureCipher and/or transform the 'n' challenge parameter
            console.log('[GVC] Player format found, running decipher/n-transform with Player engine...');
            try {
              ensureInnertubeTrustedEvaluator();
              const YouTubeJS = window.YouTubeJS || globalThis.YouTubeJS;
              const PlayerClass = YouTubeJS?.Player;
              if (PlayerClass) {
                if (!window.__GVC_PLAYER_ENGINE__) {
                  let playerId = null;
                  try {
                    if (typeof window.ytcfg !== 'undefined' && typeof window.ytcfg.get === 'function') {
                      playerId = window.ytcfg.get('PLAYER_VFL_IDENTIFIER') || null;
                    }
                    if (!playerId) {
                      const baseScript = document.querySelector('script[src*="/base.js"], script[src*="player_es6"]');
                      if (baseScript && baseScript.src) {
                        const m = baseScript.src.match(/player\/([a-zA-Z0-9_-]+)\//);
                        if (m) playerId = m[1];
                      }
                    }
                  } catch (_) {}
                  window.__GVC_PLAYER_ENGINE__ = await PlayerClass.create(null, undefined, undefined, playerId || undefined);
                }
                const playerEngine = window.__GVC_PLAYER_ENGINE__;
                if (playerEngine && typeof playerEngine.decipher === 'function') {
                  const targetToDecipher = streamUrl || cipherStr;
                  const deciphered = await playerEngine.decipher(targetToDecipher, cipherStr);
                  if (deciphered) {
                    console.log('[GVC] Successfully deciphered stream URL (n-challenge & signature)!');
                    streamUrl = deciphered;
                  }
                }
              }
            } catch (decErr) {
              console.warn('[GVC] Player decipher warning (proceeding with format URL):', decErr);
            }

            if (streamUrl) {
              const playerCpn = (() => {
                try {
                  const mp = document.getElementById('movie_player');
                  return (mp && typeof mp.getClientPlaybackNonce === 'function') ? mp.getClientPlaybackNonce() : null;
                } catch (_) { return null; }
              })();
              const fullStreamUrl = streamUrl.includes('cpn=')
                ? streamUrl
                : (playerCpn ? (streamUrl + (streamUrl.includes('?') ? '&' : '?') + 'cpn=' + playerCpn) : streamUrl);
              const totalLength = parseInt(playerFormat.contentLength, 10) || 0;
              const actualQuality = playerFormat.qualityLabel || (playerFormat.itag === 18 ? '360p' : (isAudioOnly ? 'Audio' : 'SD'));
              const isQualityFallback = !isAudioOnly && Boolean(quality && quality !== 'auto' && quality !== actualQuality);

              window.postMessage({
                type: 'GVC_RESOLVE_YOUTUBE_STREAM_RES',
                queryId,
                success: true,
                streamUrl: fullStreamUrl,
                totalLength,
                actualQuality,
                requestedQuality: quality,
                isQualityFallback,
                videoTitle: playerTitle,
                itag: playerFormat.itag,
                source: 'page_player'
              }, '*');
              return;
            }
          }

          throw new Error('Unable to extract authenticated stream from YouTube player. Please ensure video is playing and click Retry.');
        } catch (err) {
          console.error('[GVC] Failed to resolve YouTube stream:', err);
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



})();

