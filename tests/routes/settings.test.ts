import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 0.1.12 — settings UI backend: layered config (settings.json over .env),
 * masked GET, value-in-body test, and persist-with-reload POST.
 *
 * Each test runs in a fresh temp dir used as both MEDIA_ROOT and the home of
 * `settings.json` (via SETTINGS_PATH) so the suite never touches the real
 * `data/` overlay.
 */

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-settings-'));
  settingsPath = path.join(tmpDir, 'settings.json');
  process.env.SETTINGS_PATH = settingsPath;
  process.env.TMDB_API_KEY = 'env-tmdb';
  process.env.MEDIA_ROOT = tmpDir;
  process.env.OMDB_API_KEY = '';
  process.env.TVDB_API_KEY = '';
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
});

afterEach(async () => {
  delete process.env.SETTINGS_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
});

describe('config layering', () => {
  it('settings.json overrides .env', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ TMDB_API_KEY: 'file-tmdb' }));
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().tmdbApiKey).toBe('file-tmdb');
  });

  it('empty/missing settings field falls through to .env', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ TMDB_API_KEY: '' }));
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig().tmdbApiKey).toBe('env-tmdb');
  });

  it('reloadConfig picks up a freshly written file', async () => {
    const { loadConfig, reloadConfig } = await import('../../src/config.js');
    expect(loadConfig().tmdbApiKey).toBe('env-tmdb');
    await fs.writeFile(settingsPath, JSON.stringify({ TMDB_API_KEY: 'file-tmdb' }));
    expect(reloadConfig().tmdbApiKey).toBe('file-tmdb');
  });
});

describe('GET /api/settings', () => {
  it('returns masked secrets and a raw MEDIA_ROOT value, never the raw key', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ TMDB_API_KEY: 'abcd1234ef7f3a' }),
    );
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.TMDB_API_KEY.set).toBe(true);
      expect(body.TMDB_API_KEY.required).toBe(true);
      expect(body.TMDB_API_KEY.masked).toBe('•••• 7f3a');
      expect(body.TMDB_API_KEY).not.toHaveProperty('value');
      // Raw key must never appear anywhere in the response.
      expect(res.body).not.toContain('abcd1234ef7f3a');
      expect(body.MEDIA_ROOT.value).toBe(path.resolve(tmpDir));
      expect(body.OMDB_API_KEY.set).toBe(false);
      expect(body.OMDB_API_KEY.signupUrl).toContain('omdbapi.com');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/settings/test', () => {
  it('MEDIA_ROOT test passes for an existing directory and fails for a missing one', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { field: 'MEDIA_ROOT', value: tmpDir },
      });
      expect(ok.json().ok).toBe(true);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { field: 'MEDIA_ROOT', value: path.join(tmpDir, 'nope') },
      });
      expect(bad.json().ok).toBe(false);
      expect(bad.json().error).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('tests the SAVED value when no value is supplied in the body', async () => {
    // MEDIA_ROOT is saved (it's the temp dir); an empty-value test should
    // verify that saved path rather than rejecting for a missing value.
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { field: 'MEDIA_ROOT' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('400s when neither a value nor a saved value exists', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      // No OMDB key saved or in env → nothing to test.
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { field: 'OMDB_API_KEY' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown field with 400', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { field: 'NOPE', value: 'x' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/settings', () => {
  it('persists settings.json, applies them live, and never restarts', async () => {
    const { buildServer } = await import('../../src/server.js');
    const { loadConfig } = await import('../../src/config.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: { TMDB_API_KEY: 'saved-tmdb', MEDIA_ROOT: tmpDir },
      });
      expect(res.statusCode).toBe(200);
      // File written.
      const onDisk = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      expect(onDisk.TMDB_API_KEY).toBe('saved-tmdb');
      // Live config reflects it without a restart.
      expect(loadConfig().tmdbApiKey).toBe('saved-tmdb');
      // Response is the masked shape, not the raw key.
      expect(res.body).not.toContain('saved-tmdb');
    } finally {
      await app.close();
    }
  });

  it('rejects clearing a required field and rolls back the file', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ TMDB_API_KEY: 'file-tmdb' }));
    // Drop the .env fallback so clearing the file value leaves it truly unset.
    delete process.env.TMDB_API_KEY;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: { TMDB_API_KEY: '', MEDIA_ROOT: tmpDir },
      });
      expect(res.statusCode).toBe(400);
      // File rolled back to the previous overlay.
      const onDisk = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      expect(onDisk.TMDB_API_KEY).toBe('file-tmdb');
    } finally {
      await app.close();
      process.env.TMDB_API_KEY = 'env-tmdb';
    }
  });

  it('invalidates the cached TVDB token when the TVDB key changes', async () => {
    const tokenPath = path.join(tmpDir, 'tvdb-token.json');
    process.env.TVDB_TOKEN_PATH = tokenPath;
    await fs.writeFile(tokenPath, JSON.stringify({ value: 'tok', obtainedAt: 1 }));
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: { TMDB_API_KEY: 'env-tmdb', TVDB_API_KEY: 'new-tvdb', MEDIA_ROOT: tmpDir },
      });
      expect(res.statusCode).toBe(200);
      await expect(fs.stat(tokenPath)).rejects.toThrow();
    } finally {
      await app.close();
      delete process.env.TVDB_TOKEN_PATH;
    }
  });
});

describe('GET /api/settings/access', () => {
  it('returns the port and a list of reachable URLs including localhost', async () => {
    process.env.PORT = '4321';
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/access',
        headers: { host: '192.168.1.50:4321' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.port).toBe(4321);
      expect(body.host).toBe('192.168.1.50');
      expect(body.urls).toContain('http://localhost:4321');
      expect(body.urls.every((u: string) => u.endsWith(':4321'))).toBe(true);
    } finally {
      await app.close();
      delete process.env.PORT;
    }
  });
});

describe('POST /api/settings/port', () => {
  it('persists a valid port to settings.json', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/port',
        payload: { port: 8088 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().restartRequired).toBe(true);
      const onDisk = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      expect(onDisk.PORT).toBe('8088');
    } finally {
      await app.close();
    }
  });

  it('rejects an out-of-range port with 400', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      for (const bad of [0, 70000, -1, 3.5]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/settings/port',
          payload: { port: bad },
        });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('saved PORT overlays env on the next config load', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ PORT: '9090', MEDIA_ROOT: tmpDir }));
    const { reloadConfig } = await import('../../src/config.js');
    expect(reloadConfig().port).toBe(9090);
  });
});
