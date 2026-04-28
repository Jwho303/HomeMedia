/**
 * Identity resolver (0.1.9, D7).
 *
 * Every concurrency check, retention decision, and "who does this player
 * belong to" question runs through an `Identity` resolver. Today we key on
 * IP; once user accounts ship (0.2.x) a `UserIdentityResolver` will read
 * the session cookie and return a `{ kind: 'user', userId, ip }` shape.
 * The rest of the system never sees IPs vs user ids — it sees `Identity`
 * and uses it as a Map key.
 */

import type { FastifyRequest } from 'fastify';

export type Identity =
  | { kind: 'ip'; value: string }
  | { kind: 'user'; userId: string; ip: string };

/** Stable key for `Map<string, ...>` use. Distinct identities never
 *  collide; the `kind:` prefix prevents an IP that looks like a userId
 *  from aliasing onto a user. */
export function identityKey(id: Identity): string {
  return id.kind === 'user' ? `user:${id.userId}` : `ip:${id.value}`;
}

/** Human-readable label for logs / 503 panels. */
export function identityLabel(id: Identity): string {
  return id.kind === 'user' ? `user ${id.userId}` : id.value;
}

export interface IdentityResolver {
  resolve(req: FastifyRequest): Identity;
}

/** Default resolver: IP-keyed. Reads `req.ip` which Fastify auto-resolves
 *  from `X-Forwarded-For` (when `trustProxy` is on) or the connection
 *  socket. On localhost this is `::1` or `127.0.0.1`. */
export class IpIdentityResolver implements IdentityResolver {
  resolve(req: FastifyRequest): Identity {
    const ip = req.ip || '0.0.0.0';
    return { kind: 'ip', value: ip };
  }
}

let active: IdentityResolver = new IpIdentityResolver();

export function getIdentityResolver(): IdentityResolver {
  return active;
}

/** Tests / future user-accounts work swap the resolver via this hook. */
export function setIdentityResolverForTests(r: IdentityResolver | null): void {
  active = r ?? new IpIdentityResolver();
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}
