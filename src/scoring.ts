import type { VideoInfo } from "./youtube.js";

export interface Weights {
  /** Views (half total views, half views-per-day so old videos don't win by age alone). */
  popularity: number;
  /** Likes per view, smoothed. */
  likes: number;
  /** Comments per view, smoothed. */
  comments: number;
  /** Optional boost for newer videos (0 = off). */
  recency: number;
}

export const DEFAULT_WEIGHTS: Weights = { popularity: 0.45, likes: 0.35, comments: 0.2, recency: 0 };

export interface FilterOptions {
  /** Anything this short or shorter is treated as a Short and removed. */
  minDurationSec: number;
  maxDurationSec: number | null;
  minViews: number;
  maxPerChannel: number;
  /** ISO 639-1 code; removes videos whose *declared* language differs. Undeclared ones are kept. */
  language: string | null;
  excludeShorts: boolean;
}

export const DEFAULT_FILTERS: FilterOptions = {
  minDurationSec: 61,
  maxDurationSec: null,
  minViews: 1000,
  maxPerChannel: 2,
  language: null,
  excludeShorts: true,
};

export interface ScoredVideo extends VideoInfo {
  score: number;
  likeRate: number | null;
  commentRate: number | null;
  ageDays: number;
  components: { popularity: number; likes: number; comments: number; recency: number };
}

export type ExclusionReason =
  | "short"
  | "too_short"
  | "too_long"
  | "low_views"
  | "live_or_upcoming"
  | "no_stats"
  | "language"
  | "channel_cap";

/** Average-rank percentile in [0,1]; ties share a rank. Single element → 0.5. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && order[j + 1]!.v === order[k]!.v) j++;
    const avg = (k + j) / 2 / (n - 1);
    for (let t = k; t <= j; t++) ranks[order[t]!.i] = avg;
    k = j + 1;
  }
  return ranks;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Bayesian-smoothed rate: a video with 50 views and 10 likes should not beat one with
 * 2M views and 100K likes. `m` pseudo-views at the pool's median rate are mixed in.
 */
function smoothedRates(counts: (number | null)[], views: number[], m = 2000): (number | null)[] {
  const raw = counts
    .map((c, i) => (c !== null && views[i]! > 0 ? c / views[i]! : null))
    .filter((r): r is number => r !== null);
  const prior = median(raw);
  return counts.map((c, i) => (c === null ? null : (c + prior * m) / (views[i]! + m)));
}

function isMarkedShort(v: VideoInfo): boolean {
  const hay = `${v.title} ${v.description} ${v.tags.join(" ")}`.toLowerCase();
  return /#shorts?\b/.test(hay);
}

const langMatches = (declared: string | null, wanted: string) =>
  declared === null || declared === wanted || declared.split("-")[0] === wanted;

/** Hard filters that don't depend on the rest of the pool. */
export function applyFilters(videos: VideoInfo[], f: FilterOptions) {
  const kept: VideoInfo[] = [];
  const excluded: Record<string, ExclusionReason> = {};
  for (const v of videos) {
    let reason: ExclusionReason | null = null;
    if (v.liveBroadcastContent !== "none") reason = "live_or_upcoming";
    else if (v.views === null || v.durationSec === null) reason = "no_stats";
    else if (f.excludeShorts && (v.durationSec <= 60 || (v.durationSec <= 180 && isMarkedShort(v)))) reason = "short";
    else if (v.durationSec < f.minDurationSec) reason = "too_short";
    else if (f.maxDurationSec !== null && v.durationSec > f.maxDurationSec) reason = "too_long";
    else if (v.views < f.minViews) reason = "low_views";
    else if (f.language && !langMatches(v.language, f.language.toLowerCase())) reason = "language";
    if (reason) excluded[v.id] = reason;
    else kept.push(v);
  }
  return { kept, excluded };
}

