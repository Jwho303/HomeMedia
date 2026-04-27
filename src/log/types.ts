/** 0.1.7 — `evt:` is the routing key the console-pretty transport reads to
 *  decide tag/format/suppression. Call sites in our code attach one of these
 *  strings; the transport falls back to a generic `log` tag for anything
 *  unaccounted-for (Fastify internals, third-party libs).
 *
 *  Adding a new event: extend the union, add the rendering case in
 *  `console-pretty.ts`, and document in DEPLOY.md if it's a tag the operator
 *  should know to grep for.
 */
export type LogEvt =
  // request lifecycle (D3 — replaces Fastify's two-line default).
  | 'request'
  | 'response'
  // HLS session lifecycle.
  | 'hls.spawn'
  | 'hls.exit'
  | 'hls.gc'
  | 'hls.segment'
  | 'hls.spawnError'
  | 'hls.cleanup'
  | 'hls.orphanRmFailed'
  // Library scan (full + smart-diff).
  | 'scan.start'
  | 'scan.progress'
  | 'scan.done'
  | 'scan.error'
  // Server lifecycle.
  | 'startup'
  // Player diagnostic dumps (POST /api/client-log).
  | 'client-report';

/** Cosmetic mapping of `evt:` → tag column label rendered by the transport.
 *  The label is decoupled from the routing key so we can keep terse `request`
 *  while showing it as a `→ GET` arrow in the console. */
export const TAG_LABEL: Readonly<Record<LogEvt, string>> = {
  request: 'request',
  response: 'response',
  'hls.spawn': 'hls.spawn',
  'hls.exit': 'hls.exit',
  'hls.gc': 'hls.gc',
  'hls.segment': 'hls.segment',
  'hls.spawnError': 'hls.error',
  'hls.cleanup': 'hls.cleanup',
  'hls.orphanRmFailed': 'hls.orphan',
  'scan.start': 'scan',
  'scan.progress': 'scan',
  'scan.done': 'scan.done',
  'scan.error': 'scan.error',
  startup: 'startup',
  'client-report': 'client-report',
};
