#!/usr/bin/env node
/**
 * hls-capture.mjs — diagnostic capture for HLS DEMUXER failures.
 *
 * Watches the HLS cache root (%PROGRAMDATA%\HomeMedia\hls-cache by default)
 * for new sessions. For each session it tracks every segment ffmpeg writes,
 * snapshots them, and runs ffprobe on each. When you stop the script, the
 * dump dir contains every segment + playlist + ffmpeg cmdline.
 *
 * The script never touches the running server. Read-only on the cache dir.
 *
 * Usage:
 *   npm run hls-capture                              # default: localhost:3000
 *   npm run hls-capture -- --label paused-resume     # tag the dump dir
 *   npm run hls-capture -- --host 192.168.101.185
 *
 * Output:
 *   dump/<timestamp>-<label>/<sessionId>/
 *     segments/seg-NNNNN.ts            <- bytes copied from cache
 *     segments/seg-NNNNN.ffprobe.txt   <- one-line stream summary
 *     index.m3u8.final                 <- playlist as it was at end
 *     ffmpeg-cmdline.txt               <- full ffmpeg invocation
 *     events.log                       <- timestamped log of segment writes
 *     summary.txt                      <- human-readable recap
 *
 * What you do:
 *   1. Start the server (lan-host.bat / npm run start).
 *   2. Run this script with a label naming what you're testing.
 *   3. Reproduce the failure in the browser.
 *   4. Hit Ctrl+C. Dump dir path is printed at exit.
 */

import { existsSync, mkdirSync, statSync, readFileSync, copyFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';

// ----- Args ----------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return dflt;
}
const HOST = arg('--host', '127.0.0.1');
const PORT = Number(arg('--port', '3000'));
const LABEL = arg('--label', 'capture').replace(/[^A-Za-z0-9_-]/g, '_');
const CACHE_ROOT = arg('--cache', path.join(process.env.PROGRAMDATA || os.tmpdir(), 'HomeMedia', 'hls-cache'));
const POLL_MS = Number(arg('--poll', '200'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const DUMP_ROOT = path.join(REPO_ROOT, 'dump', `${stamp}-${LABEL}`);
mkdirSync(DUMP_ROOT, { recursive: true });

console.log(`hls-capture watching ${CACHE_ROOT}`);
console.log(`server: http://${HOST}:${PORT}`);
console.log(`writing to: ${DUMP_ROOT}`);
console.log(`Ctrl+C to stop\n`);

if (!existsSync(CACHE_ROOT)) {
  console.error(`cache dir does not exist: ${CACHE_ROOT}`);
  console.error(`override with --cache <path>`);
  process.exit(1);
}

// ----- Helpers -------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('http timeout')));
  });
}

function compareBuffers(a, b) {
  if (a.length !== b.length) return `LENGTH DIFFERS: a=${a.length} b=${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `differ at byte ${i}`;
  return 'IDENTICAL';
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function getFfmpegCmdline(sessionId) {
  const wmic = run('wmic', ['process', 'where', `Name='ffmpeg.exe'`, 'get', 'CommandLine', '/format:list']);
  for (const line of (wmic.stdout || '').split(/\r?\n/)) {
    if (line.includes(sessionId)) {
      const eq = line.indexOf('=');
      return eq >= 0 ? line.slice(eq + 1).trim() : line;
    }
  }
  const ps = run('powershell', [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Select-Object -ExpandProperty CommandLine`,
  ]);
  for (const line of (ps.stdout || '').split(/\r?\n/)) {
    if (line.includes(sessionId)) return line.trim();
  }
  return '(could not find ffmpeg cmdline)';
}

/** Single-line summary of a segment via ffprobe. */
function probeSegmentLine(segPath) {
  const v = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=start_pts,start_time,duration,nb_frames,codec_name,profile,width,height',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    segPath,
  ]);
  const a = run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=start_pts,start_time,duration,codec_name,sample_rate,channels',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    segPath,
  ]);
  // First-frame keyframe check.
  const f = run('ffprobe', [
    '-v', 'error', '-read_intervals', '%+0.1',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=key_frame,pict_type,pts,pts_time',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    segPath,
  ]);
  const vLines = v.stdout.trim().split(/\r?\n/);
  const aLines = a.stdout.trim().split(/\r?\n/);
  const fLines = f.stdout.trim().split(/\r?\n/);
  return JSON.stringify({
    video: vLines,
    audio: aLines,
    firstFrame: fLines.slice(0, 4),
  });
}

// ----- Per-session tracker -------------------------------------------------

