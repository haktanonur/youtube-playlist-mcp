# YouTube Playlist MCP

> 🇹🇷 [Türkçe README](README.tr.md)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude, ChatGPT, Cursor, …) **research a topic on YouTube, rank the most valuable videos and save them as a playlist in your account**.

Ask *"I want to learn German, where should I start?"* and get back a ready-to-watch playlist instead of 40 open tabs.

- 🔎 **Searches** 50–100 candidates, with filters for language, country, upload date and duration
- 📊 **Scores** every video 0–100 on popularity, like rate, comment rate and (optionally) recency, so an 8-year-old viral video doesn't win by age alone
- 🧹 **Drops** Shorts, live streams, low-view videos, and caps how many videos one channel can place in the list
- 🧠 **Lets the agent judge relevance** by reading titles and descriptions to remove off-topic, clickbait or wrong-language results
- 👀 **Previews** a numbered list (title, channel, duration, views, score) that you can tweak: "remove #3", "favour newer videos", "sort by like rate"
- ✅ **Creates the playlist only after you approve it**. Playlists are *unlisted* by default
- 🗂️ **Manages** your existing playlists: list them, add videos, remove videos
- 📉 **Tracks the daily API quota** and refuses up front if an action wouldn't fit

**What it doesn't do:** it doesn't watch or summarize videos, upload, comment, like, subscribe, or delete playlists, and it never scrapes. It only uses the official [YouTube Data API v3](https://developers.google.com/youtube/v3).

---

## Setup (about 10 minutes, one time)

Every user creates **their own** free Google Cloud project and OAuth client. You never share keys with the author or anyone else, your data and quota stay yours, and nothing passes through a third-party server.

### 0. Get the code

Requires [Node.js](https://nodejs.org) 22 or newer and git.

```bash
git clone https://github.com/haktanonur/youtube-playlist-mcp.git
cd youtube-playlist-mcp
npm install
npm run build
```

To update later, run `git pull && npm install && npm run build`.

### 1. Create a Google Cloud project and enable the API

1. Go to <https://console.cloud.google.com/> and create a project (e.g. `youtube-playlist-mcp`).
2. Open **APIs & Services → Library**, search for **YouTube Data API v3** and click **Enable**.

### 2. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform** in newer consoles).
2. Choose **External** and fill in an app name and your email. *("Internal" is only offered to Google Workspace organizations. For a personal Gmail account, External is the only option. It doesn't make your app public: while it's in Testing mode, only the test users you add can sign in.)*
3. Under **Audience → Test users**, **add your own Google account** (the one that owns the YouTube channel).
4. Under **Data access**, you can add the scope `https://www.googleapis.com/auth/youtube` (optional; the app asks for it anyway).

> While the app's publishing status is **Testing**, Google expires the authorization after **7 days** and you'll need to run `auth` again. To avoid that, click **Publish app**. Google will warn that the app is unverified, which is expected for a personal app only you use. You can click *Advanced → Go to (app name)*.

### 3. Create an OAuth client

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**.
3. Click **Download JSON**. You'll get a file like `client_secret_XXXX.json`.

### 4. Authorize (in a terminal, inside the project folder)

```bash
npm run auth -- --client-file ~/Downloads/client_secret_XXXX.json
```

A browser window opens. Sign in with your YouTube account and allow access. The client and token are saved to `~/.config/youtube-playlist-mcp/` (on Windows, `%APPDATA%\youtube-playlist-mcp\`) with permissions only you can read. After that you can delete the downloaded JSON.

### 5. Add it to your MCP client

You need two absolute paths: one to `node` (run `which node`, or `where node` on Windows) and one to `dist/index.js` in the folder you cloned.

**Claude Desktop**: edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "youtube-playlist": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/you/youtube-playlist-mcp/dist/index.js"]
    }
  }
}
```

Use the full path to `node`: Claude Desktop doesn't always see your shell's `PATH`.

**Claude Code:**

```bash
claude mcp add youtube-playlist -- node /Users/you/youtube-playlist-mcp/dist/index.js
```

**Cursor / VS Code / others**: use the same `command` + `args` in the client's MCP config.

Restart the client and ask: *"Build me a playlist of the best beginner Python tutorials in English, longer than 20 minutes."*

### Optional: search-only mode with an API key

If you only want search and scoring, without creating playlists, you can skip OAuth and use an API key (**Credentials → Create credentials → API key**, then *restrict it to YouTube Data API v3*):

```json
"env": { "YOUTUBE_API_KEY": "your-key" }
```

---

## Tools

| Tool | What it does | Writes to your account? | Quota |
|---|---|---|---|
| `search_videos` | Search, filter and score candidates | No | ~101 per 50 candidates |
| `preview_playlist` | Numbered preview; exclusions, sorting, recency, custom order | No | 0 |
| `create_playlist` | Create the approved draft (unlisted by default) | **Yes** (needs `confirm: true`) | 50 + 50/video |
| `list_my_playlists` | Your playlists | No | 1 |
| `get_playlist_items` | Videos in a playlist | No | 1 per 50 |
| `add_videos_to_playlist` | Add videos, skipping ones already present | **Yes** (needs `confirm: true`) | 50/video |
| `remove_videos_from_playlist` | Remove videos | **Yes** (needs `confirm: true`) | 50/video |
| `get_status` | Auth state and today's quota usage | No | 0 |

There is also a prompt, `research_playlist`, that walks the agent through the whole workflow.

### Quota

Google gives each project **10,000 units per day** for free (resets at midnight Pacific Time). A typical run looks like this: search 100 candidates (~202) + create a 20-video playlist (1,050) ≈ **1,250 units**, so about 8 playlists a day. Writes are the expensive part: each video added costs 50 units. If your project has a higher quota, set `YOUTUBE_DAILY_QUOTA`.

The counter is kept locally, so it can't see usage from other apps that share the same Cloud project. YouTube's own "quota exceeded" error is still handled cleanly.

### How scoring works

Each signal is converted to a percentile within the candidate pool, then combined with weights you can adjust:

| Signal | Default weight | Notes |
|---|---|---|
| Popularity | 0.45 | Half total views (log scale), half **views per day**, so old videos don't win by age alone |
| Like rate | 0.35 | likes/views with Bayesian smoothing, so 50 views with 10 likes doesn't beat 2M views with 100K likes |
| Comment rate | 0.20 | comments/views, smoothed the same way |
| Recency | 0 (off) | One-year half-life; turn it on with `recency_weight` (e.g. 0.3) |

Hidden likes or disabled comments count as neutral. Filters remove videos ≤60 s (or ≤3 min tagged `#shorts`), live/upcoming streams, videos under 1,000 views (`min_views`), and limit each channel to 2 videos (`max_per_channel`).

---

## Configuration

| Env var | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Alternative to `auth --client-file` |
| `YOUTUBE_API_KEY` | Search-only mode without OAuth |
| `YOUTUBE_DAILY_QUOTA` | Your project's daily quota (default `10000`) |
| `YOUTUBE_PLAYLIST_MCP_HOME` | Config directory (default `~/.config/youtube-playlist-mcp`) |

CLI (from the project folder):

```bash
npm run status    # what is configured
npm run logout    # revoke access at Google and delete the token
```

## Security & privacy

- Uses only the official YouTube Data API over HTTPS. There's no telemetry and no third-party server.
- OAuth uses the installed-app loopback flow with **PKCE (S256)** and a random **state**. The callback listens on `127.0.0.1` only and shuts down after one use or 5 minutes.
- Requests a single scope, `youtube`, which is the narrowest one that can manage playlists. The server has no tool that deletes playlists.
- Tokens and the OAuth client are stored in files with mode `0600`, in a `0700` directory. Credentials are sent in headers, never in URLs.
- Every write tool requires `confirm: true` and is marked with MCP tool annotations. Each draft can only be created once, so a retry can't create duplicate playlists.
- Video titles and descriptions are treated as untrusted. Control and bidi characters are stripped, text is truncated, and the agent is told to treat it as data, not instructions.
- Revoke access at any time with `logout` or at <https://myaccount.google.com/permissions>.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Development

```bash
npm test          # builds and runs unit + end-to-end tests (YouTube API is mocked)
```

Try it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
