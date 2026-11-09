import { AuthRequiredError, type TokenManager } from "./auth.js";
import { type Operation, QuotaExceededError, type QuotaTracker } from "./quota.js";
import { PLAYLIST_ID_RE, VIDEO_ID_RE, parseIsoDuration, sanitizeText } from "./util.js";

const API = "https://www.googleapis.com/youtube/v3";

export interface VideoInfo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSec: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** Declared language (defaultAudioLanguage or defaultLanguage), when the uploader set one. */
  language: string | null;
  liveBroadcastContent: string;
  tags: string[];
}

export interface SearchParams {
  query: string;
  maxResults: number;
  order?: "relevance" | "viewCount" | "rating" | "date";
  relevanceLanguage?: string;
  regionCode?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  videoDuration?: "any" | "short" | "medium" | "long";
  safeSearch?: "none" | "moderate" | "strict";
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class YouTubeClient {
  constructor(
    private readonly tokens: TokenManager,
    private readonly apiKey: string | undefined,
    readonly quota: QuotaTracker,
  ) {}

  private async request<T>(
    op: Operation,
    method: "GET" | "POST" | "DELETE",
    resource: string,
    params: Record<string, string | undefined>,
    opts: { body?: unknown; requireOAuth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${API}/${resource}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);

    const headers: Record<string, string> = { Accept: "application/json" };
    const access = await this.tokens.getAccessToken();
    if (access) {
      headers.Authorization = `Bearer ${access}`;
    } else if (opts.requireOAuth) {
      throw new AuthRequiredError("This action needs access to your YouTube account.");
    } else if (this.apiKey) {
      // Header instead of ?key= so the key never ends up in URLs or logs.
      headers["X-Goog-Api-Key"] = this.apiKey;
    } else {
      throw new AuthRequiredError("No credentials configured (set YOUTUBE_API_KEY for search-only use, or authorize with OAuth).");
    }
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
    // Google charges quota for failed requests too.
    await this.quota.record(op);

    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    if (!res.ok) {
      const reason = json.error?.errors?.[0]?.reason;
      const message = sanitizeText(json.error?.message, 300) || `HTTP ${res.status}`;
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        throw new QuotaExceededError(
          "YouTube says today's API quota for your Google Cloud project is used up (resets at midnight Pacific Time).",
        );
      }
      if (res.status === 401) throw new AuthRequiredError("YouTube rejected the credentials.");
      throw new YouTubeApiError(`YouTube API error (${op}): ${message}${reason ? ` [${reason}]` : ""}`, res.status, reason);
    }
    return json as T;
  }

  /** One page of search.list (100 units). */
  async searchPage(p: SearchParams, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
    type R = { items?: { id?: { videoId?: string } }[]; nextPageToken?: string };
    const r = await this.request<R>("search.list", "GET", "search", {
      part: "snippet",
      type: "video",
      q: p.query,
      maxResults: String(Math.min(50, p.maxResults)),
      order: p.order ?? "relevance",
      relevanceLanguage: p.relevanceLanguage,
      regionCode: p.regionCode,
      publishedAfter: p.publishedAfter,
      publishedBefore: p.publishedBefore,
      videoDuration: p.videoDuration && p.videoDuration !== "any" ? p.videoDuration : undefined,
      safeSearch: p.safeSearch ?? "moderate",
      pageToken,
    });
    const ids = (r.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => !!id && VIDEO_ID_RE.test(id));
    return { ids, nextPageToken: r.nextPageToken };
  }

