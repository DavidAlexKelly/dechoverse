import React, { useEffect, useMemo, useState } from "react";
import type { ObjectModel } from "@/foundry/models";
import { objectThumbnail } from "@/foundry/thumbnails";
import css from "@/game/ui/pickers/Picker.module.css";
import { PickerShell } from "@/game/ui/pickers/PickerShell";
import { usePickerKeys } from "@/game/ui/pickers/usePickerKeys";
import { modelKind } from "@/game/world/furnitureCatalog";

/**
 * Everything the create tool can do: the terrain verbs, the two built-in
 * props, or `model:<path>` for anything in the [AP] Objects pack.
 */
export type CreateMode = string;

interface Entry {
  mode: CreateMode;
  name: string;
  description?: string;
  glyph: string;
  /** Set for models, which get a rendered preview instead of a glyph. */
  modelPath?: string;
}

interface Section {
  title: string;
  entries: Entry[];
}

interface Tab {
  title: string;
  /** Sub-tabs. A tab with nothing to subdivide has a single unnamed one. */
  sections: Section[];
}

/** Only offered where there is terrain to shape. */
const TERRAIN_ENTRIES: Entry[] = [
  { mode: "dig", name: "Dig", description: "Scoop a hollow out of the ground", glyph: "⛏" },
  {
    mode: "flatten",
    name: "Flatten",
    description: "Hold and sweep to level the ground",
    glyph: "🪚",
  },
  {
    mode: "restore",
    name: "Restore",
    description: "Hold and sweep to put the ground back",
    glyph: "🌱",
  },
];

/** A player's door into their own room, which is a thing you place. */
const MYSPACE_ENTRIES: Entry[] = [
  {
    mode: "door",
    name: "Door",
    description: "Put down your door · one each, anywhere",
    glyph: "🚪",
  },
];

/**
 * Blocks work anywhere: a cube is a thing placed in the room, not a change to
 * the terrain, so it is not gated with digging and levelling.
 *
 * The two hand-built shapes that used to sit here are gone now the model pack
 * covers furniture properly. Ones already placed still render — they are just
 * no longer offered.
 */
const BLOCK_ENTRIES: Entry[] = [
  { mode: "build", name: "Build", description: "Place a cube, snapped to the face", glyph: "🧱" },
];

const HANDLED = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab"] as const;

/** "living room" -> "Living room", "living_room" -> "Living room". */
function titleCase(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? spaced : spaced[0].toUpperCase() + spaced.slice(1);
}

/**
 * A model's preview, rendered from the model itself the first time it is
 * shown and cached from then on. Falls back to the glyph until it arrives, so
 * the grid never jumps around as images land.
 */
function Thumb({ entry }: { entry: Entry }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (entry.modelPath == null) {
      return;
    }
    let cancelled = false;
    void objectThumbnail(entry.modelPath)
      .then((rendered) => {
        if (!cancelled) {
          setUrl(rendered);
        }
      })
      .catch(() => {
        // A model that will not render keeps its glyph.
      });
    return () => {
      cancelled = true;
    };
  }, [entry.modelPath]);

  return (
    <div className={css.pickerThumb}>
      {url == null ? (
        <span className={css.objectGlyph}>{entry.glyph}</span>
      ) : (
        <img className={css.pickerThumbImage} src={url} alt="" />
      )}
    </div>
  );
}

interface CreatePickerProps {
  selected: CreateMode;
  /** True in DechoWorld, where digging and building make sense. */
  allowTerrain: boolean;
  /** The model pack, already listed from the dataset. */
  models: ObjectModel[];
  onSelect: (mode: CreateMode) => void;
  onClose: () => void;
}

/**
 * What the create tool will make.
 *
 * Tabs and sub-tabs come from the folders the models sit in, so the pack
 * organises itself: furniture/living room/Chair_17.glb lands under
 * Furniture > Living room, and a new folder at either level becomes a new tab
 * with no code change.
 *
 * Tab switches category, up and down switch sub-category, left and right
 * browse, Enter equips, Escape closes. Keys are captured so the player cannot
 * move while it is open.
 */
