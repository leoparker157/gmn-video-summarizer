/**
 * GMN Universal Video Summarizer — Extension Action Popup Script
 * Includes Controls & Storage Upload History View
 */
'use strict';

const toggleBadge = document.getElementById('toggle-badge');
const btnOpenPanel = document.getElementById('btn-open-panel');
const tabBtnControls = document.getElementById('tab-btn-controls');
const tabBtnHistory = document.getElementById('tab-btn-history');
const panelControls = document.getElementById('panel-controls');
const panelHistory = document.getElementById('panel-history');
const historyBadge = document.getElementById('history-badge');
const histList = document.getElementById('hist-list');
const histSearch = document.getElementById('hist-search');
const histStatusText = document.getElementById('hist-status-text');
const btnVerifyHistory = document.getElementById('btn-verify-history');
const btnClearExpired = document.getElementById('btn-clear-expired');

// Unified storage helper — reads/writes directly from chrome.storage.local (same storage as content.js)
const store = {
  get: (keys) => new Promise((resolve) => {
    chrome.storage.local.get(keys, (localRes) => {
      if (chrome.runtime.lastError) {
        if (chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.get(keys, resolve);
        } else {
          resolve({});
        }
      } else {
        // Fallback/merge any keys that might have been saved to sync
        if (chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.get(keys, (syncRes) => {
            resolve({ ...(syncRes || {}), ...(localRes || {}) });
          });
        } else {
          resolve(localRes || {});
        }
      }
    });
  }),
  set: (obj) => new Promise((resolve) => {
    chrome.storage.local.set(obj, () => {
      resolve();
    });
  })
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizePageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    const ytMatch = rawUrl.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return `https://www.youtube.com/watch?v=${ytMatch[1]}`;

    const twMatch = rawUrl.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
    if (twMatch) return `https://x.com/i/status/${twMatch[1]}`;

    const ttMatch = rawUrl.match(/tiktok\.com\/@([^/]+)\/video\/(\d+)/i);
    if (ttMatch) return `https://www.tiktok.com/@${ttMatch[1]}/video/${ttMatch[2]}`;

    const fbMatch = rawUrl.match(/facebook\.com\/watch\/\?v=(\d+)/i);
    if (fbMatch) return `https://www.facebook.com/watch/?v=${fbMatch[1]}`;

    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'ref_src', 's', 't', 'spm'];
    for (const p of trackingParams) u.searchParams.delete(p);
    u.hash = '';
    return u.toString();
  } catch (_) {
    return rawUrl.split('#')[0];
  }
}

function extractVideoIdentifier(url) {
  if (!url || typeof url !== 'string') return null;
  const ytMatch = url.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return ytMatch[1];
  const twMatch = url.match(/status\/(\d+)/);
  if (twMatch) return twMatch[1];
  const ttMatch = url.match(/video\/(\d+)/);
  if (ttMatch) return ttMatch[1];
  const fbMatch = url.match(/[?&]v=(\d+)/);
  if (fbMatch) return fbMatch[1];
  return null;
}

function extractPlatformInfo(url) {
  if (!url) return { platform: 'Web Video', icon: '🌐' };
  const str = url.toLowerCase();
  if (str.includes('youtube.com') || str.includes('youtu.be')) return { platform: 'YouTube', icon: '▶️' };
  if (str.includes('twitter.com') || str.includes('x.com') || str.includes('twimg.com')) return { platform: 'Twitter / X', icon: '𝕏' };
  if (str.includes('tiktok.com')) return { platform: 'TikTok', icon: '📱' };
  if (str.includes('reddit.com')) return { platform: 'Reddit', icon: '🤖' };
  if (str.includes('facebook.com') || str.includes('fb.watch')) return { platform: 'Facebook', icon: '👥' };
  if (str.includes('instagram.com')) return { platform: 'Instagram', icon: '📷' };
  if (str.includes('vimeo.com')) return { platform: 'Vimeo', icon: '📼' };
  return { platform: 'Web Video', icon: '🌐' };
}

