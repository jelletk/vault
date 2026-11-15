// The real HTTP client against a mocked fetch: status handling, retries, pagination and deadlines.
import { describe, expect, it } from 'vitest';
import { AuthError, ChangesBacklogError, ChangesTokenError, DriveTimeoutError, HttpError, createDrive, mapLimit, type DriveOptions } from './drive';

type Reply = Response | (() => Response | Promise<Response>);
/** fetch that answers from a queue and records the urls it was asked for. */
function mockFetch(replies: Reply[]) {
  const urls: string[] = [];
  const f = async (url: any) => {
    urls.push(String(url));
    const r = replies.shift();
    if (!r) throw new Error('geen antwoord meer in de mock');
    return typeof r === 'function' ? r() : r;
  };
  return { f: f as unknown as typeof fetch, urls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const text = (t: string, status: number) => new Response(t, { status });
const stalledBody = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
const fast: DriveOptions = { timeoutMs: 40, sleep: async () => {} };

describe('HTTP-client', () => {
  it('401 wordt AuthError, zonder nieuwe poging', async () => {
    const m = mockFetch([text('nee', 401)]);
    await expect(createDrive(() => 't', m.f, fast).getStartPageToken()).rejects.toBeInstanceOf(AuthError);
    expect(m.urls.length).toBe(1);
  });
  it('zonder token geen aanvraag maar AuthError', async () => {
    const m = mockFetch([]);
    await expect(createDrive(() => null, m.f, fast).getStartPageToken()).rejects.toBeInstanceOf(AuthError);
    expect(m.urls.length).toBe(0);
  });
  it('429 en 503 worden opnieuw geprobeerd en gelogd', async () => {
    const events: string[] = [];
    const m = mockFetch([text('slow down', 429), text('oeps', 503), json({ startPageToken: '42' })]);
    const d = createDrive(() => 't', m.f, { ...fast, onEvent: (e) => events.push(e) });
    expect(await d.getStartPageToken()).toBe('42');
    expect(m.urls.length).toBe(3);
    expect(events.filter((e) => e.includes('poging')).length).toBe(2);
  });
  it('blijvende 500 geeft na het maximum aantal pogingen een HttpError', async () => {
    const m = mockFetch(Array.from({ length: 4 }, () => () => text('kapot', 500)));
    await expect(createDrive(() => 't', m.f, fast).getStartPageToken()).rejects.toBeInstanceOf(HttpError);
    expect(m.urls.length).toBe(4);
  });
  it('403 zonder rate limit wordt niet herhaald', async () => {
    const m = mockFetch([text('forbidden', 403)]);
    await expect(createDrive(() => 't', m.f, fast).getStartPageToken()).rejects.toMatchObject({ name: 'HttpError', status: 403 });
    expect(m.urls.length).toBe(1);
  });
  it('ongeldig wijzigingen-startpunt (400 pageToken, 410) wordt ChangesTokenError', async () => {
    const body = JSON.stringify({ error: { code: 400, errors: [{ location: 'pageToken', reason: 'invalid' }] } });
    await expect(createDrive(() => 't', mockFetch([text(body, 400)]).f, fast).listChanges('1')).rejects.toBeInstanceOf(ChangesTokenError);
    await expect(createDrive(() => 't', mockFetch([text('gone', 410)]).f, fast).listChanges('1')).rejects.toBeInstanceOf(ChangesTokenError);
  });
  it('bladert door alle pagina\'s van mappen', async () => {
    const m = mockFetch([json({ files: [{ id: 'a' }], nextPageToken: 'p2' }), json({ files: [{ id: 'b' }] })]);
    const out = await createDrive(() => 't', m.f, fast).listAllFolders();
    expect(out.map((f) => f.id)).toEqual(['a', 'b']);
    expect(m.urls[1]).toContain('pageToken=p2');
  });
  it('bladert door wijzigingen en logt per pagina', async () => {
    const events: string[] = [];
    const m = mockFetch([
      json({ changes: [{ fileId: 'a' }, { fileId: 'b' }], nextPageToken: 'p2' }),
      json({ changes: [], nextPageToken: 'p3' }), // Drive may return empty pages that still continue
      json({ changes: [{ fileId: 'c' }], newStartPageToken: 'nieuw' }),
    ]);
    const r = await createDrive(() => 't', m.f, { ...fast, onEvent: (e) => events.push(e) }).listChanges('start');
    expect(r).toMatchObject({ newStartPageToken: 'nieuw', pages: 3 });
    expect(r.changes.map((c) => c.fileId)).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['wijzigingen pagina 1: 2 (totaal 2)', 'wijzigingen pagina 2: 0 (totaal 2)', 'wijzigingen pagina 3: 1 (totaal 3)']);
  });
  it('stopt als Drive dezelfde pagina blijft teruggeven', async () => {
    const m = mockFetch([json({ changes: [], nextPageToken: 'x' }), json({ changes: [], nextPageToken: 'x' })]);
    await expect(createDrive(() => 't', m.f, fast).listChanges('x')).rejects.toThrow(/dezelfde pagina/);
  });
  it('te veel pagina\'s wijzigingen geeft ChangesBacklogError', async () => {
    const m = mockFetch([json({ changes: [{ fileId: 'a' }], nextPageToken: 'p2' }), json({ changes: [{ fileId: 'b' }], nextPageToken: 'p3' })]);
    await expect(createDrive(() => 't', m.f, fast).listChanges('s', { maxPages: 2 })).rejects.toBeInstanceOf(ChangesBacklogError);
    expect(m.urls.length).toBe(2);
  });
});

describe('deadlines (punt 0: sync bleef hangen)', () => {
  it('een antwoord waarvan de inhoud blijft hangen eindigt na de pogingen met een time-out', async () => {
    const events: string[] = [];
    const m = mockFetch([stalledBody, stalledBody, stalledBody]);
    const d = createDrive(() => 't', m.f, { ...fast, attempts: 3, onEvent: (e) => events.push(e) });
    await expect(d.listChanges('s')).rejects.toBeInstanceOf(DriveTimeoutError);
    expect(m.urls.length).toBe(3);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/wijzigingen pagina 1: poging 1\/3 mislukt \(.*geen antwoord binnen/);
  });
  it('een fetch die nooit antwoordt eindigt ook', async () => {
    const m = mockFetch([() => new Promise<Response>(() => {}), () => new Promise<Response>(() => {})]);
    await expect(createDrive(() => 't', m.f, { ...fast, attempts: 2 }).download('x')).rejects.toBeInstanceOf(DriveTimeoutError);
  });
  it('netwerkfout wordt opnieuw geprobeerd', async () => {
    const m = mockFetch([() => { throw new TypeError('Load failed'); }, json({ startPageToken: '7' })]);
    expect(await createDrive(() => 't', m.f, fast).getStartPageToken()).toBe('7');
  });
  it('stoppen via het signaal breekt een hangende aanvraag direct af', async () => {
    const ctrl = new AbortController();
    const m = mockFetch([() => new Promise<Response>(() => {})]);
    const p = createDrive(() => 't', m.f, { timeoutMs: 60_000, signal: ctrl.signal }).download('x');
    setTimeout(() => ctrl.abort(new Error('gestopt')), 10);
    await expect(p).rejects.toThrow('gestopt');
  });
});

describe('mapLimit', () => {
  it('de eerste fout houdt de andere workers tegen', async () => {
    const started: number[] = [];
    const p = mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 1));
      if (i === 1) throw new AuthError();
      return i;
    });
    await expect(p).rejects.toBeInstanceOf(AuthError);
    await new Promise((r) => setTimeout(r, 20));
    expect(started.length).toBeLessThan(6);
  });
});
