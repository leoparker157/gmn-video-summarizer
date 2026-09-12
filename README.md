# GMN Video Summarizer

A fast, lightweight browser extension that generates AI-powered video summaries, timestamped breakdowns, and interactive Q&A directly on any webpage using the Google Gemini API.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Gemini API](https://img.shields.io/badge/Google-Gemini_API-blue.svg)](https://ai.google.dev/)
[![Platform](https://img.shields.io/badge/Platform-Chrome_%7C_Edge-lightgrey.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

**GMN Video Summarizer** lets you summarize and chat with videos directly inside your browser without copying links, leaving the page, or relying on external relay servers. It detects video players across YouTube, Twitter/X, and web video platforms, providing instant, structured summaries and multi-turn conversational answers.

---

## ✨ Main Features

- **In-Page Video Summaries**: Convenient floating badge and right-click shortcut on video players for quick, one-click analysis.
- **Timestamped Narrative Breakdowns**: Generates detailed chronological overviews with specific timestamps covering the video from start to finish.
- **Interactive Multi-Turn Chat**: Ask follow-up questions, request deeper topic explanations, or extract key takeaways directly in the chat panel.
- **Dual Processing Modes**:
  - **Cloud Direct**: Instant server-side analysis for public YouTube videos with zero local bandwidth consumption.
  - **Local Processing**: Captures and uploads video streams or audio tracks to accommodate long playthroughs, lectures, and web media.
- **Gemini Model Selection**: Fully compatible with Gemini Flash (fast & efficient) and Gemini Pro (deep reasoning) via Google AI Studio.
- **Custom Prompts & Presets**: Easily customize, export, and import multiple prompt presets tailored for study, news, tutorials, or leisure.
- **Privacy-First & Client-Side**: Direct communication between your browser and Google's official Gemini API. Your API key and preferences are stored strictly on your local machine (`chrome.storage.local`).

---

## 🚀 Installation

### Load Unpacked in Chrome or Edge

1. **Clone or Download** this repository:
   ```bash
   git clone https://github.com/leoparker157/summaryVideos.git
   ```
   *(or download and extract the repository ZIP)*.

2. Open your browser's extension management page:
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`

3. Enable **Developer mode** via the toggle switch in the top-right corner.

4. Click **Load unpacked** and select the `summaryVideos` directory.

---

## ⚙️ Quick Setup

1. Obtain a Gemini API key from [Google AI Studio](https://aistudio.google.com/).
2. Open the extension panel by clicking the toolbar icon or the **⚙️ Settings** button.
3. Paste your Gemini API key and select your preferred Gemini model.
4. Navigate to any video (YouTube, X/Twitter, or web video player) and:
   - Click the on-player **"Summarize"** badge, or
   - Right-click directly on the video player to open the summarizer panel.

---

## 🔒 Privacy & Permissions

- **Direct API Requests**: All requests are sent directly from your browser to Google's official `generativelanguage.googleapis.com` endpoint. No intermediary relays or tracking servers are used.
- **Local Storage**: API keys and saved presets are stored strictly in your browser's local sandbox storage.

| Permission | Purpose |
| :--- | :--- |
| `storage` | Saves your API key, settings, and custom prompt presets locally. |
| `contextMenus` | Adds a right-click context menu option to summarize active videos. |
| `webRequest` | Detects video streams and playback sources on the active page. |

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
