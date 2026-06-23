import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 0.2.0 (Phase 4) note: the legacy ES5 client (web/legacy/*) is NOT built or
// copied into dist/. It is hand-authored ES5 with no imports and is served
// straight from the source web/legacy/ directory by the server (src/server.ts).
// Keeping it out of dist/ also avoids a /legacy/ route collision with the root
// @fastify/static (which auto-registers a directory-index route per dist subdir).

/**
 * 0.2.0 — inline the ES5 boot router (web/boot.js) into index.html's <head>
 * and let it own loading the modern module bundle.
 *
 * The boot router must run BEFORE any modern-syntax script the device might
 * choke on, and inlining removes a network round-trip + a module-loader that
 * could fail on a 2014 engine (D1). So instead of shipping a separate
 * <script src> we splice the file's contents directly into <head>, replacing
 * the `<!--HM_BOOT-->` marker.
 *
 * index.html still carries `<script type="module" src="/src/main.ts">` so
 * Vite/Rollup discovers the app entry the normal way. We then:
 *   - capture that script's resolved src (the hashed /assets/index-*.js in
 *     build, /src/main.ts in dev),
 *   - strip the tag from the emitted HTML, and
 *   - set window.__hmBootSrc to it so boot.js injects the bundle itself,
 *     only after capability detection says the device is 'modern'.
 */
function inlineBoot(): Plugin {
  const bootJs = (): string => readFileSync(resolve(here, 'boot.js'), 'utf8');

  return {
    name: 'homemedia-inline-boot',
    transformIndexHtml: {
      // 'post' so Rollup has finished emitting chunks (ctx.bundle is populated)
      // and any entry <script>/<link modulepreload> is already in the HTML.
      order: 'post',
      handler(html, ctx) {
        // Vite may invoke transformIndexHtml more than once in a build (an
        // early pass before chunks are emitted, then a final pass with
        // ctx.bundle populated). We must do the marker replacement EXACTLY in
        // the pass that knows the real entry, or the first pass consumes the
        // <!--HM_BOOT--> marker with a stale '/src/main.ts'. So: act only when
        // building-with-bundle (ctx.bundle) OR serving in dev (ctx.server);
        // skip any other pass untouched.
        const isBuildFinal = !!ctx.bundle;
        const isDev = !!ctx.server;
        if (!isBuildFinal && !isDev) return html;

        // Resolve the entry src. In BUILD read the hashed entry chunk straight
        // from the bundle (the HTML may carry the entry as a modulepreload link
        // rather than a <script>, so don't rely on an HTML regex). In DEV the
        // entry is the literal /src/main.ts the source HTML carries.
        let entrySrc = '/src/main.ts';
        if (ctx.bundle) {
          for (const file of Object.values(ctx.bundle)) {
            if (file.type === 'chunk' && file.isEntry) {
              entrySrc = '/' + file.fileName;
              break;
            }
          }
        }

        // Strip the entry from the HTML so it isn't auto-loaded — boot.js
        // injects it itself, only after detection says the device is 'modern'.
        // Remove both the <script type=module src=…> (dev) and any
        // <link rel=modulepreload href=…> (build) that point at the entry, plus
        // the hashed entry script if Vite emitted one.
        let out = html
          .replace(
            /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']*["'][^>]*><\/script>\s*/gi,
            '',
          )
          .replace(
            /<link\b[^>]*\brel=["']modulepreload["'][^>]*>\s*/gi,
            '',
          );

        const inline =
          `<script>window.__hmBootSrc=${JSON.stringify(entrySrc)};</script>\n` +
          `<script>\n${bootJs()}\n</script>`;
        out = out.replace('<!--HM_BOOT-->', inline);
        return out;
      },
    },
  };
}

export default defineConfig({
  plugins: [inlineBoot()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    emptyOutDir: true,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
