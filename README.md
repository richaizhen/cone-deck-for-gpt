# Cone Deck for GPT

> Navigate long chats, organize conversations into folders, and archive them with ease.

Cone Deck is an unofficial Chrome extension for [chatgpt.com](https://chatgpt.com) that adds two things the native UI doesn't:

- **A conversation navigator** — a minimap of your own messages in the current chat, so you can jump anywhere in a long thread.
- **A folder organizer** — group your conversations into folders right in ChatGPT's sidebar, and archive the ones you're done with.

Everything runs locally in your browser. No accounts, no servers, no tracking.

> **Note:** Cone Deck is an independent project and is **not affiliated with or endorsed by OpenAI**.

## Features

### Conversation navigator (right-side panel)
- Jump to any message you sent in a long conversation — click an entry or a dot.
- **Search** to filter your messages.
- A compact **minimap of dots** when collapsed.
- Markers for the **images / videos / files you uploaded** (`Image upload`, `Video upload`, `Attachment`) so you can jump straight to them.
- **Light / System / Dark** themes.

### Folder organizer (ChatGPT's left sidebar)
- Create **folders** and drag conversations into them.
- **Rename** and **delete** folders.
- **Archive** conversations you no longer need.
- The **Folders** section sits in the sidebar, just above your conversation list.
- Collapse individual folders or the whole module to keep things tidy.

## Install (unpacked)

Cone Deck isn't on the Chrome Web Store yet, so load it as an unpacked extension:

1. Download this repository (**Code → Download ZIP**, or `git clone`) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Open or reload [chatgpt.com](https://chatgpt.com) — the navigator appears on the right, and the **Folders** section in the left sidebar.

After editing any file, click the **reload** icon on the extension's card and refresh chatgpt.com.

## Privacy

Cone Deck is built to keep your data on your machine:

- The only permission it requests is **`storage`** (to remember your folders, theme, and panel state).
- All data is stored **locally** via `chrome.storage.local`. Nothing is sent anywhere.
- It makes **no network requests** and includes **no analytics or tracking**.
- It only runs on `https://chatgpt.com/*` and `https://chat.openai.com/*`.

You can verify all of this by reading the source — it's a handful of plain JavaScript/CSS files, with no build step and no dependencies.

## Project layout

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3 definition |
| `content.js` | Bootstrap, theming, shared utilities, local storage |
| `navigator.js` | The conversation navigator panel |
| `organizer.js` | The folder organizer in the sidebar |
| `panel.css` | All styles |
| `icons/` | Extension icons |

## Made by

[**ConeLab**](https://conelab.ai) — [conelab.ai](https://conelab.ai)

## License

[MIT](LICENSE)
