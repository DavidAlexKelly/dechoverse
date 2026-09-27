import React, { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_LENGTH } from "@/game/state/speech";
import css from "@/game/ui/ChatComposer.module.css";

interface ChatComposerProps {
  onSend: (text: string) => void;
  onClose: () => void;
  /** Set while the previous message is still on screen. */
  lockedUntil: number | null;
}

/**
 * The "/" message box.
 *
 * Rendered inline in the HUD rather than as a modal, and deliberately does not
 * release pointer lock the way the tag and create pickers do: those are
 * mouse-driven, this is keyboard only. Key events arrive perfectly well while
 * the pointer is locked, so keeping the lock means the player is not forced to
 * click to start moving again afterwards.
 */
function ChatComposer({ onSend, onClose, lockedUntil }: ChatComposerProps): React.ReactElement {
  const [text, setText] = useState("");
  const [remaining, setRemaining] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Take the keyboard immediately, so the player can just start typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Count the previous message down, if one is still being spoken.
  useEffect(() => {
    if (lockedUntil == null) {
      setRemaining(0);
      return;
    }
    const update = (): void => setRemaining(Math.max(0, lockedUntil - Date.now()));
    update();
    const interval = window.setInterval(update, 100);
    return () => window.clearInterval(interval);
  }, [lockedUntil]);

  const locked = remaining > 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Movement and tools are bound on window, so nothing typed in here may
      // be allowed to reach them. Game and Player also gate themselves
      // while this is open; belt and braces, because a stuck movement key is
      // a genuinely annoying bug to hit.
      event.stopPropagation();

      if (event.key === "Enter") {
        event.preventDefault();
        if (locked) {
          return;
        }
        const trimmed = text.trim();
        if (trimmed !== "") {
          onSend(trimmed);
        }
        onClose();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [text, locked, onSend, onClose],
  );

  return (
    <div className={css.chatComposer}>
      <span className={css.chatPrompt}>SAY</span>
      <input
        ref={inputRef}
        className={css.chatInput}
        type="text"
        value={text}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder={
          locked
            ? `Still speaking… ${(remaining / 1000).toFixed(1)}s`
            : "Type a message · Enter sends · Esc cancels"
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => event.stopPropagation()}
      />
      <span className={locked ? `${css.chatCount} ${css.chatCountLocked}` : css.chatCount}>
        {locked ? `${Math.ceil(remaining / 1000)}s` : MAX_MESSAGE_LENGTH - text.length}
      </span>
    </div>
  );
}

export default ChatComposer;