function formatRemainingTime(expiresAt) {
  if (!expiresAt) return { text: '⚡ Active on API', isExpired: false };
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return { text: '⚠️ Expired', isExpired: true };
  const hours = Math.floor(diffMs / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  if (hours > 0) return { text: `⏳ Expires in ${hours}h ${mins}m`, isExpired: false };
  return { text: `⏳ Expires in ${mins}m`, isExpired: false };
}

// ── Storage History Functions ────────────────────────────────────────────────
let cachedHistoryItems = [];

async function getStorageHistory() {
  const data = await store.get(['gvc_storage_history', 'gvc_url_cache']);
  let history = Array.isArray(data.gvc_storage_history) ? data.gvc_storage_history : [];

  // Sync legacy gvc_url_cache entries if not present
  const urlCache = data.gvc_url_cache || {};
  let updated = false;
  const now = Date.now();
  const maxAge = 44 * 3600 * 1000;

  for (const [cleanUrl, entry] of Object.entries(urlCache)) {
    if (!entry || !entry.fileUri) continue;
    if (now - (entry.createdAt || 0) > maxAge) continue;
    const exists = history.some(h => h.fileUri === entry.fileUri || h.cleanUrl === cleanUrl);
    if (!exists) {
      const plat = extractPlatformInfo(cleanUrl);
      history.push({
        id: 'c_' + (entry.createdAt || Date.now()),
        pageUrl: cleanUrl,
        pageTitle: entry.label || 'Web Video Stream',
        cleanUrl: cleanUrl,
        videoId: extractVideoIdentifier(cleanUrl),
        fileUri: entry.fileUri,
        fileResourceName: (entry.fileUri.match(/files\/[a-zA-Z0-9_-]+/) || [])[0] || entry.fileUri,
        sizeMB: entry.sizeMB || '0',
        createdAt: entry.createdAt || Date.now(),
        expiresAt: (entry.createdAt || Date.now()) + 48 * 3600 * 1000,
        platform: plat.platform,
        icon: plat.icon
      });
      updated = true;
    }
  }

  if (updated) {
    history.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await store.set({ gvc_storage_history: history });
  }

  cachedHistoryItems = history;
  updateBadge(history.length);
  return history;
}

function updateBadge(count) {
  if (historyBadge) {
    historyBadge.innerText = String(count || 0);
  }
}

function renderHistory(items) {
  if (!histList) return;

  if (!items || items.length === 0) {
    histList.innerHTML = `
      <div class="hist-empty">
        <span class="hist-empty-icon">📭</span>
        <div class="hist-empty-title">No Uploaded Videos Yet</div>
        <div class="hist-empty-desc">Videos uploaded to Google Gemini Files API storage will appear here for 48 hours for instant re-summarizing without re-downloading.</div>
      </div>
    `;
    return;
  }

  histList.innerHTML = items.map((item) => {
    const timeInfo = formatRemainingTime(item.expiresAt);
    const platInfo = extractPlatformInfo(item.pageUrl || item.cleanUrl);
    const resourceName = item.fileResourceName || (item.fileUri ? (item.fileUri.match(/files\/[a-zA-Z0-9_-]+/) || [])[0] : 'files/...');

    return `
      <div class="hist-card" data-id="${esc(item.id)}" data-uri="${esc(item.fileUri)}">
        <div class="hist-card-hdr">
          <div class="hist-tags">
            <span class="hist-tag hist-tag-plat">${esc(platInfo.icon)} ${esc(platInfo.platform)}</span>
            <span class="hist-tag hist-tag-size">${esc(item.sizeMB || '0')} MB</span>
          </div>
          <span class="hist-tag ${timeInfo.isExpired ? 'hist-tag-expired' : 'hist-tag-time'}">${esc(timeInfo.text)}</span>
        </div>

        <div class="hist-card-title btn-load-target" data-id="${esc(item.id)}" title="Click to load page and prepare tool">${esc(item.pageTitle || 'Video Stream')}</div>

        <div class="hist-uri-box">
          <code class="hist-uri-code" title="${esc(item.fileUri)}">${esc(resourceName)}</code>
          <button type="button" class="btn-copy-uri" data-uri="${esc(item.fileUri)}" title="Copy Google Files API URI">📋 Copy</button>
        </div>

        ${item.summarySnippet ? `<div class="hist-snippet">${esc(item.summarySnippet)}</div>` : ''}

        <div class="hist-card-actions">
          <button type="button" class="btn-load btn-load-target" data-id="${esc(item.id)}">
            <span>⚡ Load & Prepare Tool</span>
          </button>
          <button type="button" class="btn-del btn-del-item" data-id="${esc(item.id)}" title="Remove from history">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tabName) {
  if (tabName === 'controls') {
    tabBtnControls.classList.add('active');
    tabBtnHistory.classList.remove('active');
    panelControls.classList.add('active');
    panelHistory.classList.remove('active');
  } else if (tabName === 'history') {
    tabBtnHistory.classList.add('active');
    tabBtnControls.classList.remove('active');
    panelHistory.classList.add('active');
    panelControls.classList.remove('active');
    loadAndRenderHistory();
  }
}

async function loadAndRenderHistory() {
  const items = await getStorageHistory();
  renderHistory(items);
}

// ── Load & Prepare Tool on Page ──────────────────────────────────────────────
async function loadItemAndPrepare(item) {
  if (!item) return;

  // Store preparation target in storage for robust cross-navigation persistence
  await store.set({
    gvc_prepare_target: {
      pageUrl: item.pageUrl,
      fileUri: item.fileUri,
      fileResourceName: item.fileResourceName,
      sizeMB: item.sizeMB,
      pageTitle: item.pageTitle,
      cleanUrl: item.cleanUrl,
      videoId: item.videoId,
      createdAt: Date.now()
    }
  });

  const normTarget = normalizePageUrl(item.pageUrl);
  const targetVidId = item.videoId || extractVideoIdentifier(item.pageUrl);

  // Check if a tab with this page is already open
  chrome.tabs.query({}, (tabs) => {
    let matchedTab = null;

    if (tabs && tabs.length > 0) {
      for (const t of tabs) {
        if (!t.url) continue;
        const normTabUrl = normalizePageUrl(t.url);
        const tabVidId = extractVideoIdentifier(t.url);

        if (normTabUrl === normTarget || (targetVidId && tabVidId === targetVidId)) {
          matchedTab = t;
          break;
        }
      }
    }

    if (matchedTab && matchedTab.id != null) {
      // Focus the existing tab and window
      chrome.tabs.update(matchedTab.id, { active: true }, () => {
        if (matchedTab.windowId != null) {
          chrome.windows.update(matchedTab.windowId, { focused: true });
        }
        // Send message to immediately open and prepare tool on page
        chrome.tabs.sendMessage(matchedTab.id, {
          type: 'LOAD_PREPARED_STORAGE',
          item: item
        }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      });
    } else {
      // Create new tab directly with target URL
      chrome.tabs.create({ url: item.pageUrl, active: true }, () => {
        window.close();
      });
    }
  });
}

// ── Event Listeners ──────────────────────────────────────────────────────────

// Tab Switch Buttons
if (tabBtnControls) {
  tabBtnControls.addEventListener('click', () => switchTab('controls'));
}
if (tabBtnHistory) {
  tabBtnHistory.addEventListener('click', () => switchTab('history'));
}

// Search Filter Input
if (histSearch) {
  histSearch.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      renderHistory(cachedHistoryItems);
      return;
    }
    const filtered = cachedHistoryItems.filter((it) => {
      const t = (it.pageTitle || '').toLowerCase();
      const u = (it.pageUrl || '').toLowerCase();
      const p = (it.platform || '').toLowerCase();
      const r = (it.fileResourceName || it.fileUri || '').toLowerCase();
      return t.includes(q) || u.includes(q) || p.includes(q) || r.includes(q);
    });
    renderHistory(filtered);
  });
}

// History List Delegated Clicks (Load, Copy, Delete)
if (histList) {
  histList.addEventListener('click', async (e) => {
    // Copy URI
    const copyBtn = e.target.closest('.btn-copy-uri');
    if (copyBtn) {
      e.stopPropagation();
      const uri = copyBtn.dataset.uri;
      if (uri) {
        navigator.clipboard.writeText(uri).then(() => {
          const orig = copyBtn.innerText;
          copyBtn.innerText = '✓ Copied!';
          setTimeout(() => { copyBtn.innerText = orig; }, 1800);
        });
      }
      return;
    }

    // Delete item
    const delBtn = e.target.closest('.btn-del-item');
    if (delBtn) {
      e.stopPropagation();
      const itemId = delBtn.dataset.id;
      if (itemId) {
        let history = await getStorageHistory();
        history = history.filter(h => String(h.id) !== String(itemId) && h.fileUri !== itemId && h.fileResourceName !== itemId);
        await store.set({ gvc_storage_history: history });
        cachedHistoryItems = history;
        updateBadge(history.length);
        renderHistory(history);
      }
      return;
    }

    // Load page & prepare tool
    const loadBtn = e.target.closest('.btn-load-target');
    if (loadBtn) {
      e.stopPropagation();
      const itemId = loadBtn.dataset.id;
      const item = cachedHistoryItems.find(h => String(h.id) === String(itemId) || h.fileUri === itemId || h.fileResourceName === itemId);
      if (item) {
        loadItemAndPrepare(item);
      }
      return;
    }
  });
}

// Verify Google Files API Uploads
if (btnVerifyHistory) {
  btnVerifyHistory.addEventListener('click', async () => {
    btnVerifyHistory.disabled = true;
    btnVerifyHistory.innerText = '⏳ Checking...';
    if (histStatusText) histStatusText.innerText = 'Verifying storage status with Google API...';

    const data = await store.get(['gvc_storage_history', 'gic_v_api_key', 'gvc_api_key']);
    const history = Array.isArray(data.gvc_storage_history) ? data.gvc_storage_history : [];
    const apiKey = (data.gic_v_api_key || data.gvc_api_key || '').trim();

    if (!apiKey) {
      alert('Please set a Gemini API Key in the summarizer tool settings to verify Google Files API status.');
      btnVerifyHistory.disabled = false;
      btnVerifyHistory.innerText = '🔄 Verify';
      if (histStatusText) histStatusText.innerText = 'Google Files API uploads (48h cache)';
      return;
    }

    const verified = [];
    for (const item of history) {
      const resName = item.fileResourceName || (item.fileUri ? (item.fileUri.match(/files\/[a-zA-Z0-9_-]+/) || [])[0] : null);
      if (!resName) continue;
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${resName}?key=${encodeURIComponent(apiKey)}`);
        if (res.ok) {
          const json = await res.json();
          if (json.state === 'ACTIVE' || json.state === 'PROCESSING') {
            if (json.expirationTime) item.expiresAt = new Date(json.expirationTime).getTime();
            verified.push(item);
          }
        }
      } catch (_) {
        verified.push(item);
      }
    }

    await store.set({ gvc_storage_history: verified });
    cachedHistoryItems = verified;
    updateBadge(verified.length);
    renderHistory(verified);

    btnVerifyHistory.disabled = false;
    btnVerifyHistory.innerText = '🔄 Verify';
    if (histStatusText) histStatusText.innerText = `Verified: ${verified.length} active files on Google Storage`;
  });
}

