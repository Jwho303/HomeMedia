import { describe, it, expect, afterAll } from 'vitest';
import '../src/components/search-view.js';
import { SearchView } from '../src/components/search-view.js';

/** Static helper tests for <search-view>. The full component renders the home
 *  library through `apiLibrary` + filters in place; we exercise that flow via
 *  the live dev server (Phase 9 manual testing) since JSDOM has issues
 *  re-flowing Lit `${...}` slots after async state changes in this harness. */
describe('SearchView.readQueryFromHash', () => {
  const original = window.location.hash;
  afterAll(() => { window.location.hash = original; });

  it('returns "" when there is no query string', () => {
    window.location.hash = '#/search';
    expect(SearchView.readQueryFromHash()).toBe('');
  });

  it('reads the q= param', () => {
    window.location.hash = '#/search?q=dune';
    expect(SearchView.readQueryFromHash()).toBe('dune');
  });

  it('decodes URI-encoded characters', () => {
    window.location.hash = `#/search?q=${encodeURIComponent('the bear')}`;
    expect(SearchView.readQueryFromHash()).toBe('the bear');
  });

  it('returns "" for #/search?q= (empty value)', () => {
    window.location.hash = '#/search?q=';
    expect(SearchView.readQueryFromHash()).toBe('');
  });
});
