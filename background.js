/**
 * GMN Universal Video Summarizer — Service Worker (MV3 Background Script)
 * Manages video downloads, byte-range normalization, Google Files API upload/polling,
 * and real-time HEAD/HLS metadata probing.
 */

try {
  importScripts('mux.min.js');
} catch (e) {
  globalThis.__muxError = e.message || String(e);
  console.warn('[GVC] mux.min.js failed to load:', e);
}

try {
  importScripts('youtubei.bundle.js');
} catch (e) {
  globalThis.__ytError = e.message || String(e);
  console.warn('[GVC] youtubei.bundle.js failed to load:', e);
}

// ── In-Memory Sessions & Sniffed Media Cache ──────────────────────────────────
const SESSIONS = {};
const TAB_MEDIA_STREAMS = new Map(); // tabId -> Map of stream objects
const TAB_TS_CLUSTERS = new Map();   // tabId -> Map of baseKey -> cluster
const HLS_KEY_CACHE = new Map();     // keyUri -> CryptoKey
const ACTIVE_DOWNLOADS = new Map();  // cleanUrl -> download session (for chunk-level resumption)
const ACTIVE_STREAM_TRANSFERS = new Map(); // transferId -> in-flight tab streaming download
const ACTIVE_ABORTS = new Map();     // sessionId -> abortState
const ACTIVE_CHAT_ABORTS = ACTIVE_ABORTS; // backwards-compatible alias

function createAbortState(sessionId) {
  const abortState = {
    sessionId,
    isCancelled: false,
    activeController: null,
    activeTimer: null,
    abort() {
      this.isCancelled = true;
      if (this.activeController) {
        try { this.activeController.abort(); } catch (_) {}
      }
      if (this.activeTimer) {
        clearInterval(this.activeTimer);
      }
    }
  };
  if (sessionId) ACTIVE_ABORTS.set(sessionId, abortState);
  return abortState;
}

function releaseAbortState(sessionId) {
  if (sessionId) ACTIVE_ABORTS.delete(sessionId);
}

function interruptibleSleep(ms, abortState) {
  return new Promise((resolve) => {
    if (abortState && abortState.isCancelled) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (abortState) {
      const origAbort = abortState.abort;
      abortState.abort = function() {
        clearTimeout(timer);
        if (typeof origAbort === 'function') origAbort.apply(this, arguments);
        resolve();
      };
    }
  });
}

// ── Service Worker Keep-Alive During Active Operations ────────────────────────
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }, 8000);
}

function stopKeepAlive() {
  let hasActive = false;
  for (const s of ACTIVE_DOWNLOADS.values()) {
    if (s.status === 'downloading') { hasActive = true; break; }
  }
  if (ACTIVE_ABORTS.size > 0) hasActive = true;
  if (!hasActive && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ── Google Files API 2GB Hard Limit ───────────────────────────────────────────
const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (2048 MB)

// ── Transmux MPEG-TS Chunks to Genuine Playable ISO fMP4 (ftyp + moov + mdat) ──
function transmuxTsBuffersToMp4(tsBuffers) {
  return new Promise((resolve) => {
    try {
      const TransmuxerClass = (typeof self !== 'undefined' && self.muxjs && self.muxjs.mp4 && self.muxjs.mp4.Transmuxer) ||
                              (typeof muxjs !== 'undefined' && muxjs.mp4 && muxjs.mp4.Transmuxer);

      if (!TransmuxerClass) {
        console.warn('[GVC Transmuxer] mux.js Transmuxer not available');
        resolve(null);
        return;
      }

      // Normalize timestamps to start at 0:00 for Google Gemini Files API ingestion
      const transmuxer = new TransmuxerClass({
        keepOriginalTimestamps: false,
        baseMediaDecodeTime: 0
      });
      let initSegment = null;
      const mediaSegments = [];

      transmuxer.on('data', (segment) => {
        // Retain only the first valid initSegment (ftyp + moov) to prevent corrupt duplicate headers
        if (!initSegment && segment.initSegment && segment.initSegment.byteLength > 0) {
          initSegment = new Uint8Array(segment.initSegment);
        }
        if (segment.data && segment.data.byteLength > 0) {
          mediaSegments.push(new Uint8Array(segment.data));
        }
      });

      transmuxer.on('done', () => {
        if (!initSegment || mediaSegments.length === 0) {
          console.warn('[GVC Transmuxer] Transmux produced no valid initSegment or media frames');
          resolve(null);
          return;
        }
        const allChunks = [initSegment, ...mediaSegments];
        const totalLength = allChunks.reduce((acc, c) => acc + c.length, 0);
        const mp4Buffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of allChunks) {
          mp4Buffer.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(mp4Buffer.buffer);
      });

      let pushedAny = false;
      for (const buf of tsBuffers) {
        if (buf && buf.byteLength > 0) {
          transmuxer.push(new Uint8Array(buf));
          pushedAny = true;
        }
      }
      if (!pushedAny) {
        resolve(null);
        return;
      }
      transmuxer.flush();
    } catch (err) {
      console.warn('[GVC Transmuxer] Transmux fallback:', err);
      resolve(null);
    }
  });
}

// ── Clean & Normalize Media URLs (Strips Byte-Range Slices & Tracking IDs) ────
function cleanMediaUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    u.searchParams.delete('range');
    u.searchParams.delete('_nc_rid');
    u.searchParams.delete('_nc_req_id');
    return u.toString();
  } catch (_) {
    return raw.replace(/[?&](?:bytestart|byteend|range|_nc_rid|_nc_req_id)=[^&]*/g, '');
  }
}

// ── Canonical Key Helper to Group Duplicate Media Requests ───────────────────
function getStreamCanonicalKey(url, videoId) {
  if (videoId) return `vid_${videoId}`;
  try {
    const u = new URL(url);
    const itag = u.searchParams.get('itag');
    if (itag) return `${u.origin}${u.pathname}_itag_${itag}`;
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return cleanMediaUrl(url);
  }
}

// ── Strict Media Sniffer Helper ───────────────────────────────────────────────
function isMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Ignore audio tracks, fragments, segments, init slices
  if (url.match(/\.(ts|m4s|aac|m4a|mp3|ogg|wav)(\?.*)?$/i)) return false;
  if (url.includes('/segment') || url.includes('/frag') || url.includes('/chunk-') || url.includes('init-')) return false;

  // Video files and master manifests
  if (url.match(/\.(mp4|m3u8|mpd|webm|m4v|mov|flv|f4v|mkv)(\?.*)?$/i)) return true;
  if (url.includes('.m3u8') || url.includes('/hls/') || url.includes('format=m3u8') || url.includes('m3u8=')) return true;

  // Major platform video endpoints
  if (url.includes('googlevideo.com/videoplayback') && !url.includes('mime=audio')) return true;
  if (url.includes('fbcdn.net') && (url.includes('/v/') || url.includes('.mp4') || url.includes('oe=')) && !url.includes('audio')) return true;
  if (url.includes('tiktokcdn.com') && (url.includes('/video/') || url.includes('.mp4'))) return true;
  if (url.includes('v.redd.it') && (url.includes('DASH_') || url.includes('HLS') || url.includes('.mp4')) && !url.includes('audio')) return true;
  if (url.includes('vimeocdn.com') && url.includes('.mp4')) return true;
  if (url.includes('twimg.com') && url.includes('/amplify_video/')) return true;

  return false;
}

// ── Real-Time Network Sniffer via chrome.webRequest ───────────────────────────
if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const rawUrl = details.url;

      let isMedia = isMediaUrl(rawUrl);
      let contentType = '';
      let contentLength = 0;

      // Ignore document and static asset requests
      if (details.type === 'main_frame' || details.type === 'sub_frame' || details.type === 'stylesheet' || details.type === 'script' || details.type === 'font' || details.type === 'image') {
        return;
      }

      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          const name = h.name.toLowerCase();
          if (name === 'content-type') {
            contentType = h.value.toLowerCase();
            const isYouTubeMedia = rawUrl.includes('googlevideo.com/videoplayback');
            if (contentType.includes('audio/')) {
              if (isYouTubeMedia) {
                isMedia = true;
              } else {
                return; // ignore non-YouTube audio
              }
            }
            if ((contentType.includes('text/html') || contentType.includes('application/json')) && !rawUrl.includes('.m3u8') && !rawUrl.includes('.mpd')) {
              return; // ignore HTML/JSON documents
            }
            if (contentType.includes('video/') ||
                contentType.includes('application/x-mpegurl') ||
                contentType.includes('application/vnd.apple.mpegurl') ||
                contentType.includes('application/dash+xml') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('binary/octet-stream') ||
                contentType.includes('video/mp2t')) {
              isMedia = true;
            }
          }
          if (name === 'content-length') {
            contentLength = parseInt(h.value, 10) || 0;
          }
        }
      }

      // Track TS/M4S chunk requests to detect streams even if playlist is not in webRequest
      const isTsChunk = rawUrl.match(/\.(ts|m4s)(\?.*)?$/i) || (contentType && (contentType.includes('video/mp2t') || contentType.includes('octet-stream')));
      if (isTsChunk && details.tabId >= 0) {
        if (!TAB_TS_CLUSTERS.has(details.tabId)) {
          TAB_TS_CLUSTERS.set(details.tabId, new Map());
        }
        const clusters = TAB_TS_CLUSTERS.get(details.tabId);
        let baseKey = rawUrl;
        try {
          const u = new URL(rawUrl);
          const parts = u.pathname.split('/');
          parts.pop();
          baseKey = u.origin + parts.join('/');
        } catch (_) {}

        let entry = clusters.get(baseKey);
        if (!entry) {
          entry = { count: 0, firstUrl: rawUrl, totalBytes: 0, lastSeen: Date.now(), chunks: [] };
          clusters.set(baseKey, entry);
        }
        entry.count++;
        entry.totalBytes += contentLength || 0;
        entry.lastSeen = Date.now();
        if (!entry.chunks.includes(rawUrl)) entry.chunks.push(rawUrl);

        // Register candidate stream if no m3u8 exists
        if (!TAB_MEDIA_STREAMS.has(details.tabId)) {
          TAB_MEDIA_STREAMS.set(details.tabId, new Map());
        }
        const tabMap = TAB_MEDIA_STREAMS.get(details.tabId);
        const hasExistingM3u8 = Array.from(tabMap.keys()).some(k => k.includes('.m3u8'));
        if (!hasExistingM3u8 && !tabMap.has(entry.firstUrl)) {
          tabMap.set(entry.firstUrl, {
            url: entry.firstUrl,
            content_type: 'application/x-mpegURL',
            sizeBytes: entry.totalBytes,
            sizeMB: (entry.totalBytes / (1024 * 1024)).toFixed(1),
            isTsStream: true,
            label: 'MPEG-TS Stream (Multi-Chunk)',
            discoveredAt: Date.now()
          });
        }
      }

      if (isMedia && !isTsChunk) {
        const cleanUrl = cleanMediaUrl(rawUrl);

        // Extract metadata from Facebook EFG parameter if present
        let bitrate = 0;
        let duration = 0;
        let videoId = null;
        try {
          const u = new URL(cleanUrl);
          const efg = u.searchParams.get('efg');
          if (efg) {
            const dec = JSON.parse(atob(decodeURIComponent(efg)));
            if (dec.bitrate) bitrate = dec.bitrate;
            if (dec.duration_s) duration = dec.duration_s;
            if (dec.video_id) videoId = dec.video_id;
          }
        } catch (_) {}

        if (!TAB_MEDIA_STREAMS.has(details.tabId)) {
          TAB_MEDIA_STREAMS.set(details.tabId, new Map());
        }
        const tabMap = TAB_MEDIA_STREAMS.get(details.tabId);
        const canonKey = getStreamCanonicalKey(cleanUrl, videoId);

        let ytLabel = null;
        let ytHeight = 0;
        let ytIsAudio = false;
        if (cleanUrl.includes('googlevideo.com/videoplayback')) {
          try {
            const u = new URL(cleanUrl);
            const itag = parseInt(u.searchParams.get('itag'), 10);
            if (itag === 137 || itag === 248) { ytHeight = 1080; ytLabel = 'YouTube Video (1080p)'; }
            else if (itag === 136 || itag === 247 || itag === 22) { ytHeight = 720; ytLabel = 'YouTube Video (720p)'; }
            else if (itag === 135 || itag === 244) { ytHeight = 480; ytLabel = 'YouTube Video (480p)'; }
            else if (itag === 134 || itag === 243 || itag === 18) { ytHeight = 360; ytLabel = 'YouTube Video (360p)'; }
            else if (itag === 133 || itag === 242) { ytHeight = 240; ytLabel = 'YouTube Video (240p)'; }
            else if (itag === 160 || itag === 278) { ytHeight = 144; ytLabel = 'YouTube Video (144p)'; }
            else if (itag === 140 || itag === 251 || itag === 250 || itag === 249 || (contentType && contentType.includes('audio/'))) {
              ytIsAudio = true;
              ytLabel = 'YouTube Audio';
            }
          } catch (_) {}
        }

        if (tabMap.has(canonKey)) {
          const existing = tabMap.get(canonKey);
          if (contentLength > (existing.sizeBytes || 0)) {
            existing.sizeBytes = contentLength;
            existing.sizeMB = (contentLength / (1024 * 1024)).toFixed(1);
            existing.url = cleanUrl;
          }
          if (!existing.duration && duration) existing.duration = duration;
          if (!existing.bitrate && bitrate) existing.bitrate = bitrate;
          if (!existing.videoId && videoId) existing.videoId = videoId;
          if (!existing.height && ytHeight) existing.height = ytHeight;
          if (ytLabel) existing.label = ytLabel;
          if (ytIsAudio) existing.isAudio = true;
        } else {
          const sizeMB = contentLength > 0 ? (contentLength / (1024 * 1024)).toFixed(1) : null;
          tabMap.set(canonKey, {
            url: cleanUrl,
            content_type: contentType || (cleanUrl.includes('.webm') ? 'video/webm' : (cleanUrl.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4')),
            sizeBytes: contentLength,
            sizeMB: sizeMB,
            bitrate: bitrate,
            duration: duration,
            videoId: videoId,
            height: ytHeight,
            label: ytLabel,
            isAudio: ytIsAudio,
            discoveredAt: Date.now()
          });
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
}

// Clean up tab stream caches when tabs close or navigate
chrome.tabs.onRemoved.addListener((tabId) => {
  TAB_MEDIA_STREAMS.delete(tabId);
  TAB_TS_CLUSTERS.delete(tabId);
});

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      TAB_MEDIA_STREAMS.delete(details.tabId);
      TAB_TS_CLUSTERS.delete(details.tabId);
    }
  });
}

