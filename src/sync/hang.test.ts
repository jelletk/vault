// Punt 0 (H2a): Jelle's iPhone stopped at "wijzigingen ophalen" and never finished or failed.
// Reproduced on d761786 with a Drive call that never settles; these tests pin the fix.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openVault } from './db';
import { SyncStalledError, runSync, withWatchdog } from './sync';
import { seed } from './fakeDrive';
import type { ContentRecord } from './types';

let n = 0;
const open = () => openVault('vault-hang-' + n++);

describe('een sync eindigt altijd', () => {
  it('hangt Drive bij wijzigingen ophalen, dan stopt de bewaker met een duidelijke fout en blijft alles staan', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    const token = await db.get('meta', 'changesToken');
    const lastSyncAt = await db.get('meta', 'lastSyncAt');
    d.setText('prof', 'v2');
    d.hang.add('listChanges');
    const log: string[] = [];
    const t0 = Date.now();
    const p = withWatchdog((signal, ping) => runSync(d, db, (m) => { ping(m); log.push(m); }, Date.now, { signal }), 80);
    await expect(p).rejects.toBeInstanceOf(SyncStalledError);
    await expect(p).rejects.toThrow('"wijzigingen ophalen"');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(log.at(-1)).toBe('wijzigingen ophalen');
    expect(await db.get('meta', 'changesToken')).toBe(token);
    expect(await db.get('meta', 'lastSyncAt')).toBe(lastSyncAt);
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('# profiel');
    // and the next try works once Drive answers again
    d.hang.clear();
    const s = await withWatchdog((signal, ping) => runSync(d, db, ping, Date.now, { signal }), 80);
    expect(s).toMatchObject({ mode: 'incremental', downloaded: 1 });
  });
  it('de bewaker laat een sync met voortgang gewoon afmaken', async () => {
    const d = seed(), db = await open();
    const s = await withWatchdog((signal, ping) => runSync(d, db, ping, Date.now, { signal }), 80);
    expect(s.mode).toBe('full');
  });
  it('logt per stap: pagina\'s, aantal wijzigingen en downloads', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.setText('prof', 'v2');
    const log: string[] = [];
    await runSync(d, db, (m) => log.push(m));
    expect(log).toEqual(expect.arrayContaining([
      'wijzigingen ophalen',
      '1 wijzigingen in 1 pagina, toepassen',
      '4 md-bestanden, 1 te downloaden',
      'gedownload 1/1',
      'opslaan',
    ]));
  });
});

describe('grote achterstand (V1)', () => {
  it('meer pagina\'s dan het maximum: volledige sync met melding, zonder eerst te wissen', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.changesPageSize = 2;
    d.setText('prof', 'v2');
    d.put('extra', 'extra.md', 'root', { text: 'x' });
    d.put('extra2', 'extra2.md', 'root', { text: 'y' });
    d.downloads.length = 0;
    const log: string[] = [];
    const s = await runSync(d, db, (m) => log.push(m), Date.now, { maxChangePages: 1 });
    expect(s.mode).toBe('full');
    expect(s.fullReason).toMatch(/meer dan 2 wijzigingen/);
    expect(log.some((m) => m.includes('volledige sync') && m.includes('blijven leesbaar'))).toBe(true);
    expect(d.downloads.sort()).toEqual(['extra', 'extra2', 'prof']); // unchanged notes are not downloaded again
    expect(s.md).toBe(6);
  });
});
