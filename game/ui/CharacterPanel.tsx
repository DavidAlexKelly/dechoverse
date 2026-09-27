import React, { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useQuery } from "@tanstack/react-query";
import type * as THREE from "three";
import { describeError } from "@/foundry/errors";
import { hatThumbnail } from "@/foundry/thumbnails";
import { type Wearable, listHats } from "@/foundry/wearables";
import { AVATAR_PALETTE } from "@/game/domain/appearance";
import type { Appearance } from "@/game/domain/types";
import { AvatarBody } from "@/game/render/AvatarBody";
import css from "@/game/ui/CharacterPanel.module.css";
import { ColorWheelBody } from "@/game/ui/pickers/ColorWheel";
import picker from "@/game/ui/pickers/Picker.module.css";
import { usePickerKeys } from "@/game/ui/pickers/usePickerKeys";

/** Radians per second the preview turns, so a hat can be seen from behind. */
const TURN_RATE = 0.55;

/**
 * How far the avatar is dropped so that the middle of it sits at the origin.
 *
 * The camera is left looking at the origin rather than aimed at the avatar's
 * chest: react-three-fiber owns the default camera and points it at the origin
 * when it sets it up and on resize, so a lookAt of our own is liable to be
 * quietly undone. Moving the subject instead cannot be overridden.
 */
const PREVIEW_DROP = 0.9;

/** The avatar in the preview, turning on the spot. */
function TurntableAvatar({ appearance }: { appearance: Appearance }): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (groupRef.current != null) {
      groupRef.current.rotation.y += delta * TURN_RATE;
    }
  });

  return (
    <group ref={groupRef} position={[0, -PREVIEW_DROP, 0]}>
      <AvatarBody appearance={appearance} />
    </group>
  );
}

/**
 * A preview of your own character.
 *
 * Its own canvas, which is the only way to see yourself in a game played from
 * behind your own eyes. Deliberately the same AvatarBody everyone else sees,
 * rather than a mock-up of one: a preview that was its own arrangement of
 * meshes would quietly stop matching the thing it previews.
 */
function Preview({ appearance }: { appearance: Appearance }): React.ReactElement {
  return (
    <div className={css.preview}>
      {/* Framed so a tall hat and the shadow puddle both stay in shot. */}
      <Canvas camera={{ position: [0, 0.05, 3.1], fov: 38 }}>
        <color attach="background" args={["#0c0a14"]} />
        <ambientLight intensity={0.5} />
        <hemisphereLight args={["#b98cff", "#1a1626", 0.6]} />
        <directionalLight position={[3, 6, 4]} intensity={1.5} />
        <directionalLight position={[-4, 2, -3]} intensity={0.5} color="#8ea2ff" />
        <TurntableAvatar appearance={appearance} />
      </Canvas>
    </div>
  );
}