/** Score 0–100 relative to the candidate pool. */
export function scoreVideos(videos: VideoInfo[], weights: Weights, now: Date = new Date()): ScoredVideo[] {
  if (videos.length === 0) return [];
  const views = videos.map((v) => Math.max(0, v.views ?? 0));
  const ageDays = videos.map((v) => {
    const t = Date.parse(v.publishedAt);
    return Number.isFinite(t) ? Math.max(1, (now.getTime() - t) / 86_400_000) : 365 * 5;
  });

  const logViews = percentileRanks(views.map((x) => Math.log10(x + 1)));
  const velocity = percentileRanks(views.map((x, i) => Math.log10(x / ageDays[i]! + 1)));
  const popularity = logViews.map((p, i) => 0.5 * p + 0.5 * velocity[i]!);

  const likeRates = smoothedRates(
    videos.map((v) => v.likes),
    views,
  );
  const commentRates = smoothedRates(
    videos.map((v) => v.comments),
    views,
  );
  // Hidden likes / disabled comments → neutral (0.5), not punished nor rewarded.
  const rankWithNeutral = (rates: (number | null)[]) => {
    const known = rates.map((r, i) => ({ r, i })).filter((x) => x.r !== null) as { r: number; i: number }[];
    const ranks = percentileRanks(known.map((x) => x.r));
    const out = rates.map(() => 0.5);
    known.forEach((x, k) => (out[x.i] = ranks[k]!));
    return out;
  };
  const likeComp = rankWithNeutral(likeRates);
  const commentComp = rankWithNeutral(commentRates);
  // Half-life of one year: a 1-year-old video gets 0.5, 2 years 0.25.
  const recencyComp = ageDays.map((d) => Math.pow(0.5, d / 365));

  const w = { ...weights };
  const total = w.popularity + w.likes + w.comments + w.recency || 1;

  return videos.map((v, i) => {
    const components = {
      popularity: popularity[i]!,
      likes: likeComp[i]!,
      comments: commentComp[i]!,
      recency: recencyComp[i]!,
    };
    const raw =
      (w.popularity * components.popularity +
        w.likes * components.likes +
        w.comments * components.comments +
        w.recency * components.recency) /
      total;
    return {
      ...v,
      score: Math.round(raw * 1000) / 10,
      likeRate: v.likes !== null && views[i]! > 0 ? v.likes / views[i]! : null,
      commentRate: v.comments !== null && views[i]! > 0 ? v.comments / views[i]! : null,
      ageDays: Math.round(ageDays[i]!),
      components: {
        popularity: round2(components.popularity),
        likes: round2(components.likes),
        comments: round2(components.comments),
        recency: round2(components.recency),
      },
    };
  });
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export type SortKey = "score" | "views" | "like_rate" | "comment_rate" | "newest" | "oldest";

export function sortVideos(videos: ScoredVideo[], key: SortKey): ScoredVideo[] {
  const val = (v: ScoredVideo): number => {
    switch (key) {
      case "views":
        return v.views ?? 0;
      case "like_rate":
        return v.likeRate ?? -1;
      case "comment_rate":
        return v.commentRate ?? -1;
      case "newest":
        return Date.parse(v.publishedAt) || 0;
      case "oldest":
        return -(Date.parse(v.publishedAt) || 0);
      default:
        return v.score;
    }
  };
  return [...videos].sort((a, b) => val(b) - val(a) || b.score - a.score);
}

/** Keep at most `max` videos per channel, preserving order. */
export function capPerChannel(videos: ScoredVideo[], max: number) {
  const seen = new Map<string, number>();
  const kept: ScoredVideo[] = [];
  const dropped: string[] = [];
  for (const v of videos) {
    const n = seen.get(v.channelId) ?? 0;
    if (n >= max) {
      dropped.push(v.id);
      continue;
    }
    seen.set(v.channelId, n + 1);
    kept.push(v);
  }
  return { kept, dropped };
}
