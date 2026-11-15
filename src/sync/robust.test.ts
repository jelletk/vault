// R2 regressions (H2a): commit boundary, md status, root loss, real logout wipe.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openVault, wipeAll } from './db';
import { RootLostError, runSync } from './sync';
import { AuthError } from './drive';
import { seed } from './fakeDrive';
import type { ContentRecord, PreviousRecord, TreeNode } from './types';

let n = 0;
const fresh = () => 'vault-robust-' + n++;
const snapshot = async (db: Awaited<ReturnType<typeof openVault>>) => JSON.stringify({
  tree: await db.getAll('tree'), content: await db.getAll('content'), previous: await db.getAll('previous'),
  token: await db.get('meta', 'changesToken'), at: await db.get('meta', 'lastSyncAt'),
});

describe('R2-2: geen gemengde dataset na een fout midden in een batch', () => {
  it('AuthError halverwege: niets geschreven, ook niet door workers die nog bezig waren, en de rest stopt', async () => {
    const d = seed(), db = await openVault(fresh());
    for (let i = 0; i < 20; i++) d.put('x' + i, `x${i}.md`, 'root', { text: 'oud ' + i });
    await runSync(d, db);
    for (let i = 0; i < 20; i++) d.setText('x' + i, 'nieuw ' + i);
    const before = await snapshot(db);
    d.downloads.length = 0;
    d.authExpireAfterDownloads = 3;
    await expect(runSync(d, db)).rejects.toBeInstanceOf(AuthError);
    await new Promise((r) => setTimeout(r, 30)); // give stragglers time to (not) write
    expect(await snapshot(db)).toBe(before);
    expect(d.downloads.length).toBeLessThan(10); // of 20: the other workers stopped taking new files
  });
  it('na de fout en opnieuw inloggen komt alles in één keer binnen', async () => {
    const d = seed(), db = await openVault(fresh());
    await runSync(d, db);
    d.setText('prof', 'v2'); d.setText('claude', 'v2');
    d.authExpireAfterDownloads = 0;
    await expect(runSync(d, db)).rejects.toBeInstanceOf(AuthError);
    d.authExpireAfterDownloads = null; d.authExpired = false;
    const s = await runSync(d, db);
    expect(s.downloaded).toBe(2);
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('v2');
    expect(((await db.get('previous', 'claude')) as PreviousRecord).text).toBe('# root');
  });
  it('een gewone downloadfout laat die ene notitie op de oude versie en de rest gaat door', async () => {
    const d = seed(), db = await openVault(fresh());
    await runSync(d, db);
    d.setText('prof', 'v2'); d.setText('claude', 'v2');
    d.failDownload.add('prof');
    const s = await runSync(d, db);
    expect(s).toMatchObject({ downloaded: 1, failedDownloads: 1 });
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('# profiel');
    expect(((await db.get('content', 'claude')) as ContentRecord).text).toBe('v2');
    d.failDownload.clear();
    expect((await runSync(d, db)).downloaded).toBe(1);
  });
});

describe('R2-3: md-status', () => {
  it('.md naar .txt ruimt tekst en vorige versie op; terug naar .md haalt de tekst weer op', async () => {
    const d = seed(), db = await openVault(fresh());
    await runSync(d, db);
    d.setText('prof', 'v2');
    await runSync(d, db);
    expect(await db.get('previous', 'prof')).toBeDefined();
    d.rename('prof', 'personal-profile.txt');
    const s = await runSync(d, db);
    expect(s).toMatchObject({ md: 3, droppedTexts: 1 });
    expect(((await db.get('tree', 'prof')) as TreeNode).isMd).toBe(false);
    expect(await db.get('content', 'prof')).toBeUndefined();
    expect(await db.get('previous', 'prof')).toBeUndefined();
    d.rename('prof', 'personal-profile.md');
    d.downloads.length = 0;
    await runSync(d, db);
    expect(d.downloads).toEqual(['prof']);
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('v2');
  });
});

describe('R2-4: rootmap verdwijnt', () => {
  for (const how of ['trash', 'remove'] as const) {
    it(`root ${how === 'trash' ? 'naar de prullenbak' : 'verwijderd'}: duidelijke fout, lokale kopie ongewijzigd, geen andere root`, async () => {
      const d = seed(), db = await openVault(fresh());
      await runSync(d, db);
      const before = await snapshot(db);
      d.put('other', 'Life OS', 'myroot', { folder: true }); // a second "Life OS" must not be picked
      if (how === 'trash') d.trash('root'); else d.remove('root');
      await expect(runSync(d, db)).rejects.toBeInstanceOf(RootLostError);
      expect(await snapshot(db)).toBe(before);
      expect(await db.get('meta', 'rootId')).toBe('root');
    });
  }
  it('ook bij een volledige sync (ongeldig startpunt) geen stille lege boom', async () => {
    const d = seed(), db = await openVault(fresh());
    await runSync(d, db);
    const before = await snapshot(db);
    d.trash('root');
    d.invalidTokens = true;
    await expect(runSync(d, db)).rejects.toBeInstanceOf(RootLostError);
    expect(await snapshot(db)).toBe(before);
  });
  it('root teruggezet: de volgende sync werkt weer', async () => {
    const d = seed(), db = await openVault(fresh());
    await runSync(d, db);
    d.trash('root');
    await expect(runSync(d, db)).rejects.toBeInstanceOf(RootLostError);
    d.put('root', 'Life OS', 'myroot', { folder: true }); // restored from the trash
    const s = await runSync(d, db);
    expect(s.md).toBe(4);
  });
});

describe('R2-17: echte uitlog-flow', () => {
  const g = globalThis as any;
  afterEach(() => { delete g.caches; });
  it('wipeAll sluit de database, wist alles en alleen de eigen caches', async () => {
    const deleted: string[] = [];
    g.caches = { keys: async () => ['vault-precache-v2', 'vault-shell-1', 'gaar-cache'], delete: async (k: string) => { deleted.push(k); return true; } };
    const name = fresh();
    const d = seed(), db = await openVault(name);
    await runSync(d, db);
    await wipeAll(db, name);
    expect(deleted).toEqual(['vault-precache-v2', 'vault-shell-1']);
    const again = await openVault(name);
    expect(await again.count('tree')).toBe(0);
    expect(await again.count('content')).toBe(0);
    expect(await again.get('meta', 'changesToken')).toBeUndefined();
    // a fresh start after logout does a full sync again
    expect((await runSync(seed(), again)).mode).toBe('full');
  });
});