// Clear Expired Button
if (btnClearExpired) {
  btnClearExpired.addEventListener('click', async () => {
    const history = await getStorageHistory();
    const now = Date.now();
    const valid = history.filter(h => !h.expiresAt || (h.expiresAt > now));
    await store.set({ gvc_storage_history: valid });
    cachedHistoryItems = valid;
    updateBadge(valid.length);
    renderHistory(valid);
  });
}

// Initialize Controls Toggle & Pre-load History
async function initPopup() {
  const data = await store.get(['gic_v_show_video_badge']);
  const isEnabled = (data.gic_v_show_video_badge !== false);
  if (toggleBadge) {
    toggleBadge.checked = isEnabled;
  }

  // Pre-load and sync history right away on popup open
  const history = await getStorageHistory();
  updateBadge(history.length);
  if (panelHistory && panelHistory.classList.contains('active')) {
    renderHistory(history);
  }
}

// Live Storage Updates
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.gvc_storage_history || changes.gvc_url_cache)) {
      getStorageHistory().then((items) => {
        if (panelHistory && panelHistory.classList.contains('active')) {
          renderHistory(items);
        }
      });
    }
  });
}

// Toggle Badge Change
if (toggleBadge) {
  toggleBadge.addEventListener('change', async (e) => {
    const isChecked = e.target.checked;
    await store.set({ gic_v_show_video_badge: isChecked });

    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        if (t.id != null) {
          chrome.tabs.sendMessage(t.id, {
            type: 'TOGGLE_VIDEO_BADGES',
            enabled: isChecked
          }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    });
  });
}

// "Open Summarizer on Page"
if (btnOpenPanel) {
  btnOpenPanel.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id != null) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'ACTION_ICON_CLICKED' }, { frameId: 0 }, () => {
          void chrome.runtime.lastError;
        });
      }
      window.close();
    });
  });
}

initPopup();
