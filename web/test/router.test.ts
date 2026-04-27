import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHash, homeHref, seriesHref, playHref, goBack, navigate } from '../src/router.js';

describe('router', () => {
  it('parses home', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
  });

  it('parses series id', () => {
    expect(parseHash('#/series/42')).toEqual({ name: 'series', id: 42 });
  });

  it('parses play with encoded path', () => {
    const enc = encodeURIComponent('Movies/Dune (2021)/Dune.mkv');
    expect(parseHash(`#/play/${enc}`)).toEqual({
      name: 'play',
      path: 'Movies/Dune (2021)/Dune.mkv',
    });
  });

  it('parses search', () => {
    expect(parseHash('#/search')).toEqual({ name: 'search' });
  });

  it('returns unknown for garbage', () => {
    expect(parseHash('#/wat')).toEqual({ name: 'unknown', hash: '/wat' });
  });

  it('href helpers round-trip', () => {
    expect(homeHref()).toBe('#/');
    expect(seriesHref(7)).toBe('#/series/7');
    expect(playHref('A B/C.mkv')).toBe(`#/play/${encodeURIComponent('A B/C.mkv')}`);
  });
});

describe('goBack', () => {
  beforeEach(() => {
    // Reset to a clean known state.
    window.history.replaceState(null, '', '#/');
  });

  it('walks history backward when the current entry was created by navigate()', () => {
    navigate('#/series/42');
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    goBack('#/');
    expect(backSpy).toHaveBeenCalledTimes(1);
    backSpy.mockRestore();
  });

  it('falls back to the supplied hash when there is no in-app history', () => {
    // history.state is null because we replaced state above without our tag.
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    goBack('#/');
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
    backSpy.mockRestore();
  });
});
