import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { forgetAll, memoryCount } from "@/agents/brain/memory";
import { agentUserId } from "@/agents/config/identity";
import { storeJev, storeJevOff, storedJevKey, storedJevModel } from "@/agents/config/session";
import { isOperator } from "@/agents/config/operators";
import { PERSONAS, type Persona } from "@/agents/config/personas";
import {
  AGENT_MODELS,
  type AgentModelName,
  QUERY_NAMES,
  availableQueries,
  isAgentModel,
} from "@/agents/data/brainClient";
import { AgentHost, type HostSnapshot } from "@/agents/host/AgentHost";
import type { AgentSnapshot } from "@/agents/host/Agent";
import { allowedLevels, levelGeometry } from "@/agents/world/levels";
import { cachedDisplayName, fetchDisplayName } from "@/foundry/identity";
import { listHats } from "@/foundry/wearables";
import styles from "@/agents/host/AgentConsole.module.css";

/**
 * /agents — where AI players are started, watched and stopped.
 *
 * The agents run in this tab (see AgentHost), so this page is both their
 * control panel and their home: closing it despawns them. The OpenRouter key
 * for Jev is entered here and kept only for this browser session — never in
 * the bundle, which every Dechoverse player downloads.
 */

const SETTINGS_STORAGE = "dechoverse-agent-settings";

interface PersonaSettings {
  model: AgentModelName;
  levelKey: string;
  hat: string | null;
  color: string;
}

function defaultSettings(persona: Persona): PersonaSettings {
  return {
    model: persona.model,
    levelKey: allowedLevels(agentUserId(persona.name))[0],
    hat: persona.hat,
    color: persona.color,
  };
}

function loadSettings(): Record<string, PersonaSettings> {
  const settings: Record<string, PersonaSettings> = {};
  let stored: Record<string, Partial<PersonaSettings>> = {};
  try {
    stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE) ?? "{}") as Record<
      string,
      Partial<PersonaSettings>
    >;
  } catch {
    stored = {};
  }
  for (const persona of PERSONAS) {
    const base = defaultSettings(persona);
    const saved = stored[persona.id] ?? {};
    settings[persona.id] = {
      model: saved.model != null && isAgentModel(saved.model) ? saved.model : base.model,
      levelKey:
        saved.levelKey != null && allowedLevels(agentUserId(persona.name)).includes(saved.levelKey)
          ? saved.levelKey
          : base.levelKey,
      hat: saved.hat !== undefined ? saved.hat : base.hat,
      color: saved.color ?? base.color,
    };
  }
  return settings;
}

function saveSettings(settings: Record<string, PersonaSettings>): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings));
  } catch {
    // Defaults next time.
  }
}