  /** videos.list in batches of 50 (1 unit per batch). */
  async getVideos(ids: string[]): Promise<VideoInfo[]> {
    const unique = [...new Set(ids.filter((id) => VIDEO_ID_RE.test(id)))];
    const out: VideoInfo[] = [];
    for (let i = 0; i < unique.length; i += 50) {
      type Item = {
        id: string;
        snippet?: {
          title?: string;
          description?: string;
          channelId?: string;
          channelTitle?: string;
          publishedAt?: string;
          defaultAudioLanguage?: string;
          defaultLanguage?: string;
          liveBroadcastContent?: string;
          tags?: string[];
        };
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
      };
      const r = await this.request<{ items?: Item[] }>("videos.list", "GET", "videos", {
        part: "snippet,contentDetails,statistics",
        id: unique.slice(i, i + 50).join(","),
        maxResults: "50",
      });
      for (const it of r.items ?? []) {
        const s = it.snippet ?? {};
        out.push({
          id: it.id,
          title: sanitizeText(s.title, 200),
          description: sanitizeText(s.description, 300),
          channelId: s.channelId ?? "",
          channelTitle: sanitizeText(s.channelTitle, 100),
          publishedAt: s.publishedAt ?? "",
          durationSec: parseIsoDuration(it.contentDetails?.duration),
          views: num(it.statistics?.viewCount),
          likes: num(it.statistics?.likeCount),
          comments: num(it.statistics?.commentCount),
          language: (s.defaultAudioLanguage ?? s.defaultLanguage ?? null)?.toLowerCase() ?? null,
          liveBroadcastContent: s.liveBroadcastContent ?? "none",
          tags: (s.tags ?? []).slice(0, 15).map((t) => sanitizeText(t, 40)),
        });
      }
    }
    return out;
  }

  async listMyPlaylists(pageToken?: string) {
    type R = {
      items?: {
        id: string;
        snippet?: { title?: string; description?: string; publishedAt?: string };
        contentDetails?: { itemCount?: number };
        status?: { privacyStatus?: string };
      }[];
      nextPageToken?: string;
      pageInfo?: { totalResults?: number };
    };
    const r = await this.request<R>(
      "playlists.list",
      "GET",
      "playlists",
      { part: "snippet,contentDetails,status", mine: "true", maxResults: "50", pageToken },
      { requireOAuth: true },
    );
    return {
      total: r.pageInfo?.totalResults ?? null,
      nextPageToken: r.nextPageToken,
      playlists: (r.items ?? []).map((p) => ({
        id: p.id,
        title: sanitizeText(p.snippet?.title, 150),
        itemCount: p.contentDetails?.itemCount ?? null,
        privacy: p.status?.privacyStatus ?? null,
        createdAt: p.snippet?.publishedAt ?? null,
        url: `https://www.youtube.com/playlist?list=${p.id}`,
      })),
    };
  }

  /** All items of a playlist (1 unit per 50 items), capped to protect quota. */
  async listPlaylistItems(playlistId: string, max = 500) {
    assertPlaylistId(playlistId);
    type R = {
      items?: {
        id: string;
        snippet?: { title?: string; position?: number; videoOwnerChannelTitle?: string };
        contentDetails?: { videoId?: string };
      }[];
      nextPageToken?: string;
    };
    const items: { playlistItemId: string; videoId: string; position: number | null; title: string; channel: string }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.request<R>(
        "playlistItems.list",
        "GET",
        "playlistItems",
        { part: "snippet,contentDetails", playlistId, maxResults: "50", pageToken },
        { requireOAuth: true },
      );
      for (const it of r.items ?? []) {
        items.push({
          playlistItemId: it.id,
          videoId: it.contentDetails?.videoId ?? "",
          position: it.snippet?.position ?? null,
          title: sanitizeText(it.snippet?.title, 200),
          channel: sanitizeText(it.snippet?.videoOwnerChannelTitle, 100),
        });
      }
      pageToken = r.nextPageToken;
    } while (pageToken && items.length < max);
    return items;
  }

  async createPlaylist(title: string, description: string, privacy: "private" | "unlisted" | "public") {
    const r = await this.request<{ id: string }>(
      "playlists.insert",
      "POST",
      "playlists",
      { part: "snippet,status" },
      {
        requireOAuth: true,
        body: { snippet: { title, description }, status: { privacyStatus: privacy } },
      },
    );
    return r.id;
  }

  async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    assertPlaylistId(playlistId);
    if (!VIDEO_ID_RE.test(videoId)) throw new Error(`Invalid video id: ${videoId}`);
    await this.request(
      "playlistItems.insert",
      "POST",
      "playlistItems",
      { part: "snippet" },
      {
        requireOAuth: true,
        body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
      },
    );
  }

  async removePlaylistItem(playlistItemId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(playlistItemId)) throw new Error("Invalid playlist item id");
    await this.request("playlistItems.delete", "DELETE", "playlistItems", { id: playlistItemId }, { requireOAuth: true });
  }
}

export function assertPlaylistId(id: string): void {
  if (!PLAYLIST_ID_RE.test(id)) throw new Error(`Invalid playlist id: ${id}`);
}
