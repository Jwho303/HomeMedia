import { describe, it, expect } from 'vitest';
import { extractEpisode, type KnownSeason } from '../../src/identify/episode.js';

const sunny: KnownSeason[] = [
  { season_number: 1, episode_count: 7 },
  { season_number: 2, episode_count: 10 },
  { season_number: 3, episode_count: 15 },
  { season_number: 4, episode_count: 13 },
];

describe('extractEpisode', () => {
  it('S01E01 in basename', () => {
    expect(extractEpisode('Show/Show.S01E01.mkv', 'Show', null)).toEqual({ season: 1, episode: 1 });
  });

  it('1x01 in basename', () => {
    expect(extractEpisode('Show/Show.1x01.mkv', 'Show', null)).toEqual({ season: 1, episode: 1 });
  });

  it('Season 1 Episode 1 phrasing', () => {
    expect(extractEpisode('Show/Show Season 1 Episode 1.mkv', 'Show', null)).toEqual({ season: 1, episode: 1 });
  });

  it('s01.e01 dot separator', () => {
    expect(extractEpisode('Show/Show.s01.e01.mkv', 'Show', null)).toEqual({ season: 1, episode: 1 });
  });

  it('S/E in parent folder', () => {
    expect(extractEpisode('Show/S01E03/video.mkv', 'Show', null)).toEqual({ season: 1, episode: 3 });
  });

  it('Season folder + episode-only number', () => {
    expect(extractEpisode('Show/Season 1/Show.E05.mkv', 'Show', null)).toEqual({ season: 1, episode: 5 });
  });

  it('NEE shorthand: 402 → S04E02 with known seasons', () => {
    const res = extractEpisode(
      "It's Always Sunny in Philadelphia/Season 4/its.always.sunny.in.philadelphia.402.dsr.xvid.notv.avi",
      "It's Always Sunny in Philadelphia",
      sunny,
    );
    expect(res).toEqual({ season: 4, episode: 2 });
  });

  it('NEE shorthand requires known seasons (refuses to guess without)', () => {
    expect(
      extractEpisode('Show/Season 4/show.402.avi', 'Show', null),
    ).not.toEqual({ season: 4, episode: 2 });
  });

  it('rejects S04E99 when season 4 has only 13 episodes', () => {
    const res = extractEpisode('Show/Season 4/Show.S04E99.mkv', 'Show', sunny);
    expect(res).toBeNull();
  });

  it('accepts S04E13 (boundary) on a 13-episode season', () => {
    expect(
      extractEpisode('Show/Season 4/Show.S04E13.mkv', 'Show', sunny),
    ).toEqual({ season: 4, episode: 13 });
  });

  it('returns null when no pattern matches', () => {
    expect(extractEpisode('Show/random.video.mkv', 'Show', null)).toBeNull();
  });

  it('does not mistake 1080 for an episode in a Season folder', () => {
    const res = extractEpisode('Show/Season 1/Show.E05.1080p.mkv', 'Show', null);
    expect(res).toEqual({ season: 1, episode: 5 });
  });
});
