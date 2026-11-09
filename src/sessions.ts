import type { SearchParams, VideoInfo } from "./youtube.js";
import type { FilterOptions, ScoredVideo, Weights } from "./scoring.js";
import { randomId } from "./util.js";

export interface SearchSession {
  id: string;
  createdAt: number;
  params: SearchParams;
  filters: FilterOptions;
  weights: Weights;
  /** Videos that passed hard filters (unscored; re-scored on demand). */
  pool: VideoInfo[];
  /** Video ids removed by the agent or user; sticky across previews. */
  excluded: Set<string>;
  hardExcluded: Record<string, string>;
}

export interface Draft {
  id: string;
  searchId: string;
  createdAt: number;
  title: string;
  description: string;
  privacy: "private" | "unlisted" | "public";
  videos: ScoredVideo[];
  /** Set once the playlist was created, so a retry cannot create a duplicate. */
  createdPlaylistId?: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;

/** Small in-memory store; nothing about searches is persisted to disk. */
class Store<T extends { id: string; createdAt: number }> {
  private items = new Map<string, T>();

  constructor(private readonly prefix: string) {}

  add(item: Omit<T, "id" | "createdAt">): T {
    this.prune();
    const full = { ...item, id: randomId(this.prefix), createdAt: Date.now() } as T;
    this.items.set(full.id, full);
    return full;
  }

  get(id: string): T | undefined {
    this.prune();
    return this.items.get(id);
  }

  private prune() {
    const now = Date.now();
    for (const [id, it] of this.items) if (now - it.createdAt > TTL_MS) this.items.delete(id);
    while (this.items.size >= MAX_ENTRIES) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
}

export const searches = new Store<SearchSession>("search");
export const drafts = new Store<Draft>("draft");
