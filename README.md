# GMN Video Summarizer

A lightweight Chrome and Edge extension that summarizes videos and lets you chat with them directly in your browser using the Gemini API.

[![Extension Manifest V3](https://img.shields.io/badge/extension-Manifest%20V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Gemini API](https://img.shields.io/badge/AI-Google%20Gemini-blue.svg)](https://ai.google.dev/)
[![Platform Chrome / Edge](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-lightgrey.svg)]()
[![License MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
  - [Video Player Detection](#video-player-detection)
  - [Stream Sniffing and Quality Selection](#stream-sniffing-and-quality-selection)
  - [AI Summarization and Video Analysis](#ai-summarization-and-video-analysis)
  - [Multi-Turn Interactive Video Chat](#multi-turn-interactive-video-chat)
  - [Privacy and Client-Side Storage](#privacy-and-client-side-storage)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Permissions](#permissions)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

A simple hobby project built to summarize videos quickly while browsing.

Instead of downloading video files or copying links into separate websites, this extension detects the video playing on your current page (such as X/Twitter, YouTube, or general web video streams) and asks Gemini to give you a quick summary, key takeaways, or answer questions about what is happening in the clip.

---

## Architecture

The extension is client-driven with no external relay or proxy servers:

```text
+-------------------------------------------------------------------------+
| Active Tab (X / YouTube / Generic Video Sites)                          |
|                                                                         |
|  [ Injected Content Script (content.js) ]                               |
|        +---> Video Player Scanner & Frame Observer                      |
|        +---> Video Isolation & Element Docking Overlay                  |
|        +---> Interactive Side Panel & Chat Surface                      |
+-------------------------------------------------------------------------+
                                      |
                         Chrome Extension IPC (Runtime)
                                      |
+-------------------------------------------------------------------------+
| Background Service Worker (background.js)                              |
|                                                                         |
|  +---> webRequest Sniffer: Detects media streams (MP4 / HLS / TS)       |
|  +---> Quality & Size Prober: Live resolution & stream metadata         |
|  +---> Gemini Client: Direct HTTPS payload dispatch & retry recovery    |
|  +---> Local Storage: Prompt presets, API keys, and session history      |
+-------------------------------------------------------------------------+
                                      |
                     Direct HTTPS (generativelanguage.googleapis.com)
                                      |
                               [ Gemini API ]
```

---

## Features

### Video Player Detection
- Web video support: Detects active HTML5 video players on websites such as X (Twitter), YouTube, and arbitrary pages serving web video streams.
- Nested container scanning: Identifies video elements inside common layouts and embedded frames.
- Player isolation: Binds controls specifically to the targeted video player, preventing overlap when multiple media elements are present on a feed.

### Stream Sniffing and Quality Selection
- Network stream prober: Captures direct video URLs and HLS streaming segments (such as `.ts` manifests) via background network inspection.
- Stream resolution probe: Displays available stream resolutions and estimated sizes when available.
- Stream fetching: Strips transient byte-range parameters (`bytestart` / `byteend`) to ensure complete stream fetching.

### AI Summarization and Video Analysis
- Gemini model compatibility: Supports the latest Gemini models via the Google AI Studio API.
- Structured outputs: Generates timestamped summaries, key takeaways, and bulleted overviews.
- Network resilience: Automatic retry handling with backoff on high-demand 503 or transient network conditions.

### Multi-Turn Interactive Video Chat
- In-page conversational panel: Ask follow-up questions, request scene breakdowns, or clarify details about the video.
- Context retention: Maintains conversation history while pruning older turns to respect token limits.
- Query controls: In-flight requests can be cancelled and re-sent directly from the interface.

### Privacy and Client-Side Storage
- Direct connection: Requests travel directly between your browser and Google's official endpoints. No intermediary servers are used.
- Local storage: Prompt templates, user preferences, and history records are preserved in your browser via `chrome.storage.local`.

---

## Prerequisites

| Requirement | Specification |
|-------------|---------------|
| Browser | Google Chrome (version 109+) or Microsoft Edge (version 109+) |
| API Key | A Google Gemini API key (from Google AI Studio) |
| Internet Access | Direct connectivity to `generativelanguage.googleapis.com` |

---

## Installation

### Load Unpacked in Chrome or Edge

1. Clone or download this repository:
   ```bash
   git clone https://github.com/leoparker157/summaryVideos.git
   cd summaryVideos
   ```
2. Open your browser and navigate to the extensions management page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** via the toggle switch in the top-right corner.
4. Click **Load unpacked**.
5. Select the `summaryVideos` project directory.
6. The extension icon will appear in your browser toolbar.

---

## Configuration

1. Click the extension icon in your browser toolbar to open Settings.
2. Enter your Gemini API key.
3. Select your preferred default Gemini model and summary prompt template.
4. Open a page containing a video. The summary overlay badge will dock onto the detected player.

---

## Permissions

The extension uses Manifest V3 with the following scoped permissions:

| Permission | Purpose |
|------------|---------|
| `storage` | Preserves user preferences, API keys, and summary history locally. |
| `webRequest` | Detects media streams, video URLs, and manifest requests in real time. |
| `activeTab` / host permissions | Injects detection scripts and control overlays into pages with video. |

---

## Contributing

Contributions, bug reports, and suggestions are welcome. Please open an issue or submit a pull request on GitHub.

---

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.
