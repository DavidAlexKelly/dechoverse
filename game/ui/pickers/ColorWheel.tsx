import React, { useCallback } from "react";
import css from "@/game/ui/pickers/ColorWheel.module.css";
import { PickerShell } from "@/game/ui/pickers/PickerShell";
import { usePickerKeys } from "@/game/ui/pickers/usePickerKeys";

/**
 * Shortcuts for colours the wheel cannot reach: it only spans white to vivid,
 * so every neutral and every dark, desaturated brown needs a swatch. The wood
 * tones match the furniture, for building things that go with the props.
 */
const BUILDING_PRESETS = [
  "#3f4247", // default dark grey
  "#1a1c20", // near black
  "#8d949e", // mid grey
  "#f2f2f2", // off white
  "#6b4b2a", // dark walnut
  "#8b5e34", // medium wood
  "#a9743f", // furniture wood
  "#c89b6a", // light pine
];

/** HSL to hex, so the picked colour can travel on a stream as a string. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number): number => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * value);
  };
  const toHex = (value: number): string => value.toString(16).padStart(2, "0");
  return `#${toHex(channel(0))}${toHex(channel(8))}${toHex(channel(4))}`;
}

/** Opacity the slider snaps to, so a shade can be hit again deliberately. */
const OPACITY_STEP = 0.05;

interface ColorWheelBodyProps {
  color: string;
  onChange: (color: string) => void;
  /**
   * How see-through the thing being coloured is, and how to change it.
   *
   * Both or neither: the slider appears only where opacity means something,
   * which is blocks. Spray paint is already a thin translucent film and has
   * no second thing to vary, and a translucent player would be a hiding place.
   */
  opacity?: number;
  onOpacityChange?: (opacity: number) => void;
  /** Faintest the slider will go. A block nobody can see is still solid. */
  minOpacity?: number;
  /** Swatches under the wheel. Defaults to the building tones. */
  presets?: readonly string[];
}

/**
 * The wheel itself: a hue ring that desaturates toward the centre, an optional
 * opacity track, and swatches for the colours a hue ring cannot reach.
 *
 * Separate from the chooser below so it can also sit inside a bigger panel —
 * the character screen puts it beside a preview of your avatar.
 */
export function ColorWheelBody({
  color,
  onChange,
  opacity,
  onOpacityChange,
  minOpacity = 0.2,
  presets = BUILDING_PRESETS,
}: ColorWheelBodyProps): React.ReactElement {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const radius = rect.width / 2;
      const dx = event.clientX - rect.left - radius;
      const dy = event.clientY - rect.top - radius;

      const distance = Math.min(1, Math.hypot(dx, dy) / radius);
      // Screen y grows downward, so this angle already runs clockwise; the
      // +90 lines it up with the conic gradient, which starts at the top.
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;

      onChange(hslToHex(hue, 100, 100 - distance * 50));
    },
    [onChange],
  );

  /**
   * Sets opacity from where the track was clicked: top solid, bottom faint, so
   * it fills upward the way a level does.
   *
   * Click to place rather than drag to move, because the pointer is locked
   * while a chooser is open and the cursor on screen is one the game draws.
   * The DOM never sees the mouse move, so a dragged handle — or a native range
   * input, which is the same thing — would never move. The colour wheel above
   * works from a click position for exactly this reason.
   */
  const handleOpacityClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (onOpacityChange == null) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
      // The track spans the usable range rather than 0..1, so the bottom of it
      // is the faintest allowed rather than a stretch of nothing.
      const value = minOpacity + fraction * (1 - minOpacity);
      const snapped = Math.round(value / OPACITY_STEP) * OPACITY_STEP;
      onOpacityChange(Math.max(minOpacity, Math.min(1, Number(snapped.toFixed(2)))));
    },
    [onOpacityChange, minOpacity],
  );

  const showOpacity = opacity != null && onOpacityChange != null;
  /** Where the handle sits, as a percentage up the track. */
  const handleOffset = showOpacity
    ? ((Math.max(minOpacity, Math.min(1, opacity)) - minOpacity) / (1 - minOpacity)) * 100
    : 0;
  /**
   * Two stops of the current colour, full strength down to the faintest the
   * slider allows, so the track previews the range it sets.
   */
  const faintest = `${color}${Math.round(minOpacity * 255)
    .toString(16)
    .padStart(2, "0")}`;

  return (
    <div className={css.wheelPanel}>
      <div className={css.wheelRow}>
        <button
          type="button"
          className={css.wheelHit}
          aria-label="Pick a colour"
          onClick={() => undefined}
        >
          <div className={css.wheel} onClick={handleClick} role="presentation">
            <div className={css.wheelCentre} style={{ backgroundColor: color }} />
          </div>
        </button>

        {showOpacity && (
          <div className={css.opacityColumn}>
            <button
              type="button"
              className={css.wheelHit}
              aria-label="Pick an opacity"
              onClick={() => undefined}
            >
              <div className={css.opacityTrack} onClick={handleOpacityClick} role="presentation">
                {/* Over a checkerboard, so faint reads as see-through
                      rather than as simply darker. */}
                <div
                  className={css.opacityFill}
                  style={{
                    backgroundImage: `linear-gradient(to bottom, ${color}, ${faintest})`,
                  }}
                />
                <div className={css.opacityHandle} style={{ bottom: `${handleOffset}%` }} />
              </div>
            </button>
            <div className={css.opacityValue}>{Math.round(opacity * 100)}%</div>
          </div>
        )}
      </div>
      <div className={css.wheelPresets}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={`Use ${preset}`}
            className={
              preset.toLowerCase() === color.toLowerCase()
                ? `${css.wheelPreset} ${css.wheelPresetActive}`
                : css.wheelPreset
            }
            style={{ backgroundColor: preset }}
            onClick={() => onChange(preset)}
          />
        ))}
      </div>
    </div>
  );
}

interface ColorWheelProps extends ColorWheelBodyProps {
  /** What is being coloured, since the same wheel serves paint and blocks. */
  title: string;
  onClose: () => void;
}

/** The wheel as a chooser of its own, opened with C while a tool is in hand. */
function ColorWheel({ title, onClose, ...body }: ColorWheelProps): React.ReactElement {
  // Captured and stopped like the other choosers, so the player cannot walk or
  // shoot while picking a colour. There is nothing to browse here, so every
  // key this picker takes an interest in simply closes it.
  usePickerKeys({
    handled: [],
    closeWith: ["KeyC", "Enter"],
    onClose,
    onKey: () => undefined,
  });

  const showOpacity = body.opacity != null && body.onOpacityChange != null;

  return (
    <PickerShell
      title={title}
      subtitle={
        showOpacity
          ? "Click the wheel, a swatch, or the bar for opacity · C or Esc to close"
          : "Click the wheel or a swatch · C or Esc to close"
      }
    >
      <ColorWheelBody {...body} />
    </PickerShell>
  );
}

export default ColorWheel;