class SessionWatcher {
  constructor(sessionId) {
    this.id = sessionId;
    this.cacheDir = path.join(CACHE_ROOT, sessionId);
    this.dumpDir = path.join(DUMP_ROOT, sessionId);
    this.segmentsDir = path.join(this.dumpDir, 'segments');
    mkdirSync(this.segmentsDir, { recursive: true });
    this.eventsLog = path.join(this.dumpDir, 'events.log');
    this.summary = [];
    this.copiedSegments = new Set();
    this.cmdlineCaptured = false;
    this.dead = false;
    this.startedAt = Date.now();
    this.log(`session ${sessionId} appeared`);
  }

  log(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(`[${this.id.slice(0, 8)}] ${msg}`);
    appendFileSync(this.eventsLog, line + '\n');
    this.summary.push(msg);
  }

  async tick() {
    if (this.dead) return;

    if (!existsSync(this.cacheDir)) {
      // Cache dir gone — session was disposed.
      this.dead = true;
      await this.finalize('disposed');
      return;
    }

    // Copy ffmpeg cmdline once, after ffmpeg has been alive a moment.
    if (!this.cmdlineCaptured && Date.now() - this.startedAt > 200) {
      const cmd = getFfmpegCmdline(this.id);
      writeFileSync(path.join(this.dumpDir, 'ffmpeg-cmdline.txt'), cmd);
      this.cmdlineCaptured = true;
      const ssMatch = cmd.match(/-ss\s+(\S+)/);
      if (ssMatch) this.log(`ffmpeg -ss ${ssMatch[1]}`);
    }

    // Scan for new stable segments.
    let entries;
    try { entries = await fs.readdir(this.cacheDir); } catch { return; }
    for (const name of entries) {
      if (!/^seg-\d+\.ts$/.test(name)) continue;
      if (this.copiedSegments.has(name)) continue;
      const segPath = path.join(this.cacheDir, name);
      let st;
      try { st = statSync(segPath); } catch { continue; }
      // ffmpeg writes seg-NNNNN.ts.tmp first then renames; if the .ts
      // exists, the rename is done. Still, give it a tick to ensure the
      // size has settled (mirror the route layer's approach).
      const dest = path.join(this.segmentsDir, name);
      try {
        copyFileSync(segPath, dest);
      } catch (err) {
        // Race lost — segment got disposed between readdir and copy.
        continue;
      }
      this.copiedSegments.add(name);
      const probeLine = probeSegmentLine(dest);
      writeFileSync(dest.replace(/\.ts$/, '.ffprobe.txt'), probeLine);
      this.log(`captured ${name} (${st.size} bytes)`);
    }
  }

  async finalize(reason) {
    this.log(`session done: ${reason}`);
    // Final playlist snapshot.
    const playlistSrc = path.join(this.cacheDir, 'index.m3u8');
    const playlistDst = path.join(this.dumpDir, 'index.m3u8.final');
    if (existsSync(playlistSrc)) {
      try { copyFileSync(playlistSrc, playlistDst); this.log(`captured final playlist`); }
      catch { /* may be gone */ }
    }
    // HTTP-side check on first segment — confirms route layer doesn't mutate.
    const firstSeg = path.join(this.segmentsDir, 'seg-00000.ts');
    if (existsSync(firstSeg)) {
      try {
        const r = await httpGet(`http://${HOST}:${PORT}/api/hls/${this.id}/seg-00000.ts`);
        const diskBuf = readFileSync(firstSeg);
        const cmp = compareBuffers(diskBuf, r.body);
        this.log(`http vs disk seg-00000: ${cmp}`);
      } catch (err) {
        this.log(`http check failed (session likely 404): ${err.message}`);
      }
    }
    writeFileSync(path.join(this.dumpDir, 'summary.txt'), this.summary.join('\n') + '\n');
    this.log(`dump: ${this.dumpDir}`);
  }
}

// ----- Main loop -----------------------------------------------------------

const watchers = new Map(); // sessionId -> SessionWatcher

async function pollOnce() {
  let entries;
  try { entries = await fs.readdir(CACHE_ROOT); } catch { return; }
  // New sessions
  for (const name of entries) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    if (!watchers.has(name)) {
      watchers.set(name, new SessionWatcher(name));
    }
  }
  // Tick existing watchers
  for (const w of watchers.values()) {
    await w.tick();
  }
}

setInterval(() => { pollOnce().catch((err) => console.error('poll error:', err)); }, POLL_MS);
pollOnce();

let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\n--- finalizing ---');
  for (const w of watchers.values()) {
    if (!w.dead) await w.finalize('script-stopping');
  }
  console.log(`\ndump dir:`);
  console.log(DUMP_ROOT);
  process.exit(0);
});
