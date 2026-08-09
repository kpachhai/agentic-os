import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api";

type SearchHit = {
  id: number;
  kind: "session" | "thought" | "friction" | "wrap";
  ref: string;
  locator: string;
  title: string;
  timestamp: string;
  excerpt: string;
};

export type PaletteRoute = { path: string; label: string; available: boolean };

/**
 * One keyboard-first entry point over the whole panel.
 *
 * Built on the native `<dialog>` element rather than a component library. That is
 * not minimalism for its own sake: a dialog gets focus trapping, Escape-to-close,
 * a backdrop, and correct accessibility semantics from the platform, which is most
 * of what a palette dependency would have been imported to provide.
 *
 * It searches the derived index, so results span sessions, memory, friction and
 * wraps. When the index has not been built the navigation half still works, which
 * matters because the palette should never be the thing that is broken.
 */
export function Palette({
  routes,
  open,
  onClose,
}: {
  routes: PaletteRoute[];
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);

  // Routes always match; index results are additive. A palette that returned
  // nothing because a cache was cold would be worse than one that only navigates.
  const needle = query.trim().toLowerCase();
  const routeMatches = routes.filter(
    (route) =>
      !needle ||
      route.label.toLowerCase().includes(needle) ||
      route.path.toLowerCase().includes(needle),
  );

  type Row =
    | { kind: "route"; route: PaletteRoute }
    | { kind: "hit"; hit: SearchHit };

  const rows: Row[] = [
    ...routeMatches.map((route) => ({ kind: "route" as const, route })),
    ...hits.map((hit) => ({ kind: "hit" as const, hit })),
  ];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    if (!needle) {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      apiGet<{ hits: SearchHit[] }>(
        `/api/search?q=${encodeURIComponent(needle)}&limit=12`,
      )
        .then((res) => setHits(res.hits))
        // A cold or absent index must not break navigation, so a failed search
        // simply contributes no rows.
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 160);
    return () => window.clearTimeout(timer);
  }, [needle]);

  useEffect(() => {
    setSelected(0);
  }, [needle, hits.length]);

  const go = (row: Row): void => {
    // A hit navigates to its owning pillar rather than to the record. The index
    // stores enough to find a record but each pillar owns how one is opened, and
    // duplicating that here would put two answers in the codebase.
    if (row.kind === "route") window.location.hash = row.route.path;
    else if (row.hit.kind === "session") window.location.hash = "/sessions";
    else if (row.hit.kind === "thought") window.location.hash = "/engram";
    else if (row.hit.kind === "friction") window.location.hash = "/friction";
    else window.location.hash = "/wraps";
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[selected];
      if (row) go(row);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="palette"
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop closes; clicking the panel does not.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="palette-panel" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          placeholder="jump to a pillar, or search everything"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="palette-rows">
          {rows.length === 0 && (
            <div className="row-meta palette-empty">
              {searching ? "searching..." : "nothing matches"}
            </div>
          )}
          {rows.map((row, index) => (
            <button
              key={row.kind === "route" ? row.route.path : `hit-${row.hit.id}`}
              className={`palette-row${index === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => go(row)}
            >
              {row.kind === "route" ? (
                <>
                  <span className="badge purple">go</span>
                  <span className="palette-label">{row.route.label}</span>
                  {!row.route.available && (
                    <span className="row-meta">not set up</span>
                  )}
                </>
              ) : (
                <>
                  <span className="badge info">{row.hit.kind}</span>
                  <span className="palette-label">{row.hit.title}</span>
                  {row.hit.timestamp && (
                    <span className="row-meta">{row.hit.timestamp.slice(0, 10)}</span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        <div className="palette-foot row-meta">
          up and down to move, enter to open, escape to close. Search covers the
          derived index; navigation always works even when the index is empty.
        </div>
      </div>
    </dialog>
  );
}

/**
 * Global shortcut for the palette.
 *
 * Bound on the window rather than a focused element, so it works wherever the
 * reader is. It deliberately does nothing while focus is in a text field, because
 * intercepting a keystroke someone is typing into a search box is worse than
 * making them reach for the mouse.
 */
export function usePaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
