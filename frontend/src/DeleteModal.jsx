import { useState } from "react";
import { AlertTriangle, Trash2, X } from "lucide-react";

export default function DeleteModal({ value, onCancel, onConfirm }) {
    const [deleting, setDeleting] = useState(false);

    async function handleDelete(event) {
        event.preventDefault();
        if (deleting) return;
        setDeleting(true);
        try {
            await onConfirm(value.id, value.title);
        } catch {
            // App.jsx displays the error; leave the dialog open to retry.
            setDeleting(false);
        }
    }

    return (
        <div className="delete-overlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) onCancel();
        }}>
            <form className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-heading" onSubmit={handleDelete}>
                <div className="delete-dialog-top">
                    <span className="delete-symbol"><AlertTriangle size={22} /></span>
                    <button type="button" className="icon-button" aria-label="Cancel deletion" disabled={deleting} onClick={onCancel}><X size={19} /></button>
                </div>
                <h2 id="delete-heading">Delete this lecture?</h2>
                <p className="delete-description">
                    <strong>{value.title}</strong> and its notes and transcript will be permanently deleted from MongoDB.
                    Audio saved in this browser will also be deleted. This cannot be undone.
                </p>
                <div className="delete-actions">
                    <button type="button" className="delete-cancel" disabled={deleting} onClick={onCancel}>Keep lecture</button>
                    <button type="submit" className="delete-confirm" disabled={deleting}><Trash2 size={17} />{deleting ? "Deleting..." : "Delete lecture"}</button>
                </div>
            </form>
        </div>
    );
}
