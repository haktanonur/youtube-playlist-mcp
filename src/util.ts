import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** YouTube video IDs are exactly 11 chars of [A-Za-z0-9_-]. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** Playlist IDs are longer, same alphabet. */
export const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * Parse an ISO-8601 duration as returned by the YouTube API (e.g. "PT1H2M3S", "P1DT2H").
 * Returns seconds, or null when the value cannot be parsed.
 */
export function parseIsoDuration(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0))
  );
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatCount(n: number | null): string {
  if (n === null) return "?";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Titles and descriptions are third-party, user-generated content. Strip control
 * characters and bidi overrides (which can disguise text), collapse whitespace and
 * truncate so a hostile description cannot flood the agent's context.
 */
export function sanitizeText(value: string | undefined | null, maxLen: number): string {
  if (!value) return "";
  // eslint-disable-next-line no-control-regex
  let out = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ");
  out = out.replace(/[‪-‮⁦-⁩​-‏﻿]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = out.slice(0, maxLen - 1).trimEnd() + "…";
  return out;
}

/** Calendar date (YYYY-MM-DD) in Pacific Time, which is when YouTube quota resets. */
export function pacificDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Create a directory readable only by the current user. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
}

/** Atomically write a file with 0600 permissions (temp file + rename). */
export async function writePrivateFile(file: string, contents: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, file);
  if (process.platform !== "win32") {
    await fs.chmod(file, 0o600).catch(() => undefined);
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
