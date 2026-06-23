import { describe, it, expect } from 'vitest';
import {
  extractEpisode,
  extractAbsoluteNumber,
  absoluteToSe,
  absoluteOfSe,
  type KnownSeason,
} from '../../src/identify/episode.js';

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

  it('accepts explicit S05E01 for a season TMDB does not list yet (renamed/new season)', () => {
    // sunny only lists seasons 1-4. The motivating case: a show airs a new or
    // renamed season the metadata source hasn't published. An explicit SxxEyy
    // marker is trusted rather than stranded in needs_review (spec §7).
    expect(extractEpisode('Show/Show.S05E01.mkv', 'Show', sunny)).toEqual({ season: 5, episode: 1 });
  });

  it('accepts explicit S03E01 (the Vampire case) even when the list stops earlier', () => {
    const twoSeasons: KnownSeason[] = [
      { season_number: 1, episode_count: 7 },
      { season_number: 2, episode_count: 8 },
    ];
    expect(
      extractEpisode('Interview with the Vampire S03E01 Detroit.mkv', 'Interview with the Vampire', twoSeasons),
    ).toEqual({ season: 3, episode: 1 });
  });

  it('still rejects an out-of-range episode within a KNOWN season (S03E20, 15 eps)', () => {
    // The unknown-season trust does not extend to bogus episode numbers inside
    // a season we DO know the length of.
    expect(extractEpisode('Show/Show.S03E20.mkv', 'Show', sunny)).toBeNull();
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

describe('extractAbsoluteNumber', () => {
  it('reads a bare number from common anime rip names', () => {
    expect(extractAbsoluteNumber('Naruto/060.mkv', 'Naruto')).toBe(60);
    expect(extractAbsoluteNumber('Naruto/Naruto - 220.mkv', 'Naruto')).toBe(220);
    expect(extractAbsoluteNumber('Naruto/Naruto 001.mkv', 'Naruto')).toBe(1);
    expect(extractAbsoluteNumber('Naruto/[Group] Naruto 130 (1080p).mkv', 'Naruto')).toBe(130);
    expect(extractAbsoluteNumber('Naruto/E045.mkv', 'Naruto')).toBe(45);
  });

  it('reads the leading number when an episode title follows it', () => {
    // Real-world shape: "<Series>  <abs> - <Episode Title>.mkv". The leading
    // number is the absolute episode; the dash + title tail must not block it.
    expect(
      extractAbsoluteNumber('all seasons of naruto/Season 2/Naruto  053 - Long Time No See, Jiraiya Returns.mkv', 'Naruto'),
    ).toBe(53);
    expect(
      extractAbsoluteNumber('all seasons of naruto/Season 1/Naruto  001 - Enter Naruto Uzumaki.mkv', 'Naruto'),
    ).toBe(1);
    expect(
      extractAbsoluteNumber('all seasons of naruto/Season 4/Naruto  220 - Departure.mkv', 'Naruto'),
    ).toBe(220);
  });

  it('returns null when the name carries an S/E structure', () => {
    expect(extractAbsoluteNumber('Naruto/Naruto.S02E03.mkv', 'Naruto')).toBeNull();
    expect(extractAbsoluteNumber('Naruto/Naruto.2x03.mkv', 'Naruto')).toBeNull();
  });

  it('rejects 4-digit years and out-of-range numbers', () => {
    expect(extractAbsoluteNumber('Naruto/Naruto 2002.mkv', 'Naruto')).toBeNull();
    expect(extractAbsoluteNumber('Naruto/Naruto 2002 - Pilot.mkv', 'Naruto')).toBeNull();
    expect(extractAbsoluteNumber('Naruto/0.mkv', 'Naruto')).toBeNull();
  });
});

describe('absoluteToSe', () => {
  const naruto: KnownSeason[] = [
    { season_number: 0, episode_count: 5 },
    { season_number: 1, episode_count: 57 },
    { season_number: 2, episode_count: 43 },
    { season_number: 3, episode_count: 21 },
    { season_number: 4, episode_count: 99 },
  ];

  it('maps across seasons and ignores specials', () => {
    expect(absoluteToSe(1, naruto)).toEqual({ season: 1, episode: 1 });
    expect(absoluteToSe(57, naruto)).toEqual({ season: 1, episode: 57 });
    expect(absoluteToSe(60, naruto)).toEqual({ season: 2, episode: 3 });
    expect(absoluteToSe(220, naruto)).toEqual({ season: 4, episode: 99 });
  });

  it('returns null past the end or with no seasons', () => {
    expect(absoluteToSe(221, naruto)).toBeNull();
    expect(absoluteToSe(1, null)).toBeNull();
  });
});

describe('absoluteOfSe', () => {
  // Real Naruto counts: 52, 52, 54, 62.
  const naruto: KnownSeason[] = [
    { season_number: 0, episode_count: 2 },
    { season_number: 1, episode_count: 52 },
    { season_number: 2, episode_count: 52 },
    { season_number: 3, episode_count: 54 },
    { season_number: 4, episode_count: 62 },
  ];

  it('is the inverse of absoluteToSe', () => {
    expect(absoluteOfSe(1, 1, naruto)).toBe(1);
    expect(absoluteOfSe(2, 1, naruto)).toBe(53); // S2E1 = absolute 53
    expect(absoluteOfSe(2, 52, naruto)).toBe(104);
    expect(absoluteOfSe(3, 1, naruto)).toBe(105);
    expect(absoluteOfSe(4, 62, naruto)).toBe(220);
  });

  it('round-trips with absoluteToSe', () => {
    for (const abs of [1, 53, 104, 158, 220]) {
      const se = absoluteToSe(abs, naruto)!;
      expect(absoluteOfSe(se.season, se.episode, naruto)).toBe(abs);
    }
  });

  it('returns null for an unknown season', () => {
    expect(absoluteOfSe(9, 1, naruto)).toBeNull();
    expect(absoluteOfSe(1, 1, null)).toBeNull();
  });
});
