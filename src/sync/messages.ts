// Turns a failed sync into one Dutch sentence for the notice on screen. Pure, so it is unit-tested.

export interface SyncNotice {
  /** auth: token expired or refused (button logs in again); error: anything else; info: finished but incomplete. */
  kind: 'auth' | 'error' | 'info';
  text: string;
}

const SAFE = ' Er is niets half opgeslagen; je notities zijn leesbaar zoals ze waren.';

export function describeSyncError(e: any): SyncNotice {
  const msg: string = e?.message ?? String(e);
  switch (e?.name) {
    case 'AuthError':
      return { kind: 'auth', text: 'Google-toegang is verlopen of geweigerd. Je notities blijven leesbaar.' };
    case 'NeedTapError':
    case 'RootLostError':
      return { kind: 'error', text: msg };
    case 'SyncStalledError':
      return { kind: 'error', text: `De sync bleef hangen: ${msg}.` + SAFE };
    case 'DriveTimeoutError':
      return { kind: 'error', text: `Google Drive reageerde niet (${msg}).` + SAFE };
    case 'HttpError':
      return { kind: 'error', text: `Google Drive gaf een fout (${msg}).` + SAFE };
    case 'TypeError':
      return { kind: 'error', text: `Geen verbinding met Google Drive (${msg}).` + SAFE };
    default:
      return { kind: 'error', text: msg + '.' + SAFE };
  }
}

export function describeIncomplete(failed: number): SyncNotice {
  return {
    kind: 'info',
    text: `${failed} ${failed === 1 ? 'notitie kon' : 'notities konden'} niet worden opgehaald en ${failed === 1 ? 'blijft' : 'blijven'} op de vorige versie.`,
  };
}
