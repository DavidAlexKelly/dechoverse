import { useCallback, useEffect, useRef, useState } from "react";
import { type CommandResult, type CommandRoom, runCommand } from "@/agents/commands/commands";
import { logJevStatus } from "@/agents/brain/jevLog";
import { storedJevKey, storedJevModel } from "@/agents/config/session";
import { AgentHost } from "@/agents/host/AgentHost";
import type { Pose } from "@/game/state/usePresence";

/** One line of the command line's scrollback. */
export interface TranscriptLine {
  id: number;
  kind: "input" | "output" | "error";
  text: string;
}

const TRANSCRIPT_LIMIT = 60;
const HISTORY_LIMIT = 30;

/**
 * The AI players this game tab is running, and the command line that runs
 * them.
 *
 * The host is created on the first command rather than on load, so a player
 * who never opens the command line pays nothing for it. Agents live as long
 * as this tab does and stay in the room they were created in when the player
 * walks on — everyone else sees them there regardless.
 */
export function useAgentHost(
  room: CommandRoom,
  poseRef: React.MutableRefObject<Pose | null>,
): {
  run: (line: string) => CommandResult;
  transcript: TranscriptLine[];
  history: string[];
  agentCount: number;
} {
  const hostRef = useRef<AgentHost | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const serial = useRef(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [agentCount, setAgentCount] = useState(0);

  useEffect(
    () => () => {
      hostRef.current?.dispose();
      hostRef.current = null;
    },
    [],
  );

  const host = useCallback((): AgentHost => {
    if (hostRef.current == null) {
      const created = new AgentHost();
      const key = storedJevKey();
      if (key !== "") {
        created.configureJev(key, storedJevModel());
      } else {
        logJevStatus(
          false,
          'no key: VITE_OPENROUTER_API_KEY was empty in this build (restart the dev server / rebuild after editing .env) and none was typed with "jevkey <key>"',
        );
      }
      let seenUpTo = Date.now();
      created.subscribe((snapshot) => {
        setAgentCount(snapshot.agents.length);
        // Agents' errors — a brain query failing, Jev unreachable — land in
        // the command line, so the reason an agent is silent is visible
        // without opening the developer tools.
        const fresh = snapshot.log.filter((entry) => entry.kind === "error" && entry.at > seenUpTo);
        if (fresh.length === 0) {
          return;
        }
        seenUpTo = Math.max(...fresh.map((entry) => entry.at));
        setTranscript((previous) => {
          const next = [...previous];
          for (const entry of fresh) {
            const text = `${entry.agentName}: ${entry.text}`;
            // The same failure repeating (a retry) is said once.
            if (next.length > 0 && next[next.length - 1].text === text) {
              continue;
            }
            next.push({ id: serial.current++, kind: "error", text });
          }
          return next.slice(-TRANSCRIPT_LIMIT);
        });
      });
      hostRef.current = created;
    }
    return hostRef.current;
  }, []);

  const run = useCallback(
    (line: string): CommandResult => {
      const pose = poseRef.current;
      const result = runCommand(line, {
        host: host(),
        room: roomRef.current,
        pose: pose == null ? null : { x: pose.x, z: pose.z, yaw: pose.yaw },
      });
      setTranscript((previous) => {
        const next = [...previous, { id: serial.current++, kind: "input" as const, text: line }];
        for (const text of result.lines) {
          next.push({ id: serial.current++, kind: result.ok ? "output" : "error", text });
        }
        return next.slice(-TRANSCRIPT_LIMIT);
      });
      setHistory((previous) =>
        [...previous.filter((entry) => entry !== line), line].slice(-HISTORY_LIMIT),
      );
      return result;
    },
    [host, poseRef],
  );

  return { run, transcript, history, agentCount };
}
