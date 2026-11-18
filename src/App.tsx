// Vault, package 3: read screens (folders, notes) on top of the package 2 sync layer.
// Reading never needs a token: everything opens from IndexedDB. A token is only for "Bijwerken".
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { IDBPDatabase } from 'idb';
import { NeedTapError, accessToken, dropToken, getToken, googleReady, hasValidToken, loadGoogleScript, revokeToken, signInPopup } from './auth';
import { createDrive } from './sync/drive';
import { finishPendingWipe, loadContent, loadTree, openVault, requestPersistence, wipeAll } from './sync/db';
import { SyncStoppedError, runSync, withWatchdog, WATCHDOG_MS } from './sync/sync';
import { describeIncomplete, describeSyncError, type SyncNotice } from './sync/messages';
import { buildLinkIndex } from './sync/links';
import { summarize } from './sync/paths';
import type { ContentRecord, SyncStats, TreeNode } from './sync/types';
import { driveUrl, listFolder, noteTitle, parseRoute, screenTitle, splitPrefix, urlFor, type Route } from './nav';
import { previewOf, renderMarkdown, splitFrontmatter } from './markdown';

/** Resolves with the value, or with `fallback` after `ms`: for local steps that must never keep the app busy. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}
const LOCAL_MS = 10_000;

const CARD_LIMIT = 5; // up to this many entries a folder shows cards; more than that gets compact rows (Jelle, 7-11; was 12). The root always shows cards.

/* ---------------- small helpers ---------------- */

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function Tile({ iso, prefix }: { iso?: string; prefix?: string | null }) {
  if (prefix) return <div className="date"><small>map</small><b>{prefix}</b></div>;
  if (!iso) return <div className="date"><small>map</small><b>·</b></div>;
  const d = new Date(iso);
  return <div className="date"><small>{d.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '')}</small><b>{d.getDate()}</b></div>;
}
const Back = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>;
const FolderIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;

/** Lives in the fixed top bar, which hides while scrolling down and returns on a short scroll up. */
function BackButton({ onClick }: { onClick: () => void }) {
  return <button className="back" onClick={onClick}><i><Back /></i>Terug</button>;
}

/* ---------------- app ---------------- */

