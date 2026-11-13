import { useEffect, useRef, useState } from "react";

/** Keep in sync with NOTE_MAX in server/src/favorites.ts */
const NOTE_MAX = 500;

export function FavoriteStar(props: {
  on: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { on, onToggle, className } = props;
  // mouseup and click both arrive for one press. Only the first one counts.
  const lastFire = useRef(0);
  function fire(e: { preventDefault: () => void; stopPropagation: () => void }) {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastFire.current < 400) return;
    lastFire.current = now;
    onToggle();
  }
  return (
    <button
      type="button"
      className={"fav-star" + (on ? " on" : "") + (className ? " " + className : "")}
      aria-pressed={on}
      title={on ? "取消收藏" : "收藏这段对话"}
      onMouseDown={(e) => {
        // Don't steal focus from an open note box; otherwise it saves in the
        // same gesture that turns the star off and can recreate the favorite.
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseUp={fire}
      onClick={fire}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

export function FavoriteNote(props: {
  note: string;
  onSave: (note: string) => void;
  clamp?: boolean;
}) {
  const { note, onSave, clamp = true } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const skipBlur = useRef(false);
  const committed = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(note);
  }, [note, editing]);

  function commit() {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    if (committed.current) return;
    committed.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next !== note) onSave(next);
  }

  function cancel() {
    skipBlur.current = true;
    committed.current = true;
    setDraft(note);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={
          "fav-note" +
          (note ? "" : " fav-note-empty") +
          (clamp ? " fav-note-clamp" : "")
        }
        title={note ? "改备注" : "加备注"}
        onClick={(e) => {
          e.stopPropagation();
          committed.current = false;
          skipBlur.current = false;
          setDraft(note);
          setEditing(true);
        }}
      >
        {note || "加备注"}
      </button>
    );
  }

  return (
    <div
      className="fav-note-edit"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <textarea
        autoFocus
        maxLength={NOTE_MAX}
        rows={3}
        value={draft}
        placeholder="写一句备注，方便以后找"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          // Unmounting the box (cancel favorite) also blurs. Don't write the
          // note back and recreate a favorite that was just removed.
          if (!e.currentTarget.isConnected) return;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
      <div className="fav-note-bar">
        <span className="fav-note-count">
          {draft.trim().length}/{NOTE_MAX}
        </span>
        <button
          type="button"
          className="fav-note-save"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          保存
        </button>
      </div>
    </div>
  );
}
