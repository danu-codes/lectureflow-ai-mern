
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import ReactMarkdown from "react-markdown";

import {
  AudioLines,
  BookOpenText,
  Check,
  Cloud,
  Download,
  Ellipsis,
  FileDown,
  FileText,
  Menu,
  Mic,
  Moon,
  Pause,
  Pin,
  Play,
  Plus,
  Search,
  Share2,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X,
  Pencil,
  RotateCw,
} from "lucide-react";

import { api } from "./api";
import { db, downloadLocalAudio } from "./db";
import { LectureRecorder } from "./recorder";
import { exportPdf } from "./exportPdf";

const formatTime = (seconds = 0) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor(seconds / 60) % 60;
  const secs = Math.floor(seconds % 60);

  return [hrs, mins, secs]
    .map((number) =>
      String(number).padStart(2, "0")
    )
    .join(":");
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  );

function IconButton({
  title,
  children,
  onClick,
  disabled,
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// ------------------------------
// Read-only public lecture page
// ------------------------------

function PublicLecture() {
  const [lecture, setLecture] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token =
      window.location.pathname.split("/share/")[1];

    api(`/public/${encodeURIComponent(token || "")}`)
      .then(setLecture)
      .catch((err) => setError(err.message));
  }, []);

  const content = lecture
    ? lecture.notesMarkdown ||
    lecture.transcript
      ?.map((segment) => segment.text)
      .join("\n\n") ||
    "No notes available."
    : "";

  return (
    <div className="public-page">
      <header className="public-top">
        <AudioLines size={24} />
        <strong>LectureFlow AI</strong>
        <span>Shared lecture · View only</span>
      </header>

      <article className="public-paper">
        {error ? (
          <p className="error-box">{error}</p>
        ) : !lecture ? (
          <p>Loading shared lecture...</p>
        ) : (
          <>
            <p className="eyebrow">
              LECTURE NOTES ·
              {" " + formatDate(lecture.createdAt)}
            </p>

            <h1>{lecture.title}</h1>

            <div className="markdown-body">
              <ReactMarkdown>
                {content}
              </ReactMarkdown>
            </div>

            <div className="viewer-note">
              This is a read-only lecture.
              The recording is stored only
              on the original device.
            </div>
          </>
        )}
      </article>
    </div>
  );
}

// ------------------------------
// Main application
// ------------------------------

