/**
 * /open response bundle (0.1.9, D3).
 *
 * One payload containing everything the chrome needs to render — duration,
 * tracks, chapters, IMDb rating, sibling subs, manual-override status,
 * resume position. The client paints from this directly and never refetches
 * `/api/stream-meta`, `/api/playback`, etc.
 */

import type { ProbeResult, AudioStream, SubStream, Chapter } from '../db.js';
import type { SubInfo } from '../subs.js';

export interface PlayerOpenSession {
  sessionId: string;
  playlistUrl: string;
  encodedWindow: { from: number; to: number };
  startSeconds: number;
}

export interface PlayerOpenMetadata {
  durationSeconds: number;
  container: string;
  videoCodec: string;
  audioCodec: string;
  audioStreams: AudioStream[];
  subStreams: SubStream[];
  chapters: Chapter[];
  siblingSubs: SubInfo[];
  title: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  imdbRating: number | null;
  /** True when a manual identification has been applied to this path. */
  manualOverride: boolean;
  activeAudioStreamIndex: number | null;
  activeBurnSubStreamIndex: number | null;
}

export interface PlayerOpenResume {
  position: number;
  duration: number;
  watched: boolean;
}

export interface PlayerOpenResponse {
  /** Echo or replacement (per-IP single-player media-swap, D8). */
  playerId: string;
  relPath: string;
  /** True when /open was treated as a media-swap on an existing player. */
  reused: boolean;
  session: PlayerOpenSession;
  metadata: PlayerOpenMetadata;
  resume: PlayerOpenResume;
}

export interface BuildBundleInput {
  playerId: string;
  relPath: string;
  reused: boolean;
  session: PlayerOpenSession;
  probe: ProbeResult;
  siblingSubs: SubInfo[];
  /** Library row info needed by the chrome (title, poster, IMDb). May be
   *  null when the library doesn't know about this path yet (rare). */
  library: {
    title: string | null;
    posterUrl: string | null;
    backdropUrl: string | null;
    imdbRating: number | null;
  } | null;
  manualOverride: boolean;
  activeAudioStreamIndex: number | null;
  activeBurnSubStreamIndex: number | null;
  resume: PlayerOpenResume;
}

export function buildOpenBundle(input: BuildBundleInput): PlayerOpenResponse {
  return {
    playerId: input.playerId,
    relPath: input.relPath,
    reused: input.reused,
    session: input.session,
    metadata: {
      durationSeconds: input.probe.durationSeconds,
      container: input.probe.container,
      videoCodec: input.probe.videoCodec,
      audioCodec: input.probe.audioCodec,
      audioStreams: input.probe.audioStreams ?? [],
      subStreams: input.probe.subStreams ?? [],
      chapters: input.probe.chapters ?? [],
      siblingSubs: input.siblingSubs,
      title: input.library?.title ?? null,
      posterUrl: input.library?.posterUrl ?? null,
      backdropUrl: input.library?.backdropUrl ?? null,
      imdbRating: input.library?.imdbRating ?? null,
      manualOverride: input.manualOverride,
      activeAudioStreamIndex: input.activeAudioStreamIndex,
      activeBurnSubStreamIndex: input.activeBurnSubStreamIndex,
    },
    resume: input.resume,
  };
}
