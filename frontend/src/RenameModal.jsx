
import {
  useEffect,
  useRef,
  useState,
} from "react";

import { Pencil, X } from "lucide-react";

export default function RenameModal({
  value,
  onCancel,
  onSave,
}) {
  const [title, setTitle] = useState(value.title);
  const [saving, setSaving] = useState(false);

  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    function onEscape(event) {
      if (event.key === "Escape" && !saving) {
        onCancel();
      }
    }

    window.addEventListener("keydown", onEscape);

    return () => {
      window.removeEventListener(
        "keydown",
        onEscape
      );
    };
  }, [onCancel, saving]);

  async function submit(event) {
    event.preventDefault();

    const nextTitle = title.trim();

    if (
      !nextTitle ||
      nextTitle === value.title
    ) {
      onCancel();
      return;
    }

    setSaving(true);

    try {
      await onSave(value.id, nextTitle);
      onCancel();
    } catch {
      // Parent displays the API error.
      // Keep the dialog open for retry.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rename-backdrop"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !saving
        ) {
          onCancel();
        }
      }}
    >
      <form
        className="rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onSubmit={submit}
      >
        <div className="rename-dialog-top">
          <span className="rename-dialog-icon">
            <Pencil size={20} />
          </span>

          <button
            className="icon-button"
            type="button"
            aria-label="Close rename dialog"
            onClick={onCancel}
            disabled={saving}
          >
            <X size={19} />
          </button>
        </div>

        <h2 id="rename-title">
          Rename lecture
        </h2>

        <p>
          Give this lecture a short title so you
          can find it again easily.
        </p>

        <label htmlFor="rename-input">
          Lecture title
        </label>

        <input
          id="rename-input"
          ref={inputRef}
          value={title}
          maxLength={120}
          onChange={(event) =>
            setTitle(event.target.value)
          }
          placeholder="e.g. Microprocessor Architecture"
        />

        <div className="rename-counter">
          {title.length}/120
        </div>

        <div className="rename-actions">
          <button
            type="button"
            className="rename-cancel"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="rename-save"
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
