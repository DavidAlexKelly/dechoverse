import React, { useState } from "react";
import css from "@/game/ui/pickers/Picker.module.css";
import { PickerShell } from "@/game/ui/pickers/PickerShell";
import { usePickerKeys } from "@/game/ui/pickers/usePickerKeys";

/** What the drawing tool is currently doing. */
export type DrawMode = "paint" | "tag";

interface Entry {
  /** Null for an action rather than a mode, like uploading an image. */
  mode: DrawMode | null;
  name: string;
  description: string;
  glyph: string;
}

const ENTRIES: Entry[] = [
  { mode: "paint", name: "Paint", description: "Hold to spray · pick a colour below", glyph: "🎨" },
  { mode: "tag", name: "Tag", description: "Paste an image · V opens the gallery", glyph: "🖼" },
  {
    mode: null,
    name: "Upload PNG",
    description: "Add an image to the tag library",
    glyph: "⬆",
  },
];

const HANDLED = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"] as const;

interface DrawPickerProps {
  selected: DrawMode;
  onSelect: (mode: DrawMode) => void;
  /** Triggers the file dialog, which needs the click to be a user gesture. */
  onUpload: () => void;
  onClose: () => void;
}

/**
 * Paint and tags are two ways of marking a surface, so they live under one
 * tool and swap here rather than taking a slot each on the bar.
 *
 * Arrow keys move, Enter equips, Escape or F closes.
 */
function DrawPicker({
  selected,
  onSelect,
  onUpload,
  onClose,
}: DrawPickerProps): React.ReactElement {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      ENTRIES.findIndex((entry) => entry.mode === selected),
    ),
  );

  const choose = (entry: Entry): void => {
    if (entry.mode == null) {
      onUpload();
      return;
    }
    onSelect(entry.mode);
  };

  usePickerKeys({
    handled: HANDLED,
    closeWith: ["KeyF"],
    onClose,
    onKey: (code) => {
      if (code === "ArrowLeft" || code === "ArrowUp") {
        setIndex((previous) => Math.max(0, previous - 1));
      }
      if (code === "ArrowRight" || code === "ArrowDown") {
        setIndex((previous) => Math.min(ENTRIES.length - 1, previous + 1));
      }
      if (code === "Enter") {
        choose(ENTRIES[Math.min(index, ENTRIES.length - 1)]);
      }
    },
  });

  return (
    <PickerShell title="Draw" subtitle="← → to browse · Enter to equip · Esc to close">
      <div className={css.pickerGrid}>
        {ENTRIES.map((entry, position) => (
          <button
            key={entry.name}
            className={
              position === index ? `${css.pickerItem} ${css.pickerItemActive}` : css.pickerItem
            }
            onMouseEnter={() => setIndex(position)}
            onClick={() => choose(entry)}
          >
            <div className={css.pickerThumb}>
              <span className={css.objectGlyph}>{entry.glyph}</span>
            </div>
            <div className={css.pickerName}>{entry.name}</div>
            <div className={css.objectCaption}>{entry.description}</div>
          </button>
        ))}
      </div>
    </PickerShell>
  );
}

export default DrawPicker;
