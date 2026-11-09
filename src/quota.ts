import { pacificDate, readJsonFile, writePrivateFile } from "./util.js";

/** Unit costs from https://developers.google.com/youtube/v3/determine_quota_cost */
export const COST = {
  "search.list": 100,
  "videos.list": 1,
  "playlists.list": 1,
  "playlistItems.list": 1,
  "playlists.insert": 50,
  "playlistItems.insert": 50,
  "playlistItems.delete": 50,
} as const;

export type Operation = keyof typeof COST;

interface Ledger {
  date: string;
  used: number;
}

export class QuotaExceededError extends Error {}

/**
 * Local ledger of the units this server has spent today (Pacific Time).
 * It cannot see usage by other apps sharing the same Google Cloud project,
 * so the real remaining quota may be lower; the API's own 403 is still handled.
 */
export class QuotaTracker {
  private ledger: Ledger | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    readonly dailyLimit: number,
  ) {}

  private async load(): Promise<Ledger> {
    const today = pacificDate();
    if (!this.ledger) {
      const stored = await readJsonFile<Ledger>(this.file).catch(() => null);
      this.ledger =
        stored && typeof stored.used === "number" && typeof stored.date === "string"
          ? stored
          : { date: today, used: 0 };
    }
    if (this.ledger.date !== today) this.ledger = { date: today, used: 0 };
    return this.ledger;
  }

  async status(): Promise<{ date: string; used: number; limit: number; remaining: number }> {
    const l = await this.load();
    return { date: l.date, used: l.used, limit: this.dailyLimit, remaining: Math.max(0, this.dailyLimit - l.used) };
  }

  /** Throw before starting work if the estimated cost would exceed what is left today. */
  async ensureAvailable(estimatedCost: number, what: string): Promise<void> {
    const s = await this.status();
    if (estimatedCost > s.remaining) {
      throw new QuotaExceededError(
        `Not enough YouTube API quota for ${what}: needs ~${estimatedCost} units, ${s.remaining} of ${s.limit} left today ` +
          `(resets at midnight Pacific Time). Nothing was changed. Try fewer videos/candidates or wait for the reset.`,
      );
    }
  }

  async record(op: Operation, times = 1): Promise<void> {
    const l = await this.load();
    l.used += COST[op] * times;
    const snapshot = JSON.stringify(l);
    this.writing = this.writing.then(() => writePrivateFile(this.file, snapshot)).catch(() => undefined);
    await this.writing;
  }
}
