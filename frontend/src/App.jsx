import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  AudioLines, BookOpenText, Check, CircleHelp,
  Download, Ellipsis, FileDown, FileText, Menu, Mic,
  Moon, Pause, Pin, Play, Plus, Search, Share2, Sparkles,
  Square, Sun, Trash2, X, Pencil
} from 'lucide-react';
import { api } from './api';
import { db, downloadLocalAudio } from './db';
import { LectureRecorder } from './recorder';
import RenameModal from './RenameModal';

const fmt = (seconds = 0) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function stripRepeatedTitle(markdown, title) {
  const source = (markdown || '').trimStart();
  const match = source.match(/^#{1,3}\s+(.+?)\s*(?:\r?\n|$)/);
  const normalize = text => (text || '').replace(/[\*_`]/g, '').trim().toLocaleLowerCase();
  return match && normalize(match[1]) === normalize(title)
    ? source.slice(match[0].length).trimStart()
    : source;
}
const shownDate = str => new Date(str).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function IconButton({ title, onClick, disabled, children, className = '' }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`icon-button ${className}`}>{children}</button>;
}

function PublicLecture() {
  const [lecture, setLecture] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const token = location.pathname.split('/share/')[1] || '';
    api(`/public/${encodeURIComponent(token)}`).then(setLecture).catch(e => setError(e.message));
  }, []);
  return <div className="public-page">
    <div className="public-top"><AudioLines size={23} /> <strong>LectureFlow AI</strong><span>Shared lecture · View only</span></div>
    <article className="public-paper">
      {error ? <div className="error-box">{error}</div> : !lecture ? <p>Loading shared lecture...</p> : <>
        <p className="eyebrow">LECTURE NOTES · {shownDate(lecture.createdAt)}</p>
        <h1>{lecture.title}</h1>
        <div className="markdown-body"><ReactMarkdown>{stripRepeatedTitle(lecture.notesMarkdown, lecture.title) || lecture.transcript?.map(s => s.text).join('\n\n') || 'No notes yet.'}</ReactMarkdown></div>
        <div className="viewer-note">This page is read-only. Audio is stored on the recording device and is never shared.</div>
      </>}
    </article>
  </div>;
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('lf_theme') || 'dark');
  const [mobileNav, setMobileNav] = useState(false);
  const [list, setList] = useState([]);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [lecture, setLecture] = useState(null);
  const [tab, setTab] = useState('transcript');
  const [recordState, setRecordState] = useState('idle');
  const [liveStatus, setLiveStatus] = useState('Ready');
  const [interim, setInterim] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [audioCount, setAudioCount] = useState(0);
  const [renameTarget, setRenameTarget] = useState(null);
  const [gapWarning, setGapWarning] = useState('');
  const recorderRef = useRef(null);
  const currentIdRef = useRef(null);
  currentIdRef.current = activeId;
  const secondsRef = useRef(0);
  const flushPromiseRef = useRef(null);
  const recordingRef = useRef('idle');
  const publicView = location.pathname.startsWith('/share/');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('lf_theme', theme);
  }, [theme]);
  const alertError = e => setError(e?.message || String(e));

  const loadList = useCallback(async (q = '') => {
    const docs = await api(`/lectures${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setList(docs);
  }, []);

  useEffect(() => {
    if (publicView) return;
    const timer = setTimeout(() => loadList(query).catch(alertError), 260);
    return () => clearTimeout(timer);
  }, [query, loadList, publicView]);

  useEffect(() => {
    if (publicView || !activeId) return;
    let cancelled = false;
    api(`/lectures/${activeId}`).then(doc => {
      if (!cancelled && recordingRef.current === 'idle') {
        setLecture(doc); setDraft(doc.notesMarkdown || '');
        setSeconds(doc.durationSeconds || 0);
        secondsRef.current = doc.durationSeconds || 0;
      }
    }).catch(alertError);
    db.audioChunks.where('lectureId').equals(activeId).count().then(count => {
      if (!cancelled) setAudioCount(count);
    });
    return () => { cancelled = true; };
  }, [activeId, publicView]);

  useEffect(() => {
    if (recordState !== 'recording') return;
    const timer = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [recordState]);

  const flushPending = useCallback(async () => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    const sendQueued = async () => {
      const pending = await db.pendingSegments.toArray();
      for (const item of pending) {
        try {
          await api(`/lectures/${item.lectureId}/segments`, { method: 'POST', body: item.segment });
          await db.pendingSegments.delete(item.id);
        } catch {
          // Preserve the local queue; retry on the next interval or online event.
          break;
        }
      }
    };
    flushPromiseRef.current = sendQueued();
    try { await flushPromiseRef.current; }
    finally { flushPromiseRef.current = null; }
  }, []);
  useEffect(() => {
    if (publicView) return;
    flushPending();
    const t = setInterval(flushPending, 10000);
    window.addEventListener('online', flushPending);
    return () => { clearInterval(t); window.removeEventListener('online', flushPending); };
  }, [publicView, flushPending]);

  function selectLecture(id) {
    if (recordingRef.current !== 'idle' || busy) return;
    setActiveId(id); setMobileNav(false); setInterim(''); setError(''); setEditing(false);
    setLecture(null); setTab('transcript');
  }
  async function createLecture() {
    if (recordingRef.current !== 'idle' || busy) return;
    try {
      const doc = await api('/lectures', { method: 'POST' });
      setList(prev => [doc, ...prev]);
      setLecture(doc); setActiveId(doc._id); setTab('transcript'); setInterim('');
      setMobileNav(false); setError(''); setSeconds(0); secondsRef.current = 0;
      setAudioCount(0);
    } catch (e) { alertError(e); }
  }
  async function patch(changes) {
    if (!lecture) return;
    const doc = await api(`/lectures/${lecture._id}`, { method: 'PATCH', body: changes });
    setLecture(doc); await loadList(query);
    return doc;
  }
  function rename(id, oldTitle) {
    if (recordingRef.current !== 'idle') return;
    setRenameTarget({ id, title: oldTitle });
  }
  async function saveRename(id, title) {
    try {
      const updated = await api(`/lectures/${id}`, { method: 'PATCH', body: { title } });
      if (id === activeId) setLecture(updated);
      await loadList(query);
    } catch (e) { alertError(e); throw e; }
  }
  async function togglePin(id, pinned) {
    try {
      const updated = await api(`/lectures/${id}`, { method: 'PATCH', body: { pinned: !pinned } });
      if (id === activeId) setLecture(updated);
      await loadList(query);
    } catch (e) { alertError(e); }
  }
  async function deleteLecture(id, title) {
    if (recordingRef.current !== 'idle') return;
    if (!confirm(`Permanently delete "${title}"? Its local audio on this browser will also be deleted.`)) return;
    try {
      await api(`/lectures/${id}`, { method: 'DELETE' });
      await Promise.all([
        db.audioChunks.where('lectureId').equals(id).delete(),
        db.pendingSegments.where('lectureId').equals(id).delete()
      ]);
      if (activeId === id) { setActiveId(null); setLecture(null); }
      await loadList(query);
    } catch (e) { alertError(e); }
  }
  async function shareLecture(id = lecture?._id, title = lecture?.title) {
    try {
      const { token } = await api(`/lectures/${id}/share`, { method: 'POST' });
      const url = `${location.origin}/share/${token}`;
      if (navigator.share) await navigator.share({ title, url });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(url); alert('Read-only sharing link copied.'); }
      else prompt('Copy this read-only link:', url);
      await loadList(query);
    } catch (e) { if (e.name !== 'AbortError') alertError(e); }
  }
  // Called automatically after Stop. Can also retry when the AI request failed.
  async function organizeNotes(lectureId = lecture?._id) {
    if (!lectureId || recordingRef.current !== 'idle') return;
    setBusy(true);
    setTab('notes');
    setError('');
    try {
      await flushPending();
      const unsaved = await db.pendingSegments.where('lectureId').equals(lectureId).count();
      if (unsaved) {
        throw new Error('Notes not generated yet: some transcript sentences are waiting to sync. Reconnect and press Retry notes.');
      }
      const doc = await api(`/lectures/${lectureId}/organize`, { method: 'POST' });
      if (currentIdRef.current === lectureId) {
        setLecture(doc);
        setDraft(doc.notesMarkdown);
      }
      await loadList(query);
      return doc;
    } catch (e) {
      alertError(e);
      setLecture(previous => previous?._id === lectureId ? { ...previous, notesStatus: 'failed' } : previous);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    if (!lecture || recordingRef.current !== 'idle' || busy) return;
    setError(''); setInterim(''); setGapWarning(''); setTab('transcript');
    const rec = new LectureRecorder(lecture._id, {
      interim: setInterim,
      status: setLiveStatus,
      error: setError,
      gap: setGapWarning,
      final: async text => {
        const segment = { id: crypto.randomUUID(), text, seconds: secondsRef.current };
        setLecture(prev => prev?._id === lecture._id ?
          { ...prev, transcript: [...(prev.transcript || []), segment] } : prev);
        try {
          await db.pendingSegments.put({ id: segment.id, lectureId: lecture._id, segment });
          await flushPending();
        } catch (e) { alertError(e); }
      }
    });
    recorderRef.current = rec;
    recordingRef.current = 'starting';
    setRecordState('starting');
    try {
      await rec.start();
      if (recordingRef.current === 'starting') {
        recordingRef.current = 'recording';
        setRecordState('recording');
      }
    }
    catch (e) {
      recordingRef.current = 'idle'; setRecordState('idle');
      recorderRef.current = null; alertError(e);
    }
  }
  function togglePause() {
    if (!recorderRef.current) return;
    if (recordingRef.current === 'recording') {
      recorderRef.current.pause();
      recordingRef.current = 'paused'; setRecordState('paused');
    } else if (recordingRef.current === 'paused') {
      recorderRef.current.resume();
      recordingRef.current = 'recording'; setRecordState('recording');
    }
  }
  async function stopRecording() {
    if (!recorderRef.current || !lecture) return;
    const lectureId = lecture._id;
    recordingRef.current = 'stopping';
    setRecordState('stopping');
    let shouldGenerate = false;
    try {
      // Recorder.stop awaits all finalized transcription and local audio writes.
      await recorderRef.current.stop();
      await flushPending();
      const unsaved = await db.pendingSegments.where('lectureId').equals(lectureId).count();
      const doc = await api(`/lectures/${lectureId}`, {
        method: 'PATCH',
        body: { durationSeconds: secondsRef.current }
      });
      setLecture(prev => prev?._id === doc._id ? {
        ...doc,
        transcript: [...doc.transcript, ...(prev.transcript || []).filter(s => !doc.transcript.some(r => r.id === s.id))]
      } : prev);
      await loadList(query);
      setAudioCount(await db.audioChunks.where('lectureId').equals(lectureId).count());
      if (unsaved) {
        setLecture(prev => prev?._id === lectureId ? { ...prev, notesStatus: 'failed' } : prev);
        setError('Recording stopped and audio saved locally. Some transcript sentences are waiting to sync; retry notes after reconnection.');
      } else if (!doc.transcript.length) {
        setError('No finalized speech was captured. Audio remains locally saved. Notes cannot be generated from an empty transcript.');
      } else {
        shouldGenerate = true;
      }
    } catch (e) { alertError(e); }
    finally {
      recorderRef.current = null;
      recordingRef.current = 'idle';
      setRecordState('idle');
      setInterim('');
      setTab('notes');
    }
    // Automatically generate notes after recording and transcript uploads finish.
    if (shouldGenerate) await organizeNotes(lectureId);
  }

  async function makePdf(id = lecture?._id) {
    if (!id) return;
    try {
      const doc = lecture?._id === id ? lecture : await api(`/lectures/${id}`);
      const { exportPdf } = await import('./exportPdf');
      exportPdf(doc);
    } catch (e) { alertError(e); }
  }

  if (publicView) return <PublicLecture />;
  const hasLecture = Boolean(lecture);
  const running = recordState !== 'idle';
  const listPinned = list.filter(x => x.pinned);
  const listOther = list.filter(x => !x.pinned);
  const sidebarItem = item => <div key={item._id} className={`chat-row ${activeId === item._id ? 'active' : ''}`}>
    <button className="chat-name" onClick={() => selectLecture(item._id)} disabled={running || busy} title={item.title}>
      <FileText size={16} /> <span>{item.title}</span>
    </button>
    <details className="chat-options">
      <summary title="Chat actions"><Ellipsis size={18} /></summary>
      <div className="menu-pop">
        <button onClick={() => rename(item._id, item.title)} disabled={running}><Pencil size={15} /> Rename</button>
        <button onClick={() => togglePin(item._id, item.pinned)} disabled={running}><Pin size={15} /> {item.pinned ? 'Unpin' : 'Pin'}</button>
        <button onClick={() => makePdf(item._id)}><FileDown size={15} /> Export PDF</button>
        <button onClick={() => shareLecture(item._id, item.title)}><Share2 size={15} /> Share view-only</button>
        <button onClick={() => deleteLecture(item._id, item.title)} disabled={running} className="danger"><Trash2 size={15} /> Delete</button>
      </div>
    </details>
  </div>;

  return <div className="app-shell">
    {mobileNav && <button className="sidebar-overlay" aria-label="Close menu" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand"><span className="brand-icon"><AudioLines size={21} /></span><span>LectureFlow <b>AI</b></span>
        <IconButton className="mobile-close" title="Close menu" onClick={() => setMobileNav(false)}><X size={19} /></IconButton>
      </div>
      <button className="new-button" onClick={createLecture} disabled={running || busy}><Plus size={19} /> New lecture</button>
      <div className="search-box"><Search size={17} /><input aria-label="Search lectures" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your lectures..." /></div>
      <div className="chat-list">
        {!!listPinned.length && <><div className="group-label"><Pin size={12} /> PINNED</div>{listPinned.map(sidebarItem)}</>}
        <div className="group-label">RECENT LECTURES</div>
        {listOther.length ? listOther.map(sidebarItem) : <p className="empty-side">No lectures found.</p>}
      </div>
      <div className="sidebar-footer"><span className="privacy-hint">Your audio stays on this device.</span></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="topbar-left"><IconButton className="mobile-menu" title="Open menu" onClick={() => setMobileNav(true)}><Menu size={21} /></IconButton>
          <span className="topbar-title">{lecture?.title || 'My lectures'}</span></div>
        <div className="topbar-right"><IconButton title="Switch theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</IconButton></div>
      </header>
      {gapWarning && <div className="gap-banner" role="status">
        <span><strong>Review recording:</strong> {gapWarning} Your local audio is kept on this device.</span>
        <button type="button" onClick={() => setGapWarning('')} aria-label="Dismiss recording warning"><X size={16} /></button>
      </div>}
      {error && <div className="error-banner"><CircleHelp size={18} /><span>{error}</span><IconButton title="Dismiss" onClick={() => setError('')}><X size={16} /></IconButton></div>}
      {!activeId ? <section className="welcome">
        <div className="welcome-icon"><Mic size={28} /></div>
        <h1>Never miss a lecture note.</h1><p>Record lectures, follow the live transcript, and turn speech into organized notes with Gemini AI.</p>
        <button className="primary-button" disabled={busy} onClick={createLecture}><Plus size={19} /> Start a new lecture</button>
        <div className="welcome-features"><span><Check size={16} /> Live transcript</span><span><Check size={16} /> Auto-saved notes</span><span><Check size={16} /> Local audio</span></div>
      </section> : !hasLecture ? <div className="loading-state">Loading lecture...</div> : <section className="workspace">
        <div className="lecture-heading"><div><p className="eyebrow">LECTURE SESSION · {shownDate(lecture.createdAt)}</p><h1>{lecture.title}</h1>
          <p className="lecture-meta">{fmt(seconds)} recorded · {lecture.transcript?.length || 0} confirmed segments</p></div>
          <div className="action-row">
            <IconButton title="Rename" disabled={running} onClick={() => rename(lecture._id, lecture.title)}><Pencil size={18} /></IconButton>
            <IconButton title={lecture.pinned ? 'Unpin' : 'Pin'} disabled={running} onClick={() => togglePin(lecture._id, lecture.pinned)}><Pin size={18} className={lecture.pinned ? 'accent' : ''} /></IconButton>
            <IconButton title="Share read-only link" disabled={running} onClick={() => shareLecture(lecture._id, lecture.title)}><Share2 size={18} /></IconButton>
            <IconButton title="Export PDF" onClick={makePdf}><FileDown size={18} /></IconButton>
          </div></div>

        <section className={`record-card ${running ? 'is-recording' : ''}`}>
          <div className="record-info"><div className="record-indicator"><span className={running && recordState === 'recording' ? 'red-dot' : 'muted-dot'} /> {running ? (recordState === 'starting' ? 'Starting...' : recordState === 'paused' ? 'Paused' : recordState === 'stopping' ? 'Finishing...' : 'Recording') : 'Ready to record'}</div><strong className="timer">{fmt(seconds)}</strong></div>
          <div className="waveform" aria-hidden="true">{Array.from({ length: 64 }, (_, i) => <span key={i} style={{ '--h': `${7 + Math.abs(Math.sin(i * 1.4) * Math.cos(i * 0.41)) * 33}px`, '--d': `${(i % 11) * 0.08}s` }} className={recordState === 'recording' ? 'moving' : ''} />)}</div>
          <div className="record-controls">{recordState === 'idle' ? <button onClick={startRecording} disabled={busy} className="record-start"><Mic size={20} /> Start recording</button> : <>
            <button className="secondary-button" disabled={recordState === 'stopping' || recordState === 'starting'} onClick={togglePause}>{recordState === 'paused' ? <Play size={18} /> : <Pause size={18} />} {recordState === 'paused' ? 'Resume' : 'Pause'}</button>
            <button className="stop-button" disabled={recordState === 'stopping' || recordState === 'starting'} onClick={stopRecording}><Square size={16} fill="currentColor" /> Stop</button>
          </>}</div>
          <div className="live-status"><span className={recordState === 'recording' ? 'green-dot' : 'muted-dot'} />{running ? liveStatus : 'Start recording to enable live transcription'}</div>
          {running && <div className="live-caption" aria-live="polite">
            <span className="live-caption-label">LIVE CAPTIONS</span>
            <p>{interim || (recordState === 'recording' ? 'Listening… Words will appear as the lecturer speaks and then move into the transcript.' : 'Recording paused or connecting...')}</p>
          </div>}
        </section>

        <div className="content-tabs"><div className="tabs">
          <button className={tab === 'transcript' ? 'selected' : ''} onClick={() => setTab('transcript')}><AudioLines size={17} /> Transcript</button>
          <button className={tab === 'notes' ? 'selected' : ''} onClick={() => setTab('notes')}><BookOpenText size={17} /> Organized notes</button>
        </div>
          {tab === 'notes' ? <div className="tab-actions">
            {(!lecture.notesMarkdown || lecture.notesStatus === 'failed') && !busy && !running && !!lecture.transcript?.length &&
              <button className="small-action" onClick={() => organizeNotes(lecture._id)}><Sparkles size={16} /> Retry AI notes</button>}
            {busy && <span className="transcript-count"><Sparkles size={15} /> Generating notes...</span>}
          </div>
            : <span className="transcript-count">{lecture.transcript?.length || 0} segments</span>}
        </div>
        {tab === 'transcript' ? <div className="transcript-content">
          {!lecture.transcript?.length && !interim && <div className="empty-content"><Mic size={30} /><h3>Waiting for your lecture</h3><p>Press Start recording. Confirmed sentences will appear here and save to MongoDB.</p></div>}
          {lecture.transcript?.map((s, i) => <div className="segment" key={s.id || i}>
            <span className="timestamp">{fmt(s.seconds)}</span>
            <div className="segment-content"><p>{s.text}</p></div>
          </div>)}
          {!!interim && <div className="segment interim"><span className="timestamp">LIVE</span><p>{interim}<span className="typing-cursor" /></p></div>}
        </div> : <div className="note-content">
          <div className="note-toolbar"><span>AI notes can be edited before sharing or exporting.</span>
            <button className="small-action" disabled={busy} onClick={() => { if (editing) setEditing(false); else { setDraft(lecture.notesMarkdown || ''); setEditing(true); } }}><Pencil size={15} />{editing ? 'Cancel editing' : 'Edit notes'}</button></div>
          {editing ? <><textarea className="notes-editor" rows={16} value={draft} onChange={e => setDraft(e.target.value)} placeholder="# Lecture topic\n\nWrite your notes here..." />
            <button className="primary-button" onClick={() => patch({ notesMarkdown: draft }).then(() => setEditing(false)).catch(alertError)}><Check size={17} /> Save notes</button></> :
            <div className="markdown-body">
              {busy ? <div className="notes-progress" role="status">
                <Sparkles size={22} />
                <h3>Creating your lecture notes...</h3>
                <p>Gemini is reviewing the full transcript, keeping subject explanations and relevant Q&amp;A, and ignoring unrelated conversations.</p>
              </div> : <ReactMarkdown>{lecture.notesMarkdown || 'Your notes will be generated automatically after you stop recording. The complete raw transcript stays available in the Transcript tab.'}</ReactMarkdown>}
            </div>}
        </div>}
        <div className="lecture-footer">
          <button className="small-action" onClick={() => downloadLocalAudio(lecture._id, lecture.title).catch(alertError)} disabled={!audioCount || running}><Download size={16} /> Download local audio {audioCount ? `(${audioCount} chunks)` : ''}</button>
          <button className="small-action danger-text" disabled={running} onClick={() => deleteLecture(lecture._id, lecture.title)}><Trash2 size={16} /> Delete lecture</button>
        </div>
      </section>}
    </main>
    {renameTarget && <RenameModal value={renameTarget} onCancel={() => setRenameTarget(null)} onSave={saveRename} />}
  </div>;
}