// ── Context Menu ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "gvc-summarize-video",
      title: "✨ Summarize / Caption This Video (Gemini)",
      contexts: ["video", "all"]
    });
  });
});

// ── Forward Messages between Frames (e.g. Iframe Badge -> Top Frame Panel) ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CHECK_NETWORK') {
    checkNetworkHealth().then(health => {
      try { sendResponse({ health }); } catch (_) {}
    }).catch(err => {
      try { sendResponse({ health: { ok: false, reason: err.message, userMessage: 'Failed to probe connection.' } }); } catch (_) {}
    });
    return true; // asynchronous response
  }
  if (msg && msg.type === 'FORWARD_TO_TOP_FRAME' && sender && sender.tab && sender.tab.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, msg.payload, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
    return true;
  }
  if (msg && msg.type === 'BROADCAST_TO_ALL_FRAMES' && sender && sender.tab && sender.tab.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, msg.payload, () => {
      void chrome.runtime.lastError;
    });
    return true;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "gvc-summarize-video" && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_MENU_CLICKED", mediaUrl: info.srcUrl || null }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "ACTION_ICON_CLICKED" }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
  }
});

// ── Stream Metadata Prober (HEAD request & HLS Manifest Inspector) ────────────
async function probeStreamMetadata(url) {
  try {
    if (!url || typeof url !== 'string') return { url, error: 'Invalid URL' };
    const cleanUrl = cleanMediaUrl(url);

    // 1. If HLS (.m3u8), parse manifest text to extract resolutions, segments, duration, and estimated size
    if (isHlsStreamUrl(cleanUrl)) {
      try {
        const manifest = await parseHlsManifest(cleanUrl);
        if (manifest.isMaster) {
          const resolutions = manifest.variants.map(v => v.resolution).filter(Boolean);
          const highestBw = manifest.variants[0]?.bandwidth || 0;
          return {
            url: cleanUrl,
            isHLS: true,
            isMaster: true,
            resolutions,
            bitrate: highestBw,
            variants: manifest.variants,
            sizeBytes: null,
            sizeMB: null
          };
        } else {
          // Media Playlist: estimate size from chunk count
          let estBytes = null;
          let estMB = null;
          if (manifest.segments.length > 0) {
            try {
              const headRes = await fetch(manifest.segments[0].url, { method: 'HEAD' });
              const segLen = parseInt(headRes.headers.get('Content-Length') || '0', 10);
              if (segLen > 0) {
                estBytes = segLen * manifest.segments.length;
                estMB = (estBytes / (1024 * 1024)).toFixed(1);
              }
            } catch (_) {}
          }
          return {
            url: cleanUrl,
            isHLS: true,
            isMaster: false,
            duration: Math.round(manifest.totalDuration),
            segmentCount: manifest.segments.length,
            sizeBytes: estBytes,
            sizeMB: estMB
          };
        }
      } catch (_) {}
    }

    // 2. HTTP HEAD Request for Content-Length (File Size)
    try {
      const headRes = await fetch(cleanUrl, { method: 'HEAD' });
      if (headRes.ok) {
        const len = headRes.headers.get('Content-Length');
        const type = headRes.headers.get('Content-Type') || '';
        const lowerType = type.toLowerCase();
        if (!lowerType.includes('text/html') && !lowerType.includes('application/json')) {
          const sizeBytes = len ? parseInt(len, 10) : 0;
          const sizeMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : null;
          return {
            url: cleanUrl,
            contentType: type,
            sizeBytes,
            sizeMB
          };
        }
      }
    } catch (_) {}

    return {
      url: cleanUrl,
      sizeBytes: null,
      sizeMB: null
    };
  } catch (e) {
    return { url, error: e.message };
  }
}

// ── Port-based connection from content script ────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gvc') return;

  const portSessions = new Set();
  let isPortOpen = true;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;

  const send = (msg) => {
    if (!isPortOpen) return;
    try {
      port.postMessage(msg);
    } catch (_) {
      isPortOpen = false;
    }
  };

  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === 'PING') {
        send({ type: 'PONG', time: Date.now() });
      } else if (msg.type === 'CLEAR_TAB_STREAMS') {
        if (msg.force && tabId != null) {
          TAB_MEDIA_STREAMS.delete(tabId);
          TAB_TS_CLUSTERS.delete(tabId);
        }
      } else if (msg.type === 'GET_SNIFFED_STREAMS') {
        const tabStreams = (tabId != null && TAB_MEDIA_STREAMS.has(tabId))
          ? Array.from(TAB_MEDIA_STREAMS.get(tabId).values())
          : [];
        send({ type: 'SNIFFED_STREAMS_RESULT', streams: tabStreams });
      } else if (msg.type === 'PROBE_METADATA') {
        const meta = await probeStreamMetadata(msg.url);
        send({ type: 'METADATA_RESULT', url: msg.url, meta });
      } else if (msg.type === 'DOWNLOAD') {
        await handleDownload(msg.url, send, portSessions, tabId, msg.referer, msg.autoUpload, msg.apiKey);
      } else if (msg.type === 'ATTACH_DOWNLOAD') {
        const cleanUrl = cleanMediaUrl(msg.url);
        const session = ACTIVE_DOWNLOADS.get(cleanUrl);
        if (session) {
          session.sendFns.add(send);
          if (session.status === 'completed' && session.result) {
            send(session.result);
          } else if (session.totalSegments > 0) {
            const pct = Math.round((session.completedCount / session.totalSegments) * 100);
            const mb = (session.receivedBytes / (1024 * 1024)).toFixed(1);
            send({
              type: 'DL_PROGRESS',
              pct,
              mb,
              chunk: session.completedCount,
              totalChunks: session.totalSegments
            });
          }
        }
      } else if (msg.type === 'INGEST_BLOB') {
        await handleIngestBlob(msg, send, portSessions, tabId);
      } else if (msg.type === 'ANALYZE') {
        if (msg.sessionId) portSessions.add(msg.sessionId);
        await handleAnalyze(msg, send, portSessions, tabId);
      } else if (msg.type === 'ANALYZE_YOUTUBE_DIRECT') {
        if (msg.sessionId) portSessions.add(msg.sessionId);
        await handleAnalyzeYouTubeDirect(msg, send);
      } else if (msg.type === 'UPLOAD_SESSION') {
        if (msg.sessionId) portSessions.add(msg.sessionId);
        await handleUploadSession(msg, send);
      } else if (msg.type === 'DOWNLOAD_RESOLVED_YOUTUBE_STREAM') {
        await handleDownloadResolvedYouTubeStream(msg, send, portSessions, tabId);
      } else if (msg.type === 'STREAM_TRANSFER_START') {
        startKeepAlive();
        ACTIVE_STREAM_TRANSFERS.set(msg.transferId, {
          chunks: [],
          receivedBytes: 0,
          videoId: msg.videoId,
          videoTitle: msg.videoTitle,
          quality: msg.quality || '360p',
          isQualityFallback: Boolean(msg.isQualityFallback),
          totalLength: msg.totalLength || 0,
          autoUpload: Boolean(msg.autoUpload),
          apiKey: msg.apiKey,
          tabId: tabId
        });
        send({
          type: 'PROGRESS',
          message: `Downloading ${msg.quality || '360p'} stream directly from YouTube page...`
        });
      } else if (msg.type === 'STREAM_TRANSFER_CHUNK') {
        const transfer = ACTIVE_STREAM_TRANSFERS.get(msg.transferId);
        if (transfer && msg.chunk) {
          let uint8 = null;
          if (typeof msg.chunk === 'string') {
            const binary = atob(msg.chunk);
            uint8 = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              uint8[i] = binary.charCodeAt(i);
            }
          } else if (msg.chunk instanceof ArrayBuffer) {
            uint8 = new Uint8Array(msg.chunk);
          } else if (ArrayBuffer.isView(msg.chunk)) {
            uint8 = new Uint8Array(msg.chunk.buffer, msg.chunk.byteOffset, msg.chunk.byteLength);
          }
          if (uint8 && uint8.length > 0) {
            transfer.chunks.push(uint8);
            transfer.receivedBytes += uint8.length;
          }
        }
      } else if (msg.type === 'STREAM_TRANSFER_END') {
        const transfer = ACTIVE_STREAM_TRANSFERS.get(msg.transferId);
        if (transfer) {
          ACTIVE_STREAM_TRANSFERS.delete(msg.transferId);
          try {
            const firstChunk = transfer.chunks.length > 0 ? transfer.chunks[0] : null;
            const detectedMime = firstChunk ? detectVideoMimeType(firstChunk.buffer || firstChunk) : 'video/mp4';
            const blob = new Blob(transfer.chunks, { type: detectedMime });

            if (blob.size < 150 * 1024) {
              throw new Error(`Downloaded media stream was truncated (${(blob.size / 1024).toFixed(1)} KB).`);
            }

            const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
            const sessionId = crypto.randomUUID();
            const downloadLabel = transfer.isQualityFallback
              ? `YouTube (${transfer.quality || '360p'} • Best Available)`
              : (transfer.videoTitle ? `${transfer.videoTitle} (${transfer.quality || '360p'})` : `YouTube (${transfer.quality || '360p'})`);

            SESSIONS[sessionId] = {
              blob,
              sizeMB,
              fileUri: null,
              videoUrl: `https://www.youtube.com/watch?v=${transfer.videoId}`,
              label: downloadLabel,
              createdAt: Date.now()
            };

            if (portSessions) portSessions.add(sessionId);

            send({
              type: 'DOWNLOAD_DONE',
              sessionId,
              sizeMB,
              url: `https://www.youtube.com/watch?v=${transfer.videoId}`,
              label: downloadLabel,
              actualQuality: transfer.quality || '360p',
              requestedQuality: transfer.quality || '360p',
              isQualityFallback: transfer.isQualityFallback
            });

            if (transfer.autoUpload && transfer.apiKey) {
              await uploadSessionBlobToGoogleFiles(sessionId, transfer.apiKey, send);
            }
          } catch (finishErr) {
            send({ type: 'ERROR', message: `Video stream processing failed: ${finishErr.message}` });
          } finally {
            stopKeepAlive();
          }
        }
      } else if (msg.type === 'STREAM_TRANSFER_ERROR') {
        ACTIVE_STREAM_TRANSFERS.delete(msg.transferId);
        stopKeepAlive();
        send({ type: 'ERROR', message: `YouTube stream download failed: ${msg.error}` });
      } else if (msg.type === 'YOUTUBE_JS_DOWNLOAD') {
        await handleYouTubeDownloadWithYouTubeJS(msg, send, portSessions, tabId);
      } else if (msg.type === 'CHAT_QUERY') {
        if (msg.sessionId) portSessions.add(msg.sessionId);
        await handleChatQuery(msg, send);
      } else if (msg.type === 'CANCEL_CHAT' || msg.type === 'CANCEL_SESSION') {
        const abortState = ACTIVE_ABORTS.get(msg.sessionId);
        if (abortState) {
          abortState.abort();
          ACTIVE_ABORTS.delete(msg.sessionId);
        }
        if (msg.type === 'CANCEL_SESSION') {
          delete SESSIONS[msg.sessionId];
          portSessions.delete(msg.sessionId);
        }
      } else if (msg.type === 'FETCH_MODELS') {
        await handleFetchModels(msg.apiKey, send);
      } else if (msg.type === 'CHECK_NETWORK') {
        const health = await checkNetworkHealth();
        send({ type: 'NETWORK_HEALTH_RESULT', health });
      }
    } catch (e) {
      send({ type: 'ERROR', message: e.message });
    }
  });

  port.onDisconnect.addListener(() => {
    isPortOpen = false;
    for (const id of portSessions) {
      const abortState = ACTIVE_ABORTS.get(id);
      if (abortState) {
        abortState.abort();
        ACTIVE_ABORTS.delete(id);
      }
      if (SESSIONS[id] && !SESSIONS[id].fileUri) {
        delete SESSIONS[id];
      }
    }
    portSessions.clear();
  });
});

async function configureCdnBypassRules(targetUrl, refererUrl) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  try {
    const targetHost = (new URL(targetUrl)).hostname;
    const isGoogleVideo = targetHost.includes('googlevideo.com');
    const filter = isGoogleVideo ? '*://*.googlevideo.com/*' : `||${targetHost}/`;
    const requestHeaders = [];
    if (refererUrl) {
      requestHeaders.push({ header: 'Referer', operation: 'set', value: refererUrl });
      try {
        const originUrl = (new URL(refererUrl)).origin;
        requestHeaders.push({ header: 'Origin', operation: 'set', value: originUrl });
      } catch (_) {}
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1000, 1001],
      addRules: [{
        id: 1000,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: requestHeaders
        },
        condition: {
          urlFilter: filter,
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }]
    });
  } catch (err) {
    console.debug('[GVC DNR] Failed to set dynamic rule:', err);
  }
}

