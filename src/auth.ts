import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Config, type OAuthClient, loadOAuthClient, paths } from "./config.js";
import { readJsonFile, writePrivateFile } from "./util.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * The narrowest scope that allows creating playlists and adding/removing items.
 * (youtube.readonly cannot write; youtube.upload cannot manage playlists.)
 */
export const SCOPE = "https://www.googleapis.com/auth/youtube";

interface StoredToken {
  refresh_token: string;
  access_token?: string;
  /** epoch ms */
  expires_at?: number;
  scope?: string;
}

export class AuthRequiredError extends Error {
  constructor(reason: string) {
    super(
      `${reason} To grant access, run in a terminal:\n  ${authCommand()}\n` +
        `(see the README for how to create the OAuth client).`,
    );
  }
}

/** Exact command for this installation, so the user can copy-paste it. */
export function authCommand(): string {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  return `node "${entry}" auth --client-file /path/to/client_secret.json`;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Only surface Google's error code/description; never echo request bodies (they contain secrets).
    const code = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    const desc = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    const err = new Error(`Google OAuth error ${code}${desc}`);
    (err as Error & { oauthCode?: string }).oauthCode = code;
    throw err;
  }
  return json;
}

/** Holds the OAuth token and refreshes it on demand. */
export class TokenManager {
  private cached: StoredToken | null | undefined;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly cfg: Config) {}

  private get file() {
    return paths(this.cfg).token;
  }

  private async load(): Promise<StoredToken | null> {
    if (this.cached === undefined) {
      const t = await readJsonFile<StoredToken>(this.file).catch(() => null);
      this.cached = t?.refresh_token ? t : null;
    }
    return this.cached;
  }

  async isAuthorized(): Promise<boolean> {
    return (await this.load()) !== null && (await loadOAuthClient(this.cfg)) !== null;
  }

  /** Returns a valid access token, or null if the user never ran `auth`. */
  async getAccessToken(): Promise<string | null> {
    const token = await this.load();
    if (!token) return null;
    if (token.access_token && token.expires_at && token.expires_at - Date.now() > 60_000) {
      return token.access_token;
    }
    this.refreshing ??= this.refresh(token).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(token: StoredToken): Promise<string> {
    const client = await loadOAuthClient(this.cfg);
    if (!client) throw new AuthRequiredError("OAuth client credentials are missing.");
    try {
      const json = await postForm(TOKEN_URL, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      });
      const access = String(json.access_token ?? "");
      if (!access) throw new Error("Google returned no access token.");
      const updated: StoredToken = {
        ...token,
        access_token: access,
        expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
        scope: typeof json.scope === "string" ? json.scope : token.scope,
      };
      this.cached = updated;
      await writePrivateFile(this.file, JSON.stringify(updated));
      return access;
    } catch (err) {
      if ((err as { oauthCode?: string }).oauthCode === "invalid_grant") {
        this.cached = null;
        await fs.rm(this.file, { force: true });
        throw new AuthRequiredError(
          "Your YouTube authorization expired or was revoked (apps in Google 'Testing' mode expire after 7 days).",
        );
      }
      throw err;
    }
  }
}

function openBrowser(url: string): void {
  // URL is built by us; pass as a single argv element, never through a shell string.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* user can open the printed URL manually */
  }
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>YouTube Playlist MCP</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h2>YouTube Playlist MCP</h2><p>${msg}</p></body>`;

/**
 * Interactive OAuth 2.0 "installed app" flow with a loopback redirect, PKCE (S256)
 * and a random state parameter. The callback server listens on 127.0.0.1 only and
 * shuts down after the first valid response or after 5 minutes.
 */
export async function runAuthFlow(cfg: Config, client: OAuthClient, log: (s: string) => void): Promise<void> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = "";
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "Cache-Control": "no-store",
      };
      const gotState = url.searchParams.get("state") ?? "";
      if (!safeEqual(gotState, state)) {
        res.writeHead(400, headers).end(PAGE("Invalid state parameter. Please restart the authorization."));
        return; // keep waiting for the genuine redirect
      }
      const error = url.searchParams.get("error");
      const gotCode = url.searchParams.get("code");
      if (error || !gotCode) {
        res.writeHead(400, headers).end(PAGE("Authorization was not granted. You can close this tab."));
        finish(new Error(`Authorization failed: ${error ?? "no code returned"}`));
        return;
      }
      res.writeHead(200, headers).end(PAGE("Done! You can close this tab and return to the terminal."));
      finish(null, { code: gotCode, redirectUri });
    });

    const timer = setTimeout(() => finish(new Error("Timed out after 5 minutes waiting for authorization.")), 5 * 60_000);
    function finish(err: Error | null, value?: { code: string; redirectUri: string }) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(value!);
    }

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = new URL(AUTH_URL);
      authUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      log("Opening your browser to authorize YouTube access…");
      log("If it does not open, visit this URL manually:\n\n" + authUrl.toString() + "\n");
      openBrowser(authUrl.toString());
    });
  });

  const json = await postForm(TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: code.code,
    code_verifier: verifier,
    redirect_uri: code.redirectUri,
    grant_type: "authorization_code",
  });

  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : "";
  const scope = typeof json.scope === "string" ? json.scope : "";
  if (!refresh) throw new Error("Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and try again.");
  if (!scope.split(" ").includes(SCOPE)) {
    throw new Error("The YouTube permission was not granted (did you untick it on the consent screen?). Please run auth again.");
  }

  const token: StoredToken = {
    refresh_token: refresh,
    access_token: typeof json.access_token === "string" ? json.access_token : undefined,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scope,
  };
  await writePrivateFile(paths(cfg).token, JSON.stringify(token));
}

/** Revoke the refresh token at Google and delete local credentials. */
export async function logout(cfg: Config): Promise<string> {
  const p = paths(cfg);
  const token = await readJsonFile<StoredToken>(p.token).catch(() => null);
  let msg = "No stored YouTube authorization found.";
  if (token?.refresh_token) {
    try {
      await postForm(REVOKE_URL, { token: token.refresh_token });
      msg = "Access revoked at Google and local token deleted.";
    } catch {
      msg = "Local token deleted. (Revocation at Google failed; you can remove access at https://myaccount.google.com/permissions.)";
    }
  }
  await fs.rm(p.token, { force: true });
  return msg;
}