/** One hat in the grid, with a preview rendered from the model itself. */
function HatThumb({ path }: { path: string }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hatThumbnail(path)
      .then((rendered) => {
        if (!cancelled) {
          setUrl(rendered);
        }
      })
      .catch(() => {
        // A hat that will not render keeps the placeholder glyph.
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className={picker.pickerThumb}>
      {url == null ? (
        <span className={picker.objectGlyph}>🎩</span>
      ) : (
        <img className={picker.pickerThumbImage} src={url} alt="" />
      )}
    </div>
  );
}

interface CharacterPanelProps {
  /** What the player looks like now. */
  appearance: Appearance;
  /** Called as choices are made, so the preview and the world both follow. */
  onChange: (appearance: Appearance) => void;
  onClose: () => void;
}

/**
 * The character screen, opened with H.
 *
 * Changes apply as they are made rather than on a Save button: the preview is
 * the confirmation, and the caller publishes when this closes — so a session
 * of fiddling is one record on the stream rather than one per click.
 */
function CharacterPanel({
  appearance,
  onChange,
  onClose,
}: CharacterPanelProps): React.ReactElement {
  const hatsQuery = useQuery({
    queryKey: ["wearable-hats"],
    queryFn: listHats,
    staleTime: Infinity,
  });
  const hats: Wearable[] = hatsQuery.data ?? [];

  /** Which part of the character the wheel is painting. */
  const [colorTarget, setColorTarget] = useState<"body" | "hat">("body");
  /**
   * The colour the wheel shows for the hat when none has been chosen.
   *
   * A hat with no tint has no single colour to report — it is whatever its
   * materials are — so the wheel starts from the body colour rather than
   * claiming the hat is currently white.
   */
  const wheelColor =
    colorTarget === "body" ? appearance.color : (appearance.hatColor ?? appearance.color);

  // Taking the hat off leaves nothing to paint, so the wheel goes back to the
  // body rather than sitting on a target that is not there.
  useEffect(() => {
    if (appearance.hat == null) {
      setColorTarget("body");
    }
  }, [appearance.hat]);

  usePickerKeys({
    handled: [],
    closeWith: ["KeyH", "Enter"],
    onClose,
    onKey: () => undefined,
  });

  return (
    <div className={css.backdrop}>
      <div className={css.panel}>
        <div className={css.header}>
          <div className={css.title}>Your character</div>
          <div className={css.subtitle}>
            Click a colour or a hat · everyone else sees it · H or Esc to close
          </div>
        </div>

        <div className={css.columns}>
          <Preview appearance={appearance} />

          <div className={css.controls}>
            <div className={css.sectionLabel}>Colour</div>
            {/*
             * One wheel, two things it can paint. Two wheels side by side
             * would not fit beside the preview, and stacking them would push
             * the hats off the bottom of the panel.
             */}
            <div className={picker.pickerSubTabs}>
              {(["body", "hat"] as const).map((target) => (
                <button
                  key={target}
                  className={
                    colorTarget === target
                      ? `${picker.pickerSubTab} ${picker.pickerSubTabActive}`
                      : picker.pickerSubTab
                  }
                  disabled={target === "hat" && appearance.hat == null}
                  onClick={() => setColorTarget(target)}
                >
                  {target === "body" ? "Body" : "Hat"}
                </button>
              ))}
              {colorTarget === "hat" && appearance.hatColor != null && (
                <button
                  className={picker.pickerSubTab}
                  onClick={() => onChange({ ...appearance, hatColor: null })}
                >
                  ↺ Original colours
                </button>
              )}
            </div>

            {colorTarget === "hat" && appearance.hat == null ? (
              <div className={picker.pickerEmpty}>Pick a hat below to paint it.</div>
            ) : (
              <ColorWheelBody
                color={wheelColor}
                presets={AVATAR_PALETTE}
                onChange={(color) =>
                  onChange(
                    colorTarget === "body"
                      ? { ...appearance, color }
                      : { ...appearance, hatColor: color },
                  )
                }
              />
            )}

            <div className={css.sectionLabel}>Hat</div>
            {hatsQuery.isLoading && (
              <div className={picker.pickerEmpty}>Looking in the wardrobe…</div>
            )}
            {hatsQuery.error != null && (
              <div className={picker.pickerEmpty}>
                Could not read the wearables pack: {describeError(hatsQuery.error)}
              </div>
            )}
            {!hatsQuery.isLoading && hatsQuery.error == null && hats.length === 0 && (
              <div className={picker.pickerEmpty}>No hats in the wearables pack yet.</div>
            )}
            <div className={picker.pickerGrid}>
              <button
                className={
                  appearance.hat == null
                    ? `${picker.pickerItem} ${picker.pickerItemActive}`
                    : picker.pickerItem
                }
                onClick={() => onChange({ ...appearance, hat: null })}
              >
                <div className={picker.pickerThumb}>
                  <span className={picker.objectGlyph}>🚫</span>
                </div>
                <div className={picker.pickerName}>No hat</div>
              </button>

              {hats.map((hat) => (
                <button
                  key={hat.path}
                  className={
                    appearance.hat === hat.path
                      ? `${picker.pickerItem} ${picker.pickerItemActive}`
                      : picker.pickerItem
                  }
                  onClick={() => onChange({ ...appearance, hat: hat.path })}
                >
                  <HatThumb path={hat.path} />
                  <div className={picker.pickerName}>{hat.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <button className={css.close} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

export default CharacterPanel;
