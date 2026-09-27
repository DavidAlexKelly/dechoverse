import React, { useEffect, useRef, useState } from "react";
import css from "@/game/ui/VirtualCursor.module.css";

/**
 * A cursor drawn by the game, for use while the pointer is locked.
 *
 * Pointer lock hides the real cursor and pins it, but still reports relative
 * movement — so a position can be accumulated from that and drawn. The point
 * is that menus stay clickable without ever handing the cursor back to the
 * desktop: it cannot leave the window, and there is no lock-and-unlock dance
 * around opening a chooser.
 *
 * Hit testing is done here rather than by the browser, because as far as the
 * DOM is concerned the mouse never moves.
 */
function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function VirtualCursor({ active }: { active: boolean }): React.ReactElement | null {
  const [point, setPoint] = useState(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }));
  const pointRef = useRef(point);
  /** What the cursor is currently over, so enter and leave can be synthesised. */
  const overRef = useRef<Element | null>(null);

  // Start from the middle each time, so it is never lost off in a corner from
  // whenever it was last used.
  useEffect(() => {
    if (!active) {
      return;
    }
    const centre = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    pointRef.current = centre;
    setPoint(centre);
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const move = (event: MouseEvent): void => {
      const next = {
        x: clamp(pointRef.current.x + event.movementX, window.innerWidth - 1),
        y: clamp(pointRef.current.y + event.movementY, window.innerHeight - 1),
      };
      pointRef.current = next;
      setPoint(next);

      const element = document.elementFromPoint(next.x, next.y);
      const previous = overRef.current;
      if (element === previous) {
        return;
      }

      // React builds onMouseEnter and onMouseLeave out of mouseover and
      // mouseout, so dispatching those gives real hover highlighting without
      // any menu needing to know this cursor exists.
      previous?.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: element,
          clientX: next.x,
          clientY: next.y,
        }),
      );
      element?.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: previous,
          clientX: next.x,
          clientY: next.y,
        }),
      );
      overRef.current = element;
    };

    const press = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      // Captured and stopped so the press cannot also reach the game and fire
      // whatever tool is in hand.
      event.preventDefault();
      event.stopPropagation();

      const { x, y } = pointRef.current;
      const target = document.elementFromPoint(x, y);
      if (!(target instanceof HTMLElement)) {
        return;
      }
      // A text field has to be focused as well as clicked, since a click alone
      // does not move focus and the field would then swallow nothing.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.focus();
      }
      // Dispatched rather than target.click(), which reports the click at the
      // origin. Anything that reads the position — the colour wheel works out
      // hue from where inside it you clicked — would otherwise always see the
      // top-left corner.
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mousedown", press, true);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mousedown", press, true);
      // Leave whatever was hovered, or it stays highlighted after closing.
      overRef.current?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      overRef.current = null;
    };
  }, [active]);

  if (!active) {
    return null;
  }
  return <div className={css.virtualCursor} style={{ left: point.x, top: point.y }} />;
}

export default VirtualCursor;