// ── In-Tab Fetch Fallback (Bypasses all 403 Forbidden checks using tab session) ─
async function fetchChunkViaTab(tabId, url) {
  if (tabId == null) return null;
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'FETCH_CHUNK_IN_TAB', url }, (res) => {
        if (chrome.runtime.lastError || !res || !res.base64) {
          resolve(null);
        } else {
          try {
            const binary = atob(res.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            resolve(bytes.buffer);
          } catch (_) {
            resolve(null);
          }
        }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// ── Helper: Fetch with Exponential Backoff Retry & 10s Abort Timeout ─────────
async function fetchWithRetry(url, maxRetries = 3, timeoutMs = 10000) {
  let attempt = 0;
  let lastErr = null;

  // Build origin/referer headers to bypass CDN hotlink protection
  const fetchHeaders = {};
  try {
    const u = new URL(url);
    fetchHeaders['Referer'] = u.origin + '/';
    fetchHeaders['Origin'] = u.origin;
  } catch (_) {}

  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: fetchHeaders,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error(`Failed to fetch (${lastErr ? (lastErr.name === 'AbortError' ? 'Request Timeout' : lastErr.message) : 'Network error'}): ${url}`);
}

// ── Check if URL is an HLS / TS Stream ────────────────────────────────────────
function isHlsStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('/hls/') || lower.includes('format=m3u8') || lower.includes('m3u8=');
}

// ── Parse Segment IV according to RFC 8216 Section 5.2 ────────────────────────
function getSegmentIv(keyInfo, seqIndex) {
  if (keyInfo.ivHex) {
    const cleanHex = keyInfo.ivHex.replace(/^0x/i, '').padStart(32, '0');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  const bytes = new Uint8Array(16);
  let num = seqIndex;
  for (let i = 15; i >= 12; i--) {
    bytes[i] = num & 0xff;
    num = num >> 8;
  }
  return bytes;
}

// ── Decrypt AES-128 HLS Segment using Web Crypto API ──────────────────────────
async function decryptChunk(encryptedBuffer, keyInfo, seqIndex, tabId = null) {
  let cryptoKey = HLS_KEY_CACHE.get(keyInfo.keyUri);
  if (!cryptoKey) {
    let keyRaw = null;
    try {
      const keyRes = await fetchWithRetry(keyInfo.keyUri, 3);
      keyRaw = await keyRes.arrayBuffer();
    } catch (keyErr) {
      if (tabId != null) {
        keyRaw = await fetchChunkViaTab(tabId, keyInfo.keyUri);
      }
      if (!keyRaw) {
        throw new Error('Failed to fetch AES-128 encryption key from ' + keyInfo.keyUri + ': ' + keyErr.message);
      }
    }
    if (keyRaw.byteLength !== 16) {
      throw new Error('Invalid AES-128 key length (' + keyRaw.byteLength + ' bytes)');
    }
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyRaw,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    HLS_KEY_CACHE.set(keyInfo.keyUri, cryptoKey);
  }

  const iv = getSegmentIv(keyInfo, seqIndex);
  return await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    encryptedBuffer
  );
}

// ── Video Container Detection & MIME Normalization (Gemini Official Specs) ────
function detectVideoMimeType(buffer) {
  if (!buffer || buffer.byteLength < 8) return 'video/mp4';
  const u8 = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));

  // Check for WebM / MKU (EBML: 0x1A 0x45 0xDF 0xA3)
  if (u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) {
    return 'video/webm';
  }

  // Check for MPEG-2 TS (Sync byte 0x47 or ID3 header)
  if (u8[0] === 0x47 || (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)) {
    return 'video/mp2t';
  }

  // Universal standard accepted by Google Gemini Files API
  return 'video/mp4';
}

function cleanTsChunk(buffer) {
  if (!buffer || buffer.byteLength < 188) return buffer;
  const u8 = new Uint8Array(buffer);

  // If already starts with sync byte 0x47 and has valid 188-byte alignment
  if (u8[0] === 0x47 && u8[188] === 0x47) {
    const cleanLength = Math.floor(u8.length / 188) * 188;
    return cleanLength === u8.length ? buffer : buffer.slice(0, cleanLength);
  }

  // If starts with ID3 header: calculate ID3 size and skip it
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33 && u8.length > 10) {
    const id3Size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    const id3Total = id3Size + 10;
    if (id3Total < u8.length) {
      for (let i = id3Total; i < Math.min(u8.length - 188, id3Total + 512); i++) {
        if (u8[i] === 0x47 && u8[i + 188] === 0x47) {
          const cleanLength = Math.floor((u8.length - i) / 188) * 188;
          return buffer.slice(i, i + cleanLength);
        }
      }
    }
  }

  // Scan for first aligned sync byte 0x47
  for (let i = 0; i < Math.min(u8.length - 188, 1024); i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47) {
      const cleanLength = Math.floor((u8.length - i) / 188) * 188;
      return buffer.slice(i, i + cleanLength);
    }
  }

  return buffer;
}

// ── High-Performance HLS Manifest Parser (Master & Media Playlists) ───────────
async function parseHlsManifest(manifestUrl, tabId = null) {
  const cleanUrl = cleanMediaUrl(manifestUrl);
  let text = '';
  let baseUrl = cleanUrl;
  try {
    const res = await fetchWithRetry(cleanUrl, 3);
    text = await res.text();
    baseUrl = res.url || cleanUrl; // Use final redirected URL for relative segment paths
  } catch (err) {
    if (tabId != null) {
      const tabBuf = await fetchChunkViaTab(tabId, cleanUrl);
      if (tabBuf && tabBuf.byteLength > 0) {
        text = new TextDecoder().decode(tabBuf);
      }
    }
    if (!text) throw err;
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrStr = line.substring('#EXT-X-STREAM-INF:'.length);
        
        // Search forward for the next non-comment URI line
        let variantUrl = null;
        for (let j = i + 1; j < lines.length; j++) {
          const candidate = lines[j];
          if (!candidate.startsWith('#') && candidate.length > 0) {
            variantUrl = candidate;
            break;
          }
        }

        if (variantUrl) {
          try {
            variantUrl = new URL(variantUrl, baseUrl).toString();
          } catch (_) {}

          let bandwidth = 0;
          let resolution = null;

          const bwMatch = attrStr.match(/BANDWIDTH=(\d+)/);
          if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);

          let width = 0, height = 0;
          const resMatch = attrStr.match(/RESOLUTION=(\d+x\d+)/);
          if (resMatch) {
            resolution = resMatch[1];
            const parts = resolution.split('x');
            width = parseInt(parts[0], 10) || 0;
            height = parseInt(parts[1], 10) || 0;
          }

          variants.push({
            url: variantUrl,
            bandwidth,
            resolution,
            width,
            height,
            label: resolution ? `${resolution}` : (bandwidth ? `${Math.round(bandwidth / 1000)}k` : 'Variant')
          });
        }
      }
    }

    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    return {
      isMaster: true,
      variants,
      baseUrl
    };
  }

  // Media Playlist
  let currentKey = null;
  let initSegmentUrl = null;
  const segments = [];
  let totalDuration = 0;
  const isLive = !lines.some(l => l.startsWith('#EXT-X-ENDLIST'));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrStr = line.substring('#EXT-X-KEY:'.length);
      if (attrStr.includes('METHOD=NONE')) {
        currentKey = null;
      } else if (attrStr.includes('METHOD=AES-128')) {
        const uriMatch = attrStr.match(/URI=["']([^"']+)["']/);
        const ivMatch = attrStr.match(/IV=(0x[0-9a-fA-F]+)/);
        if (uriMatch) {
          let keyUri = uriMatch[1];
          try {
            keyUri = new URL(uriMatch[1], baseUrl).toString();
          } catch (_) {}
          currentKey = {
            method: 'AES-128',
            keyUri,
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      }
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const mapMatch = line.match(/URI=["']([^"']+)["']/);
      if (mapMatch) {
        try {
          initSegmentUrl = new URL(mapMatch[1], baseUrl).toString();
        } catch (_) {
          initSegmentUrl = mapMatch[1];
        }
      }
    }

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      const duration = durMatch ? parseFloat(durMatch[1]) : 0;
      totalDuration += duration;

      // Resilient parser: Search forward for the next non-comment URI line (skipping tags like #EXT-X-BYTERANGE, #EXT-X-PROGRAM-DATE-TIME, #EXT-X-DISCONTINUITY)
      let segUrl = null;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (!candidate.startsWith('#') && candidate.length > 0) {
          segUrl = candidate;
          break;
        }
      }

      if (segUrl) {
        try {
          segUrl = new URL(segUrl, baseUrl).toString();
        } catch (_) {}

        segments.push({
          url: segUrl,
          duration,
          key: currentKey ? { ...currentKey } : null,
          seqIndex: segments.length
        });
      }
    }
  }

  return {
    isMaster: false,
    initSegmentUrl,
    segments,
    totalDuration,
    isLive,
    baseUrl
  };
}

