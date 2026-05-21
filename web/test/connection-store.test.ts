import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getConnectionState,
  setConnectionState,
  subscribeConnectionState,
  getLastKnownShareStatus,
  __resetConnectionStoreForTests,
  type ConnectionState,
} from '../src/connection-store.js';
import type { ShareStatus } from '../src/types.js';

function online(overrides: Partial<ShareStatus> = {}): ShareStatus {
  return { online: true, mountPath: '/m', lastSeen: 1, ...overrides };
}

describe('connection-store (0.1.11)', () => {
  beforeEach(() => {
    __resetConnectionStoreForTests();
  });

  it('starts with null state', () => {
    expect(getConnectionState()).toBeNull();
    expect(getLastKnownShareStatus()).toBeNull();
  });

  it('setConnectionState replaces state and notifies subscribers', () => {
    const calls: ConnectionState[] = [];
    subscribeConnectionState((s) => calls.push(s));
    setConnectionState({ kind: 'reachable', status: online() });
    expect(getConnectionState()).toEqual({ kind: 'reachable', status: online() });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('reachable');
  });

  it('getLastKnownShareStatus returns the most recent reachable status only', () => {
    setConnectionState({ kind: 'reachable', status: online() });
    expect(getLastKnownShareStatus()).toEqual(online());

    setConnectionState({ kind: 'unreachable', phase: 'active', since: 100 });
    // Last known stays last known — getLastKnownShareStatus is for compat
    // with consumers that want "what was the share doing the last time the
    // server answered"; on unreachable we have no fresh info to share.
    expect(getLastKnownShareStatus()).toBeNull();
  });

  it('unsubscribe removes the subscriber', () => {
    const calls: ConnectionState[] = [];
    const unsub = subscribeConnectionState((s) => calls.push(s));
    setConnectionState({ kind: 'reachable', status: online() });
    expect(calls).toHaveLength(1);
    unsub();
    setConnectionState({ kind: 'unreachable', phase: 'active', since: 1 });
    expect(calls).toHaveLength(1); // no further notification
  });

  it('does not break delivery if one subscriber throws', () => {
    const calls: ConnectionState[] = [];
    subscribeConnectionState(() => {
      throw new Error('boom');
    });
    subscribeConnectionState((s) => calls.push(s));
    setConnectionState({ kind: 'reachable', status: online() });
    expect(calls).toHaveLength(1);
  });

  it('dispatches library-invalidated on unreachable → reachable', () => {
    const spy = vi.fn();
    document.addEventListener('library-invalidated', spy);
    setConnectionState({ kind: 'unreachable', phase: 'active', since: 1 });
    expect(spy).toHaveBeenCalledTimes(0);
    setConnectionState({ kind: 'reachable', status: online() });
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('library-invalidated', spy);
  });

  it('also dispatches library-invalidated on idle → reachable', () => {
    const spy = vi.fn();
    document.addEventListener('library-invalidated', spy);
    setConnectionState({ kind: 'unreachable', phase: 'active', since: 1 });
    setConnectionState({ kind: 'unreachable', phase: 'idle', since: 1 });
    expect(spy).toHaveBeenCalledTimes(0);
    setConnectionState({ kind: 'reachable', status: online() });
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('library-invalidated', spy);
  });

  it('does NOT dispatch library-invalidated on reachable → reachable', () => {
    const spy = vi.fn();
    document.addEventListener('library-invalidated', spy);
    setConnectionState({ kind: 'reachable', status: online() });
    setConnectionState({ kind: 'reachable', status: online({ online: false }) });
    expect(spy).toHaveBeenCalledTimes(0);
    document.removeEventListener('library-invalidated', spy);
  });

  it('does NOT dispatch on active → idle (still unreachable)', () => {
    const spy = vi.fn();
    document.addEventListener('library-invalidated', spy);
    setConnectionState({ kind: 'unreachable', phase: 'active', since: 1 });
    setConnectionState({ kind: 'unreachable', phase: 'idle', since: 1 });
    expect(spy).toHaveBeenCalledTimes(0);
    document.removeEventListener('library-invalidated', spy);
  });
});
