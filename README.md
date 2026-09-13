# GMN Video Summarizer

A fast, lightweight browser extension that generates AI-powered video summaries, timestamped breakdowns, and interactive Q&A directly on any webpage using the Google Gemini API.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Gemini API](https://img.shields.io/badge/Google-Gemini_API-blue.svg)](https://ai.google.dev/)
[![Platform](https://img.shields.io/badge/Platform-Chrome_%7C_Edge-lightgrey.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

**GMN Video Summarizer** lets you summarize and chat with videos directly inside your browser without copying links, leaving the page, or relying on external relay servers. It detects video players across YouTube, Twitter/X, and web video platforms, providing instant, structured summaries and multi-turn conversational answers.
<img width="1773" height="1057" alt="Screenshot 2026-09-11 191908" src="https://github.com/user-attachments/assets/6fe4ee7c-a4ce-46a3-ae4c-9859ee560be4" />


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
   git clone https://github.com/leoparker157/gmn-video-summarizer.git
   ```
   *(or download and extract the repository ZIP)*.

2. Open your browser's extension management page:
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`

3. Enable **Developer mode** via the toggle switch in the top-right corner.

4. Click **Load unpacked** and select the `gmn-video-summarizer` directory.

---

## 🔑 How to Get a Gemini API Key from Google AI Studio

This extension requires a Google Gemini API key to generate video summaries and interact with the chat assistant. You can get an API key with a free usage tier directly from Google AI Studio:

1. **Visit Google AI Studio**: Go to [Google AI Studio API Keys](https://aistudio.google.com/apikey) (or [aistudio.google.com](https://aistudio.google.com/)).
2. **Sign In**: Log in using your standard Google account.
3. **Create API Key**:
   - Click the **"Create API key"** (or **"Get API key"**) button.
   - Select **"Create API key in new project"** (fastest setup), or select an existing Google Cloud project from your list.
4. **Copy Your Key**:
   - Once generated, click the copy icon next to your new API key (starts with `AIza...`).
5. **(Optional) Free Tier vs. Paid Tier**:
   - Google AI Studio provides a generous **Free Tier** (rate-limited requests per minute) that is completely sufficient for personal video summarizing and chat.
   - If you need higher rate limits or higher daily quotas, you can click **"Set up billing"** in AI Studio to connect a Google Cloud billing account.

> [!NOTE]
> Keep your API key secure and do not share it publicly. The extension stores your key exclusively in your local browser sandbox (`chrome.storage.local`) and connects directly to Google's official Gemini API endpoints.

---

## ⚙️ Quick Setup

1. **Add Your API Key**:
   - Click the **GMN Video Summarizer** toolbar icon or click the **⚙️ Settings** button on the in-page floating badge.
   - Paste your Gemini API key into the API key field and select your preferred Gemini model (e.g., Gemini Flash or Gemini Pro).
   - Save your settings.
2. **Summarize Any Video**:
   - Navigate to any video on YouTube, X (Twitter), or any website with an HTML5 video player.
   - Click the floating **"Summarize"** badge located on the video player, or right-click the video and select the context menu option.
   - Enjoy instant summaries, key takeaways, timestamped chapters, and interactive Q&A!

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