function CreatePicker({
  selected,
  allowTerrain,
  models,
  onSelect,
  onClose,
}: CreatePickerProps): React.ReactElement {
  const tabs = useMemo(() => {
    const built: Tab[] = [];

    // Terrain is hidden outside DechoWorld rather than shown disabled: there
    // is nothing to dig in a flat room, so offering it would be noise.
    if (allowTerrain) {
      built.push({ title: "Terrain", sections: [{ title: "", entries: TERRAIN_ENTRIES }] });
    }
    built.push({ title: "Blocks", sections: [{ title: "", entries: BLOCK_ENTRIES }] });
    built.push({ title: "MySpace", sections: [{ title: "", entries: MYSPACE_ENTRIES }] });

    const byGroup = new Map<string, Map<string, Entry[]>>();
    for (const model of models) {
      const sections = byGroup.get(model.group) ?? new Map<string, Entry[]>();
      const entries = sections.get(model.category) ?? [];
      entries.push({
        mode: modelKind(model.path),
        name: model.name,
        glyph: "📦",
        modelPath: model.path,
      });
      sections.set(model.category, entries);
      byGroup.set(model.group, sections);
    }

    for (const group of [...byGroup.keys()].sort()) {
      const sections = byGroup.get(group) as Map<string, Entry[]>;
      built.push({
        title: titleCase(group),
        sections: [...sections.keys()].sort().map((category) => ({
          title: titleCase(category),
          entries: sections.get(category) as Entry[],
        })),
      });
    }

    return built;
  }, [allowTerrain, models]);

  /** Open on whichever tab and sub-tab hold the current selection. */
  const [tabIndex, setTabIndex] = useState(() => {
    const found = tabs.findIndex((tab) =>
      tab.sections.some((section) => section.entries.some((entry) => entry.mode === selected)),
    );
    return found === -1 ? 0 : found;
  });
  const [sectionIndex, setSectionIndex] = useState(0);

  const tab = tabs[Math.min(tabIndex, tabs.length - 1)];
  const sections = useMemo(() => tab?.sections ?? [], [tab]);
  const entries = useMemo(
    () => sections[Math.min(sectionIndex, sections.length - 1)]?.entries ?? [],
    [sections, sectionIndex],
  );

  const [index, setIndex] = useState(0);

  // Moving to another tab or sub-tab starts from its first entry rather than
  // keeping a position that meant something in a different list.
  useEffect(() => {
    setSectionIndex(0);
  }, [tabIndex]);
  useEffect(() => {
    setIndex(0);
  }, [tabIndex, sectionIndex]);

  usePickerKeys({
    handled: HANDLED,
    closeWith: ["KeyF"],
    onClose,
    onKey: (code, event) => {
      if (code === "Tab") {
        setTabIndex((previous) =>
          event.shiftKey
            ? (previous - 1 + tabs.length) % tabs.length
            : (previous + 1) % tabs.length,
        );
        return;
      }
      if (code === "ArrowUp") {
        setSectionIndex((previous) => Math.max(0, previous - 1));
        return;
      }
      if (code === "ArrowDown") {
        setSectionIndex((previous) => Math.min(sections.length - 1, previous + 1));
        return;
      }
      if (code === "ArrowLeft") {
        setIndex((previous) => Math.max(0, previous - 1));
      }
      if (code === "ArrowRight") {
        setIndex((previous) => Math.min(entries.length - 1, previous + 1));
      }
      if (code === "Enter" && entries.length > 0) {
        onSelect(entries[Math.min(index, entries.length - 1)].mode);
      }
    },
  });

  /** A single unnamed section is a tab with nothing to subdivide. */
  const showSections = sections.length > 1 || (sections[0]?.title ?? "") !== "";

  return (
    <PickerShell
      title="Create"
      subtitle="Tab switches category · ↑ ↓ sub-category · ← → to browse · Enter equips · F closes"
    >
      <div className={css.pickerTabs}>
        {tabs.map((entry, position) => (
          <button
            key={entry.title}
            className={
              position === tabIndex ? `${css.pickerTab} ${css.pickerTabActive}` : css.pickerTab
            }
            onClick={() => setTabIndex(position)}
          >
            {entry.title}
          </button>
        ))}
      </div>

      {showSections && (
        <div className={css.pickerSubTabs}>
          {sections.map((section, position) => (
            <button
              key={section.title}
              className={
                position === sectionIndex
                  ? `${css.pickerSubTab} ${css.pickerSubTabActive}`
                  : css.pickerSubTab
              }
              onClick={() => setSectionIndex(position)}
            >
              {section.title === "" ? "All" : section.title}
            </button>
          ))}
        </div>
      )}

      <div className={css.pickerGrid}>
        {entries.map((entry, position) => (
          <button
            key={entry.mode}
            className={
              position === index ? `${css.pickerItem} ${css.pickerItemActive}` : css.pickerItem
            }
            onMouseEnter={() => setIndex(position)}
            onClick={() => onSelect(entry.mode)}
          >
            <Thumb entry={entry} />
            <div className={css.pickerName}>{entry.name}</div>
            {entry.description != null && (
              <div className={css.objectCaption}>{entry.description}</div>
            )}
          </button>
        ))}
      </div>
    </PickerShell>
  );
}

export default CreatePicker;