// ── Download HLS / MPEG-TS Streams (Parallel Chunk Downloader with Resumption) ─────
async function handleHlsDownload(url, send, portSessions, tabId, refererUrl) {
  startKeepAlive();

  const cleanUrl = cleanMediaUrl(url);

  if (refererUrl) {
    await configureCdnBypassRules(cleanUrl, refererUrl);
  }

  // If already completed and cached in memory, return immediately!
  let session = ACTIVE_DOWNLOADS.get(cleanUrl);
  if (session && session.status === 'completed' && session.result) {
    send({ type: 'PROGRESS', message: 'Video stream already downloaded and cached in memory!' });
    send(session.result);
    if (portSessions) portSessions.add(session.result.sessionId);
    return session.result;
  }

  send({ type: 'PROGRESS', message: 'Analyzing HLS / MPEG-TS stream playlist...' });

  let manifest = (session && session.manifest) ? session.manifest : await parseHlsManifest(url, tabId);

  if (manifest.isMaster) {
    if (!manifest.variants || manifest.variants.length === 0) {
      throw new Error('No playable stream variants found in master HLS playlist.');
    }
    const selectedVariant = manifest.variants[0];
    send({
      type: 'PROGRESS',
      message: `Found ${manifest.variants.length} quality variants. Selected ${selectedVariant.label || 'highest'} quality...`
    });
    manifest = await parseHlsManifest(selectedVariant.url, tabId);
  }

  if (!manifest.segments || manifest.segments.length === 0) {
    throw new Error('No media chunks found in HLS stream playlist.');
  }

  let segmentsToDownload = manifest.segments;
  if (manifest.isLive && segmentsToDownload.length > 30) {
    send({
      type: 'PROGRESS',
      message: `Live stream detected. Capturing the latest ${Math.min(segmentsToDownload.length, 30)} chunks...`
    });
    segmentsToDownload = segmentsToDownload.slice(-30);
  }

  const totalSegments = segmentsToDownload.length;

  // Initialize or attach to existing session
  if (!session || session.totalSegments !== totalSegments) {
    session = {
      url: cleanUrl,
      manifest,
      segmentsToDownload,
      totalSegments,
      initSegmentBuffer: null,
      downloadedChunks: new Array(totalSegments),
      completedCount: 0,
      receivedBytes: 0,
      sendFns: new Set([send]),
      inFlight: new Set(),
      status: 'downloading',
      result: null
    };
    ACTIVE_DOWNLOADS.set(cleanUrl, session);
  } else {
    session.sendFns.add(send);
  }

  const broadcast = (m) => {
    for (const s of session.sendFns) {
      try { s(m); } catch (_) {}
    }
  };

  // Count chunks already in cache
  let existingCount = 0;
  let cachedBytes = session.initSegmentBuffer ? session.initSegmentBuffer.byteLength : 0;
  for (let i = 0; i < totalSegments; i++) {
    if (session.downloadedChunks[i] && session.downloadedChunks[i].byteLength > 0) {
      existingCount++;
      cachedBytes += session.downloadedChunks[i].byteLength;
    }
  }
  session.completedCount = existingCount;
  session.receivedBytes = cachedBytes;

  if (existingCount > 0) {
    const resumePct = Math.round((existingCount / totalSegments) * 100);
    broadcast({
      type: 'PROGRESS',
      message: `Resuming download at ${resumePct}% (${existingCount}/${totalSegments} chunks already cached)...`
    });
  } else {
    broadcast({
      type: 'PROGRESS',
      message: `Starting parallel download of ${totalSegments} video chunks...`
    });
  }

  if (manifest.initSegmentUrl && !session.initSegmentBuffer) {
    broadcast({ type: 'PROGRESS', message: 'Downloading stream initialization header (fMP4)...' });
    const initRes = await fetchWithRetry(manifest.initSegmentUrl, 3);
    session.initSegmentBuffer = await initRes.arrayBuffer();
    session.receivedBytes += session.initSegmentBuffer.byteLength;
  }

  const CONCURRENCY = 5;

  async function worker() {
    while (session.status === 'downloading') {
      let idx = -1;
      for (let i = 0; i < totalSegments; i++) {
        if (!session.downloadedChunks[i] && !session.inFlight.has(i)) {
          session.inFlight.add(i);
          idx = i;
          break;
        }
      }
      if (idx === -1) break; // All chunks either downloaded or currently in flight

      const seg = segmentsToDownload[idx];
      let chunkBuffer = null;
      try {
        const chunkRes = await fetchWithRetry(seg.url, 3, 12000);
        chunkBuffer = await chunkRes.arrayBuffer();
      } catch (fetchErr) {
        // If background fetch failed (e.g. 403 Forbidden), fetch directly through the player tab/iframe!
        if (tabId != null) {
          try {
            const tabBuf = await fetchChunkViaTab(tabId, seg.url);
            if (tabBuf && tabBuf.byteLength > 0) {
              chunkBuffer = tabBuf;
            }
          } catch (_) {}
        }
        if (!chunkBuffer) {
          console.warn('[GUC HLS] Segment #${idx + 1} unavailable (${fetchErr.message}).');
        }
      } finally {
        session.inFlight.delete(idx);
      }

      // Decrypt AES-128 chunks (works whether fetched directly or via tab session)
      if (chunkBuffer && seg.key && seg.key.method === 'AES-128') {
        try {
          chunkBuffer = await decryptChunk(chunkBuffer, seg.key, seg.seqIndex, tabId);
        } catch (decErr) {
          console.warn(`[GVC HLS] Failed to decrypt segment #${idx + 1}:`, decErr);
          chunkBuffer = null;
        }
      }

      if (chunkBuffer && chunkBuffer.byteLength > 0) {
        const isTs = !manifest.initSegmentUrl || (detectVideoMimeType(chunkBuffer) === 'video/mp2t');
        const readyBuffer = isTs ? cleanTsChunk(chunkBuffer) : chunkBuffer;
        if (readyBuffer && readyBuffer.byteLength > 0) {
          session.downloadedChunks[idx] = readyBuffer;
          session.receivedBytes += readyBuffer.byteLength;
        }
      }
      session.completedCount++;

      if (session.receivedBytes > MAX_VIDEO_SIZE_BYTES) {
        throw new Error(`HLS video stream exceeded the 2 GB limit (${(session.receivedBytes / (1024 * 1024)).toFixed(0)} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
      }

      const pct = Math.round((session.completedCount / totalSegments) * 100);
      const mb = (session.receivedBytes / (1024 * 1024)).toFixed(1);
      const estTotalMB = ((session.receivedBytes / Math.max(1, session.completedCount)) * totalSegments / (1024 * 1024)).toFixed(1);

      broadcast({
        type: 'DL_PROGRESS',
        pct,
        mb,
        totalMB: estTotalMB,
        chunk: session.completedCount,
        totalChunks: totalSegments
      });
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, totalSegments); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const validChunks = session.downloadedChunks.filter(c => c && c.byteLength > 0);
  if (validChunks.length === 0) {
    throw new Error('Downloaded HLS video chunks produced an empty file (all chunks returned 404/network error).');
  }

  broadcast({ type: 'PROGRESS', message: `Assembling and transmuxing ${validChunks.length}/${totalSegments} chunks into playable MP4...` });

  let blob = null;
  if (session.initSegmentBuffer) {
    blob = new Blob([session.initSegmentBuffer, ...validChunks], { type: 'video/mp4' });
  } else {
    const mp4ArrayBuffer = await transmuxTsBuffersToMp4(validChunks);
    if (mp4ArrayBuffer && mp4ArrayBuffer.byteLength > 0) {
      blob = new Blob([mp4ArrayBuffer], { type: 'video/mp4' });
    } else {
      throw new Error('Failed to transmux HLS video chunks into playable MP4. Please select a different quality variant.');
    }
  }

  if (blob.size === 0) {
    throw new Error('Downloaded HLS video chunks produced an empty file (0 bytes).');
  }

  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  if (blob.size > MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video file is too large (${sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
  }
  const sessionId = crypto.randomUUID();
  SESSIONS[sessionId] = {
    blob,
    sizeMB,
    fileUri: null,
    videoUrl: url,
    isHls: true,
    segmentCount: totalSegments,
    createdAt: Date.now()
  };
  if (portSessions) portSessions.add(sessionId);

  session.status = 'completed';
  session.result = {
    type: 'DOWNLOAD_DONE',
    sessionId,
    sizeMB,
    url: cleanUrl
  };
  ACTIVE_DOWNLOADS.set(cleanUrl, session);

  broadcast(session.result);
  stopKeepAlive();
  return session.result;
}

// ── Probe HLS Manifest from a TS Chunk URL ─────────────────────────────────
async function probeManifestFromTsUrl(tsUrl) {
  try {
    const u = new URL(tsUrl);
    const pathParts = u.pathname.split('/');
    pathParts.pop(); // Remove filename e.g. segment_001.ts
    const dirPath = pathParts.join('/');

    const candidates = [
      'index.m3u8',
      'playlist.m3u8',
      'master.m3u8',
      'video.m3u8',
      'main.m3u8',
      'stream.m3u8',
      'prog_index.m3u8',
      'all.m3u8'
    ];

    const probeList = [];
    for (const c of candidates) {
      probeList.push(`${u.origin}${dirPath}/${c}${u.search}`);
    }
    if (pathParts.length > 1) {
      const parentParts = [...pathParts];
      parentParts.pop();
      const parentDir = parentParts.join('/');
      for (const c of ['master.m3u8', 'playlist.m3u8', 'index.m3u8', 'video.m3u8']) {
        probeList.push(`${u.origin}${parentDir}/${c}${u.search}`);
      }
    }

    for (const probeUrl of probeList) {
      try {
        const res = await fetchWithRetry(probeUrl, 1);
        if (res.ok) {
          const text = await res.text();
          if (text.includes('#EXTM3U')) {
            return probeUrl;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ── Extract Chunk Numeric Pattern from a TS URL ──────────────────────────────
function extractChunkPattern(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const m = pathname.match(/^(.*?)(\d+)(\.(?:ts|m4s|m2ts|mp4|aac|js|png|jpg))$/i);
    if (!m) return null;
    return {
      prefix: m[1],
      numStr: m[2],
      num: parseInt(m[2], 10),
      width: m[2].length,
      isZeroPadded: m[2].startsWith('0') && m[2].length > 1,
      suffix: m[3],
      search: u.search,
      origin: u.origin
    };
  } catch (_) {
    return null;
  }
}

function formatChunkUrl(pattern, index) {
  let numStr = String(index);
  if (pattern.isZeroPadded) {
    numStr = numStr.padStart(pattern.width, '0');
  }
  return `${pattern.origin}${pattern.prefix}${numStr}${pattern.suffix}${pattern.search}`;
}

// ── Harvest Sequential MPEG-TS Chunks ─────────────────────────────────────────
async function handleSequentialChunkDownload(firstUrl, pattern, send, portSessions) {
  send({ type: 'PROGRESS', message: 'Analyzing sequential MPEG-TS stream...' });

  let startIndex = 0;
  if (pattern.num > 0) {
    try {
      const probe0 = await fetchWithRetry(formatChunkUrl(pattern, 0), 1);
      if (!probe0.ok) startIndex = 1;
    } catch (_) {
      startIndex = 1;
    }
  }

  const downloadedChunks = [];
  let currentIndex = startIndex;
  let consecutiveFailures = 0;
  let totalBytes = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const CONCURRENCY = 5;

  send({ type: 'PROGRESS', message: `Downloading sequential chunks starting at #${startIndex}...` });

  let done = false;

  async function fetchChunk(idx) {
    const chunkUrl = formatChunkUrl(pattern, idx);
    try {
      const res = await fetchWithRetry(chunkUrl, 2);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 512) {
          return { idx, buf, ok: true };
        }
      }
    } catch (_) {}
    return { idx, buf: null, ok: false };
  }

  while (!done && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    const batchPromises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const idx = currentIndex + i;
      batchPromises.push(fetchChunk(idx));
    }

    const results = await Promise.all(batchPromises);
    results.sort((a, b) => a.idx - b.idx);

    for (const r of results) {
      if (r.ok && r.buf) {
        const cleanedBuf = cleanTsChunk(r.buf);
        if (cleanedBuf && cleanedBuf.byteLength > 0) {
          downloadedChunks.push(cleanedBuf);
          totalBytes += cleanedBuf.byteLength;
          consecutiveFailures = 0;
          currentIndex = r.idx + 1;
        }

        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        if (totalBytes > MAX_VIDEO_SIZE_BYTES) {
          throw new Error(`Sequential video stream exceeded the 2 GB limit (${mb} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
        }

        send({
          type: 'DL_PROGRESS',
          pct: Math.min(99, Math.round((downloadedChunks.length / (downloadedChunks.length + 5)) * 100)),
          mb: mb,
          totalMB: 'Calculating...',
          chunk: downloadedChunks.length,
          totalChunks: 'Live/Sequential'
        });
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          done = true;
          break;
        }
        currentIndex = r.idx + 1;
      }
    }

    if (downloadedChunks.length >= 5000) break;
  }

  if (downloadedChunks.length === 0) {
    send({ type: 'PROGRESS', message: 'Downloading standalone video buffer...' });
    const singleRes = await fetchWithRetry(firstUrl, 3);
    const singleBuf = await singleRes.arrayBuffer();
    const cleanedSingle = cleanTsChunk(singleBuf);
    downloadedChunks.push(cleanedSingle);
  }

  send({ type: 'PROGRESS', message: `Assembling and transmuxing ${downloadedChunks.length} TS chunks into playable MP4...` });
  const mp4ArrayBuffer = await transmuxTsBuffersToMp4(downloadedChunks);
  if (!mp4ArrayBuffer || mp4ArrayBuffer.byteLength === 0) {
    throw new Error('Failed to transmux TS chunks into playable MP4. Please select a different quality variant.');
  }
  const blob = new Blob([mp4ArrayBuffer], { type: 'video/mp4' });
  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  if (blob.size > MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video file is too large (${sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
  }

  const sessionId = crypto.randomUUID();
  SESSIONS[sessionId] = {
    blob,
    sizeMB,
    fileUri: null,
    videoUrl: firstUrl,
    isHls: true,
    segmentCount: downloadedChunks.length,
    createdAt: Date.now()
  };
  if (portSessions) portSessions.add(sessionId);

  const dlResult = {
    type: 'DOWNLOAD_DONE',
    sessionId,
    sizeMB,
    url: firstUrl
  };
  ACTIVE_DOWNLOADS.set(firstUrl, {
    status: 'completed',
    result: dlResult
  });

  send(dlResult);
  return dlResult;
}

// ── Ingest In-Memory Recorded Video Blob ─────────────────────────────────────
async function handleIngestBlob(msg, send, portSessions, senderTabId) {
  send({ type: 'PROGRESS', message: 'Ingesting recorded video buffer...' });
  const byteCharacters = atob(msg.base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: msg.mimeType || 'video/webm' });
  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);

  const sessionId = crypto.randomUUID();
  SESSIONS[sessionId] = {
    blob,
    sizeMB,
    fileUri: null,
    videoUrl: 'recorded://in-memory-stream',
    createdAt: Date.now()
  };
  if (portSessions) portSessions.add(sessionId);

  send({
    type: 'DOWNLOAD_DONE',
    sessionId,
    sizeMB,
    url: 'recorded://in-memory-stream'
  });

  if (senderTabId != null) {
    chrome.tabs.sendMessage(senderTabId, {
      type: 'IFRAME_DOWNLOAD_DONE',
      sessionId,
      sizeMB,
      url: 'recorded://in-memory-stream'
    }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
  }
}

// ── Download Direct Streams (Normalized Full File from Byte 0) ────────────────
async function handleDownload(url, send, portSessions, tabId, refererUrl, autoUpload, apiKey) {
  const cleanUrl = cleanMediaUrl(url);

  if (refererUrl) {
    await configureCdnBypassRules(cleanUrl, refererUrl);
  }

  if (isHlsStreamUrl(cleanUrl)) {
    return await handleHlsDownload(cleanUrl, send, portSessions, tabId, refererUrl);
  }

  // Check if URL is a TS or M4S chunk
  const isTsOrChunk = cleanUrl.match(/\.(ts|m4s|m2ts)(\?.*)?$/i);
  if (isTsOrChunk) {
    send({ type: 'PROGRESS', message: 'Detected MPEG-TS stream chunk. Probing for full video playlist...' });

    // Step A: Probe parent directories for HLS playlist (.m3u8)
    const probedM3u8 = await probeManifestFromTsUrl(cleanUrl);
    if (probedM3u8) {
      send({ type: 'PROGRESS', message: 'Found complete HLS playlist! Downloading all video chunks...' });
      return await handleHlsDownload(probedM3u8, send, portSessions, tabId, refererUrl);
    }

    // Step B: Harvest sequential TS chunks
    const pattern = extractChunkPattern(cleanUrl);
    if (pattern) {
      send({ type: 'PROGRESS', message: 'Harvesting sequential MPEG-TS stream chunks...' });
      return await handleSequentialChunkDownload(cleanUrl, pattern, send, portSessions);
    }
  }

  send({ type: 'PROGRESS', message: 'Downloading complete video...' });

  const fetchHeaders = {};
  try {
    const u = new URL(cleanUrl);
    fetchHeaders['Referer'] = u.origin + '/';
    fetchHeaders['Origin'] = u.origin;
  } catch (_) {}

  const response = await fetch(cleanUrl, { headers: fetchHeaders });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

  const contentLength = parseInt(response.headers.get('Content-Length') || '0');
  if (contentLength > MAX_VIDEO_SIZE_BYTES) {
    const sizeMB = (contentLength / (1024 * 1024)).toFixed(0);
    throw new Error(`Video file is too large (${sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    if (received > MAX_VIDEO_SIZE_BYTES) {
      throw new Error(`Video download exceeded the 2 GB limit (${(received / (1024 * 1024)).toFixed(0)} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
    }

    if (contentLength > 0) {
      const pct = Math.round((received / contentLength) * 100);
      const mb  = (received / 1024 / 1024).toFixed(1);
      send({ type: 'DL_PROGRESS', pct, mb, totalMB: (contentLength / 1024 / 1024).toFixed(1) });
    }
  }

  const firstChunk = chunks.length > 0 ? chunks[0] : null;
  const mimeType = firstChunk ? detectVideoMimeType(firstChunk.buffer || firstChunk) : 'video/mp4';
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size < 150 * 1024) {
    if (cleanUrl.includes('googlevideo.com') || (refererUrl && refererUrl.includes('youtube.com'))) {
      throw new Error(`YouTube stream download truncated (${(blob.size / 1024).toFixed(1)} KB). YouTube CDN blocks direct file downloads. Please use Mode 1 (Cloud Direct) to analyze YouTube videos instantly with zero download required.`);
    }
    throw new Error(`Downloaded media stream was incomplete or empty (${(blob.size / 1024).toFixed(1)} KB).`);
  }

  const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
  if (blob.size > MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video file is too large (${sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
  }

  const sessionId = crypto.randomUUID();
  SESSIONS[sessionId] = { blob, sizeMB, fileUri: null, videoUrl: cleanUrl, createdAt: Date.now() };
  if (portSessions) portSessions.add(sessionId);

  const dlResult = { type: 'DOWNLOAD_DONE', sessionId, sizeMB, url: cleanUrl };
  ACTIVE_DOWNLOADS.set(cleanUrl, {
    status: 'completed',
    result: dlResult
  });

  send(dlResult);
  if (autoUpload && apiKey) {
    await uploadSessionBlobToGoogleFiles(sessionId, apiKey, send);
  }
  return dlResult;
}

// ── Analyze (Upload → Poll → Generate with Auto-Retry) ───────────────────────
async function handleAnalyze({ sessionId, videoUrl, fileUri, apiKey, model, retryCount = 5, retryDelayMs = 2200, payload }, send, portSessions = null, tabId = null) {
  const abortState = createAbortState(sessionId);
  try {
    startKeepAlive();
    let session = SESSIONS[sessionId];
    if (!session && videoUrl) {
      const cleanUrl = cleanMediaUrl(videoUrl);
      const activeDl = ACTIVE_DOWNLOADS.get(cleanUrl);
      if (activeDl && activeDl.result && SESSIONS[activeDl.result.sessionId]) {
        session = SESSIONS[activeDl.result.sessionId];
        sessionId = activeDl.result.sessionId;
      }
    }

    if (!session) {
      if (fileUri) {
        session = { blob: null, sizeMB: '0', fileUri: fileUri, videoUrl, createdAt: Date.now() };
        SESSIONS[sessionId] = session;
      } else if (videoUrl) {
        const cleanUrl = cleanMediaUrl(videoUrl);
        if (isHlsStreamUrl(cleanUrl)) {
          const dlResult = await handleHlsDownload(cleanUrl, send, portSessions, tabId);
          const activeDl = ACTIVE_DOWNLOADS.get(cleanUrl);
          const effectiveSessionId = dlResult?.sessionId || activeDl?.result?.sessionId;
          if (effectiveSessionId && SESSIONS[effectiveSessionId]) {
            sessionId = effectiveSessionId;
            session = SESSIONS[effectiveSessionId];
          } else if (sessionId && SESSIONS[sessionId]) {
            session = SESSIONS[sessionId];
          }
          if (portSessions && sessionId) portSessions.add(sessionId);
        } else {
          send({ type: 'PROGRESS', message: 'Restoring video buffer in background...' });
          const res = await fetch(cleanUrl);
          if (!res.ok) throw new Error(`Could not restore video from source: HTTP ${res.status}`);
          const blob = await res.blob();
          const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
          if (blob.size > MAX_VIDEO_SIZE_BYTES) {
            throw new Error(`Video file exceeds the 2 GB limit (${sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
          }
          session = { blob, sizeMB, fileUri: null, videoUrl: cleanUrl, createdAt: Date.now() };
          SESSIONS[sessionId] = session;
        }
      }
    }

    if (!session) {
      throw new Error('Video session expired or stream download failed. Please click "🔄 Retry" on the video card to re-fetch the stream.');
    }

    if (session.blob && session.blob.size > MAX_VIDEO_SIZE_BYTES) {
      throw new Error(`Video file exceeds the 2 GB limit (${session.sizeMB} MB). Google Gemini Files API supports a maximum file size of 2 GB (2048 MB). Please select a lower resolution variant.`);
    }

    let activeFileUri = fileUri || session.fileUri;
    let fileResourceName = session.fileResourceName;
    let fileState = null;

    if (!fileResourceName && activeFileUri) {
      const match = activeFileUri.match(/files\/[a-zA-Z0-9_-]+/);
      if (match) fileResourceName = match[0];
    }

    // Probe existing file link to verify it is still ACTIVE and not expired
    if (fileResourceName) {
      try {
        const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileResourceName}?key=${encodeURIComponent(apiKey)}`);
        if (checkRes.ok) {
          const fileMeta = await checkRes.json();
          fileState = fileMeta.state;
          if (fileState === 'FAILED') {
            send({ type: 'STORAGE_FILE_EXPIRED', fileUri: activeFileUri, fileResourceName });
            activeFileUri = null;
            fileResourceName = null;
            session.fileUri = null;
            session.fileResourceName = null;
          }
        } else {
          // Link not accessible with THIS key (could be 403 because uploaded with another key, or 404 expired)
          // Only send STORAGE_FILE_EXPIRED if 404 (file actually deleted from Google Cloud)
          if (checkRes.status === 404) {
            send({ type: 'STORAGE_FILE_EXPIRED', fileUri: activeFileUri, fileResourceName });
          }
          activeFileUri = null;
          fileResourceName = null;
          session.fileUri = null;
          session.fileResourceName = null;
        }
      } catch (_) {
        activeFileUri = null;
        fileResourceName = null;
      }
    }

    // Step 1: Upload to Google Files API if not already uploaded or if link expired
    if (!activeFileUri) {
      if (!session.blob) {
        throw new Error('Video buffer unavailable for Google upload. Please click "🔄 Retry" on the video card to re-fetch the stream.');
      }
      activeFileUri = await uploadSessionBlobToGoogleFiles(sessionId, apiKey, send, abortState);
      fileResourceName = session.fileResourceName;
      fileState = 'ACTIVE';
    }

    // Step 3: Inject File URI and exact MIME type into Payload
    const containerMime = (session?.blob?.type === 'video/webm') ? 'video/webm' : 'video/mp4';
    injectFileUriIntoPayload(payload, activeFileUri, containerMime);

    // Step 4: Execute GenerateContent with Auto-Retry (waits until finished or user cancels)
    send({ type: 'PROGRESS', message: 'Generating analysis with Gemini...' });
    await generateWithAutoRetry(model, apiKey, payload, retryCount, retryDelayMs, send, session, containerMime, abortState);
  } finally {
    releaseAbortState(sessionId);
    stopKeepAlive();
  }
}

// ── YouTube Cloud Direct Analysis Handler (Mode 1) ───────────────────────────
async function handleAnalyzeYouTubeDirect(msg, send) {
  const { sessionId, youtubeUrl, totalDuration, startOffset, endOffset, apiKey, model, payload, prompt, systemPrompt, generationConfig, retryCount, retryDelayMs } = msg;

  if (!apiKey) throw new Error('Missing Gemini API Key');
  if (!youtubeUrl) throw new Error('Missing YouTube Video URL');

  const MAX_CLOUD_DIRECT_SECONDS = 10800; // 3 hours (180 minutes)
  if (totalDuration && totalDuration > MAX_CLOUD_DIRECT_SECONDS) {
    const durMin = Math.round(totalDuration / 60);
    const durHours = (totalDuration / 3600).toFixed(1);
    throw new Error(`Google Cloud Direct Limit Exceeded: This video is ${durHours} hours (${durMin} minutes) long. Google Gemini API strictly caps Cloud Direct YouTube processing to a maximum of 3 hours (180 minutes) total duration. Please switch to Mode 2 (Local Download & Upload).`);
  }

  const sSec = parseFloat(String(startOffset || '0').replace('s', '')) || 0;
  const eSec = parseFloat(String(endOffset || '0').replace('s', '')) || 0;
  if (eSec > MAX_CLOUD_DIRECT_SECONDS || (eSec - sSec) > MAX_CLOUD_DIRECT_SECONDS) {
    throw new Error(`Google Cloud Direct Limit Exceeded: The requested time range (${startOffset} - ${endOffset}) exceeds Google's 3-hour (180 minutes) maximum window. Please adjust the range to under 3 hours (180 minutes) or switch to Mode 2 (Local Download & Upload).`);
  }

  send({ type: 'PROGRESS', message: 'Connecting to Gemini Cloud Direct (Zero Bandwidth)...' });

  // Ensure full canonical watch URL
  let canonicalUrl = youtubeUrl;
  const vMatch = canonicalUrl.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (vMatch) {
    canonicalUrl = `https://www.youtube.com/watch?v=${vMatch[1]}`;
  }

  // Build the specialized YouTube Part
  const ytPart = {
    fileData: {
      fileUri: canonicalUrl,
      mimeType: 'video/mp4'
    }
  };

  if (startOffset || endOffset) {
    ytPart.videoMetadata = {};
    if (startOffset) ytPart.videoMetadata.startOffset = String(startOffset).endsWith('s') ? String(startOffset) : `${startOffset}s`;
    if (endOffset) ytPart.videoMetadata.endOffset = String(endOffset).endsWith('s') ? String(endOffset) : `${endOffset}s`;
  }

  // Construct request contents
  let finalPayload = payload;
  if (!finalPayload || !Array.isArray(finalPayload.contents) || !finalPayload.contents.length) {
    finalPayload = {
      contents: [
        {
          role: 'user',
          parts: [
            ytPart,
            { text: prompt || 'Please summarize the key highlights and contents of this video segment.' }
          ]
        }
      ]
    };
  } else {
    // Inject or replace the fileData part
    let inserted = false;
    for (const content of finalPayload.contents) {
      if (Array.isArray(content.parts)) {
        for (let i = 0; i < content.parts.length; i++) {
          if (content.parts[i].file_data || content.parts[i].fileData) {
            content.parts[i] = ytPart;
            inserted = true;
            break;
          }
        }
      }
    }
    if (!inserted && finalPayload.contents[0]) {
      if (!Array.isArray(finalPayload.contents[0].parts)) finalPayload.contents[0].parts = [];
      finalPayload.contents[0].parts.unshift(ytPart);
    }
  }

  // Prevent duplicate oneof field collision (_system_instruction vs systemInstruction)
  if (finalPayload.systemInstruction && finalPayload.system_instruction) {
    delete finalPayload.systemInstruction;
  }
  if (systemPrompt && !finalPayload.systemInstruction && !finalPayload.system_instruction) {
    finalPayload.system_instruction = {
      parts: [{ text: systemPrompt }]
    };
  }
  if (finalPayload.systemInstruction && finalPayload.system_instruction) {
    delete finalPayload.systemInstruction;
  }

  if (generationConfig && !finalPayload.generationConfig && !finalPayload.generation_config) {
    finalPayload.generationConfig = generationConfig;
  }

  send({ type: 'PROGRESS', message: 'Gemini is processing the YouTube video directly from Google servers...' });

  const activeModel = model || 'gemini-3.5-flash-lite';
  const abortState = createAbortState(sessionId);
  try {
    startKeepAlive();
    await generateWithAutoRetry(
      activeModel,
      apiKey,
      finalPayload,
      retryCount || 4,
      retryDelayMs || 2500,
      send,
      null,
      'video/mp4',
      abortState
    );
  } finally {
    releaseAbortState(sessionId);
    stopKeepAlive();
  }
}

// ── Download Resolved YouTube Stream (From In-Page YouTube.js Engine) ────────
async function handleDownloadResolvedYouTubeStream({ streamUrl, totalLength, quality, requestedQuality, isQualityFallback, label, videoId, videoTitle, autoUpload, apiKey, useTabFetch }, send, portSessions, tabId) {
  startKeepAlive();
  try {
    const totalMB = totalLength > 0 ? (totalLength / (1024 * 1024)).toFixed(1) : null;
    const initialMsg = isQualityFallback
      ? `YouTube direct stream: downloading ${quality || '360p'} AI-optimal combined stream (${totalMB ? `${totalMB} MB` : 'in progress'})...`
      : `Downloading ${quality || 'video'} (${totalMB ? `${totalMB} MB` : 'stream'}) from page player...`;
    send({ type: 'PROGRESS', message: initialMsg });

    let res = null;
    const headers = {
      'accept': '*/*',
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com'
    };

    // Download via service worker fetch (with YouTube headers set via declarativeNetRequest)
    try {
      await configureCdnBypassRules(streamUrl, 'https://www.youtube.com/');
    } catch (_) {}

    const boundFetch = (input, init) => globalThis.fetch.call(globalThis, input, init);
    res = await boundFetch(streamUrl, { headers });
    if (!res.ok) throw new Error(`YouTube download failed: HTTP ${res.status}`);

    const headerLen = res.headers.get('content-length');
    const actualTotalLength = totalLength || (headerLen ? parseInt(headerLen, 10) : 0);
    const actualTotalMB = actualTotalLength > 0 ? (actualTotalLength / (1024 * 1024)).toFixed(1) : totalMB;

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (received > MAX_VIDEO_SIZE_BYTES) {
        throw new Error('Video download exceeded 2 GB limit.');
      }

      if (actualTotalLength > 0) {
        const pct = Math.round((received / actualTotalLength) * 100);
        const mb = (received / 1024 / 1024).toFixed(1);
        send({ type: 'DL_PROGRESS', pct, mb, totalMB: actualTotalMB });
      }
    }

    const firstChunk = chunks.length > 0 ? chunks[0] : null;
    const detectedMime = firstChunk ? detectVideoMimeType(firstChunk.buffer || firstChunk) : 'video/mp4';
    const blob = new Blob(chunks, { type: detectedMime });

    if (blob.size < 150 * 1024) {
      throw new Error(`Downloaded media stream was truncated (${(blob.size / 1024).toFixed(1)} KB). Please use Mode 1 (Cloud Direct).`);
    }

    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    const sessionId = crypto.randomUUID();
    const downloadLabel = isQualityFallback
      ? `YouTube (${quality || '360p'} • Best Available)`
      : (label || `YouTube (${quality || '360p'})`);

    SESSIONS[sessionId] = {
      blob,
      sizeMB,
      fileUri: null,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      label: downloadLabel,
      createdAt: Date.now()
    };

    if (portSessions) portSessions.add(sessionId);

    send({
      type: 'DOWNLOAD_DONE',
      sessionId,
      sizeMB,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      label: downloadLabel,
      actualQuality: quality || '360p',
      requestedQuality: requestedQuality || quality || '360p',
      isQualityFallback: Boolean(isQualityFallback)
    });

    if (autoUpload && apiKey) {
      await uploadSessionBlobToGoogleFiles(sessionId, apiKey, send);
    }
  } catch (err) {
    console.error(`[GVC Background] Stream URL direct fetch failed: ${err.message}`);
    throw new Error(`YouTube stream download failed (${err.message}). Please retry or switch to Mode 1 (Cloud Direct).`);
  } finally {
    stopKeepAlive();
  }
}

// ── YouTube.js Local Download Handler (Mode 2 Fallback) ───────────────────────
async function handleYouTubeDownloadWithYouTubeJS({ videoId, quality = '360p', mediaType = 'video', label, autoUpload, apiKey }, send, portSessions, tabId) {
  startKeepAlive();
  try {
    send({ type: 'PROGRESS', message: 'Initializing YouTube.js engine (Web Client)...' });

    if (typeof globalThis.Innertube === 'undefined') {
      throw new Error('YouTube.js engine is not loaded in service worker.');
    }

    let activeTabId = tabId;
    if (!activeTabId) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) activeTabId = activeTab.id;
      } catch (_) {}
    }

    const hybridFetch = async (input, init) => {
      let url = typeof input === 'string' ? input : (input?.url || String(input));
      let method = init?.method || (input instanceof Request ? input.method : 'GET');
      let headers = {};
      if (input instanceof Request && input.headers) {
        input.headers.forEach((v, k) => { headers[k] = v; });
      }
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([k, v]) => { headers[k] = v; });
        } else if (typeof init.headers === 'object') {
          Object.assign(headers, init.headers);
        }
      }
      let body = init?.body;
      if (!body && input instanceof Request && method !== 'GET' && method !== 'HEAD') {
        try { body = await input.clone().text(); } catch (_) {}
      }

      // If this is a YouTube API call (e.g. /youtubei/v1/player), route through the active YouTube tab
      // to execute with genuine same-origin https://www.youtube.com context, bypassing 403 Forbidden
      if (activeTabId && (url.includes('youtube.com') || url.includes('/youtubei/'))) {
        const tabRes = await new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(activeTabId, {
              type: 'TAB_FETCH',
              url,
              method,
              headers,
              body: typeof body === 'string' ? body : undefined
            }, (res) => {
              if (chrome.runtime.lastError || !res || !res.status) {
                resolve(null);
              } else {
                resolve(res);
              }
            });
          } catch (_) {
            resolve(null);
          }
        });

        if (tabRes && tabRes.status > 0) {
          return new Response(tabRes.text, {
            status: tabRes.status,
            statusText: tabRes.statusText || 'OK',
            headers: tabRes.headers || {}
          });
        }
      }

      // Direct service-worker fetch (for media chunks or standalone fallback)
      return globalThis.fetch.call(globalThis, input, init);
    };

    const yt = await globalThis.Innertube.create({
      fetch: hybridFetch
    });
    send({ type: 'PROGRESS', message: 'Extracting direct media formats...' });

    const info = await yt.getBasicInfo(videoId);
    const videoTitle = info.basic_info?.title || label || 'YouTube Video';
    const cpn = info.cpn || Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');

    const formats = (info.streaming_data?.formats || []).concat(info.streaming_data?.adaptive_formats || []);

    const isAudioOnly = mediaType === 'audio';
    let selectedFormat = null;

    const hasAny = (f) => !!(f.url || f.signature_cipher || f.cipher);

    if (!isAudioOnly) {
      if (quality === '1080p') {
        selectedFormat = formats.find(f => f.quality_label?.includes('1080') && hasAny(f));
      } else if (quality === '720p') {
        selectedFormat = formats.find(f => (f.itag === 22 || f.quality_label?.includes('720')) && hasAny(f));
      } else if (quality === '480p') {
        selectedFormat = formats.find(f => f.quality_label?.includes('480') && hasAny(f));
      } else if (quality === '360p') {
        selectedFormat = formats.find(f => f.itag === 18 && hasAny(f));
      }

      // Fallback hierarchy if requested resolution lacks direct combined stream
      if (!selectedFormat) {
        if (quality === '720p' || quality === '480p' || quality === '1080p') {
          selectedFormat = formats.find(f => (f.itag === 22 || f.quality_label?.includes('720')) && hasAny(f));
        }
        if (!selectedFormat) {
          selectedFormat = formats.find(f => f.itag === 18 && hasAny(f)) ||
                           formats.find(f => (f.itag === 18 || f.itag === 22) && hasAny(f)) ||
                           formats.find(f => f.has_video && hasAny(f));
        }
      }
    } else {
      // Audio stream or fallback to itag 18 (which contains full audio track)
      selectedFormat = formats.find(f => f.has_audio && !f.has_video && hasAny(f)) ||
                       formats.find(f => f.itag === 18 && hasAny(f));
    }

    if (selectedFormat && !selectedFormat.url && (selectedFormat.signature_cipher || selectedFormat.cipher)) {
      try {
        selectedFormat.url = await selectedFormat.decipher(yt.session.player);
      } catch (_) {}
    }

    if (!selectedFormat || !selectedFormat.url) {
      if (info.playability_status?.status === 'LOGIN_REQUIRED' || info.playability_status?.reason?.includes('inappropriate') || info.playability_status?.reason?.includes('age')) {
        const reason = info.playability_status.reason || 'This video is age-restricted or requires sign-in.';
        throw new Error(`Age-Restricted Video: ${reason} YouTube restricts direct local download. Please switch to Mode 1 (Cloud Direct) which analyzes directly via Gemini.`);
      }
      throw new Error('No direct stream URL available on YouTube.js. Please use Mode 1 (Cloud Direct) for instant zero-bandwidth analysis.');
    }

    const streamUrl = `${selectedFormat.url}&cpn=${cpn}`;
    const formatLen = parseInt(selectedFormat.content_length, 10) || 0;

    const actualQuality = selectedFormat.quality_label || (selectedFormat.itag === 18 ? '360p' : (isAudioOnly ? 'Audio' : 'SD'));
    const isQualityFallback = !isAudioOnly && Boolean(quality && quality !== 'auto' && quality !== actualQuality);

    const headers = {
      'accept': '*/*',
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com'
    };

    try {
      await configureCdnBypassRules(streamUrl, 'https://www.youtube.com/');
    } catch (_) {}

    const res = await hybridFetch(streamUrl, { headers });
    if (!res.ok) throw new Error(`YouTube download failed: HTTP ${res.status}`);

    const headerLen = res.headers.get('content-length');
    const totalLength = formatLen || (headerLen ? parseInt(headerLen, 10) : 0);
    const totalMB = totalLength > 0 ? (totalLength / (1024 * 1024)).toFixed(1) : null;

    const initialMsg = isQualityFallback
      ? `YouTube direct stream: downloading ${actualQuality || '360p'} AI-optimal combined stream (${totalMB ? `${totalMB} MB` : 'in progress'})...`
      : `Downloading ${actualQuality} (${totalMB ? `${totalMB} MB` : 'stream'}) via YouTube.js...`;
    send({ type: 'PROGRESS', message: initialMsg });

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (received > MAX_VIDEO_SIZE_BYTES) {
        throw new Error('Video download exceeded 2 GB limit.');
      }

      if (totalLength > 0) {
        const pct = Math.round((received / totalLength) * 100);
        const mb = (received / 1024 / 1024).toFixed(1);
        send({ type: 'DL_PROGRESS', pct, mb, totalMB });
      }
    }

    const firstChunk = chunks.length > 0 ? chunks[0] : null;
    const detectedMime = firstChunk ? detectVideoMimeType(firstChunk.buffer || firstChunk) : (selectedFormat.mime_type?.split(';')[0] || 'video/mp4');
    const blob = new Blob(chunks, { type: detectedMime });

    if (blob.size < 150 * 1024) {
      throw new Error(`Downloaded media stream was truncated (${(blob.size / 1024).toFixed(1)} KB). Please use Mode 1 (Cloud Direct).`);
    }

    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    const sessionId = crypto.randomUUID();
    const downloadLabel = isQualityFallback
      ? `YouTube (${actualQuality || '360p'} • Best Available)`
      : `YouTube (${actualQuality || (isAudioOnly ? 'Audio' : '360p')})`;

    SESSIONS[sessionId] = {
      blob,
      sizeMB,
      fileUri: null,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      label: downloadLabel,
      createdAt: Date.now()
    };

    if (portSessions) portSessions.add(sessionId);

    send({
      type: 'DOWNLOAD_DONE',
      sessionId,
      sizeMB,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      label: downloadLabel,
      actualQuality,
      requestedQuality: quality || '360p',
      isQualityFallback
    });

    if (autoUpload && apiKey) {
      await uploadSessionBlobToGoogleFiles(sessionId, apiKey, send);
    }
  } finally {
    stopKeepAlive();
  }
}

