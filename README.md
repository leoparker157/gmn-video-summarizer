# GMN Video Summarizer

A lightweight Chrome and Edge extension that summarizes videos and lets you chat with them directly in your browser using the Gemini API.

[![Extension Manifest V3](https://img.shields.io/badge/extension-Manifest%20V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Gemini API](https://img.shields.io/badge/AI-Google%20Gemini-blue.svg)](https://ai.google.dev/)
[![Platform Chrome / Edge](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-lightgrey.svg)]()
[![License MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Table of Contents

- [Important Notice: Processing Limits (Cloud vs Local)](#important-notice-processing-limits-cloud-vs-local)
- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
  - [Video Player Detection](#video-player-detection)
  - [Stream Sniffing and Quality Selection](#stream-sniffing-and-quality-selection)
  - [AI Summarization and Video Analysis](#ai-summarization-and-video-analysis)
  - [Multi-Turn Interactive Video Chat](#multi-turn-interactive-video-chat)
  - [Processing Modes & Limits (Cloud vs Local)](#processing-modes--limits-cloud-vs-local)
  - [Privacy and Client-Side Storage](#privacy-and-client-side-storage)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Permissions](#permissions)
- [Contributing](#contributing)
- [License](#license)

---

## Important Notice: Processing Limits (Cloud vs Local)

> [!IMPORTANT]
> ### ⚠️ Operational Limits Notice: Cloud Direct vs. Local Mode
>
> When summarizing videos, the maximum length you can process depends strictly on the pathway you choose:
>
> - **☁️ Cloud Direct (Mode 1) is limited by Google's Gemini API Ingestion Limits:**
>   - **Maximum Duration:** Capped at **3 hours (180 minutes / 10,800 frames at 1 fps)**.
>   - **Source File Pre-Validation Gate:** Google checks and validates the *total length of the original YouTube video* before applying any `startOffset` or `endOffset`. If the source video exceeds 3 hours (such as a 17-hour playthrough or long livestream), Google rejects the request with `HTTP 400 INVALID_ARGUMENT: Request contains an invalid argument`, even if your chosen timestamp offset is only 1 minute long.
>   - **Eligibility:** Strictly requires standard public YouTube videos (active livestreams, premiere waiting rooms, age-gated, or member-only videos are not supported).
>   - **Bandwidth:** Consumes **0 MB** of your local download or upload bandwidth.
>
> - **💻 Local Download & Upload (Mode 2) is limited by your Model's Maximum Token Context Window:**
>   - **No 3-Hour Source Video Duration Gate:** Not subject to Google's 3-hour Cloud Direct ingestion ceiling. Any video length can be processed as long as its token count fits within the selected Gemini model's context window.
>   - **Token Consumption Rates:**
>     - **Full Video (1 frame/sec):** Consumes **~258 tokens per second** (~930,000 tokens per hour).
>       - **1M Token Window** (e.g. standard Flash models): Supports up to **~45 to 60 minutes** of full video.
>       - **2M Token Window** (e.g. Gemini 1.5 Pro / Flash): Supports up to **~2 to 2.5 hours** of full video.
>     - **Audio Only (*Fastest & Recommended for Long Videos*):** Consumes only **32 tokens per second** (~115,000 tokens per hour).
>       - **1M Token Window:** Supports up to **~8.5 hours** of continuous audio.
>       - **2M Token Window:** Supports up to **17.5+ hours** of continuous audio! Perfect for multi-hour gameplay walkthroughs, conference talks, podcasts, and long streams.
>   - **Google File API Upload Limit:** Supports file uploads up to **20 GB per file**, and uploaded media is automatically cached on Google's servers for **48 hours** for fast follow-up chat turns at zero re-upload bandwidth.

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

### Processing Modes & Limits (Cloud vs Local)

The extension offers two distinct processing pathways designed for different video lengths and use cases:

| Pathway | Primary Limit | Key Constraints & Specifications |
| :--- | :--- | :--- |
| **☁️ Mode 1: Cloud Direct** *(Zero Bandwidth)* | **Google Gemini API Limit** | • **Max 3 hours (180 minutes / 10,800 frames at 1 fps)** total video duration.<br>• Google pre-validates the source video file and rejects any video over 3 hours before applying `startOffset`/`endOffset`.<br>• Strictly requires **public, standard YouTube videos** (no active livestreams, premiere queues, or age/member-restricted videos).<br>• Uses **0 MB** of your local download/upload bandwidth. |
| **💻 Mode 2: Local Download & Upload** | **Model Max Token Context Window** | • **No 3-hour video duration gate** on the input source.<br>• Bounded only by your selected model's token context window:<br>&nbsp;&nbsp;– **Full Video (Frames):** Up to ~2–2.5 hours on 2M token models (~45–60 min on 1M models) at ~258 tokens/sec.<br>&nbsp;&nbsp;– **Audio (Fastest):** Up to **17.5+ hours** on 2M token models (only 32 tokens/sec)! Ideal for long playthroughs, podcasts, and streams.<br>• Supports all browser-playable video sources.<br>• Uploads up to 20 GB to Google File API; **cached for 48 hours** for instant zero-bandwidth re-analysis and multi-turn chat. |

#### Detailed Limits Breakdown

1. **Cloud Direct Mode (Gemini API Limit):**
   - **Google's Ingestion Gate:** Cloud direct ingestion passes the YouTube URL (`fileUri`) directly to Google's server-side ingestion pipeline. Google enforces a strict ceiling of **10,800 frames (3 hours at 1 fps)** per video.
   - **Full Video Pre-Validation:** Even if you define an offset window like `16:25:39` to `17:42:10`, Google's API checks the duration of the entire source YouTube video *first*. If total video duration > 3 hours, the request is rejected with `HTTP 400: Request contains an invalid argument`.
   - **Best Use Case:** Fast summaries of standard YouTube videos under 3 hours where you want instant results without downloading anything.

2. **Local Download & Upload Mode (Model Max Token Limit):**
   - **Token Math:** Media uploaded to the Gemini File API is tokenized according to Google's multimodal specifications:
     - **Video Frames:** 1 image frame per second = **~258 tokens/sec** (~930,000 tokens/hour).
     - **Audio Track:** 1 second of audio = **32 tokens/sec** (~115,000 tokens/hour).
   - **Context Window Capacity:**
     - **1 Million Token Window** (Gemini 2.5 Flash, Gemini 1.5 Flash 1M):
       - Full Video: ~45–60 minutes.
       - Audio Only: **~8.5 hours**.
     - **2 Million Token Window** (Gemini 1.5 Pro, Gemini 1.5 Flash 2M):
       - Full Video: ~2–2.5 hours.
       - Audio Only: **17.5+ hours**!
   - **Best Use Case:** Long playthroughs (10–20+ hours), lectures, webinars, podcasts, or videos that fail Cloud Direct ingestion. Choosing **Audio (Fastest)** processes multi-hour videos in seconds while easily staying within the model's context window.

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
