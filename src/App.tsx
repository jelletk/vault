// Vault, package 3: read screens (folders, notes) on top of the package 2 sync layer.
// Reading never needs a token: everything opens from IndexedDB. A token is only for "Bijwerken".
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { IDBPDatabase } from 'idb';
import { accessToken, dropToken, getToken, hasValidToken, loadGoogleScript, revokeToken, signInPopup } from './auth';
import { createDrive } from './sync/drive';
import { loadContent, loadTree, openVault, requestPersistence, wipeAll } from './sync/db';
import { runSync } from './sync/sync';
import { buildLinkIndex } from './sync/links';
import { summarize } from './sync/paths';
import type { SyncStats, TreeNode } from './sync/types';
import { driveUrl, listFolder, noteTitle, parseRoute, splitPrefix, urlFor, type Route } from './nav';
import { previewOf, renderMarkdown, splitFrontmatter } from './markdown';

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

/** Floating at the bottom, so "Terug" is reachable at any scroll position, also at the end of a long note. */
function BackButton({ onClick }: { onClick: () => void }) {
  return <button className="back" onClick={onClick}><i><Back /></i>Terug</button>;
}

/* ---------------- app ---------------- */

export function App() {
  const dbRef = useRef<IDBPDatabase | null>(null);
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
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
  const go = useCallback((r: Route, replace = false) => {
    const depth = (history.state?.depth ?? 0) + (replace ? 0 : 1);
    if (!replace) history.replaceState({ ...history.state, y: window.scrollY }, '');
    (replace ? history.replaceState : history.pushState).call(history, { depth }, '', urlFor(r));
    popped.current = false;
    setRoute(r);
  }, []);

  useEffect(() => {
    const onPop = () => { popped.current = true; setRoute(parseRoute(location.pathname, location.hash)); };
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
    setLastSyncAt(((await db.get('meta', 'lastSyncAt')) as number | undefined) ?? null);
  }, []);

  // One path for both buttons. The popup call is the first thing that happens in the tap (Safari needs the gesture).
  const runUpdate = useCallback(async (prompt: '' | 'consent') => {
    if (busy) return;
    setBusy(true);
    try {
      if (prompt === 'consent' || !hasValidToken()) {
        log(prompt === 'consent' ? "popup-login (prompt='consent')" : "token verlopen: popup-login (prompt='')");
        await signInPopup(prompt);
        log('popup-login ok');
      }
      if (!dbRef.current) dbRef.current = await openVault();
      const stats: SyncStats = await runSync(createDrive(accessToken), dbRef.current, (m) => log(m));
      log(`sync klaar (${stats.mode}) in ${(stats.durationMs / 1000).toFixed(1)} s: ${stats.md} md, ${stats.folders} mappen, ${stats.otherFiles} andere; `
        + `${stats.downloaded} gedownload, ${stats.skippedUnchanged} ongewijzigd, +${stats.added} ~${stats.modified} -${stats.removed}, ${stats.apiCalls} API-calls`
        + (stats.failedDownloads ? `, ${stats.failedDownloads} MISLUKT` : ''));
      await reload();
    } catch (e: any) {
      if (e?.name === 'AuthError') { dropToken(); log('token verlopen of afgewezen; opgeslagen notities blijven leesbaar. Tik op Bijwerken.'); }
      else log('FOUT: ' + (e?.message ?? e));
    } finally { setBusy(false); tick((x) => x + 1); }
  }, [busy, log, reload]);
  const update = useCallback(() => runUpdate(''), [runUpdate]);
  const firstLogin = useCallback(() => runUpdate('consent'), [runUpdate]);

  const logout = useCallback(async () => {
    if (busy) return;
    revokeToken(); dropToken();
    await wipeAll(dbRef.current);
    dbRef.current = null;
    setNodes([]); setLastSyncAt(null);
    log('uitgelogd; lokale notities en caches gewist');
    go({ kind: 'folder', id: null }, true);
  }, [busy, go, log]);

  // startup: open IndexedDB (no token needed), ask for persistent storage, sync only if the token is still valid
  useEffect(() => {
    (async () => {
      try {
        dbRef.current = await openVault();
        const persisted = await requestPersistence();
        log(`opslag blijvend: ${persisted === null ? 'onbekend (niet ondersteund)' : persisted ? 'ja' : 'nee (kan door iOS gewist worden)'}`);
        await reload();
      } catch (e: any) { log('IndexedDB: ' + e.message); }
      setReady(true);
      loadGoogleScript().catch((e) => log(e.message));
      if (hasValidToken()) { log('bestaand token gebruikt'); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startedSync = useRef(false);
  useEffect(() => {
    if (ready && !startedSync.current && hasValidToken()) { startedSync.current = true; update(); }
  }, [ready, update]);

  /* --- rendering --- */
  const hasData = nodes.length > 0;
  const expired = !hasValidToken();
  const rootRoute: Route = { kind: 'folder', id: null };
  let screen: ReactNode;
  if (!ready) screen = <p className="sub">Laden…</p>;
  else if (route.kind === 'sync') {
    screen = <SyncView nodes={nodes} lastSyncAt={lastSyncAt} busy={busy} lines={lines} update={update} login={firstLogin} logout={logout} />;
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
      ? <NoteView key={n.id} node={n} heading={route.heading} db={dbRef} index={index} byId={byId} go={go} goBack={goBack} />
      : <Missing go={go} what="Deze notitie" />;
  } else {
    const folder = route.id ? byId.get(route.id) : rootNode;
    screen = folder && folder.isFolder
      ? <FolderView key={folder.id} folder={folder} isRoot={folder === rootNode} kids={children.get(folder.id) ?? []} byId={byId} mdCount={mdCount} db={dbRef} go={go} goBack={goBack} />
      : <Missing go={go} what="Deze map" />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="chip" onClick={() => go(rootRoute)} aria-label="Naar het begin">Vault</button>
        <span className="sp" />
        {hasData && <button className="chip accent" onClick={update} disabled={busy} aria-label="Bijwerken vanuit Google Drive">{busy ? 'Bezig…' : expired ? 'Bijwerken ⟳' : 'Bijwerken'}</button>}
        <button className="chip" onClick={() => go({ kind: 'sync' })} aria-label="Sync-status en log">Status</button>
      </header>
      {screen}
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
          {i > 0 && ' / '}
          <a href={urlFor({ kind: 'folder', id: c.parent ? c.id : null })}
            onClick={(e) => { e.preventDefault(); go({ kind: 'folder', id: c.parent ? c.id : null }); }}>{c.parent ? c.name : 'Life OS'}</a>
        </span>
      ))}
    </nav>
  );
}

/* ---------------- folder ---------------- */

interface FolderProps {
  folder: TreeNode; isRoot: boolean; kids: TreeNode[]; byId: Map<string, TreeNode>; mdCount: Map<string, number>;
  db: { current: IDBPDatabase | null }; go: (r: Route, replace?: boolean) => void; goBack: (fallback: Route) => void;
}

function FolderView({ folder, isRoot, kids, byId, mdCount, db, go, goBack }: FolderProps) {
  const { folders, notes, others } = useMemo(() => listFolder(kids), [kids]);
  const cards = isRoot || folders.length + notes.length <= CARD_LIMIT;
  const parentRoute: Route = { kind: 'folder', id: folder.parent && byId.get(folder.parent)?.parent ? folder.parent : null };
  const title = isRoot ? 'Life OS' : splitPrefix(folder.name).label;
  const open = (n: TreeNode) => go(n.isFolder ? { kind: 'folder', id: n.id } : { kind: 'note', id: n.id, heading: null });
  return (
    <section className="A">
      {!isRoot && <BackButton onClick={() => goBack(parentRoute)} />}
      {!isRoot && <Crumbs node={folder} byId={byId} go={go} />}
      <h1>{title}</h1>
      <p className="sub">{folders.length} {folders.length === 1 ? 'map' : 'mappen'} · {notes.length} {notes.length === 1 ? 'notitie' : 'notities'}{others.length ? ` · ${others.length} andere` : ''}</p>
      {cards ? (
        <div>
          {folders.map((f) => <FolderCard key={f.id} f={f} count={mdCount.get(f.id) ?? 0} open={open} />)}
          {notes.map((n) => <NoteCard key={n.id} n={n} db={db} open={open} />)}
        </div>
      ) : (
        <div className="list">
          {folders.map((f) => (
            <a key={f.id} className="crow" href={urlFor({ kind: 'folder', id: f.id })} onClick={(e) => { e.preventDefault(); open(f); }}>
              <span className="ct"><FolderIcon /> {f.name}</span><span className="cm">{mdCount.get(f.id) ?? 0}</span>
            </a>
          ))}
          {notes.map((n) => (
            <a key={n.id} className="crow" href={urlFor({ kind: 'note', id: n.id, heading: null })} onClick={(e) => { e.preventDefault(); open(n); }}>
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
    <a className="row" href={urlFor({ kind: 'folder', id: f.id })} onClick={(e) => { e.preventDefault(); open(f); }}>
      <Tile prefix={prefix ?? '·'} />
      <div><div className="rt">{label}</div><div className="rm">{count} {count === 1 ? 'notitie' : 'notities'}</div></div>
    </a>
  );
}

function NoteCard({ n, db, open }: { n: TreeNode; db: { current: IDBPDatabase | null }; open: (n: TreeNode) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    if (db.current) loadContent(db.current, n.id).then((c) => { if (alive && c) setText(previewOf(c.text)); });
    return () => { alive = false; };
  }, [n.id, db]);
  return (
    <a className="row" href={urlFor({ kind: 'note', id: n.id, heading: null })} onClick={(e) => { e.preventDefault(); open(n); }}>
      <Tile iso={n.modifiedTime} />
      <div><div className="rt">{noteTitle(n)}</div><div className="rm">{fmtDate(n.modifiedTime)}</div>{text && <div className="rx">{text}</div>}</div>
    </a>
  );
}

/* ---------------- note ---------------- */

interface NoteProps {
  node: TreeNode; heading: string | null; db: { current: IDBPDatabase | null }; index: ReturnType<typeof buildLinkIndex>;
  byId: Map<string, TreeNode>; go: (r: Route, replace?: boolean) => void; goBack: (fallback: Route) => void;
}

function NoteView({ node, heading, db, index, byId, go, goBack }: NoteProps) {
  const [text, setText] = useState<string | null | undefined>(undefined); // undefined = loading, null = not downloaded
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = db.current ? await loadContent(db.current, node.id) : undefined;
      if (alive) setText(c ? c.text : null);
    })();
    return () => { alive = false; };
  }, [node.id, db]);

  const parsed = useMemo(() => {
    if (text == null) return null;
    const { front, body } = splitFrontmatter(text);
    const html = renderMarkdown(body, { fromPath: node.path, index });
    return { front, html, hasH1: /^\s*#\s/.test(body) };
  }, [text, node.path, index]);

  const articleRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!parsed) return;
    if (heading) document.getElementById(heading)?.scrollIntoView();
    else if (history.state?.y !== undefined && window.scrollY === 0) window.scrollTo(0, history.state.y);
  }, [parsed, heading]);

  const parent = node.parent ? byId.get(node.parent) : undefined;
  const parentRoute: Route = { kind: 'folder', id: parent && parent.parent ? parent.id : null };

  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    if (a.classList.contains('broken')) { e.preventDefault(); return; }
    const anchor = a.getAttribute('data-anchor');
    if (anchor !== null) { e.preventDefault(); document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }); return; }
    if (a.hasAttribute('data-nav')) {
      e.preventDefault();
      const u = new URL(a.getAttribute('href')!, location.origin);
      go(parseRoute(u.pathname, u.hash));
    }
  }

  return (
    <section className="A">
      <BackButton onClick={() => goBack(parentRoute)} />
      <Crumbs node={node} byId={byId} go={go} />
      <article className="note" ref={articleRef} onClick={onClick}>
        {!parsed?.hasH1 && <h1>{noteTitle(node)}</h1>}
        <p className="meta">Gewijzigd {fmtDate(node.modifiedTime)}</p>
        {parsed?.front && (
          <details className="fm"><summary>Frontmatter</summary><pre>{parsed.front}</pre></details>
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
  nodes: TreeNode[]; lastSyncAt: number | null; busy: boolean; lines: string[];
  update: () => void; login: () => void; logout: () => void;
}

function SyncView({ nodes, lastSyncAt, busy, lines, update, login, logout }: SyncProps) {
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
      {nodes.length ? <button className="btn" onClick={update} disabled={busy}>{busy ? 'Bezig…' : 'Bijwerken'}</button> : <button className="btn" onClick={login} disabled={busy}>Inloggen met Google</button>}
      {nodes.length > 0 && <button className="btn secondary" onClick={logout} disabled={busy}>Uitloggen</button>}
      <pre className="log">{lines.join('\n') || '(nog geen log)'}</pre>
    </section>
  );
}