// ── Multi-Turn Chat Query Handler ────────────────────────────────────────────
async function handleChatQuery({ sessionId, videoUrl, fileUri, apiKey, model, retryCount = 5, retryDelayMs = 2200, payload, userQuery }, send) {
  let session = SESSIONS[sessionId];
  if (!session) {
    if (fileUri || videoUrl) {
      session = { blob: null, sizeMB: '0', fileUri: fileUri || videoUrl, videoUrl, sessionId, createdAt: Date.now() };
      SESSIONS[sessionId] = session;
    } else {
      throw new Error('Video session expired. Please analyze the video again before chatting.');
    }
  }
  session.sessionId = sessionId;
  if (videoUrl && (!session.videoUrl || session.videoUrl !== videoUrl)) {
    session.videoUrl = videoUrl;
  }

  const activeFileUri = fileUri || session.fileUri;
  if (!activeFileUri) {
    throw new Error('Video file is not available on Google Files API. Please summarize the video first.');
  }

  const containerMime = (session?.blob?.type === 'video/webm') ? 'video/webm' : 'video/mp4';
  injectFileUriIntoPayload(payload, activeFileUri, containerMime);

  const abortState = createAbortState(sessionId);

  // Dedicated routing for chat response and progress
  const chatSend = (m) => {
    if (abortState.isCancelled) return;
    if (m.type === 'PROGRESS') {
      send({ type: 'CHAT_PROGRESS', message: m.message, query: userQuery });
    } else if (m.type === 'RESULT') {
      send({ type: 'CHAT_RESULT', json: m.json, model: m.model, query: userQuery });
    } else if (m.type === 'ERROR' || m.type === 'DIAGNOSTIC_ERROR') {
      const detail = (m.error && (m.error.rawApiMessage || m.error.message)) || m.message || 'Chat request failed';
      send({ type: 'CHAT_ERROR', message: detail, query: userQuery, error: m.error });
    } else {
      send(m);
    }
  };

  send({ type: 'CHAT_PROGRESS', message: `Thinking with Gemini (${model})...` });
  try {
    startKeepAlive();
    await generateWithAutoRetry(model, apiKey, payload, retryCount, retryDelayMs, chatSend, session, containerMime, abortState);
  } finally {
    releaseAbortState(sessionId);
    stopKeepAlive();
  }
}

