import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS, DEFAULT_WEIGHTS, applyFilters, capPerChannel, percentileRanks, scoreVideos } from "./scoring.js";
import { parseIsoDuration, sanitizeText } from "./util.js";
import { parseClientFile } from "./config.js";
import type { VideoInfo } from "./youtube.js";

const now = new Date("2026-11-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

function vid(p: Partial<VideoInfo> & { id: string }): VideoInfo {
  return {
    title: "t",
    description: "",
    channelId: `ch_${p.id}`,
    channelTitle: "c",
    publishedAt: daysAgo(100),
    durationSec: 600,
    views: 100_000,
    likes: 3000,
    comments: 200,
    language: null,
    liveBroadcastContent: "none",
    tags: [],
    ...p,
  };
}

test("parseIsoDuration", () => {
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("P1DT1M"), 86460);
  assert.equal(parseIsoDuration("garbage"), null);
});

test("sanitizeText strips control/bidi chars and truncates", () => {
  assert.equal(sanitizeText("a‮b\u0007c\n\nd", 100), "ab c d");
  assert.equal(sanitizeText("x".repeat(50), 10).length, 10);
});

test("percentileRanks handles ties and single values", () => {
  assert.deepEqual(percentileRanks([5]), [0.5]);
  assert.deepEqual(percentileRanks([1, 2, 2, 3]), [0, 0.5, 0.5, 1]);
});

test("filters remove shorts, live, low views, wrong language", () => {
  const videos = [
    vid({ id: "aaaaaaaaaaa", durationSec: 45 }),
    vid({ id: "bbbbbbbbbbb", durationSec: 150, title: "Quick tip #shorts" }),
    vid({ id: "ccccccccccc", liveBroadcastContent: "upcoming" }),
    vid({ id: "ddddddddddd", views: 10 }),
    vid({ id: "eeeeeeeeeee", language: "en" }),
    vid({ id: "fffffffffff", language: "tr-TR" }),
    vid({ id: "ggggggggggg", language: null }),
  ];
  const { kept, excluded } = applyFilters(videos, { ...DEFAULT_FILTERS, language: "tr" });
  assert.deepEqual(
    kept.map((v) => v.id),
    ["fffffffffff", "ggggggggggg"],
  );
  assert.equal(excluded["aaaaaaaaaaa"], "short");
  assert.equal(excluded["bbbbbbbbbbb"], "short");
  assert.equal(excluded["ccccccccccc"], "live_or_upcoming");
  assert.equal(excluded["ddddddddddd"], "low_views");
  assert.equal(excluded["eeeeeeeeeee"], "language");
});

test("old viral video with poor engagement does not automatically win", () => {
  const oldViral = vid({ id: "old", views: 5_000_000, likes: 20_000, comments: 500, publishedAt: daysAgo(8 * 365) });
  const goodRecent = vid({ id: "new", views: 400_000, likes: 25_000, comments: 2_000, publishedAt: daysAgo(200) });
  const filler = [1, 2, 3, 4].map((i) => vid({ id: `f${i}`, views: 50_000 * i, likes: 1000 * i, comments: 50 * i }));
  const scored = scoreVideos([oldViral, goodRecent, ...filler], DEFAULT_WEIGHTS, now);
  const s = Object.fromEntries(scored.map((v) => [v.id, v.score]));
  assert.ok(s.new! > s.old!, `expected new (${s.new}) > old (${s.old})`);
  for (const v of scored) assert.ok(v.score >= 0 && v.score <= 100);
});

test("recency weight boosts newer videos", () => {
  const a = vid({ id: "a", publishedAt: daysAgo(30) });
  const b = vid({ id: "b", publishedAt: daysAgo(1500) });
  const flat = scoreVideos([a, b], DEFAULT_WEIGHTS, now);
  const boosted = scoreVideos([a, b], { ...DEFAULT_WEIGHTS, recency: 0.5 }, now);
  const gap = (xs: typeof flat) => xs[0]!.score - xs[1]!.score;
  assert.ok(gap(boosted) > gap(flat));
});

test("tiny sample like rate is smoothed", () => {
  const tiny = vid({ id: "tiny", views: 1200, likes: 600, comments: 5 });
  const big = vid({ id: "big", views: 1_000_000, likes: 60_000, comments: 3000 });
  const mid = vid({ id: "mid", views: 200_000, likes: 4000, comments: 100 });
  const scored = scoreVideos([tiny, big, mid], DEFAULT_WEIGHTS, now);
  const by = Object.fromEntries(scored.map((v) => [v.id, v.components.likes]));
  assert.ok(by.big! >= by.mid!);
});

test("hidden likes are neutral", () => {
  const scored = scoreVideos([vid({ id: "x", likes: null }), vid({ id: "y" }), vid({ id: "z", likes: 10 })], DEFAULT_WEIGHTS, now);
  assert.equal(scored[0]!.components.likes, 0.5);
});

test("capPerChannel", () => {
  const scored = scoreVideos(
    [vid({ id: "1", channelId: "A" }), vid({ id: "2", channelId: "A" }), vid({ id: "3", channelId: "A" }), vid({ id: "4", channelId: "B" })],
    DEFAULT_WEIGHTS,
    now,
  );
  const { kept, dropped } = capPerChannel(scored, 2);
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 1);
});

test("parseClientFile validates shape", () => {
  const c = parseClientFile({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "s" } });
  assert.equal(c.clientSecret, "s");
  assert.throws(() => parseClientFile({ foo: 1 }));
});
