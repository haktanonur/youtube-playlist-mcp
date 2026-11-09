import os from "node:os";
import path from "node:path";
import { readJsonFile } from "./util.js";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  /** Directory holding the OAuth token, imported client and quota ledger (0700). */
  homeDir: string;
  /** Optional API key, used for read-only calls when no OAuth token is present. */
  apiKey: string | undefined;
  /** Daily quota of the user's Google Cloud project (default 10,000 units). */
  dailyQuota: number;
}

function defaultHome(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "youtube-playlist-mcp");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "youtube-playlist-mcp");
}

export function loadConfig(): Config {
  const home = process.env.YOUTUBE_PLAYLIST_MCP_HOME;
  const quota = Number(process.env.YOUTUBE_DAILY_QUOTA ?? 10000);
  return {
    homeDir: home && path.isAbsolute(home) ? home : defaultHome(),
    apiKey: process.env.YOUTUBE_API_KEY?.trim() || undefined,
    dailyQuota: Number.isFinite(quota) && quota > 0 ? Math.floor(quota) : 10000,
  };
}

export const paths = (cfg: Config) => ({
  token: path.join(cfg.homeDir, "token.json"),
  client: path.join(cfg.homeDir, "oauth-client.json"),
  quota: path.join(cfg.homeDir, "quota.json"),
});

/**
 * Parse a client_secret_*.json downloaded from Google Cloud Console
 * ("Desktop app" OAuth client). Accepts both the "installed" and "web" shapes.
 */
export function parseClientFile(raw: unknown): OAuthClient {
  const obj = raw as Record<string, { client_id?: unknown; client_secret?: unknown }> | null;
  const section = obj?.installed ?? obj?.web ?? (obj as unknown as { client_id?: unknown; client_secret?: unknown });
  const clientId = typeof section?.client_id === "string" ? section.client_id : "";
  const clientSecret = typeof section?.client_secret === "string" ? section.client_secret : "";
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) {
    throw new Error(
      "This does not look like a Google OAuth client file. Download it from Google Cloud Console → APIs & Services → Credentials → your 'Desktop app' OAuth client → Download JSON.",
    );
  }
  return { clientId, clientSecret };
}

/** OAuth client from env vars, falling back to the file imported by `auth --client-file`. */
export async function loadOAuthClient(cfg: Config): Promise<OAuthClient | null> {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (id && secret) return { clientId: id, clientSecret: secret };
  const stored = await readJsonFile<OAuthClient>(paths(cfg).client);
  if (stored?.clientId && stored?.clientSecret) return stored;
  return null;
}
