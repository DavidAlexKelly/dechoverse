import React, { useCallback, useEffect, useState } from "react";
import { getTagImageName, getTagImageUrl } from "@/foundry/tagMedia";
import css from "@/game/ui/pickers/Picker.module.css";
import { PickerShell } from "@/game/ui/pickers/PickerShell";
import { usePickerKeys } from "@/game/ui/pickers/usePickerKeys";

interface TagPickerProps {
  /** Media item RIDs already used in this world, newest first. */
  entries: string[];
  onSelect: (mediaItemRid: string) => void;
  /** Pulls an image that predates the app into the library, by file name. */
  onImportPath: (mediaItemPath: string) => void;
  onClose: () => void;
}

const COLUMNS = 4;

const HANDLED = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"] as const;

/**
 * Gallery of images already in the [AP] tags media set. Arrow keys move the
 * selection, Enter loads it into the tag tool, Escape or C closes.
 */
function TagPicker({
  entries,
  onSelect,
  onImportPath,
  onClose,
}: TagPickerProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [importPath, setImportPath] = useState("");

  useEffect(() => {
    let cancelled = false;
    for (const rid of entries) {
      void getTagImageUrl(rid)
        .then((url) => {
          if (!cancelled) {
            setUrls((previous) => ({ ...previous, [rid]: url }));
          }
        })
        .catch(() => undefined);
      void getTagImageName(rid)
        .then((name) => {
          if (!cancelled) {
            setNames((previous) => ({ ...previous, [rid]: name }));
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const move = useCallback(
    (delta: number) => {
      setIndex((previous) => {
        if (entries.length === 0) {
          return 0;
        }
        const next = previous + delta;
        if (next < 0 || next >= entries.length) {
          return previous;
        }
        return next;
      });
    },
    [entries.length],
  );

  usePickerKeys({
    handled: HANDLED,
    closeWith: ["KeyC"],
    onClose,
    onKey: (code) => {
      if (code === "ArrowLeft") {
        move(-1);
      }
      if (code === "ArrowRight") {
        move(1);
      }
      if (code === "ArrowUp") {
        move(-COLUMNS);
      }
      if (code === "ArrowDown") {
        move(COLUMNS);
      }
      if (code === "Enter" && entries.length > 0) {
        onSelect(entries[Math.min(index, entries.length - 1)]);
      }
    },
  });

  const submitImport = (): void => {
    const trimmed = importPath.trim();
    if (trimmed === "") {
      return;
    }
    onImportPath(trimmed);
    setImportPath("");
  };

  return (
    <PickerShell title="Tag library" subtitle="← → ↑ ↓ to browse · Enter to load · Esc to close">
      {entries.length === 0 ? (
        <div className={css.pickerEmpty}>No images yet — press C to upload a PNG.</div>
      ) : (
        <div className={css.pickerGrid}>
          {entries.map((rid, entryIndex) => (
            <button
              key={rid}
              className={
                entryIndex === index ? `${css.pickerItem} ${css.pickerItemActive}` : css.pickerItem
              }
              onMouseEnter={() => setIndex(entryIndex)}
              onClick={() => onSelect(rid)}
            >
              <div className={css.pickerThumb}>
                {urls[rid] != null ? (
                  <img src={urls[rid]} alt={names[rid] ?? "tag"} />
                ) : (
                  <span className={css.pickerLoading}>…</span>
                )}
              </div>
              <div className={css.pickerName}>{names[rid] ?? "loading…"}</div>
            </button>
          ))}
        </div>
      )}

      <div className={css.pickerImport}>
        <label className={css.pickerImportLabel} htmlFor="tag-import-path">
          Already in the media set? Type its file name to add it here.
        </label>
        <div className={css.pickerImportRow}>
          <input
            id="tag-import-path"
            className={css.pickerInput}
            value={importPath}
            placeholder="logo.png"
            autoComplete="off"
            onChange={(event) => setImportPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submitImport();
              }
            }}
          />
          <button className={css.pickerImportButton} onClick={submitImport}>
            Add
          </button>
        </div>
      </div>
    </PickerShell>
  );
}

export default TagPicker;
