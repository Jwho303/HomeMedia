import { describe, it, expect } from 'vitest';
import {
  IpIdentityResolver,
  identityKey,
  identityLabel,
  type Identity,
  type IdentityResolver,
} from '../../src/identity/resolver.js';
import type { FastifyRequest } from 'fastify';

describe('IpIdentityResolver', () => {
  it('returns ip-keyed identity from req.ip', () => {
    const r = new IpIdentityResolver();
    const id = r.resolve({ ip: '10.0.0.5' } as FastifyRequest);
    expect(id).toEqual({ kind: 'ip', value: '10.0.0.5' });
  });

  it('falls back to 0.0.0.0 when req.ip is missing', () => {
    const r = new IpIdentityResolver();
    const id = r.resolve({ ip: undefined } as unknown as FastifyRequest);
    expect(id).toEqual({ kind: 'ip', value: '0.0.0.0' });
  });
});

describe('identityKey', () => {
  it('namespaces ip vs user so they cannot collide', () => {
    const ip: Identity = { kind: 'ip', value: '10.0.0.5' };
    const user: Identity = { kind: 'user', userId: '10.0.0.5', ip: '1.2.3.4' };
    expect(identityKey(ip)).not.toBe(identityKey(user));
    expect(identityKey(ip)).toBe('ip:10.0.0.5');
    expect(identityKey(user)).toBe('user:10.0.0.5');
  });
});

describe('identityLabel', () => {
  it('renders user identities with the userId', () => {
    expect(identityLabel({ kind: 'user', userId: 'alice', ip: '1.1.1.1' })).toBe('user alice');
  });
  it('renders ip identities with just the ip', () => {
    expect(identityLabel({ kind: 'ip', value: '10.0.0.5' })).toBe('10.0.0.5');
  });
});

describe('resolver swap', () => {
  it('a UserIdentityResolver-shaped mock is wire-compatible', () => {
    class UserMock implements IdentityResolver {
      resolve(): Identity {
        return { kind: 'user', userId: 'alice', ip: '1.1.1.1' };
      }
    }
    const r: IdentityResolver = new UserMock();
    expect(r.resolve({} as FastifyRequest)).toEqual({
      kind: 'user',
      userId: 'alice',
      ip: '1.1.1.1',
    });
  });
});
