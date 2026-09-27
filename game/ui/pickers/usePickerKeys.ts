import { useEffect, useRef } from "react";

interface PickerKeys {
  /** Codes the picker acts on. Everything else is swallowed. */
  handled: readonly string[];
  /** Codes that close it, on top of `handled`. Escape is always one. */
  closeWith?: readonly string[];
  onKey: (code: string, event: KeyboardEvent) => void;
  onClose: () => void;
}

/**
 * Keyboard handling for an open chooser.
 *
 * Registered in the capture phase and stopping propagation on *everything*,
 * because the player's movement, tools and navigation are all bound on window:
 * a key that is merely unhandled here would otherwise still walk them across
 * the room while they browse. Typing in a text field inside the picker is let
 * through, since a path or a message has to be typeable.
 *
 * The callbacks are held in refs, so a caller does not have to memoise them —
 * DrawPicker's copy of this had no dependency array at all and re-subscribed
 * on every render.
 */
export function usePickerKeys({ handled, closeWith, onKey, onClose }: PickerKeys): void {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handledRef = useRef(handled);
  handledRef.current = handled;
  const closeWithRef = useRef(closeWith);
  closeWithRef.current = closeWith;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Let a field inside the picker receive normal typing, but keep the
      // keystrokes out of the game underneath.
      if ((event.target as HTMLElement | null)?.tagName === "INPUT") {
        event.stopPropagation();
        if (event.code === "Escape") {
          onCloseRef.current();
        }
        return;
      }

      const closes = event.code === "Escape" || closeWithRef.current?.includes(event.code) === true;
      if (!closes && !handledRef.current.includes(event.code)) {
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (closes) {
        onCloseRef.current();
        return;
      }
      onKeyRef.current(event.code, event);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
