import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptLine } from "@/game/state/useAgentHost";
import chatCss from "@/game/ui/ChatComposer.module.css";
import css from "@/game/ui/CommandLine.module.css";

interface CommandLineProps {
  onRun: (line: string) => void;
  onClose: () => void;
  transcript: TranscriptLine[];
  history: string[];
}

/**
 * The "\" command line.
 *
 * The same box as the "/" chat composer, but nothing typed here is said: each
 * line is run as a command (see agents/commands/commands.ts), and the box
 * stays open so the answer can be read. Up and down walk back through earlier
 * commands. Like the composer it keeps pointer lock, since it is keyboard only.
 */
function CommandLine({ onRun, onClose, transcript, history }: CommandLineProps): React.ReactElement {
  const [text, setText] = useState("");
  const [recall, setRecall] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Movement and tools are bound on window; nothing typed here may reach them.
      event.stopPropagation();

      if (event.key === "Enter") {
        event.preventDefault();
        const trimmed = text.trim();
        if (trimmed !== "") {
          onRun(trimmed);
        }
        setText("");
        setRecall(null);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowUp" && history.length > 0) {
        event.preventDefault();
        const index = recall == null ? history.length - 1 : Math.max(0, recall - 1);
        setRecall(index);
        setText(history[index]);
        return;
      }
      if (event.key === "ArrowDown" && recall != null) {
        event.preventDefault();
        const index = recall + 1;
        if (index >= history.length) {
          setRecall(null);
          setText("");
        } else {
          setRecall(index);
          setText(history[index]);
        }
      }
    },
    [text, history, recall, onRun, onClose],
  );

  return (
    <div className={css.commandLine}>
      {transcript.length > 0 && (
        <ol ref={scrollRef} className={css.transcript}>
          {transcript.map((line) => (
            <li key={line.id} className={css[line.kind]}>
              {line.kind === "input" ? `> ${line.text}` : line.text}
            </li>
          ))}
        </ol>
      )}
      <div className={`${chatCss.chatComposer} ${css.inputRow}`}>
        <span className={`${chatCss.chatPrompt} ${css.prompt}`}>CMD</span>
        <input
          ref={inputRef}
          className={chatCss.chatInput}
          type="text"
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder='Type a command · "help" lists them · Enter runs · Esc closes'
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
}

export default CommandLine;
