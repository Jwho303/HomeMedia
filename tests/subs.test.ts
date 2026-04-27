import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mediaRoot: string;

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-subs-test-'));
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

describe('srtToVtt', () => {
  it('converts millisecond separators and prepends WEBVTT header', async () => {
    const { srtToVtt } = await import('../src/subs.js');
    const srt = [
      '1',
      '00:00:01,500 --> 00:00:04,250',
      'Hello world',
      '',
      '2',
      '00:00:05,000 --> 00:00:07,000',
      'Second cue',
      '',
    ].join('\n');
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.500 --> 00:00:04.250');
    expect(vtt).toContain('00:00:05.000 --> 00:00:07.000');
    expect(vtt).not.toContain(',500');
  });

  it('passes plain text through unchanged after the header', async () => {
    const { srtToVtt } = await import('../src/subs.js');
    expect(srtToVtt('hello')).toBe('WEBVTT\n\nhello');
  });

  it('strips a leading UTF-8 BOM', async () => {
    const { srtToVtt } = await import('../src/subs.js');
    const out = srtToVtt('﻿1\n00:00:01,000 --> 00:00:02,000\nx\n');
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).not.toContain('﻿');
  });

  it('handles CRLF line endings', async () => {
    const { srtToVtt } = await import('../src/subs.js');
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n';
    const out = srtToVtt(srt);
    expect(out).toContain('00:00:01.000 --> 00:00:02.000');
  });
});

describe('discoverSubs', () => {
  it('finds sibling .srt and .en.srt; ignores .txt and Bar.srt', async () => {
    const dir = await fs.mkdtemp(path.join(mediaRoot, 'show-'));
    await fs.writeFile(path.join(dir, 'Foo.mkv'), '');
    await fs.writeFile(path.join(dir, 'Foo.srt'), '');
    await fs.writeFile(path.join(dir, 'Foo.en.srt'), '');
    await fs.writeFile(path.join(dir, 'Foo.vtt'), '');
    await fs.writeFile(path.join(dir, 'Foo.txt'), '');
    await fs.writeFile(path.join(dir, 'Bar.srt'), '');

    const { discoverSubs } = await import('../src/subs.js');
    const rel = path.relative(mediaRoot, path.join(dir, 'Foo.mkv')).split(path.sep).join('/');
    const subs = await discoverSubs(rel, mediaRoot);
    const paths = subs.map((s) => s.path);
    expect(paths.some((p) => p.endsWith('Foo.srt'))).toBe(true);
    expect(paths.some((p) => p.endsWith('Foo.en.srt'))).toBe(true);
    expect(paths.some((p) => p.endsWith('Foo.vtt'))).toBe(true);
    expect(paths.some((p) => p.endsWith('Bar.srt'))).toBe(false);
    expect(paths.some((p) => p.endsWith('Foo.txt'))).toBe(false);
  });

  it('sorts .vtt before .srt', async () => {
    const dir = await fs.mkdtemp(path.join(mediaRoot, 'order-'));
    await fs.writeFile(path.join(dir, 'A.mkv'), '');
    await fs.writeFile(path.join(dir, 'A.srt'), '');
    await fs.writeFile(path.join(dir, 'A.vtt'), '');

    const { discoverSubs } = await import('../src/subs.js');
    const rel = path.relative(mediaRoot, path.join(dir, 'A.mkv')).split(path.sep).join('/');
    const subs = await discoverSubs(rel, mediaRoot);
    expect(subs[0]!.ext).toBe('vtt');
    expect(subs[1]!.ext).toBe('srt');
  });

  it('parses language tag from .<lang>.srt', async () => {
    const dir = await fs.mkdtemp(path.join(mediaRoot, 'lang-'));
    await fs.writeFile(path.join(dir, 'B.mkv'), '');
    await fs.writeFile(path.join(dir, 'B.en.srt'), '');
    await fs.writeFile(path.join(dir, 'B.srt'), '');

    const { discoverSubs } = await import('../src/subs.js');
    const rel = path.relative(mediaRoot, path.join(dir, 'B.mkv')).split(path.sep).join('/');
    const subs = await discoverSubs(rel, mediaRoot);
    const en = subs.find((s) => s.lang === 'en');
    expect(en).toBeDefined();
    const noLang = subs.find((s) => s.lang === null);
    expect(noLang).toBeDefined();
  });

  it('returns empty list when the directory does not exist', async () => {
    const { discoverSubs } = await import('../src/subs.js');
    const subs = await discoverSubs('does/not/exist.mkv', mediaRoot);
    expect(subs).toEqual([]);
  });
});
