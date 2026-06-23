import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/components/manual-identify-modal.js';
import type {
  ManualIdentifyModal,
  ManualIdentifyTarget,
} from '../src/components/manual-identify-modal.js';
import type { Episode, LibraryItem } from '../src/types.js';

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    path: 'Wrong.mkv',
    type: 'movie',
    tmdbId: 99,
    title: 'Wrong',
    year: 2000,
    posterUrl: null,
    backdropUrl: null,
    overview: null,
    genres: [],
    runtimeSeconds: null,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    addedAt: 0,
    lastPlayedAt: null,
    imdbRating: null,
    imdbVotes: null,
    ...overrides,
  };
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 5,
    path: 'TheBear/wrong.mkv',
    season: 1,
    episode: 99,
    title: null,
    overview: null,
    absoluteNumber: null,
    stillUrl: null,
    runtimeSeconds: null,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function tick(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function flushDebounce(ms = 220): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function mountModal(target: ManualIdentifyTarget): Promise<ManualIdentifyModal> {
  const el = document.createElement('manual-identify-modal') as ManualIdentifyModal;
  el.target = target;
  el.open = true;
  document.body.appendChild(el);
  await el.updateComplete;
  await tick();
  return el;
}

describe('<manual-identify-modal>', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when closed', async () => {
    const el = document.createElement('manual-identify-modal') as ManualIdentifyModal;
    document.body.appendChild(el);
    await el.updateComplete;
    const panel = el.shadowRoot!.querySelector('.panel');
    expect(panel).toBeFalsy();
    document.body.removeChild(el);
  });

  it('renders header + current identity for an item target', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: 'Wrong Movie', year: 2010, tmdbId: 42 }),
    });
    const panel = el.shadowRoot!.querySelector('.panel');
    expect(panel).toBeTruthy();
    const meta = el.shadowRoot!.querySelector('.current .meta .name')?.textContent ?? '';
    expect(meta).toContain('Wrong Movie');
    expect(meta).toContain('2010');
    const ids = el.shadowRoot!.querySelector('.current .meta .ids')?.textContent ?? '';
    expect(ids).toContain('TMDB: 42');
    document.body.removeChild(el);
  });

  it('seeds the search input with the current title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: 'The Bear', type: 'series' }),
    });
    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    expect(input.value).toBe('The Bear');
    document.body.removeChild(el);
  });

  it('debounces typing and calls the search API', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        mockJson({
          candidates: [
            { tmdbId: 1, imdbId: null, tvdbId: null, title: 'A', year: 2020, type: 'movie', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
          ],
        }),
      );
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: '' }),
    });
    // The seeded query was empty so no initial search; fire one now.
    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'Foo';
    input.dispatchEvent(new Event('input'));
    expect(fetchSpy).not.toHaveBeenCalled();
    await flushDebounce();
    await el.updateComplete;
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]![0];
    expect(String(url)).toContain('/api/manual-identify/search');
    expect(String(url)).toContain('q=Foo');
    document.body.removeChild(el);
  });

  it('renders search results and selecting one enables Apply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJson({
        candidates: [
          { tmdbId: 11, imdbId: null, tvdbId: null, title: 'Right', year: 2021, type: 'movie', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
        ],
      }),
    );
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: 'Wrong' }),
    });
    await flushDebounce();
    await el.updateComplete;
    const result = el.shadowRoot!.querySelector('.result') as HTMLButtonElement;
    expect(result).toBeTruthy();
    // Apply starts disabled.
    let applyBtn = el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    result.click();
    await el.updateComplete;
    applyBtn = el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    document.body.removeChild(el);
  });

  it('typing into the link field enables Apply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: '' }),
    });
    await el.updateComplete;
    const inputs = el.shadowRoot!.querySelectorAll('input[type="text"]');
    // The link field is the second input on item-kind modals (search, link).
    const linkInput = inputs[inputs.length - 1] as HTMLInputElement;
    linkInput.value = 'tmdb:42';
    linkInput.dispatchEvent(new Event('input'));
    await el.updateComplete;
    const applyBtn = el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    document.body.removeChild(el);
  });

  it('Apply success POSTs the picked tmdbId, fires `applied`, and closes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => mockJson({
        candidates: [
          { tmdbId: 11, imdbId: null, tvdbId: null, title: 'Right', year: 2021, type: 'movie', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
        ],
      }))
      .mockImplementationOnce(async () => mockJson({ item: { id: 1, tmdbId: 11 } }));

    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: 'Wrong' }),
    });
    await flushDebounce();
    await el.updateComplete;
    const appliedSpy = vi.fn();
    el.addEventListener('applied', appliedSpy as EventListener);

    (el.shadowRoot!.querySelector('.result') as HTMLButtonElement).click();
    await el.updateComplete;
    (el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement).click();
    await tick(5);
    await el.updateComplete;

    expect(appliedSpy).toHaveBeenCalledOnce();
    expect(el.open).toBe(false);
    // Last fetch is the apply POST.
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]!;
    expect(String(lastCall[0])).toBe('/api/manual-identify/item/1');
    const init = lastCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ tmdbId: 11, type: 'movie' });
    document.body.removeChild(el);
  });

  it('Apply error keeps modal open and surfaces an inline error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => mockJson({
        candidates: [
          { tmdbId: 11, imdbId: null, tvdbId: null, title: 'Right', year: 2021, type: 'movie', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
        ],
      }))
      .mockImplementationOnce(async () => mockJson({ error: 'unresolvable_link' }, 404));

    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: 'Wrong' }),
    });
    await flushDebounce();
    await el.updateComplete;
    (el.shadowRoot!.querySelector('.result') as HTMLButtonElement).click();
    await el.updateComplete;
    (el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement).click();
    await tick(5);
    await el.updateComplete;

    expect(el.open).toBe(true);
    const err = el.shadowRoot!.querySelector('.error');
    expect(err).toBeTruthy();
    document.body.removeChild(el);
  });

  it('Cancel button fires `cancelled` and closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem(),
    });
    const cancelledSpy = vi.fn();
    el.addEventListener('cancelled', cancelledSpy as EventListener);
    const cancelBtn = el.shadowRoot!.querySelector('button.action:not(.primary)') as HTMLButtonElement;
    cancelBtn.click();
    await el.updateComplete;
    expect(cancelledSpy).toHaveBeenCalledOnce();
    expect(el.open).toBe(false);
    document.body.removeChild(el);
  });

  it('Backdrop click cancels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem(),
    });
    const cancelledSpy = vi.fn();
    el.addEventListener('cancelled', cancelledSpy as EventListener);
    (el.shadowRoot!.querySelector('.backdrop') as HTMLElement).click();
    await el.updateComplete;
    expect(cancelledSpy).toHaveBeenCalledOnce();
    expect(el.open).toBe(false);
    document.body.removeChild(el);
  });

  it('ESC closes the modal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson({ candidates: [] }));
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem(),
    });
    const cancelledSpy = vi.fn();
    el.addEventListener('cancelled', cancelledSpy as EventListener);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await el.updateComplete;
    expect(cancelledSpy).toHaveBeenCalledOnce();
    expect(el.open).toBe(false);
    document.body.removeChild(el);
  });

  it('episode-kind modal renders the S/E input and forwards seInput on Apply', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => mockJson({
        candidates: [
          { tmdbId: 136315, imdbId: null, tvdbId: null, title: 'The Bear', year: 2022, type: 'series', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
        ],
      }))
      .mockImplementationOnce(async () => mockJson({ episode: { id: 5 }, item: null }));

    const el = await mountModal({
      kind: 'episode',
      id: 5,
      row: episode(),
      seriesTitle: 'The Bear',
    });
    await flushDebounce();
    await el.updateComplete;

    // S/E input is rendered between Search and Results for episode kind.
    const inputs = el.shadowRoot!.querySelectorAll('input[type="text"]');
    // Inputs: [search, seInput, link]
    expect(inputs.length).toBe(3);
    const seInput = inputs[1] as HTMLInputElement;
    seInput.value = 'S04E01';
    seInput.dispatchEvent(new Event('input'));
    await el.updateComplete;

    (el.shadowRoot!.querySelector('.result') as HTMLButtonElement).click();
    await el.updateComplete;
    (el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement).click();
    await tick(5);

    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]!;
    expect(String(lastCall[0])).toBe('/api/manual-identify/episode/5');
    const body = JSON.parse(String((lastCall[1] as RequestInit).body));
    expect(body.tmdbId).toBe(136315);
    expect(body.type).toBe('series');
    expect(body.seInput).toBe('S04E01');
    document.body.removeChild(el);
  });

  it('uncategorized-kind modal seeds from the filename, shows S/E input, and POSTs path + seInput', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => mockJson({
        candidates: [
          { tmdbId: 128098, imdbId: null, tvdbId: null, title: 'Interview with the Vampire', year: 2022, type: 'series', overview: null, posterUrl: null, score: 1, sources: ['tmdb'] },
        ],
      }))
      .mockImplementationOnce(async () => mockJson({ ok: true, episode: { id: 9 } }));

    const el = await mountModal({ kind: 'uncategorized', path: 'Vampire/S03E01.mkv' });

    // Seeds the search input with the file basename.
    const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    expect(searchInput.value).toBe('S03E01.mkv');
    // The "current" block labels it as an uncategorized file.
    expect(el.shadowRoot!.querySelector('.current .meta .name')?.textContent).toContain('S03E01.mkv');

    await flushDebounce();
    await el.updateComplete;

    // Inputs: [search, seInput, link] — the S/E input is shown for this kind.
    const inputs = el.shadowRoot!.querySelectorAll('input[type="text"]');
    expect(inputs.length).toBe(3);
    const seInput = inputs[1] as HTMLInputElement;
    seInput.value = 'S03E01';
    seInput.dispatchEvent(new Event('input'));
    await el.updateComplete;

    const appliedSpy = vi.fn();
    el.addEventListener('applied', appliedSpy as EventListener);
    (el.shadowRoot!.querySelector('.result') as HTMLButtonElement).click();
    await el.updateComplete;
    (el.shadowRoot!.querySelector('button.action.primary') as HTMLButtonElement).click();
    await tick(5);
    await el.updateComplete;

    expect(appliedSpy).toHaveBeenCalledOnce();
    expect(el.open).toBe(false);
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]!;
    expect(String(lastCall[0])).toBe('/api/library/uncategorized/identify');
    const body = JSON.parse(String((lastCall[1] as RequestInit).body));
    expect(body).toEqual({ path: 'Vampire/S03E01.mkv', tmdbId: 128098, type: 'series', seInput: 'S03E01' });
    document.body.removeChild(el);
  });

  it('search aborts in flight when typing again', async () => {
    let aborted = false;
    const pending: Array<(r: Response) => void> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }
        pending.push(resolve);
      });
    }) as never);
    const el = await mountModal({
      kind: 'item',
      id: 1,
      row: libraryItem({ title: '' }),
    });
    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'Aa';
    input.dispatchEvent(new Event('input'));
    await flushDebounce();
    expect(fetchSpy).toHaveBeenCalled();
    input.value = 'Bb';
    input.dispatchEvent(new Event('input'));
    await flushDebounce();
    expect(aborted).toBe(true);
    // Resolve any pending calls so vitest doesn't leak.
    for (const r of pending) r(mockJson({ candidates: [] }));
    document.body.removeChild(el);
  });
});
