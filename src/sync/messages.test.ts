import { describe, expect, it } from 'vitest';
import { describeIncomplete, describeSyncError } from './messages';
import { AuthError, DriveTimeoutError, HttpError } from './drive';
import { RootLostError, SyncStalledError } from './sync';

describe('foutmeldingen', () => {
  it('geeft per soort fout een begrijpelijke reden', () => {
    expect(describeSyncError(new AuthError()).kind).toBe('auth');
    expect(describeSyncError(new SyncStalledError('wijzigingen ophalen', 120_000)).text).toContain('"wijzigingen ophalen" (120 s)');
    expect(describeSyncError(new DriveTimeoutError('wijzigingen pagina 1', 25_000)).text).toContain('Google Drive reageerde niet');
    expect(describeSyncError(new HttpError(500, 'x', true)).text).toContain('Drive 500');
    expect(describeSyncError(new TypeError('Load failed')).text).toContain('Geen verbinding');
    expect(describeSyncError(new RootLostError()).text).toContain('Life OS');
    expect(describeSyncError(new Error('raar')).text).toContain('niets half opgeslagen');
    expect(describeIncomplete(2).text).toBe('2 notities konden niet worden opgehaald en blijven op de vorige versie.');
  });
});