export function App() {
  const dbRef = useRef<IDBPDatabase | null>(null);
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  // Bumped after every reload from IndexedDB; open notes and previews re-read their text on a new version (R2-1).
  const [version, setVersion] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Stops the running sync (logout). `session` changes on logout, so a run that started before cannot write afterwards.
  const stopRef = useRef<AbortController | null>(null);
  const session = useRef(0);
  const [notice, setNotice] = useState<SyncNotice | null>(null);
  const [syncSay, setSyncSay] = useState(''); // polite live text for sync start/end (R2-13)
  const [lastAttempt, setLastAttempt] = useState<Attempt | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.hash));
  const [, tick] = useState(0);
  const popped = useRef(false);

  const log = useCallback((msg: string) => {
    setLines((l) => [...l.slice(-199), new Date().toLocaleTimeString('nl-NL') + '  ' + msg]);
  }, []);

  /* --- derived data --- */
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const rootNode = useMemo(() => nodes.find((n) => n.parent === null && n.isFolder) ?? null, [nodes]);
  const children = useMemo(() => {
    const m = new Map<string, TreeNode[]>();
    for (const n of nodes) if (n.parent) (m.get(n.parent) ?? m.set(n.parent, []).get(n.parent)!).push(n);
    return m;
  }, [nodes]);
  const index = useMemo(() => buildLinkIndex(nodes), [nodes]);
  const mdCount = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of nodes) if (n.isMd) for (let p = n.parent; p; p = byId.get(p)?.parent ?? null) c.set(p, (c.get(p) ?? 0) + 1);
    return c;
  }, [nodes, byId]);

  /* --- navigation (History API, so the iOS edge swipe goes back) --- */
  // Where keyboard/VoiceOver focus goes once the new screen is there (R2-12): the heading after opening
  // something, the card or row you came from after going back. null = leave focus alone (startup).
  const focusReq = useRef<{ itemId?: string } | null>(null);
  const go = useCallback((r: Route, replace = false) => {
    const depth = (history.state?.depth ?? 0) + (replace ? 0 : 1);
    // remember the item being opened, so going back can return focus to it
    if (!replace) history.replaceState({ ...history.state, y: window.scrollY, from: 'id' in r ? r.id : null }, '');
    (replace ? history.replaceState : history.pushState).call(history, { depth }, '', urlFor(r));
    popped.current = false;
    focusReq.current = {};
    setRoute(r);
  }, []);

  /** Tries to apply a pending focus request; called after every render and when a note has rendered. */
  const applyFocus = useCallback(() => {
    const req = focusReq.current;
    if (!req) return;
    const el = (req.itemId && document.querySelector<HTMLElement>(`main [data-id="${CSS.escape(req.itemId)}"]`))
      || document.querySelector<HTMLElement>('main h1');
    if (!el) return; // screen not there yet (note still loading); NoteView calls again
    if (el.tagName === 'H1') el.tabIndex = -1;
    el.focus({ preventScroll: true });
    focusReq.current = null;
  }, []);
  useEffect(() => { applyFocus(); });

  useEffect(() => {
    const onPop = () => {
      popped.current = true;
      focusReq.current = { itemId: history.state?.from ?? undefined };
      setRoute(parseRoute(location.pathname, location.hash));
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    if (route.kind === 'note' && route.heading) {
      // the note renders asynchronously; NoteView scrolls to the heading itself once it is there
      return;
    }
    window.scrollTo(0, popped.current ? (history.state?.y ?? 0) : 0);
  }, [route, ready]);

  const goBack = useCallback((fallback: Route) => {
    if ((history.state?.depth ?? 0) > 0) history.back(); else go(fallback, true);
  }, [go]);

  /* --- data --- */
  const reload = useCallback(async () => {
    const db = dbRef.current;
    if (!db) { setNodes([]); setLastSyncAt(null); return; }
    setNodes(await loadTree(db));
    setVersion((v) => v + 1);
    setLastSyncAt(((await db.get('meta', 'lastSyncAt')) as number | undefined) ?? null);
    setLastAttempt(((await db.get('meta', 'lastAttempt')) as Attempt | undefined) ?? null);
  }, []);

  // Remembered on the device, so Status still shows why the last try failed after a restart.
  const saveAttempt = useCallback(async (a: Attempt) => {
    setLastAttempt(a);
    try { if (dbRef.current) await within(dbRef.current.put('meta', a, 'lastAttempt'), LOCAL_MS, undefined); } catch { /* reading still works */ }
  }, []);

  // One path for both buttons. The popup call is the first thing that happens in the tap (Safari needs the gesture).
  // A sync always ends: every Drive request has a deadline, and the watchdog stops the run after
  // WATCHDOG_MS without progress. `busy` is cleared in `finally`, whatever happened.
  const runUpdate = useCallback(async (prompt: '' | 'consent') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setSyncSay('Bijwerken gestart.');
    const at = Date.now();
    const mine = session.current;
    const stop = new AbortController();
    stopRef.current = stop;
    const stillMine = () => { if (session.current !== mine || stop.signal.aborted) throw new SyncStoppedError(); };
    try {
      if (prompt === 'consent' || !hasValidToken()) {
        if (!googleReady()) {
          // Offline at startup, so the Google script is missing. Load it now; the popup needs a fresh tap.
          log('Google-login nog niet geladen: nu laden');
          await loadGoogleScript();
          log('Google-login geladen');
          throw new NeedTapError();
        }
        log(prompt === 'consent' ? "popup-login (prompt='consent')" : "token verlopen: popup-login (prompt='')");
        await signInPopup(prompt);
        log('popup-login ok');
      }
      stillMine();
      if (!dbRef.current) {
        const opened = await within(openVault(), LOCAL_MS, null);
        if (!opened) throw new Error('de opslag op dit toestel reageert niet; sluit de app helemaal en open hem opnieuw');
        dbRef.current = opened;
      }
      stillMine();
      const db = dbRef.current;
      log('sync gestart');
      const stats: SyncStats = await withWatchdog((signal, ping) => {
        const step = (m: string) => { ping(m); log(m); };
        const drive = createDrive(accessToken, fetch, { signal, onEvent: step, onActivity: () => ping() });
        return runSync(drive, db, step, Date.now, { signal, onActivity: () => ping() });
      }, WATCHDOG_MS, stop.signal);
      log(`sync klaar (${stats.mode === 'full' ? 'volledig' : 'incrementeel'}${stats.fullReason ? ', omdat ' + stats.fullReason : ''}) in ${(stats.durationMs / 1000).toFixed(1)} s: ${stats.md} md, ${stats.folders} mappen, ${stats.otherFiles} andere; `
        + `${stats.downloaded} gedownload, ${stats.skippedUnchanged} ongewijzigd, +${stats.added} ~${stats.modified} -${stats.removed}, ${stats.apiCalls} API-calls`
        + (stats.failedDownloads ? `, ${stats.failedDownloads} MISLUKT` : ''));
      if (stats.failedDownloads) setNotice(describeIncomplete(stats.failedDownloads));
      else setSyncSay(`Bijwerken klaar: ${stats.downloaded ? stats.downloaded + ' notities opgehaald' : 'niets nieuws'}.`);
      await saveAttempt({ at, ok: true, text: stats.failedDownloads ? describeIncomplete(stats.failedDownloads).text : '' });
      await within(reload(), LOCAL_MS, undefined);
    } catch (e: any) {
      if (e?.name === 'SyncStoppedError' || session.current !== mine) { log('sync gestopt'); setSyncSay('Bijwerken gestopt.'); return; }
      setSyncSay(''); // the notice card itself is the live message
      const n = describeSyncError(e);
      if (n.kind === 'auth') dropToken();
      setNotice(n);
      if (n.kind === 'tap') { log(n.text); return; } // not a failure: the popup just needs a fresh tap
      log('FOUT: ' + n.text + (e?.message && !n.text.includes(e.message) ? ` [${e.message}]` : ''));
      await saveAttempt({ at, ok: false, text: n.text });
    } finally {
      if (stopRef.current === stop) stopRef.current = null;
      if (session.current === mine) { busyRef.current = false; setBusy(false); }
      tick((x) => x + 1);
    }
  }, [log, reload, saveAttempt]);
  const update = useCallback(() => runUpdate(''), [runUpdate]);
  const firstLogin = useCallback(() => runUpdate('consent'), [runUpdate]);

  // Always possible, also while a sync runs or hangs: it stops that sync first (H2a, 15-11: "Uitloggen" stayed blocked).
  const logout = useCallback(async () => {
    session.current++;
    stopRef.current?.abort(new SyncStoppedError());
    stopRef.current = null;
    revokeToken(); dropToken();
    const db = dbRef.current;
    dbRef.current = null;
    setNodes([]); setLastSyncAt(null); setLastAttempt(null); setNotice(null);
    busyRef.current = false; setBusy(false);
    const wiped = await wipeAll(db);
    log(wiped ? 'uitgelogd; lokale notities en caches gewist' : 'uitgelogd; het wissen van de opslag wordt bij de volgende start afgemaakt');
    go({ kind: 'folder', id: null }, true);
  }, [go, log]);

  // startup: open IndexedDB (no token needed), ask for persistent storage, sync only if the token is still valid
  useEffect(() => {
    (async () => {
      log(`Vault versie ${__BUILD__}`);
      try {
        if (await within(finishPendingWipe(), LOCAL_MS, false)) log('wissen van een eerdere uitlog afgemaakt');
        dbRef.current = await openVault();
        const persisted = await requestPersistence();
        log(`opslag blijvend: ${persisted === null ? 'onbekend (niet ondersteund)' : persisted ? 'ja' : 'nee (kan door iOS gewist worden)'}`);
        await reload();
      } catch (e: any) { log('IndexedDB: ' + e.message); }
      setReady(true);
      loadGoogleScript().catch((e) => log(e.message));
      addEventListener('online', () => { if (!googleReady()) loadGoogleScript().then(() => log('weer online: Google-login geladen'), () => {}); });
      if (hasValidToken()) { log('bestaand token gebruikt'); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startedSync = useRef(false);
  useEffect(() => {
    if (ready && !startedSync.current && hasValidToken()) { startedSync.current = true; update(); }
  }, [ready, update]);

  /* --- top bar: back button + hide on scroll down, show on a short scroll up --- */
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY, acc = 0;
    const onScroll = () => {
      const y = window.scrollY, dy = y - last; last = y;
      if (y < 60) { acc = 0; setBarHidden(false); return; }
      if ((dy > 0) !== (acc > 0)) acc = 0; // direction changed
      acc += dy;
      if (acc > 12) setBarHidden(true);
      else if (acc < -24) setBarHidden(false);
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { setBarHidden(false); }, [route]);

  // The bar may wrap to more rows at large text sizes (R2-14); the page padding follows its real height.
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--bar-real', el.offsetHeight + 'px'));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* --- rendering --- */
  const hasData = nodes.length > 0;
  const expired = !hasValidToken();
  const rootRoute: Route = { kind: 'folder', id: null };
  let screen: ReactNode;
  if (!ready) screen = <p className="sub">Laden…</p>;
  else if (route.kind === 'sync') {
    screen = <SyncView nodes={nodes} lastSyncAt={lastSyncAt} lastAttempt={lastAttempt} busy={busy} lines={lines} update={update} login={firstLogin} logout={logout} />;
  } else if (!hasData) {
    screen = (
      <section>
        <h1>Vault</h1>
        <p className="sub">Nog geen notities op dit toestel. Log eenmalig in met Google om Life OS binnen te halen; daarna lees je ook zonder internet.</p>
        <button className="btn" onClick={hasValidToken() ? update : firstLogin} disabled={busy}>{busy ? 'Bezig…' : hasValidToken() ? 'Bijwerken' : 'Inloggen met Google'}</button>
        {lines.length > 0 && <pre className="log">{lines.slice(-6).join('\n')}</pre>}
      </section>
    );
  } else if (route.kind === 'note') {
    const n = byId.get(route.id);
    screen = n && n.isMd
      ? <NoteView key={n.id} node={n} version={version} heading={route.heading} db={dbRef} index={index} byId={byId} go={go} goBack={goBack} onRendered={applyFocus} />
      : <Missing go={go} what="Deze notitie" />;
  } else {
    const folder = route.id ? byId.get(route.id) : rootNode;
    screen = folder && folder.isFolder
      ? <FolderView key={folder.id} folder={folder} isRoot={folder === rootNode} kids={children.get(folder.id) ?? []} byId={byId} mdCount={mdCount} version={version} db={dbRef} go={go} goBack={goBack} />
      : <Missing go={go} what="Deze map" />;
  }

  const shownNode = route.kind === 'note' || route.kind === 'folder' ? (route.id ? byId.get(route.id) : undefined) : undefined;
  const showBack = ready && (route.kind === 'sync' || (!!shownNode && shownNode !== rootNode));
  const backTo: Route = shownNode?.parent && byId.get(shownNode.parent)?.parent ? { kind: 'folder', id: shownNode.parent } : rootRoute;

  // Page title per screen, and a polite announcement after a route change (R2-12/13).
  const title = !ready ? 'Vault' : screenTitle(route, route.kind === 'sync' ? undefined : route.id ? byId.get(route.id) : rootNode ?? undefined, hasData);
  const [routeSay, setRouteSay] = useState('');
  const firstTitle = useRef(true);
  useEffect(() => {
    document.title = title;
    if (firstTitle.current) { firstTitle.current = false; return; }
    setRouteSay(title.replace(/ – Vault$/, '') + ' geopend');
  }, [title]);

  return (
    <div className="app">
      {/* Focus inside the hidden bar brings it back (keyboard, VoiceOver); touch scrolling is unchanged (R2-12). */}
      <header className={'topbar' + (barHidden ? ' hidden' : '')} onFocus={() => setBarHidden(false)}>
        <div className="in" ref={barRef}>
        {showBack
          ? <BackButton onClick={() => goBack(backTo)} />
          : <button className="chip" onClick={() => go(rootRoute)} aria-label="Naar het begin">Vault</button>}
        <span className="sp" />
        {hasData && <button className="chip accent" onClick={update} disabled={busy} aria-label="Bijwerken vanuit Google Drive">{busy ? 'Bezig…' : expired ? 'Bijwerken ⟳' : 'Bijwerken'}</button>}
        <button className="chip" onClick={() => go({ kind: 'sync' })} aria-label="Sync-status en log">Status</button>
        </div>
      </header>
      <main id="main">
        {notice && ready && <Notice notice={notice} busy={busy} retry={update} dismiss={() => setNotice(null)} />}
        {screen}
      </main>
      <div className="sr" aria-live="polite" aria-atomic="true">{routeSay}</div>
      <div className="sr" role="status" aria-atomic="true">{syncSay}</div>
    </div>
  );
}

interface Attempt { at: number; ok: boolean; text: string }

/** Shown above every screen after a failed or incomplete sync, with a way to try again. */
function Notice({ notice, busy, retry, dismiss }: { notice: SyncNotice; busy: boolean; retry: () => void; dismiss: () => void }) {
  const title = notice.kind === 'info' ? 'Bijwerken onvolledig.' : notice.kind === 'tap' ? 'Bijna klaar.' : 'Bijwerken mislukt.';
  return (
    <div className={'notice ' + notice.kind} role={notice.kind === 'info' || notice.kind === 'tap' ? 'status' : 'alert'}>
      <p><b>{title}</b> {notice.text}</p>
      <button className="btn" onClick={retry} disabled={busy}>{busy ? 'Bezig…' : notice.kind === 'auth' || notice.kind === 'tap' ? 'Inloggen' : 'Opnieuw proberen'}</button>
      <button className="btn secondary" onClick={dismiss}>Sluiten</button>
    </div>
  );
}

function Missing({ go, what }: { go: (r: Route, replace?: boolean) => void; what: string }) {
  return (
    <section>
      <h1>Niet gevonden</h1>
      <p className="sub">{what} staat niet (meer) op dit toestel. Misschien is het verplaatst of verwijderd; tik op Bijwerken.</p>
      <button className="btn" onClick={() => go({ kind: 'folder', id: null }, true)}>Naar het begin</button>
    </section>
  );
}

/* ---------------- breadcrumbs ---------------- */

function Crumbs({ node, byId, go }: { node: TreeNode; byId: Map<string, TreeNode>; go: (r: Route) => void }) {
  const chain: TreeNode[] = [];
  for (let p = node.parent ? byId.get(node.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) chain.unshift(p);
  if (!chain.length) return null;
  return (
    <nav className="path" aria-label="Pad">
      {chain.map((c, i) => (
        <span key={c.id}>
          {i > 0 && <span className="sep" aria-hidden="true">/</span>}
          <a href={urlFor({ kind: 'folder', id: c.parent ? c.id : null })}
            onClick={(e) => { e.preventDefault(); go({ kind: 'folder', id: c.parent ? c.id : null }); }}>{c.parent ? c.name : 'Life OS'}</a>
        </span>
      ))}
    </nav>
  );
}

/* ---------------- folder ---------------- */

interface FolderProps {
  folder: TreeNode; isRoot: boolean; kids: TreeNode[]; byId: Map<string, TreeNode>; mdCount: Map<string, number>; version: number;
  db: { current: IDBPDatabase | null }; go: (r: Route, replace?: boolean) => void; goBack: (fallback: Route) => void;
}

function FolderView({ folder, isRoot, kids, byId, mdCount, version, db, go, goBack }: FolderProps) {
  const { folders, notes, others } = useMemo(() => listFolder(kids), [kids]);
  const cards = isRoot || folders.length + notes.length <= CARD_LIMIT;
  const parentRoute: Route = { kind: 'folder', id: folder.parent && byId.get(folder.parent)?.parent ? folder.parent : null };
  const title = isRoot ? 'Life OS' : splitPrefix(folder.name).label;
  const open = (n: TreeNode) => go(n.isFolder ? { kind: 'folder', id: n.id } : { kind: 'note', id: n.id, heading: null });
  return (
    <section className="A">
      {!isRoot && <Crumbs node={folder} byId={byId} go={go} />}
      <h1>{title}</h1>
      <p className="sub">{folders.length} {folders.length === 1 ? 'map' : 'mappen'} · {notes.length} {notes.length === 1 ? 'notitie' : 'notities'}{others.length ? ` · ${others.length} andere` : ''}</p>
      {cards ? (
        <div>
          {folders.map((f) => <FolderCard key={f.id} f={f} count={mdCount.get(f.id) ?? 0} open={open} />)}
          {notes.map((n) => <NoteCard key={n.id} n={n} version={version} db={db} open={open} />)}
        </div>
      ) : (
        <div className="list">
          {folders.map((f) => (
            <a key={f.id} data-id={f.id} className="crow" href={urlFor({ kind: 'folder', id: f.id })} onClick={(e) => { e.preventDefault(); open(f); }}>
              <span className="ct"><FolderIcon /> {f.name}</span><span className="cm">{mdCount.get(f.id) ?? 0}</span>
            </a>
          ))}
          {notes.map((n) => (
            <a key={n.id} data-id={n.id} className="crow" href={urlFor({ kind: 'note', id: n.id, heading: null })} onClick={(e) => { e.preventDefault(); open(n); }}>
              <span className="ct">{noteTitle(n)}</span><span className="cm">{fmtDate(n.modifiedTime)}</span>
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <details className="others">
          <summary>Andere bestanden ({others.length}) — openen in Drive</summary>
          <div className="list">
            {others.map((o) => (
              <a key={o.id} className="crow" href={driveUrl(o.id)} target="_blank" rel="noopener noreferrer">
                <span className="ct">{o.name}</span><span className="cm">Drive ↗</span>
              </a>
            ))}
          </div>
        </details>
      )}
      {kids.length === 0 && <p className="sub">Lege map.</p>}
    </section>
  );
}

function FolderCard({ f, count, open }: { f: TreeNode; count: number; open: (n: TreeNode) => void }) {
  const { prefix, label } = splitPrefix(f.name);
  return (
    <a className="row" data-id={f.id} href={urlFor({ kind: 'folder', id: f.id })} onClick={(e) => { e.preventDefault(); open(f); }}>
      <Tile prefix={prefix ?? '·'} />
      <div><div className="rt">{label}</div><div className="rm">{count} {count === 1 ? 'notitie' : 'notities'}</div></div>
    </a>
  );
}

function NoteCard({ n, version, db, open }: { n: TreeNode; version: number; db: { current: IDBPDatabase | null }; open: (n: TreeNode) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    if (db.current) loadContent(db.current, n.id).then((c) => { if (alive) setText(c ? previewOf(c.text) : ''); });
    return () => { alive = false; };
  }, [n.id, version, db]);
  return (
    <a className="row" data-id={n.id} href={urlFor({ kind: 'note', id: n.id, heading: null })} onClick={(e) => { e.preventDefault(); open(n); }}>
      <Tile iso={n.modifiedTime} />
      <div><div className="rt">{noteTitle(n)}</div><div className="rm">{fmtDate(n.modifiedTime)}</div>{text && <div className="rx">{text}</div>}</div>
    </a>
  );
}

/* ---------------- note ---------------- */

interface NoteProps {
  node: TreeNode; version: number; heading: string | null; db: { current: IDBPDatabase | null }; index: ReturnType<typeof buildLinkIndex>;
  byId: Map<string, TreeNode>; go: (r: Route, replace?: boolean) => void; goBack: (fallback: Route) => void; onRendered: () => void;
}

/** 'smooth' unless the system asks for reduced motion, like the CSS does (R2-15). */
const scrollBehavior = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

function NoteView({ node, version, heading, db, index, byId, go, goBack, onRendered }: NoteProps) {
  // undefined = loading, null = not downloaded. Re-read on every new data version, so an open note shows
  // the synced text; the date shown is the date of that text, not of the newest tree entry (R2-1).
  const [rec, setRec] = useState<ContentRecord | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = db.current ? await loadContent(db.current, node.id) : undefined;
      if (alive) setRec(c ?? null);
    })();
    return () => { alive = false; };
  }, [node.id, version, db]);
  const text = rec === undefined ? undefined : rec === null ? null : rec.text;
  const behind = !!rec && (node.md5Checksum ? rec.md5Checksum !== node.md5Checksum : rec.modifiedTime !== node.modifiedTime);

  const parsed = useMemo(() => {
    if (text == null) return null;
    const { front, body } = splitFrontmatter(text);
    const html = renderMarkdown(body, { fromPath: node.path, index });
    return { front, html, hasH1: /^\s*#\s/.test(body) };
  }, [text, node.path, index]);

  const articleRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (rec === undefined) return;
    onRendered(); // the heading exists now, so a pending focus can land (R2-12)
    if (!parsed) return;
    if (heading) document.getElementById(heading)?.scrollIntoView();
    else if (history.state?.y !== undefined && window.scrollY === 0) window.scrollTo(0, history.state.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, heading, rec === undefined]);

  const parent = node.parent ? byId.get(node.parent) : undefined;
  const parentRoute: Route = { kind: 'folder', id: parent && parent.parent ? parent.id : null };

  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    if (a.classList.contains('broken')) { e.preventDefault(); return; }
    const anchor = a.getAttribute('data-anchor');
    if (anchor !== null) { e.preventDefault(); document.getElementById(anchor)?.scrollIntoView({ behavior: scrollBehavior() }); return; }
    if (a.hasAttribute('data-nav')) {
      e.preventDefault();
      const u = new URL(a.getAttribute('href')!, location.origin);
      go(parseRoute(u.pathname, u.hash));
    }
  }

  return (
    <section className="A">
      <Crumbs node={node} byId={byId} go={go} />
      <article className="note" ref={articleRef} onClick={onClick}>
        {/* own title only once we know the note has no H1 of its own, so focus never lands on a heading that disappears */}
        {(parsed ? !parsed.hasH1 : text === null) && <h1>{noteTitle(node)}</h1>}
        <p className="meta">Gewijzigd {fmtDate(rec?.modifiedTime || node.modifiedTime)}</p>
        {behind && <p className="sub">Er staat een nieuwere versie in Google Drive die nog niet is opgehaald. Tik op Bijwerken.</p>}
        {parsed?.front && (
          <details className="fm"><summary><span>Frontmatter</span></summary><pre>{parsed.front}</pre></details>
        )}
        {text === undefined && <p className="sub">Laden…</p>}
        {text === null && <p className="sub">Deze notitie is nog niet gedownload. Tik op Bijwerken (internet en een token nodig).</p>}
        {parsed && <div className="md" dangerouslySetInnerHTML={{ __html: parsed.html }} />}
      </article>
    </section>
  );
}

/* ---------------- sync / status ---------------- */

interface SyncProps {
  nodes: TreeNode[]; lastSyncAt: number | null; lastAttempt: Attempt | null; busy: boolean; lines: string[];
  update: () => void; login: () => void; logout: () => void;
}

function SyncView({ nodes, lastSyncAt, lastAttempt, busy, lines, update, login, logout }: SyncProps) {
  const standalone = (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
  const tok = getToken();
  const left = tok ? Math.round((tok.expires_at - Date.now()) / 60000) : 0;
  const root = nodes.find((n) => n.parent === null && n.isFolder);
  const sum = root ? summarize(new Map(nodes.map((n) => [n.id, n])), root.id) : null;
  return (
    <section>
      <h1>Status</h1>
      <p className="sub">Modus: {standalone ? 'beginscherm (standalone)' : 'browser'} · {navigator.onLine ? 'online' : 'offline'}</p>
      {sum && <p className="big">{sum.md}<small> notities lokaal</small></p>}
      <p className="sub">
        {hasValidToken() ? `Ingelogd, token nog ±${left} min geldig.` : tok ? 'Token verlopen. Lezen kan nog; tik op Bijwerken om te vernieuwen.' : nodes.length ? 'Geen geldig token. Lezen kan nog; tik op Bijwerken.' : 'Niet ingelogd.'}
        {lastSyncAt ? ` Laatst bijgewerkt ${new Date(lastSyncAt).toLocaleString('nl-NL')}.` : ''}
      </p>
      {lastAttempt && !lastAttempt.ok && (
        <p className="sub">Laatste poging {new Date(lastAttempt.at).toLocaleString('nl-NL')} mislukt: {lastAttempt.text}</p>
      )}
      {nodes.length ? <button className="btn" onClick={update} disabled={busy}>{busy ? 'Bezig…' : 'Bijwerken'}</button> : <button className="btn" onClick={login} disabled={busy}>Inloggen met Google</button>}
      {nodes.length > 0 && <button className="btn secondary" onClick={logout}>Uitloggen</button>}
      <p className="sub">Versie {__BUILD__}</p>
      <pre className="log">{lines.join('\n') || '(nog geen log)'}</pre>
    </section>
  );
}