function AgentConsole(): React.ReactElement {
  const hostRef = useRef<AgentHost | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [apiKey, setApiKey] = useState(storedJevKey);
  const [jevModel, setJevModel] = useState(storedJevModel);
  const [settings, setSettings] = useState(loadSettings);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [notice, setNotice] = useState<string | null>(null);

  const nameQuery = useQuery({
    queryKey: ["agents-console-name"],
    queryFn: fetchDisplayName,
    placeholderData: cachedDisplayName() ?? undefined,
    staleTime: Infinity,
  });
  const hatsQuery = useQuery({ queryKey: ["agents-console-hats"], queryFn: listHats, staleTime: Infinity });
  const queries = useMemo(availableQueries, []);

  // The host lives exactly as long as this page.
  useEffect(() => {
    const host = new AgentHost();
    hostRef.current = host;
    const key = storedJevKey();
    if (key !== "") {
      host.configureJev(key, storedJevModel());
    }
    const unsubscribe = host.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      host.dispose();
      hostRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onVisibility = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => saveSettings(settings), [settings]);

  const operator = isOperator(nameQuery.data ?? null);
  if (!operator) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>AI Players</h1>
        <p className={styles.muted}>
          {nameQuery.data ?? "You"} {"aren't"} on the list of agent operators. Ask whoever runs
          Dechoverse to add you in agents/config/operators.ts.
        </p>
        <Link className={styles.link} to="/">
          Back to Dechoverse
        </Link>
      </div>
    );
  }

  const host = hostRef.current;
  const running = new Map((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
  // The review query is optional: without it builds simply are not revisited.
  const missingQueries = (Object.keys(queries) as Array<keyof typeof queries>).filter(
    (kind) => kind !== "review" && !queries[kind],
  );

  const applyJev = (): void => {
    if (apiKey.trim() === "") {
      storeJevOff();
    } else {
      storeJev(apiKey, jevModel);
    }
    host?.configureJev(apiKey, jevModel);
    setNotice(apiKey.trim() === "" ? "Jev switched off: agents use simple heuristics." : "Jev key applied.");
  };

  const update = (personaId: string, change: Partial<PersonaSettings>): void => {
    setSettings((previous) => ({ ...previous, [personaId]: { ...previous[personaId], ...change } }));
    if (change.model != null) {
      host?.setModel(personaId, change.model);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>AI Players</h1>
          <p className={styles.muted}>
            Residents run in this tab as {nameQuery.data ?? "you"}. Closing it sends them home.
          </p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.spend}>
            Jev spend this session: ${(snapshot?.spentDollars ?? 0).toFixed(4)}
          </span>
          <button
            className={styles.danger}
            type="button"
            onClick={() => host?.despawnAll()}
            disabled={running.size === 0}
          >
            Despawn all
          </button>
          <Link className={styles.link} to="/">
            Back to Dechoverse
          </Link>
        </div>
      </header>

      {!visible && running.size > 0 && (
        <div className={styles.warning}>
          This tab is in the background, so the browser is slowing its timers and the agents will
          stutter. Keep it visible — a separate window works.
        </div>
      )}

      <section className={styles.panel}>
        <h2 className={styles.heading}>Setup</h2>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>OpenRouter key (for Jev)</span>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Jev model</span>
            <input value={jevModel} onChange={(event) => setJevModel(event.target.value)} />
          </label>
          <button className={styles.button} type="button" onClick={applyJev}>
            Apply
          </button>
        </div>
        <p className={styles.muted}>
          Kept for this browser session only. Use a dedicated key with a credit limit set in the
          OpenRouter dashboard.
        </p>
        {notice != null && <p className={styles.muted}>{notice}</p>}
        <ul className={styles.checks}>
          <li className={snapshot?.jevConfigured ? styles.ok : styles.bad}>
            Jev:{" "}
            {snapshot?.jevConfigured
              ? `on (${snapshot.jevModel})`
              : snapshot?.jevError != null
                ? `stopped — ${snapshot.jevError}`
                : "off — agents fall back to simple heuristics"}
          </li>
          <li className={missingQueries.length === 0 ? styles.ok : styles.bad}>
            Brain queries:{" "}
            {missingQueries.length === 0
              ? "all present in @ap-homepage/sdk"
              : `missing ${missingQueries.map((kind) => QUERY_NAMES[kind]).join(", ")} — publish llmfunctions/ and regenerate the SDK`}
          </li>
          <li className={queries.review ? styles.ok : styles.bad}>
            Build reviews:{" "}
            {queries.review
              ? "on — builders look at their work as it goes up"
              : "off — publish dechoAgentReview to let builders look at and extend their work"}
          </li>
          {snapshot?.presenceError != null && (
            <li className={styles.bad}>Presence publish: {snapshot.presenceError}</li>
          )}
          {snapshot?.marksError != null && (
            <li className={styles.bad}>Mark publish: {snapshot.marksError}</li>
          )}
          {Object.entries(snapshot?.links ?? {}).map(([levelKey, links]) =>
            links.presence != null || links.chat != null || links.marks != null ? (
              <li key={levelKey} className={styles.bad}>
                {levelKey}: {[links.presence, links.chat, links.marks].filter(Boolean).join(" · ")}
              </li>
            ) : null,
          )}
        </ul>
      </section>

      <section className={styles.grid}>
        {PERSONAS.map((persona) => (
          <ResidentCard
            key={persona.id}
            persona={persona}
            settings={settings[persona.id]}
            live={running.get(persona.id) ?? null}
            hats={hatsQuery.data ?? []}
            onChange={(change) => update(persona.id, change)}
            onSpawn={() => host?.spawn(persona, settings[persona.id])}
            onDespawn={() => host?.despawn(persona.id)}
            onErase={async () => {
              const erased = (await host?.eraseMarksBy(persona.id)) ?? 0;
              setNotice(`Erased ${erased} marks by ${persona.name}.`);
            }}
            onForget={() => {
              forgetAll(persona.id);
              setNotice(`${persona.name} has forgotten everyone.`);
            }}
          />
        ))}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.heading}>Activity</h2>
        <ol className={styles.log}>
          {[...(snapshot?.log ?? [])].reverse().map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={styles[`log_${entry.kind}`]}>
              <time>{new Date(entry.at).toLocaleTimeString()}</time>
              <strong>{entry.agentName}</strong>
              <span className={styles.kind}>{entry.kind}</span>
              <span>{entry.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

interface ResidentCardProps {
  persona: Persona;
  settings: PersonaSettings;
  live: AgentSnapshot | null;
  hats: Array<{ path: string; name: string }>;
  onChange: (change: Partial<PersonaSettings>) => void;
  onSpawn: () => void;
  onDespawn: () => void;
  onErase: () => Promise<void>;
  onForget: () => void;
}

function ResidentCard({
  persona,
  settings,
  live,
  hats,
  onChange,
  onSpawn,
  onDespawn,
  onErase,
  onForget,
}: ResidentCardProps): React.ReactElement {
  const levels = allowedLevels(agentUserId(persona.name));
  return (
    <article className={styles.card} style={{ borderColor: settings.color }}>
      <div className={styles.cardHeader}>
        <span className={styles.swatch} style={{ background: settings.color }} />
        <h3>{agentUserId(persona.name)}</h3>
        <span className={live != null ? styles.badgeLive : styles.badge}>
          {live != null ? live.mode : "home"}
        </span>
      </div>
      <p className={styles.persona}>{persona.persona}</p>

      <div className={styles.controls}>
        <label className={styles.field}>
          <span>Model</span>
          <select
            value={settings.model}
            onChange={(event) =>
              isAgentModel(event.target.value) && onChange({ model: event.target.value })
            }
          >
            {AGENT_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Room</span>
          <select
            value={settings.levelKey}
            disabled={live != null}
            onChange={(event) => onChange({ levelKey: event.target.value })}
          >
            {levels.map((levelKey) => (
              <option key={levelKey} value={levelKey}>
                {levelGeometry(levelKey)?.label ?? levelKey}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Hat</span>
          <select
            value={settings.hat ?? ""}
            disabled={live != null}
            onChange={(event) => onChange({ hat: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">Bare head</option>
            {hats.map((hat) => (
              <option key={hat.path} value={hat.path}>
                {hat.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Colour</span>
          <input
            type="color"
            value={settings.color}
            disabled={live != null}
            onChange={(event) => onChange({ color: event.target.value })}
          />
        </label>
      </div>

      <div className={styles.actions}>
        {live == null ? (
          <button className={styles.button} type="button" onClick={onSpawn}>
            Spawn
          </button>
        ) : (
          <button className={styles.danger} type="button" onClick={onDespawn}>
            Despawn
          </button>
        )}
        <button
          className={styles.secondary}
          type="button"
          disabled={live == null}
          onClick={() => void onErase()}
          title="Erase every mark this agent made in its current room"
        >
          Erase builds
        </button>
        <button
          className={styles.secondary}
          type="button"
          onClick={onForget}
          title={`${memoryCount(persona.id)} memories`}
        >
          Forget
        </button>
      </div>

      {live != null && (
        <dl className={styles.stats}>
          <dt>Goal</dt>
          <dd>{live.goal ?? "—"}</dd>
          <dt>Talking to</dt>
          <dd>{live.partner ?? "—"}</dd>
          <dt>Building</dt>
          <dd>
            {live.plan != null ? `${live.plan.title} (${live.plan.placed}/${live.plan.total})` : "—"}
          </dd>
          <dt>Last said</dt>
          <dd>{live.lastSaid ?? "—"}</dd>
          <dt>Position</dt>
          <dd>{live.position.join(", ")}</dd>
          <dt>Jev</dt>
          <dd>
            {live.jev.calls} calls, {live.jev.failures} failed
            {live.jev.lastLatencyMs > 0 ? `, ${live.jev.lastLatencyMs} ms` : ""}
            {live.jev.error != null && <span className={styles.error}> — {live.jev.error}</span>}
          </dd>
          <dt>Brain</dt>
          <dd>
            {live.brain.calls} calls, {live.brain.failures} failed
            {live.brain.busy != null ? `, asking (${live.brain.busy})` : ""}
            {live.brain.error != null && <span className={styles.error}> — {live.brain.error}</span>}
          </dd>
          {live.reflexes != null && (
            <>
              <dt>Reflexes</dt>
              <dd className={styles.reflexes}>
                {live.reflexes.nextState != null &&
                  `next ${live.reflexes.nextState.choice}${
                    live.reflexes.nextState.confidence != null
                      ? ` (${Math.round(live.reflexes.nextState.confidence * 100)}%)`
                      : ""
                  }`}
                {live.reflexes.urgency != null && ` · urgency ${live.reflexes.urgency.toFixed(1)}`}
                {live.reflexes.addressedToMe != null &&
                  ` · addressed ${Math.round(live.reflexes.addressedToMe * 100)}%`}
              </dd>
            </>
          )}
        </dl>
      )}
    </article>
  );
}

export default AgentConsole;