export default function App() {
  const publicView =
    window.location.pathname.startsWith("/share/");

  // UI state

  const [theme, setTheme] = useState(
    () => localStorage.getItem("lf_theme") || "dark"
  );

  const [mobileNav, setMobileNav] = useState(false);
  const [list, setList] = useState([]);
  const [query, setQuery] = useState("");

  const [activeId, setActiveId] = useState(null);
  const [lecture, setLecture] = useState(null);

  const [tab, setTab] = useState("transcript");

  const [recordState, setRecordState] =
    useState("idle");

  const [liveStatus, setLiveStatus] =
    useState("Ready");

  const [interim, setInterim] = useState("");
  const [seconds, setSeconds] = useState(0);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const [audioCount, setAudioCount] = useState(0);

  // Refs for recording callbacks

  const recorderRef = useRef(null);
  const secondsRef = useRef(0);
  const recordingRef = useRef("idle");
  const flushingRef = useRef(false);

  const isRecording = recordState !== "idle";

  const showError = (err) => {
    setError(err?.message || String(err));
  };

  // ------------------------------
  // Theme selection
  // ------------------------------

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lf_theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((previous) =>
      previous === "dark" ? "light" : "dark"
    );
  }

  // ------------------------------
  // Fetch MongoDB lecture history
  // ------------------------------

  const loadList = useCallback(
    async (search = "") => {
      const endpoint = search
        ? `/lectures?q=${encodeURIComponent(search)}`
        : "/lectures";

      const result = await api(endpoint);
      setList(result);
    },
    []
  );

  useEffect(() => {
    if (publicView) return;

    const timer = setTimeout(() => {
      loadList(query).catch(showError);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, loadList, publicView]);

  // ------------------------------
  // Fetch selected lecture
  // ------------------------------

  useEffect(() => {
    if (!activeId || publicView) return;

    let cancelled = false;

    api(`/lectures/${activeId}`)
      .then((doc) => {
        if (
          cancelled ||
          recordingRef.current !== "idle"
        ) {
          return;
        }

        setLecture(doc);
        setDraft(doc.notesMarkdown || "");

        const duration = doc.durationSeconds || 0;

        setSeconds(duration);
        secondsRef.current = duration;
      })
      .catch(showError);

    db.audioChunks
      .where("lectureId")
      .equals(activeId)
      .count()
      .then((count) => {
        if (!cancelled) {
          setAudioCount(count);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, publicView]);

  // ------------------------------
  // Recording duration timer
  // ------------------------------

  useEffect(() => {
    if (recordState !== "recording") return;

    const timer = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);

    return () => clearInterval(timer);
  }, [recordState]);

  // ------------------------------
  // Retry unsaved transcript text
  // ------------------------------

  const flushPending = useCallback(async () => {
    if (flushingRef.current) return;

    flushingRef.current = true;

    try {
      const pending =
        await db.pendingSegments.toArray();

      for (const item of pending) {
        try {
          await api(
            `/lectures/${item.lectureId}/segments`,
            {
              method: "POST",
              body: item.segment,
            }
          );

          await db.pendingSegments.delete(item.id);
        } catch {
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (publicView) return;

    flushPending();

    const timer = setInterval(
      flushPending,
      10000
    );

    window.addEventListener(
      "online",
      flushPending
    );

    return () => {
      clearInterval(timer);

      window.removeEventListener(
        "online",
        flushPending
      );
    };
  }, [flushPending, publicView]);

  // ------------------------------
  // Select lecture
  // ------------------------------

  function selectLecture(id) {
    if (recordingRef.current !== "idle") return;

    setActiveId(id);
    setLecture(null);
    setMobileNav(false);

    setTab("transcript");
    setInterim("");
    setError("");
    setEditing(false);
  }

  // ------------------------------
  // New lecture
  // ------------------------------

  async function createLecture() {
    if (recordingRef.current !== "idle") return;

    try {
      const doc = await api("/lectures", {
        method: "POST",
      });

      setList((previous) => [
        doc,
        ...previous,
      ]);

      setLecture(doc);
      setActiveId(doc._id);

      setTab("transcript");
      setMobileNav(false);
      setInterim("");
      setError("");

      setSeconds(0);
      secondsRef.current = 0;

      setAudioCount(0);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Rename lecture
  // ------------------------------

  async function renameLecture(id, oldTitle) {
    if (isRecording) return;

    const title = window.prompt(
      "Enter a lecture title:",
      oldTitle
    );

    if (!title?.trim()) return;

    try {
      const updated = await api(
        `/lectures/${id}`,
        {
          method: "PATCH",
          body: { title: title.trim() },
        }
      );

      if (id === activeId) {
        setLecture(updated);
      }

      await loadList(query);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Pin or unpin
  // ------------------------------

  async function togglePin(id, pinned) {
    if (isRecording) return;

    try {
      const updated = await api(
        `/lectures/${id}`,
        {
          method: "PATCH",
          body: { pinned: !pinned },
        }
      );

      if (id === activeId) {
        setLecture(updated);
      }

      await loadList(query);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Delete lecture and local audio
  // ------------------------------

  async function deleteLecture(id, title) {
    if (isRecording) return;

    const confirmed = window.confirm(
      `Delete "${title}" permanently?\n` +
      "The local audio will also be deleted."
    );

    if (!confirmed) return;

    try {
      await api(`/lectures/${id}`, {
        method: "DELETE",
      });

      await Promise.all([
        db.audioChunks
          .where("lectureId")
          .equals(id)
          .delete(),

        db.pendingSegments
          .where("lectureId")
          .equals(id)
          .delete(),
      ]);

      if (activeId === id) {
        setActiveId(null);
        setLecture(null);
      }

      await loadList(query);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Save notes
  // ------------------------------

  async function saveNotes() {
    if (!lecture) return;

    try {
      const doc = await api(
        `/lectures/${lecture._id}`,
        {
          method: "PATCH",
          body: {
            notesMarkdown: draft,
          },
        }
      );

      setLecture(doc);
      setEditing(false);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Export any lecture as PDF
  // ------------------------------

  async function handlePdf(id) {
    try {
      const doc =
        lecture?._id === id
          ? lecture
          : await api(`/lectures/${id}`);

      exportPdf(doc);
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Create read-only share link
  // ------------------------------

  async function shareLecture(id, title) {
    try {
      const { token } = await api(
        `/lectures/${id}/share`,
        { method: "POST" }
      );

      const url =
        `${window.location.origin}/share/${token}`;

      if (navigator.share) {
        await navigator.share({
          title,
          url,
        });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        window.alert("Sharing link copied!");
      } else {
        window.prompt(
          "Copy this read-only link:",
          url
        );
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        showError(err);
      }
    }
  }

  // ------------------------------
  // Revoke sharing
  // ------------------------------

  async function revokeShare() {
    if (!lecture) return;

    if (
      !window.confirm(
        "Revoke the currently active sharing link?"
      )
    ) {
      return;
    }

    try {
      await api(
        `/lectures/${lecture._id}/share`,
        { method: "DELETE" }
      );

      window.alert("Sharing link revoked.");
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------
  // Generate AI lecture notes
  // ------------------------------

  async function organizeNotes() {
    if (!lecture || isRecording) return;

    setBusy(true);
    setError("");

    try {
      await flushPending();

      const unsaved = await db.pendingSegments
        .where("lectureId")
        .equals(lecture._id)
        .count();

      if (unsaved) {
        throw new Error(
          "Some transcript segments are not saved " +
          "to MongoDB. Retry when online."
        );
      }

      const doc = await api(
        `/lectures/${lecture._id}/organize`,
        { method: "POST" }
      );

      setLecture(doc);
      setDraft(doc.notesMarkdown);

      setTab("notes");

      await loadList(query);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------
  // Start recording
  // ------------------------------

  async function startRecording() {
    if (
      !lecture ||
      recordingRef.current !== "idle"
    ) {
      return;
    }

    setError("");
    setInterim("");
    setTab("transcript");

    const lectureId = lecture._id;

    const recorder = new LectureRecorder(
      lectureId,
      {
        interim: setInterim,
        status: setLiveStatus,
        error: setError,

        // Called when Gemini finalizes
        // one transcript segment.

        final: async (text) => {
          const segment = {
            id: crypto.randomUUID(),
            text,
            seconds: secondsRef.current,
          };

          // Immediately display confirmed text.

          setLecture((previous) => {
            if (previous?._id !== lectureId) {
              return previous;
            }

            return {
              ...previous,
              transcript: [
                ...(previous.transcript || []),
                segment,
              ],
            };
          });

          // Queue locally before sending to
          // MongoDB to support retries.

          try {
            await db.pendingSegments.put({
              id: segment.id,
              lectureId,
              segment,
            });

            await flushPending();
          } catch (err) {
            showError(err);
          }
        },
      }
    );

    recorderRef.current = recorder;
    recordingRef.current = "starting";

    setRecordState("starting");

    try {
      await recorder.start();

      if (recordingRef.current === "starting") {
        recordingRef.current = "recording";
        setRecordState("recording");
      }
    } catch (err) {
      recorderRef.current = null;
      recordingRef.current = "idle";

      setRecordState("idle");
      showError(err);
    }
  }

  // ------------------------------
  // Pause / resume
  // ------------------------------

  function togglePause() {
    const recorder = recorderRef.current;

    if (!recorder) return;

    if (recordingRef.current === "recording") {
      recorder.pause();

      recordingRef.current = "paused";
      setRecordState("paused");
    } else if (
      recordingRef.current === "paused"
    ) {
      recorder.resume();

      recordingRef.current = "recording";
      setRecordState("recording");
    }
  }

  // ------------------------------
  // Stop recording
  // ------------------------------

  async function stopRecording() {
    if (!recorderRef.current || !lecture) {
      return;
    }

    const lectureId = lecture._id;

    recordingRef.current = "stopping";
    setRecordState("stopping");

    try {
      await recorderRef.current.stop();

      await flushPending();

      const doc = await api(
        `/lectures/${lectureId}`,
        {
          method: "PATCH",
          body: {
            durationSeconds:
              secondsRef.current,
          },
        }
      );

      // Preserve text still pending locally.

      setLecture((previous) => {
        if (previous?._id !== lectureId) {
          return previous;
        }

        const missing = (
          previous.transcript || []
        ).filter(
          (segment) =>
            !doc.transcript.some(
              (saved) =>
                saved.id === segment.id
            )
        );

        return {
          ...doc,
          transcript: [
            ...doc.transcript,
            ...missing,
          ],
        };
      });

      setAudioCount(
        await db.audioChunks
          .where("lectureId")
          .equals(lectureId)
          .count()
      );

      await loadList(query);
    } catch (err) {
      showError(err);
    } finally {
      recorderRef.current = null;
      recordingRef.current = "idle";

      setRecordState("idle");
      setInterim("");
    }
  }

  // ------------------------------
  // Shared public view
  // ------------------------------

  if (publicView) {
    return <PublicLecture />;
  }

  const pinned = list.filter(
    (item) => item.pinned
  );

  const recent = list.filter(
    (item) => !item.pinned
  );

  // ------------------------------
  // Sidebar lecture item
  // ------------------------------

  const renderLectureItem = (item) => (
    <div
      key={item._id}
      className={
        "chat-row " +
        (activeId === item._id ? "active" : "")
      }
    >
      <button
        className="chat-name"
        onClick={() => selectLecture(item._id)}
        disabled={isRecording}
        title={item.title}
      >
        <FileText size={16} />
        <span>{item.title}</span>
      </button>

      <details className="chat-options">
        <summary title="Lecture actions">
          <Ellipsis size={18} />
        </summary>

        <div className="menu-pop">
          <button
            disabled={isRecording}
            onClick={() =>
              renameLecture(item._id, item.title)
            }
          >
            <Pencil size={15} />
            Rename
          </button>

          <button
            disabled={isRecording}
            onClick={() =>
              togglePin(item._id, item.pinned)
            }
          >
            <Pin size={15} />
            {item.pinned ? "Unpin" : "Pin"}
          </button>

          <button
            onClick={() => handlePdf(item._id)}
          >
            <FileDown size={15} />
            Export PDF
          </button>

          <button
            onClick={() =>
              shareLecture(item._id, item.title)
            }
          >
            <Share2 size={15} />
            Share
          </button>

          <button
            className="danger"
            disabled={isRecording}
            onClick={() =>
              deleteLecture(item._id, item.title)
            }
          >
            <Trash2 size={15} />
            Delete
          </button>
        </div>
      </details>
    </div>
  );

  // ------------------------------
  // Main layout
  // ------------------------------

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}

      {/* Sidebar */}

      <aside
        className={
          "sidebar " +
          (mobileNav ? "open" : "")
        }
      >
        <div className="brand">
          <span className="brand-icon">
            <AudioLines size={21} />
          </span>

          <span>
            LectureFlow <b>AI</b>
          </span>

          <button
            className="icon-button mobile-close"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>

        <button
          className="new-button"
          onClick={createLecture}
          disabled={isRecording}
        >
          <Plus size={19} />
          New lecture
        </button>

        <div className="search-box">
          <Search size={17} />

          <input
            value={query}
            onChange={(event) =>
              setQuery(event.target.value)
            }
            placeholder="Search your lectures..."
          />
        </div>

        <div className="chat-list">
          {pinned.length > 0 && (
            <>
              <div className="group-label">
                <Pin size={12} />
                PINNED
              </div>

              {pinned.map(renderLectureItem)}
            </>
          )}

          <div className="group-label">
            RECENT LECTURES
          </div>

          {recent.length > 0 ? (
            recent.map(renderLectureItem)
          ) : (
            <p className="empty-side">
              No lectures found.
            </p>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="privacy-hint">
            Your audio stays on this device.
          </span>
        </div>
      </aside>

      {/* Main area */}

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>

            <span className="topbar-title">
              {lecture?.title || "My Lectures"}
            </span>
          </div>
          <div className="topbar-right">
            <IconButton
              title="Switch theme"
              onClick={toggleTheme}
            >
              {theme === "dark" ? (
                <Sun size={19} />
              ) : (
                <Moon size={19} />
              )}
            </IconButton>
          </div>

        </header>

        {error && (
          <div className="error-banner">
            <span>{error}</span>

            <IconButton
              title="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}

        {/* Welcome screen */}

        {!activeId ? (
          <section className="welcome">
            <div className="welcome-icon">
              <Mic size={28} />
            </div>

            <h1>Never miss a lecture note.</h1>

            <p>
              Record your lectures, view speech
              as live text, and generate
              organized study notes using Gemini AI.
            </p>

            <button
              className="primary-button"
              onClick={createLecture}
            >
              <Plus size={19} />
              Start a new lecture
            </button>

            <div className="welcome-features">
              <span>
                <Check size={16} />
                Live transcription
              </span>

              <span>
                <Check size={16} />
                MongoDB notes
              </span>

              <span>
                <Check size={16} />
                Local audio
              </span>
            </div>
          </section>
        ) : !lecture ? (
          <div className="loading-state">
            Loading lecture...
          </div>
        ) : (
          <section className="workspace">
            {/* Lecture heading */}

            <div className="lecture-heading">
              <div>
                <p className="eyebrow">
                  LECTURE SESSION ·
                  {" " + formatDate(lecture.createdAt)}
                </p>

                <h1>{lecture.title}</h1>

                <p className="lecture-meta">
                  {formatTime(seconds)} recorded
                  {" · "}
                  {lecture.transcript?.length || 0}
                  {" "}confirmed segments
                </p>
              </div>

              <div className="action-row">
                <IconButton
                  title="Rename"
                  disabled={isRecording}
                  onClick={() =>
                    renameLecture(
                      lecture._id,
                      lecture.title
                    )
                  }
                >
                  <Pencil size={18} />
                </IconButton>

                <IconButton
                  title="Pin or unpin"
                  disabled={isRecording}
                  onClick={() =>
                    togglePin(
                      lecture._id,
                      lecture.pinned
                    )
                  }
                >
                  <Pin size={18} />
                </IconButton>

                <IconButton
                  title="Share lecture"
                  onClick={() =>
                    shareLecture(
                      lecture._id,
                      lecture.title
                    )
                  }
                >
                  <Share2 size={18} />
                </IconButton>

                <IconButton
                  title="Export PDF"
                  onClick={() =>
                    handlePdf(lecture._id)
                  }
                >
                  <FileDown size={18} />
                </IconButton>
              </div>
            </div>

            {/* Recording panel */}

            <section
              className={
                "record-card " +
                (isRecording ? "is-recording" : "")
              }
            >
              <div className="record-info">
                <div className="record-indicator">
                  <span
                    className={
                      recordState === "recording"
                        ? "red-dot"
                        : "muted-dot"
                    }
                  />

                  {recordState === "recording"
                    ? "Recording"
                    : recordState === "paused"
                      ? "Paused"
                      : recordState === "starting"
                        ? "Starting..."
                        : recordState === "stopping"
                          ? "Finishing..."
                          : "Ready to record"}
                </div>

                <strong className="timer">
                  {formatTime(seconds)}
                </strong>
              </div>

              <div className="waveform">
                {Array.from(
                  { length: 48 },
                  (_, index) => (
                    <span
                      key={index}
                      className={
                        recordState === "recording"
                          ? "moving"
                          : ""
                      }
                      style={{
                        "--h":
                          `${7 +
                          Math.abs(
                            Math.sin(index * 1.4)
                          ) * 33
                          }px`,
                        "--d":
                          `${(index % 11) * 0.08}s`,
                      }}
                    />
                  )
                )}
              </div>

              <div className="record-controls">
                {recordState === "idle" ? (
                  <button
                    className="record-start"
                    onClick={startRecording}
                  >
                    <Mic size={20} />
                    Start recording
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary-button"
                      disabled={
                        recordState === "starting" ||
                        recordState === "stopping"
                      }
                      onClick={togglePause}
                    >
                      {recordState === "paused" ? (
                        <Play size={18} />
                      ) : (
                        <Pause size={18} />
                      )}

                      {recordState === "paused"
                        ? "Resume"
                        : "Pause"}
                    </button>

                    <button
                      className="stop-button"
                      disabled={
                        recordState === "starting" ||
                        recordState === "stopping"
                      }
                      onClick={stopRecording}
                    >
                      <Square size={16} />
                      Stop
                    </button>
                  </>
                )}
              </div>

              <div className="live-status">
                <span
                  className={
                    recordState === "recording"
                      ? "green-dot"
                      : "muted-dot"
                  }
                />

                {isRecording
                  ? liveStatus
                  : "Start recording for live transcription"}
              </div>
            </section>

            {/* Transcript / notes navigation */}

            <div className="content-tabs">
              <div className="tabs">
                <button
                  className={
                    tab === "transcript"
                      ? "selected"
                      : ""
                  }
                  onClick={() =>
                    setTab("transcript")
                  }
                >
                  <AudioLines size={17} />
                  Transcript
                </button>

                <button
                  className={
                    tab === "notes"
                      ? "selected"
                      : ""
                  }
                  onClick={() => setTab("notes")}
                >
                  <BookOpenText size={17} />
                  Organized notes
                </button>
              </div>

              {tab === "notes" ? (
                <button
                  className="small-action"
                  onClick={organizeNotes}
                  disabled={
                    busy ||
                    isRecording ||
                    !lecture.transcript?.length
                  }
                >
                  <Sparkles size={16} />
                  {busy
                    ? "Generating..."
                    : "Generate AI notes"}
                </button>
              ) : (
                <span className="transcript-count">
                  {lecture.transcript?.length || 0}
                  {" "}segments
                </span>
              )}
            </div>

            {/* Transcript screen */}

            {tab === "transcript" ? (
              <div className="transcript-content">
                {!lecture.transcript?.length &&
                  !interim && (
                    <div className="empty-content">
                      <Mic size={30} />

                      <h3>
                        Waiting for your lecture
                      </h3>

                      <p>
                        Start recording to show live
                        speech here.
                      </p>
                    </div>
                  )}

                {lecture.transcript?.map(
                  (segment, index) => (
                    <div
                      className="segment"
                      key={segment.id || index}
                    >
                      <span className="timestamp">
                        {formatTime(
                          segment.seconds
                        )}
                      </span>

                      <p>{segment.text}</p>
                    </div>
                  )
                )}

                {interim && (
                  <div className="segment interim">
                    <span className="timestamp">
                      LIVE
                    </span>

                    <p>
                      {interim}
                      <span className="typing-cursor" />
                    </p>
                  </div>
                )}
              </div>
            ) : (
              /* Organized notes screen */

              <div className="note-content">
                <div className="note-toolbar">
                  <span>
                    Edit your generated lecture notes.
                  </span>

                  <button
                    className="small-action"
                    onClick={() => {
                      if (editing) {
                        setEditing(false);
                      } else {
                        setDraft(
                          lecture.notesMarkdown || ""
                        );
                        setEditing(true);
                      }
                    }}
                  >
                    <Pencil size={15} />
                    {editing
                      ? "Cancel editing"
                      : "Edit notes"}
                  </button>
                </div>

                {editing ? (
                  <>
                    <textarea
                      className="notes-editor"
                      rows={16}
                      value={draft}
                      onChange={(event) =>
                        setDraft(event.target.value)
                      }
                      placeholder="# Lecture Topic"
                    />

                    <button
                      className="primary-button"
                      onClick={saveNotes}
                    >
                      <Check size={17} />
                      Save notes
                    </button>
                  </>
                ) : (
                  <div className="markdown-body">
                    <ReactMarkdown>
                      {lecture.notesMarkdown ||
                        "No organized notes yet. " +
                        "Record your lecture and " +
                        "click Generate AI notes."}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}

            {/* Footer actions */}

            <div className="lecture-footer">
              <button
                className="small-action"
                disabled={
                  isRecording || !audioCount
                }
                onClick={() =>
                  downloadLocalAudio(
                    lecture._id,
                    lecture.title
                  ).catch(showError)
                }
              >
                <Download size={16} />
                Download local audio
              </button>

              <button
                className="small-action"
                disabled={isRecording}
                onClick={revokeShare}
              >
                <X size={16} />
                Revoke share link
              </button>

              <button
                className="small-action danger-text"
                disabled={isRecording}
                onClick={() =>
                  deleteLecture(
                    lecture._id,
                    lecture.title
                  )
                }
              >
                <Trash2 size={16} />
                Delete lecture
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
