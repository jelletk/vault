import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { openVault } from './db';
import { runSync } from './sync';
import { FakeDrive, seed } from './fakeDrive';
import { AuthError } from './drive';
import type { ContentRecord, PreviousRecord, TreeNode } from './types';

let n = 0;
let name = '';
beforeEach(() => { name = 'vault-test-' + n++; });
const open = () => openVault(name);

describe('eerste sync', () => {
  it('haalt alleen Life OS op: telt klopt, buiten-Life OS-bestanden ontbreken', async () => {
    const d = seed(), db = await open();
    const s = await runSync(d, db);
    expect(s).toMatchObject({ mode: 'full', md: 4, folders: 3, otherFiles: 2, downloaded: 4, failedDownloads: 0 });
    const tree = (await db.getAll('tree')) as TreeNode[];
    expect(tree.map((t) => t.id)).not.toContain('m1');
    expect(tree.map((t) => t.id)).not.toContain('lo-out');
    expect(tree.find((t) => t.id === 'mem-werk')!.path).toBe('02 Areas/Werk/MEMORY.md');
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('# profiel');
    expect(await db.count('content')).toBe(4); // niet-md krijgt geen inhoud
    expect(await db.get('meta', 'rootId')).toBe('root');
    expect(d.downloads).not.toContain('pdf');
  });
  it('meldt voortgang', async () => {
    const msgs: string[] = [];
    await runSync(seed(), await open(), (m) => msgs.push(m));
    expect(msgs.some((m) => m.includes('md-bestanden'))).toBe(true);
  });
  it('geeft een duidelijke fout als Life OS ontbreekt', async () => {
    const d = new FakeDrive();
    await expect(runSync(d, await open())).rejects.toThrow(/Life OS/);
  });
});

describe('tweede sync', () => {
  it('zonder wijzigingen downloadt niets', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.downloads.length = 0;
    const s = await runSync(d, db);
    expect(s).toMatchObject({ mode: 'incremental', downloaded: 0, added: 0, modified: 0, removed: 0, md: 4 });
    expect(d.downloads).toEqual([]);
  });
  it('haalt alleen het gewijzigde bestand op en bewaart de vorige versie', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.downloads.length = 0;
    d.setText('mem-werk', '# mem werk v2');
    const s = await runSync(d, db);
    expect(d.downloads).toEqual(['mem-werk']);
    expect(s).toMatchObject({ mode: 'incremental', downloaded: 1, modified: 1 });
    expect(((await db.get('content', 'mem-werk')) as ContentRecord).text).toBe('# mem werk v2');
    expect(((await db.get('previous', 'mem-werk')) as PreviousRecord).text).toBe('# mem werk');
  });
  it('negeert wijzigingen buiten Life OS, ook een bestand dat eruit wordt verplaatst', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.setText('m1', 'buiten gewijzigd');
    d.put('x', 'buiten.md', 'media', { text: 'nieuw buiten' });
    d.move('prof', 'media');
    d.downloads.length = 0;
    const s = await runSync(d, db);
    expect(d.downloads).toEqual([]);
    expect(s.removed).toBe(1);
    expect(await db.get('content', 'prof')).toBeUndefined();
    expect(await db.get('tree', 'prof')).toBeUndefined();
    expect(await db.get('tree', 'm1')).toBeUndefined();
  });
  it('neemt een nieuwe submap met bestand mee', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.put('f-new', 'Nieuw', 'f-werk', { folder: true });
    d.put('nieuw-md', 'idee.md', 'f-new', { text: 'idee' });
    const s = await runSync(d, db);
    expect(s).toMatchObject({ added: 2, downloaded: 1, md: 5 });
    expect(((await db.get('tree', 'nieuw-md')) as TreeNode).path).toBe('02 Areas/Werk/Nieuw/idee.md');
  });
  it('een verplaatste map werkt de paden van de inhoud bij', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.move('f-werk', 'f-res');
    await runSync(d, db);
    // het change-record van de map zelf; de kinderen houden hun oude pad tot we ze herberekenen
    expect(((await db.get('tree', 'mem-werk')) as TreeNode).path).toBe('00 Resources/Werk/MEMORY.md');
  });
  it('een map van buiten die in Life OS wordt gezet brengt zijn inhoud mee', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.move('media', 'f-areas');
    const s = await runSync(d, db);
    expect(s.md).toBe(5);
    expect(((await db.get('tree', 'm1')) as TreeNode).path).toBe('02 Areas/Media/foto.md');
    expect(((await db.get('content', 'm1')) as ContentRecord).text).toBe('buiten Life OS');
  });
  it('verwijderen en trashen ruimen boom en inhoud op', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.remove('claude');
    d.trash('prof');
    const s = await runSync(d, db);
    expect(s.removed).toBe(2);
    expect(await db.count('content')).toBe(2);
  });
  it('valt terug op een volledige sync als het changes-token ongeldig is', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    d.invalidTokens = true;
    const s = await runSync(d, db);
    expect(s.mode).toBe('full');
    expect(s.downloaded).toBe(0); // inhoud is al binnen
  });
});

describe('fouten en herstel', () => {
  it('een mislukte download wordt de volgende keer opnieuw geprobeerd', async () => {
    const d = seed(), db = await open();
    d.failDownload.add('prof');
    const s1 = await runSync(d, db);
    expect(s1.failedDownloads).toBe(1);
    expect(await db.get('content', 'prof')).toBeUndefined();
    d.failDownload.clear();
    const s2 = await runSync(d, db);
    expect(s2.downloaded).toBe(1);
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('# profiel');
  });
  it('een verlopen token stopt de sync en laat de opgeslagen data ongemoeid', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    const token = await db.get('meta', 'changesToken');
    d.setText('prof', 'v2');
    d.authExpired = true;
    await expect(runSync(d, db)).rejects.toBeInstanceOf(AuthError);
    expect(await db.get('meta', 'changesToken')).toBe(token);
    expect(((await db.get('content', 'prof')) as ContentRecord).text).toBe('# profiel');
    expect(await db.count('tree')).toBeGreaterThan(5); // lezen kan nog
  });
  it('wissen verwijdert alles', async () => {
    const d = seed(), db = await open();
    await runSync(d, db);
    db.close();
    await deleteDB(name);
    const fresh = await open();
    expect(await fresh.count('tree')).toBe(0);
    expect(await fresh.count('content')).toBe(0);
  });
});