function injectFileUriIntoPayload(payload, fileUri, mimeType) {
  if (!payload || !Array.isArray(payload.contents) || !payload.contents.length) return;
  const safeMime = (mimeType === 'video/webm') ? 'video/webm' : 'video/mp4';
  let found = false;
  for (const content of payload.contents) {
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (part.file_data) {
          part.file_data.file_uri = fileUri;
          part.file_data.mime_type = safeMime;
          found = true;
        } else if (part.fileData) {
          part.fileData.fileUri = fileUri;
          part.fileData.mimeType = safeMime;
          found = true;
        }
      }
    }
  }
  if (!found && fileUri && payload.contents[0]) {
    if (!Array.isArray(payload.contents[0].parts)) payload.contents[0].parts = [];
    payload.contents[0].parts.unshift({ file_data: { file_uri: fileUri, mime_type: safeMime } });
  }
}

// ── Gemini Model Prefill Compatibility & Payload Sanitizer ────────────────────
function normalizeGeminiModelId(modelId) {
  return String(modelId || '').trim().toLowerCase().replace(/^models\//, '');
}

function geminiModelRejectsPrefilledModelTurns(modelId) {
  const id = normalizeGeminiModelId(modelId);
  if (!/^gemini(?:-|$)/.test(id)) return false;
  if (/^gemini-[a-z0-9-]*latest(?:-|$)/.test(id)) return true;
  if (/^gemini-3\.5-flash-lite(?:-|$)/.test(id)) return true;
  if (/^gemini-3\.[6-9]/.test(id)) return true;
  const version = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (!version) return false;
  const major = parseInt(version[1], 10);
  const minor = parseInt(version[2] || '0', 10);
  return major > 3 || (major === 3 && minor >= 6) || (major === 3 && minor === 5 && id.includes('flash-lite'));
}

function sanitizePayloadForModel(payload, model) {
  if (!payload) return payload;

  // Resolve oneof duplicate collisions for protobuf fields
  if (payload.systemInstruction && payload.system_instruction) {
    delete payload.systemInstruction;
  } else if (payload.systemInstruction) {
    payload.system_instruction = payload.systemInstruction;
    delete payload.systemInstruction;
  }

  if (payload.generation_config && payload.generationConfig) {
    delete payload.generation_config;
  } else if (payload.generation_config) {
    payload.generationConfig = payload.generation_config;
    delete payload.generation_config;
  }

  // Deduplicate oneof fields inside content parts if any
  if (Array.isArray(payload.contents)) {
    for (const c of payload.contents) {
      if (Array.isArray(c.parts)) {
        for (const p of c.parts) {
          if (p.file_data && p.fileData) delete p.fileData;
          if (p.video_metadata && p.videoMetadata) delete p.videoMetadata;
        }
      }
    }
  }

  if (!Array.isArray(payload.contents) || !payload.contents.length) return payload;
  const rejects = geminiModelRejectsPrefilledModelTurns(model);
  const lastTurn = payload.contents[payload.contents.length - 1];
  if (rejects && lastTurn && lastTurn.role === 'model') {
    // Convert trailing model turn(s) to user turn
    for (let i = payload.contents.length - 1; i >= 0; i--) {
      if (payload.contents[i].role === 'model') {
        payload.contents[i].role = 'user';
      } else {
        break;
      }
    }
    // Merge consecutive same-role turns
    const merged = [];
    for (const turn of payload.contents) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === turn.role) prev.parts = prev.parts.concat(turn.parts);
      else merged.push({ role: turn.role, parts: turn.parts.slice() });
    }
    payload.contents = merged;
  }
  return payload;
}

// ── Google Files API: Resumable Upload ────────────────────────────────────────
async function initResumableUpload(blob, apiKey, maxRetries = 3) {
  const uploadMime = (blob && blob.type === 'video/webm') ? 'video/webm' : 'video/mp4';
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const initRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(blob.size),
            'X-Goog-Upload-Header-Content-Type': uploadMime,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file: { display_name: `universal_video_${Date.now()}` } }),
        }
      );
      if (initRes.ok) {
        const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
        if (uploadUrl) return uploadUrl;
      }
      const errText = await initRes.text();
      if (attempt >= maxRetries) {
        throw new Error(`Google Upload Init failed (${initRes.status}): ${errText}`);
      }
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ── Google Files API: Chunked Upload ──────────────────────────────────────────
async function uploadInChunks(blob, uploadUrl, apiKey, send) {
  const CHUNK_SIZE = 8 * 1024 * 1024;
  let offset = 0;
  const total = blob.size;
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  let chunkIndex = 0;
  const totalChunks = Math.ceil(total / CHUNK_SIZE);

  while (offset < total) {
    chunkIndex++;
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = blob.slice(offset, end);
    const isLast = end === total;
    const mb = (offset / (1024 * 1024)).toFixed(1);

    send({
      type: 'UL_PROGRESS',
      chunk: chunkIndex,
      total: totalChunks,
      pct: Math.round((offset / total) * 100),
      mb,
      totalMB
    });

    let chunkUploaded = false;
    let chunkAttempt = 0;
    let lastChunkErr = null;
    let resultJson = null;

    while (!chunkUploaded && chunkAttempt < 4) {
      chunkAttempt++;
      try {
        const chunkRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Content-Length': String(chunk.size),
            'X-Goog-Upload-Offset': String(offset),
            'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
          },
          body: chunk,
        });

        if (chunkRes.ok) {
          chunkUploaded = true;
          if (isLast) {
            resultJson = await chunkRes.json();
          }
        } else {
          const errText = await chunkRes.text();
          lastChunkErr = new Error(`Chunk ${chunkIndex}/${totalChunks} upload failed (${chunkRes.status}): ${errText}`);
          if (chunkAttempt >= 4) throw lastChunkErr;
          await new Promise(r => setTimeout(r, 1000 * chunkAttempt));
        }
      } catch (err) {
        lastChunkErr = err;
        if (chunkAttempt >= 4) throw err;
        await new Promise(r => setTimeout(r, 1000 * chunkAttempt));
      }
    }

    if (isLast) {
      return resultJson;
    }

    offset = end;
  }
}

// ── Google Files API: Poll File Processing State ──────────────────────────────
async function pollFileState(fileResourceName, apiKey, send, abortState = null) {
  const fileApiUrl = `https://generativelanguage.googleapis.com/v1beta/${fileResourceName}?key=${encodeURIComponent(apiKey)}`;
  let pollAttempts = 0;
  let serverErrorCount = 0;
  const startTime = Date.now();

  // Keep polling until Gemini finishes (ACTIVE) or explicitly returns FAILED!
  // No artificial timeout: wait as long as Google is processing the video frames.
  while (true) {
    if (abortState && abortState.isCancelled) return false;
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const elapsedFormatted = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;

    if (elapsedSec > 900) {
      throw new Error(`Video processing timed out on Google servers (15 minutes). Resetting for fresh upload...`);
    }

    if (serverErrorCount >= 15) {
      throw new Error(`Google video processing encountered persistent server errors. Resetting for fresh upload...`);
    }

    const delay = serverErrorCount > 0 ? Math.min(5000, 2500 + serverErrorCount * 600) : 2500;
    await interruptibleSleep(delay, abortState);
    if (abortState && abortState.isCancelled) return false;
    pollAttempts++;

    try {
      const checkRes = await fetch(fileApiUrl);
      if (!checkRes.ok) {
        const status = checkRes.status;
        const errText = await checkRes.text().catch(() => '');

        // Transient 5xx server errors or 429 rate limits from Google:
        if ((status >= 500 && status < 600) || status === 429) {
          serverErrorCount++;
          send({
            type: 'PROGRESS',
            message: `Google Gemini is indexing video frames (HTTP ${status}, ${elapsedFormatted})...`
          });
          continue;
        }

        // Only abort if Google explicitly returns 404 (file deleted/expired) or 403/401 (invalid key)
        if (status === 404 || status === 403 || status === 401) {
          throw new Error(`Google file check failed (HTTP ${status}): ${errText || 'File not found or permission denied'}`);
        }

        serverErrorCount++;
        send({
          type: 'PROGRESS',
          message: `Waiting for Gemini video frame processing (${elapsedFormatted})...`
        });
        continue;
      }

      serverErrorCount = 0; // Reset error count on successful 200 response
      const fileMeta = await checkRes.json();
      const state = fileMeta.state;

      if (state === 'ACTIVE') {
        return true;
      }

      if (state === 'FAILED') {
        const errMsg = fileMeta.error ? fileMeta.error.message : 'The file failed to be processed by Gemini.';
        throw new Error(`Google video processing failed: ${errMsg}`);
      }

      // State is 'PROCESSING' or 'STATE_UNSPECIFIED': Keep waiting!
      send({
        type: 'PROGRESS',
        message: `Gemini is processing video frames (${elapsedFormatted})...`
      });
    } catch (netErr) {
      if (netErr.message && (netErr.message.includes('Google video processing failed') || netErr.message.includes('permission denied') || netErr.message.includes('File not found') || netErr.message.includes('timed out') || netErr.message.includes('persistent server errors'))) {
        throw netErr;
      }
      serverErrorCount++;
      send({
        type: 'PROGRESS',
        message: `Waiting for Google to finish video frame indexing (${elapsedFormatted})...`
      });
    }
  }
}

// ── Upload Session Blob to Google Files API ─────────────────────────────────
async function uploadSessionBlobToGoogleFiles(sessionId, apiKey, send, abortState) {
  const session = SESSIONS[sessionId];
  if (!session || !session.blob) {
    throw new Error('Video buffer unavailable for Google upload.');
  }

  send({ type: 'PROGRESS', message: `Initializing Google Files API upload (${session.sizeMB}MB)...\nRegistering session with active Gemini API key...` });
  const uploadUrl = await initResumableUpload(session.blob, apiKey);

  send({ type: 'PROGRESS', message: `Uploading video chunks to Google Gemini (${session.sizeMB}MB)...\nActive API key • Resumable stream upload` });
  const uploadResult = await uploadInChunks(session.blob, uploadUrl, apiKey, send);
  const activeFileUri = uploadResult.file.uri;
  const fileResourceName = uploadResult.file.name;
  let fileState = uploadResult.file.state;
  session.fileResourceName = fileResourceName;

  if (fileState !== 'ACTIVE' && fileResourceName) {
    send({ type: 'PROGRESS', message: `Gemini is processing video frames...\nWaiting for Google frame indexing state: ACTIVE...` });
    const localAbort = abortState || createAbortState(sessionId);
    await pollFileState(fileResourceName, apiKey, send, localAbort);
  }

  session.fileUri = activeFileUri;
  const keyLast4 = (apiKey && typeof apiKey === 'string') ? apiKey.trim().slice(-4) : '';
  send({
    type: 'SESSION_FILE_URI',
    sessionId,
    fileUri: activeFileUri,
    fileResourceName: session.fileResourceName,
    sizeMB: session.sizeMB,
    videoUrl: session.videoUrl,
    label: session.label,
    apiKeyLast4: keyLast4,
    apiKeyMasked: keyLast4 ? ('••••' + keyLast4) : ''
  });
  return activeFileUri;
}

async function handleUploadSession({ sessionId, apiKey }, send) {
  startKeepAlive();
  try {
    const session = SESSIONS[sessionId];
    if (!session || !session.blob) {
      send({ type: 'SESSION_BLOB_NOT_FOUND', sessionId });
      return;
    }
    if (!apiKey) throw new Error('Missing Gemini API Key for upload');
    await uploadSessionBlobToGoogleFiles(sessionId, apiKey, send);
  } catch (err) {
    send({ type: 'ERROR', message: `Google Files upload failed: ${err.message}` });
  } finally {
    stopKeepAlive();
  }
}

// ── Network Health Probe ──────────────────────────────────────────────────────
async function checkNetworkHealth() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      ok: false,
      isOffline: true,
      reason: 'Browser reports device is offline',
      userMessage: 'Your device is offline. Check your internet connection.'
    };
  }

  const startTime = Date.now();
  // 1. Direct probe to Google API host (generativelanguage.googleapis.com)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://generativelanguage.googleapis.com', {
      method: 'HEAD',
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;
    // Any HTTP response (including 404/403/200) proves DNS, TCP, TLS and Google API edge are reachable!
    if (res.status > 0) {
      return {
        ok: true,
        target: 'Google Gemini API Edge',
        status: res.status,
        latencyMs,
        reason: 'Connection to Google API edge verified',
        userMessage: 'Internet connection is verified active and Google API edge is reachable.'
      };
    }
  } catch (probeErr) {
    // Probe to Google API failed. Check general internet connectivity via Google 204
    try {
      const gStart = Date.now();
      const gRes = await fetch('https://www.google.com/generate_204', {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      const gLatency = Date.now() - gStart;
      if (gRes.status === 204 || gRes.status > 0) {
        return {
          ok: false,
          isBlocked: true,
          latencyMs: gLatency,
          reason: 'Google API edge unreachable despite active internet',
          userMessage: 'Internet is active, but Google Gemini API (generativelanguage.googleapis.com) is currently unreachable. Check VPN, proxy, or firewall settings.'
        };
      }
    } catch (_) {
      return {
        ok: false,
        isOffline: true,
        reason: 'No internet connection',
        userMessage: 'No internet connection detected. Check Wi-Fi or network connection.'
      };
    }
  }

  return {
    ok: false,
    reason: 'Connection probe timed out',
    userMessage: 'Network probe timed out. Check your internet connection or proxy.'
  };
}

// ── Gemini Server Overload Detection (From GMN Pipeline Pattern) ──────────────
function isGeminiServerOverloadedText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return t.includes('high demand')
    || t.includes('spikes in demand')
    || t.includes('overloaded')
    || t.includes('temporarily unavailable')
    || t.includes('model is currently experiencing')
    || t.includes('resource_exhausted');
}

// ── Network Reconnection Waiter (Preserves Attempt Budget) ────────────────────
async function waitForNetworkReconnection(send, abortState, maxWaitMs = 180000) {
  const checkIntervalMs = 3000;
  const startTime = Date.now();

  send({
    type: 'PROGRESS',
    message: '⚠️ Network connection unavailable (failed to fetch). Waiting for internet connection to be restored... (Retry budget paused ⏸️)'
  });

  while (Date.now() - startTime < maxWaitMs) {
    if (abortState && abortState.isCancelled) return false;

    await interruptibleSleep(checkIntervalMs, abortState);
    if (abortState && abortState.isCancelled) return false;

    const health = await checkNetworkHealth();
    if (health.ok) {
      send({
        type: 'PROGRESS',
        message: '✅ Internet connection restored! Resuming analysis...'
      });
      return true;
    }

    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const maxSec = Math.floor(maxWaitMs / 1000);
    send({
      type: 'PROGRESS',
      message: `⚠️ Network offline. Waiting for internet connection to be restored (${elapsedSec}s / ${maxSec}s)... (Retry budget paused ⏸️)`
    });
  }

  return false;
}

// ── Gemini Generate Content with Auto-Retry & Diagnostics ─────────────────────
async function generateWithAutoRetry(model, apiKey, payload, maxRetries, retryDelayMs, send, session, containerMime, abortState = null) {
  const currentModel = normalizeGeminiModelId(model) || 'gemini-2.5-flash';
  const cleanApiKey = String(apiKey || '').trim();
  let lastError = null;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(cleanApiKey)}`;
  let attempt = 0;
  const modelMaxRetries = maxRetries;

  while (attempt <= modelMaxRetries) {
    if (abortState && abortState.isCancelled) return;
    attempt++;
    let timer = null;
    let controller = null;

    const isRetry = attempt > 1;
    const retryNum = attempt - 1;
    const retryTag = attempt > 1 ? ` [Retry ${retryNum}/${modelMaxRetries}]` : '';

    let prevReasonLine = '';
    if (isRetry && lastError) {
      const reason = lastError.humanReason || (lastError.status ? `HTTP ${lastError.status}` : 'Request Error');
      let errMsg = (lastError.message || '').replace(/\s+/g, ' ').trim();
      if (errMsg.length > 160) errMsg = errMsg.slice(0, 157) + '...';
      prevReasonLine = `\nPrevious try failed: ${reason}${errMsg ? ` - "${errMsg}"` : ''}`;
    }

    try {
      send({
        type: 'PROGRESS',
        message: `Generating analysis with Gemini (${currentModel})${retryTag}... (0s) ⏳\nActive connection • Waiting for response...${prevReasonLine}`
      });

      controller = new AbortController();
      if (abortState) abortState.activeController = controller;
      const startTime = Date.now();

      timer = setInterval(() => {
        if (abortState && abortState.isCancelled) {
          if (controller) controller.abort();
          clearInterval(timer);
          return;
        }
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const elapsedFormatted = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
        send({
          type: 'PROGRESS',
          message: `Generating analysis with Gemini (${currentModel})${retryTag}... (${elapsedFormatted}) ⏳\nActive connection • Waiting for response...${prevReasonLine}`
        });
      }, 1000);
      if (abortState) abortState.activeTimer = timer;

      sanitizePayloadForModel(payload, currentModel);

      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        if (timer) clearInterval(timer);
      }

      if (abortState && abortState.isCancelled) return;

      if (res.ok) {
        const json = await res.json();
        send({ type: 'RESULT', json, model: currentModel });
        return;
      }

      const status = res.status;
      const rawText = await res.text();
      let errorJson = null;
      try { errorJson = JSON.parse(rawText); } catch (_) {}

      let rawApiMessage = (errorJson && errorJson.error && errorJson.error.message) ? errorJson.error.message : rawText;
      const errMessage = rawApiMessage || '';
      let friendlyAdvice = '';

      let humanReason = `HTTP ${status}`;
      if (status === 429) {
        humanReason = 'Rate Limit / Quota Exceeded (429)';
        friendlyAdvice = 'You reached your Gemini API rate limit. Please wait a moment before retrying, or check your quota at ai.google.dev.';
      } else if (status === 503 || rawApiMessage.includes('unreachable') || rawApiMessage.includes('overloaded') || isGeminiServerOverloadedText(rawApiMessage)) {
        humanReason = 'Model Overloaded / High Demand (503)';
        friendlyAdvice = 'Google servers are temporarily experiencing high traffic spikes. Please wait a moment and click "Retry Analysis", or select a Flash model.';
      } else if (status === 400 && (errMessage.includes('API_KEY_INVALID') || errMessage.includes('API key not valid'))) {
        humanReason = 'Invalid API Key (400)';
        friendlyAdvice = 'Your Gemini API Key is invalid. Please check your API key in Settings (⚙️).';
      } else if (status === 400 && (rawApiMessage.includes('10800 images') || rawApiMessage.includes('10800'))) {
        humanReason = 'Video Exceeds 3 Hours (180 Minutes) Limit (400)';
        friendlyAdvice = 'The video duration or selected time range exceeds Google Gemini 3-hour (180 minutes) limit. Please reduce your time range or switch to Mode 2 (Local Download & Upload).';
      } else if (status === 400 && (rawApiMessage.includes('Request contains an invalid argument') || rawApiMessage.includes('INVALID_ARGUMENT'))) {
        humanReason = 'Invalid Argument / Unsupported Stream (400)';
        friendlyAdvice = 'The video length or context window may have exceeded Gemini limits. Try selecting a shorter time range/video length, or switch to Mode 2 (Local Download & Upload) which bypasses Cloud Direct limits.';
      } else if (status === 400) {
        humanReason = 'Invalid Request / File State (400)';
        friendlyAdvice = 'Google rejected this request format. Try a shorter video segment, or switch to Mode 2 (Local Download & Upload).';
      } else if (status === 403 && (errMessage.includes('permission to access the File') || errMessage.includes('not have permission') || errMessage.includes('files/'))) {
        humanReason = 'Video File Scoped to Different API Key or Expired (403)';
        friendlyAdvice = 'This video file was uploaded under a different API key or has expired (Google Files API files are private and automatically deleted after 48 hours). Please re-analyze the video to refresh the video session.';
      } else if (status === 403) {
        humanReason = 'Permission Denied (403)';
        friendlyAdvice = rawApiMessage || 'Google denied permission for this request (HTTP 403).';
      } else if (status === 404) {
        humanReason = `Model Not Found: "${currentModel}" (404)`;
        friendlyAdvice = `The model "${currentModel}" was not found or is deprecated. Please select a supported model like gemini-2.5-flash or gemini-3.5-flash in Settings.`;
      } else if (status >= 500) {
        humanReason = `Google Server Error (${status})`;
        friendlyAdvice = 'Google encountered an internal server error. Please retry in a few moments.';
      }

      lastError = {
        status,
        humanReason,
        message: rawApiMessage || friendlyAdvice,
        friendlyAdvice,
        rawApiMessage,
        rawText,
        errorJson
      };

      // If request ended with a model turn on an incompatible model, auto-repair by converting trailing model turns to user!
      if (status === 400 && errMessage.includes('Requests ending with a model turn are not supported')) {
        send({
          type: 'PROGRESS',
          message: `Model ${currentModel} rejects trailing model turns. Auto-repairing prefill into user turn and retrying...`
        });
        if (payload && Array.isArray(payload.contents)) {
          for (let i = payload.contents.length - 1; i >= 0; i--) {
            if (payload.contents[i].role === 'model') {
              payload.contents[i].role = 'user';
            } else {
              break;
            }
          }
          const merged = [];
          for (const turn of payload.contents) {
            const prev = merged[merged.length - 1];
            if (prev && prev.role === turn.role) prev.parts = prev.parts.concat(turn.parts);
            else merged.push({ role: turn.role, parts: turn.parts.slice() });
          }
          payload.contents = merged;
          continue; // Re-send request immediately with repaired payload!
        }
      }

      // If file link expired, invalid, or belongs to a different API key (403 Permission Denied on File), re-upload or switch to YouTube Direct and re-send!
      const isFileAccessError = (status === 400 || status === 403 || status === 404) && (
        errMessage.includes('files/') ||
        errMessage.includes('permission to access the File') ||
        errMessage.includes('not have permission') ||
        errMessage.includes('ACTIVE') ||
        errMessage.includes('not found') ||
        errMessage.includes('expired') ||
        errMessage.includes('deleted') ||
        errMessage.includes('may not exist')
      );

      if (isFileAccessError) {
        const deadMatch = errMessage.match(/(?:files\/|File\s+)([a-zA-Z0-9_-]+)/i);
        const deadFileUri = (session && session.fileUri) || (deadMatch ? ('files/' + deadMatch[1]) : null);
        const currentSessionId = (session && session.sessionId) || 's_' + Date.now();

        if (session && session.blob) {
          try {
            const freshUri = await uploadSessionBlobToGoogleFiles(currentSessionId, apiKey, send, abortState);
            injectFileUriIntoPayload(payload, freshUri, containerMime || 'video/mp4');
            continue; // Re-send request immediately with fresh link!
          } catch (reupErr) {
            console.debug('[GVC] Re-upload failed:', reupErr);
          }
        } else {
          // In-memory video buffer unavailable: notify user cleanly without switching modes behind their back
          if (status === 404 && deadFileUri) {
            send({
              type: 'STORAGE_FILE_EXPIRED',
              fileUri: deadFileUri,
              fileResourceName: deadFileUri
            });
          }
          if (session) {
            session.fileUri = null;
            session.fileResourceName = null;
          }
          friendlyAdvice = 'Video buffer is no longer in memory. Please click "Fetch Video" or "Analyze Video" to upload the video with your active API key.';
          humanReason = 'Video Session Buffer Expired';
          lastError.friendlyAdvice = friendlyAdvice;
          lastError.humanReason = humanReason;
          lastError.message = friendlyAdvice;
          break; // Stop retrying with a dead file
        }
      }

      const isOverloadedOrRetryable = status === 429
        || status >= 500
        || (status === 400 && errMessage.includes('not in an ACTIVE state'))
        || errMessage.includes('unreachable')
        || errMessage.includes('overloaded')
        || isGeminiServerOverloadedText(errMessage);

      if (isOverloadedOrRetryable && attempt <= modelMaxRetries) {
        if (abortState && abortState.isCancelled) return;
        const waitTime = Math.max(200, Number(retryDelayMs) || 2200);
        let cleanErrMsg = (errMessage || '').replace(/\s+/g, ' ').trim();
        if (cleanErrMsg.length > 160) cleanErrMsg = cleanErrMsg.slice(0, 157) + '...';
        send({
          type: 'PROGRESS',
          message: `⏳ Overloaded / Rate limited (${humanReason}). Retrying with ${currentModel} in ${(waitTime / 1000).toFixed(1)}s • Retry ${attempt}/${modelMaxRetries} (Attempt ${attempt + 1}/${modelMaxRetries + 1})...\nPrevious try failed: ${humanReason}${cleanErrMsg ? ` - "${cleanErrMsg}"` : ''}`
        });
        await interruptibleSleep(waitTime, abortState);
        if (abortState && abortState.isCancelled) return;
        continue;
      }

      break;
    } catch (netErr) {
      if (timer) clearInterval(timer);
      if (abortState && abortState.isCancelled) {
        return;
      }

      // Check if error text is actually a server overload / capacity spike
      const netMsg = (netErr && netErr.message ? netErr.message : String(netErr)).toLowerCase();
      const isDemandSpike = isGeminiServerOverloadedText(netMsg);

      if (isDemandSpike) {
        // Google server capacity spike, NOT client network failure!
        const humanReason = 'Model Overloaded / High Demand (503)';
        const waitTime = Math.max(200, Number(retryDelayMs) || 2500);
        lastError = {
          status: 503,
          humanReason,
          message: 'Google servers are temporarily experiencing high traffic spikes. Spikes in demand are usually temporary.',
          friendlyAdvice: 'Google servers are under heavy traffic spikes. Retrying automatically...',
          rawText: null,
          rawApiMessage: netErr.message,
          errorJson: null
        };

        if (attempt <= modelMaxRetries) {
          if (abortState && abortState.isCancelled) return;
          send({
            type: 'PROGRESS',
            message: `⏳ Overloaded / High Demand (503). Retrying with ${currentModel} in ${(waitTime / 1000).toFixed(1)}s • Retry ${attempt}/${modelMaxRetries} (Attempt ${attempt + 1}/${modelMaxRetries + 1})...\nPrevious try failed: ${humanReason}`
          });
          await interruptibleSleep(waitTime, abortState);
          if (abortState && abortState.isCancelled) return;
          continue;
        }
        break;
      }

      // Active pre-flight check to verify connection health
      const health = await checkNetworkHealth();

      // If device is truly offline or blocked, pause and wait without burning the attempt budget!
      if (!health.ok && (health.isOffline || health.isBlocked)) {
        const reconnected = await waitForNetworkReconnection(send, abortState, 180000);
        if (reconnected && (!abortState || !abortState.isCancelled)) {
          // Attempt budget preservation: restore attempt counter so zero tries are wasted while offline!
          attempt--;
          continue;
        }
      }

      let humanReason = 'Network / Connection Interrupted';
      let detailMsg = '';
      let friendlyAdvice = '';

      if (health.ok) {
        // Internet is active and Google edge is reachable -> Google server dropped the socket or timed out!
        humanReason = 'Google Server Connection Dropped';
        detailMsg = `Internet connection is verified active (Google API responded in ${health.latencyMs}ms). Google's model server dropped the connection or timed out during processing (Server-Side Disconnect).`;
        friendlyAdvice = 'Google servers are experiencing high traffic spikes or request processing timed out. Automatic retry will proceed.';
      } else if (health.isBlocked) {
        humanReason = 'Google API Unreachable';
        detailMsg = health.userMessage;
        friendlyAdvice = 'Ensure traffic to generativelanguage.googleapis.com is allowed in your VPN, proxy, or firewall.';
      } else if (health.isOffline) {
        humanReason = 'Internet Disconnected';
        detailMsg = health.userMessage;
        friendlyAdvice = 'Please reconnect your device to Wi-Fi or network.';
      } else {
        detailMsg = health.userMessage || 'Network connection to Google Gemini API failed or timed out.';
      }

      lastError = {
        status: 0,
        humanReason,
        message: detailMsg,
        friendlyAdvice,
        rawText: null,
        rawApiMessage: null,
        isNetworkError: true,
        networkHealth: health
      };

      if (attempt <= modelMaxRetries) {
        if (abortState && abortState.isCancelled) return;

        const waitTime = Math.max(200, Number(retryDelayMs) || 2500);
        send({
          type: 'PROGRESS',
          message: `⏳ Retrying with ${currentModel} in ${(waitTime / 1000).toFixed(1)}s • Retry ${attempt}/${modelMaxRetries}...`
        });
        await interruptibleSleep(waitTime, abortState);
        if (abortState && abortState.isCancelled) return;
        continue;
      }
      break;
    }
  }

  if (abortState && abortState.isCancelled) return;

  send({
    type: 'DIAGNOSTIC_ERROR',
    attempts: attempt,
    maxRetries: modelMaxRetries,
    model: currentModel,
    error: lastError
  });
}

// ── Fetch Models List ─────────────────────────────────────────────────────────
async function handleFetchModels(apiKey, send) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      const err = await res.text();
      send({ type: 'MODELS_ERROR', message: `HTTP ${res.status}: ${err}` });
      return;
    }
    const data = await res.json();
    const list = data.models || [];

    // Excluded patterns (non-video: image generation, omni audio, transcription, robotics, tools)
    const EXCLUDED_PATTERNS = [
      /image/i,         // Excludes gemini-*-image, nano banana, imagen
      /banana/i,        // Excludes all Nano Banana models
      /omni/i,          // Excludes gemini-omni live audio models
      /transcribe/i,    // Excludes audio transcription models
      /speech/i,        // Excludes speech models
      /tts/i,           // Excludes text-to-speech
      /audio/i,         // Excludes audio models
      /music/i,         // Excludes music models
      /lyria/i,         // Excludes Lyria music
      /imagen/i,        // Excludes Imagen
      /robotics/i,      // Excludes Robotics-ER
      /computer-use/i,  // Excludes Computer Use
      /antigravity/i,   // Excludes Antigravity
      /deep-research/i, // Excludes Deep Research
      /customtools/i,   // Excludes Custom Tools
      /custom-tools/i,  // Excludes Custom Tools
      /embedding/i,     // Excludes Embedding
      /aqa/i,           // Excludes AQA
      /bison/i,         // Excludes Bison
      /learnlm/i,       // Excludes LearnLM
      /medlm/i,         // Excludes MedLM
    ];

    const flashModels = [];
    const proModels = [];
    const otherVideoModels = [];

    list.forEach(m => {
      const id = m.name.replace(/^models\//, '');
      const displayName = m.displayName || id;
      const methods = m.supportedGenerationMethods || [];

      // Must support generateContent
      if (!methods.includes('generateContent')) return;

      // Must be a Gemini or Gemma model
      if (!id.toLowerCase().startsWith('gemini') && !id.toLowerCase().startsWith('gemma')) return;

      // Must NOT match excluded non-video tools
      const isExcluded = EXCLUDED_PATTERNS.some(regex => regex.test(id) || regex.test(displayName));
      if (isExcluded) return;

      const item = { id: id, name: displayName };

      const lowerId = id.toLowerCase();
      if (lowerId.includes('flash') || lowerId.includes('lite')) {
        flashModels.push(item);
      } else if (lowerId.includes('pro') || lowerId.includes('ultra')) {
        proModels.push(item);
      } else {
        otherVideoModels.push(item);
      }
    });

    // Sort newer versions first (e.g. 3.7 -> 3.5 -> 3.1 -> 2.5 -> 2.0)
    const versionSorter = (a, b) => {
      const extractNum = (str) => {
        const match = str.match(/(\d+(?:\.\d+)?)/);
        return match ? parseFloat(match[1]) : (str.includes('latest') ? 99 : 0);
      };
      return extractNum(b.id) - extractNum(a.id);
    };

    flashModels.sort(versionSorter);
    proModels.sort(versionSorter);
    otherVideoModels.sort(versionSorter);

    const groups = [];
    if (flashModels.length)      groups.push({ label: 'Gemini Flash (Fast & Recommended)', models: flashModels });
    if (proModels.length)        groups.push({ label: 'Gemini Pro (Deep Analysis & Reasoning)', models: proModels });
    if (otherVideoModels.length) groups.push({ label: 'Other Video-Capable Models', models: otherVideoModels });

    send({
      type: 'MODELS_RESULT',
      groups,
      total: flashModels.length + proModels.length + otherVideoModels.length
    });
  } catch (err) {
    send({ type: 'MODELS_ERROR', message: err.message });
  }
}
