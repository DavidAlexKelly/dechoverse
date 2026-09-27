# Dechoverse AI Players – Design & Implementation Plan

**Goal**
Add autonomous "players" backed by language models to DechoWorld, and optionally to other levels. They should feel alive. They walk around, talk to humans and to each other, react to events, and build simple structures alone or together. The design borrows from Mindcraft but is much simpler, to fit Dechoverse's small action space and its stream-based multiplayer model.

**Core principle.** Everything an AI player does produces the same records a human client publishes. Nothing about AI players needs a new server, a new stream schema or special privileges.

| What the agent does | Stream (dataset RID in code) | Module that already writes it |
|---|---|---|
| Moves / looks | `[AP] Presence` (`PRESENCE_STREAM_DATASET_RID`) | `foundry/streams/presence.ts` → `publishPresence` |
| Speaks | `[AP] Chat Stream` (`CHAT_STREAM_DATASET_RID`) | `foundry/streams/chat.ts` → `publishChat` |
| Builds / paints / erases | `[AP] Server State` (`MARK_STREAM_DATASET_RID`) | `foundry/streams/marks.ts` → `publishMarks` |
| Looks like something | `[AP] Characters` (`CHARACTER_STREAM_DATASET_RID`) | `foundry/streams/characters.ts` → `publishCharacter` |

Human clients therefore render AI players with **zero changes**. They show up in `usePresence` as `RemotePlayer`s, their chat is spoken by `useChat`, and their cubes are folded by `useMarkSync`.

---

## 0. What the app is on Foundry (and why that matters)

Dechoverse is a **Developer Console application** of type *Client-facing*. It uses a public OAuth client with PKCE (`createPublicOauthClient` in `foundry/client.ts`) and is served through **Developer Console → Website hosting**. It is *not* a Workshop **custom widget** in the Foundry sense (a widget set built with `@osdk/widget.client`). That difference decides what AI players can do:

| | Developer Console hosted website (what we have) | Workshop custom widget (`@osdk/widget.*`) |
|---|---|---|
| Platform APIs (Streams, Datasets, AIP Agents, LLM proxy) | ✅ via `createPlatformClient` | ❌ "Non-Ontology APIs are not supported" |
| External requests (Jev) | ✅ CSP rules are configurable per website (already done for Jev) | ❌ widget CSP cannot be configured |
| `localStorage` / IndexedDB | ✅ | ❌ |

**Decision:** AI players live in the existing hosted website, as a new route. If we ever want them inside a Workshop module, embed the hosted site in an iframe widget rather than porting to a custom widget.

Docs: [Website hosting](https://www.palantir.com/docs/foundry/developer-console/deploy-custom-application-on-foundry/), [Custom widgets overview](https://www.palantir.com/docs/foundry/custom-widgets/overview/).

---

## 1. High-Level Architecture

```
┌───────────────────────────── Agent Host (browser tab: /agents) ─────────────────────────────┐
│                                                                                            │
│   WorldView (read side)                 Brain                        Body (write side)     │
│   ─────────────────────                 ─────                        ─────────────────     │
│   presence.ts  readPresence ─┐     ┌─ Layer 1: Game logic (TS) ─┐    publishPresence       │
│   chat.ts      readChat ─────┼──▶  │  Layer 2: Jev (TypeSafe)   │ ─▶ publishChat           │
│   marks.ts     readMarks ────┤     │  Layer 3: Foundry LLM      │    publishMarks          │
│   snapshots.ts (cold start) ─┘     └────────────────────────────┘    publishCharacter      │
│   worldgen.ts / collision.ts (pure, local)                                                 │
└──────────────┬──────────────────────────────┬──────────────────────────────┬───────────────┘
               │ Platform SDK (OAuth token)   │ fetch (Jev API key)          │ Platform SDK
               ▼                              ▼                              ▼
   Foundry Streams (high-scale)     api.typesafe.ai/v1/systemone     AIP Chatbot sessions  /
   /v2/highScale/streams/…                                           LLM proxy (Anthropic)
```

### Where the loop runs

| Phase | Runtime | Auth | Why |
|---|---|---|---|
| **MVP (Tiers 1–2)** | An **Agent Host** page at `/agents` in the existing website, running N agents in one tab | The signed-in operator's OAuth token (existing public client) | Reuses every stream module, `worldgen.ts` and `collision.ts` unchanged. No new infrastructure. Easy to debug. |
| **Later (Tier 3, always-on)** | A **Compute Module** in *pipeline mode* with **min replicas ≥ 1**, built with `@palantir/compute-module` | Job token / *Application permissions* service user | Agents keep living when nobody has the host tab open. It is the same TS code, just bundled into a container. |

Automate (object-change or time triggers) was considered and **rejected** for the loop. Time conditions run at most hourly, and "live" evaluation takes seconds to minutes. That is fine for daily reflection jobs but far too slow for a 400 ms reactive tick. ([Automate: streaming](https://www.palantir.com/docs/foundry/automate/streaming), [time conditions](https://www.palantir.com/docs/foundry/automate/condition-time))

---

## 2. Capability Tiers (phased roll-out)

| Tier | Name | Capabilities | Foundry pieces used |
|---|---|---|---|
| 1 | Social NPC | Walk, look, proximity chat, react to players | Streams (presence, chat, characters), Jev, AIP Chatbot **or** LLM proxy |
| 2 | Builder | + place/erase cubes, paint strokes, props | + mark stream writes, a structured plan call to the LLM |
| 3 | Full Agent | + goals, memory, multi-agent coordination, doors, admin control | + Ontology object types, Actions, Chatbot retrieval context, Compute Module |

---

## 3. Division of Labour

### A. Layer 1: Standard game logic (deterministic TypeScript, no AI)

Almost all of this **already exists** as pure functions:

| Need | Existing code to reuse |
|---|---|
| Terrain height in `world:plains` | `heightAt` / `buildTerrainSampler(craters, pads)` in `game/world/worldgen.ts`. These are pure and seeded, so no dataset read is needed. |
| Collision, gravity, stepping | `sweepHorizontal`, `sweepVertical`, `floorUnder`, `supportedAt`, `VoxelWorld` in `game/world/collision.ts` |
| Cube grid | `snapToCell`, `cellKey`, `buildVoxelMap`, `hasCube`, `CUBE_SIZE` in `game/world/voxels.ts` |
| Prop footprints | `obstacleFor` in `game/world/furnitureCatalog.ts` |
| Mark fold (newest record per `markId` wins) | Currently inside the `useMemo`s of `game/state/useMarkSync.ts`. **Extract it** into `game/domain/markFold.ts` so both the hook and the agents use it (see §9, step 1). |
| Hearing radius and shouting | `HEARING_RADIUS = 32`, `SHOUT_RADIUS = 45` in `useChat.ts`; `isShout`, `bubbleDurationMs`, `MAX_MESSAGE_LENGTH = 200` in `speech.ts` |
| Room boundaries | `ARENA_HALF_SIZE`, `MYSPACE_HALF_SIZE`, `myspaceLevelKey`/`myspaceOwner` in `game/world/level.ts` |
| Pose conventions | Presence `y` is **eye height**: feet + `EYE_HEIGHT` (1.7). `Avatars.tsx` subtracts it again. |

New deterministic code:
- **Steering / pathing**: A* over a 1 m grid built from `blockedAt`, falling back to straight-line steering with `sweepHorizontal` sliding.
- **Pose publisher**: a non-React port of the adaptive sampler in `usePresence.ts`. Keep a `PUBLISH_INTERVAL_MS` of 100 while moving and a `HEARTBEAT_MS` of 2000 while idle. Send `vx`/`vz` so humans' Hermite interpolation stays smooth, and `state: "left"` on shutdown.
- **Cooldowns & budgets**: a per-agent token bucket for chat (for example 1 message per `bubbleDurationMs(lastText)` plus 3 s), marks (for example 20 cubes/min) and LLM calls (see §8).
- **Spatial summariser**: turns the fold into the compact JSON `state` that Jev and the LLM receive (§7).

### B. Layer 2: Jev, the fast reactive layer (System-1)

**What it is.** Jev is TypeSafe AI's "System One" model. It never produces free text. One request carries a `state` plus a map of named, typed questions, and it answers all of them in a single parallel pass. There are three question types:

| Jev type | Returns | Use it for |
|---|---|---|
| `noul` | `{ noul: 0..1 }`, the probability that a statement is true | "Is this message addressed to me?", "Am I stuck?" |
| `choice` (≤ 255 labels) | `{ choice, confidence, probabilities }` | "Next state: IDLE / EXPLORE / SOCIAL / BUILD", "which colour fits" |
| `score` (2–10 ordered levels) | `{ score (can fall between levels), confidence, legend, probabilities }` | Urgency 0–10, "how interesting is this spot" |

**Wire format.** This is confirmed from the official SDK `@typesafe-ai/sdk@0.6.0`:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <JEV_API_KEY>
Content-Type: application/json

{
  "model": "jev-latest",
  "state": { ...compact agent state (§7)... },
  "questions": {
    "addressed_to_me": { "type": "noul",
      "instructions": "The newest chat message is directed at this agent (by name, by 'you' while facing it, or as a reply to its last message)." },
    "next_state": { "type": "choice",
      "instructions": "Best behavioural state for the agent right now.",
      "criteria": {
        "IDLE":    "Nothing nearby is worth attention.",
        "EXPLORE": "No one to talk to and no active build; wander toward open or unvisited space.",
        "SOCIAL":  "A human or agent within hearing range is engaging, or is likely to engage.",
        "BUILD":   "An active build goal exists and nothing social is more urgent." } },
    "urgency": { "type": "score",
      "instructions": "How urgently should the agent interrupt what it is doing?",
      "criteria": ["ignorable", "mild", "notable", "someone is waiting on me", "must respond now"] }
  }
}
```

The response is `{ model, answers: { addressed_to_me: { type:"noul", noul:0.93 }, next_state: { type:"choice", choice:"SOCIAL", confidence:0.88, probabilities:{…} }, urgency:{…} }, usage:{ input_tokens, output_tokens } }`. The request ID comes back in the `x-typesafe-request-id` header, so log it next to each decision.

**Calling it from the browser.** The official SDK refuses to run in a browser unless you pass `dangerouslyAllowBrowser: true`, and it targets Node ≥ 20. Use a ~60-line `fetch` wrapper in `agents/brain/jev.ts` instead. It should:
- Set a 2 s timeout with `AbortController`. That is much tighter than the SDK's 10 s default, because a late System-1 answer is worthless.
- Retry **once** on 429/5xx, honouring the `Retry-After` / `retry-after-ms` headers.
- Pass through the typed answers.

**Deployment facts:**
- The CSP entry for `https://api.typesafe.ai` is already in place.
- **Phase 0 must confirm that the API returns CORS headers** for the website's origin. The SDK authors clearly expect server-side use.
- **Key handling:** don't put the key in a `VITE_*` variable. Vite inlines those into the bundle, which every Dechoverse player downloads. Instead, the `/agents` page asks the operator to paste the key and keeps it in memory, or in `sessionStorage` at most. When agents move into a Compute Module (§10), the key moves into a Data Connection source credential.

**Cadence.** Don't tick blindly every 400 ms. Tick when the summarised `state` hash changes, with at most one tick per 400 ms and at least one per 5 s. Chat arrivals and a player entering 12 m trigger an immediate tick.

**Budget** (third-party-reported figures; verify against the TypeSafe dashboard):
- About $0.042 per 1M input tokens, with output free. One agent sending an ~800-token state at 2 ticks/s costs roughly **$0.25/hour**.
- A limit of about 1,200 req/min means **≤ 8 agents at 400 ms** per API key. Beyond that, batch several agents' questions into one request (question names prefixed `a1.`, `a2.`, and so on) or slow the tick.
- The context budget is 64k tokens for the state plus all questions, and 32k for the state plus the longest question. The §7 state is kept to ~1–2k tokens.

Typical question sets per state are in §6. Jev never writes chat, names or plans.

### C. Layer 3: Foundry LLM, the deliberative layer

It is called only for things that need language or planning: chat replies, choosing a new goal, build plans, negotiating, reflecting. There are two Foundry-native ways to reach a model. **Use both, for different jobs:**

#### C1. AIP Chatbot (Chatbot Studio) for SOCIAL: personality, memory, tools

"AIP Agent Studio" has been renamed **AIP Chatbot Studio**. The API namespace is still `aipAgents`, and the RIDs are `ri.aip-agents..*`.

- **Build in Chatbot Studio:** one chatbot, *"Dechoverse Resident"*.
  - **Instructions / system prompt:** Dechoverse rules, a speaking style limited to 200 characters (to match `MAX_MESSAGE_LENGTH`), and "reply with only the spoken line".
  - **Application variables** (string, `READ_ONLY` unless noted), filled on every turn through `parameterInputs`:
    - `agent_name`, `persona`, `current_goal` (`READ_WRITE`, so the model can change its own goal)
    - `world_summary` (the §7 JSON), `nearby_players`
  - **Retrieval context (Tier 3):** *Ontology context* over `DechoAgentMemory` objects (semantic top-K, which needs an embedding property) so each agent remembers people and past builds. Alternatively, *function-backed context* that takes the `MessageList` plus `agent_name` and returns `RetrievedContext`.
  - **Tools (Tier 3):**
    - *Action* tool → `remember-fact` (creates a `DechoAgentMemory`)
    - *Action* tool → `set-agent-goal`
    - *Object query* tool over `DechoAgent` (to know the other residents)
    - Use "Native" tool mode if the chosen model supports it.
  - **Session logging** → a streaming dataset, for auditing everything the agents said.
- **Call it from the host** with `@osdk/foundry.aipagents` (also exported as `AipAgents` from `@osdk/foundry`). It is **beta**, so pass `{ preview: true }`:

```ts
import { Sessions } from "@osdk/foundry.aipagents";

// once per NPC — concurrent continues on one session are not supported
const session = await Sessions.create(client, CHATBOT_RID, {}, { preview: true });

const result = await Sessions.blockingContinue(client, CHATBOT_RID, session.rid, {
  userInput: { text: `${speaker}: ${message}` },
  parameterInputs: {
    agent_name:    { type: "string", value: agent.name },
    persona:       { type: "string", value: agent.persona },
    current_goal:  { type: "string", value: agent.goal ?? "" },
    world_summary: { type: "string", value: JSON.stringify(summary) },
  },
  sessionTraceId: crypto.randomUUID(), // poll SessionTraces.get to watch tool calls
}, { preview: true });

result.agentMarkdownResponse; // → strip markdown, clamp to 200 chars, publishChat
result.parameterUpdates;      // → e.g. the model changed current_goal
```

  - **Endpoints:**
    - `POST /api/v2/aipAgents/agents/{agentRid}/sessions`
    - `POST /api/v2/aipAgents/agents/{agentRid}/sessions/{sessionRid}/blockingContinue` (or `streamingContinue`, which streams markdown; the first token can go into a "…typing" bubble)
    - `POST …/cancel` when a newer message makes the pending reply obsolete
  - Sessions expire (`SessionMetadata.estimatedExpiresTime`). Recreate on a not-found error.
  - **Pin `agentVersion`** at session creation so a Studio edit can't change live behaviour mid-conversation.
- **Developer Console setup** for the chatbot:
  - On the *Platform SDK* tab, add the **chatbot's project** and enable the **AIP Chatbots / AIP Agents write** operation under *Client allowed operations*.
  - Add all object/action/function types the chatbot uses on the *Ontology SDK* tab. They must come from a single Ontology.
  - Resources are **not** updated automatically when the chatbot changes.
- **Scopes to add** to `foundry/client.ts`: `api:aip-agents-read` and `api:aip-agents-write`.
- **Alternative:** turn on *"Publish function from chatbot"* and call it as a query (`userInput`, optional `sessionRid` → `markdownResponse`, `sessionRid`). It is simpler, but you lose `parameterUpdates`, traces and cancel, so prefer the Sessions API.

Docs: [Chatbot Studio overview](https://www.palantir.com/docs/foundry/chatbot-studio/overview/), [retrieval context](https://www.palantir.com/docs/foundry/chatbot-studio/retrieval-context/), [tools](https://www.palantir.com/docs/foundry/chatbot-studio/tools/), [application state](https://www.palantir.com/docs/foundry/chatbot-studio/application-state/), [calling from Foundry APIs / OSDK](https://www.palantir.com/docs/foundry/chatbot-studio/foundry-apis/), [streamingContinue API](https://www.palantir.com/docs/foundry/api/v2/aip-agents-v2-resources/sessions/streaming-continue-session/).

#### C2. LLM proxy with tool use for BUILD plans and goals: structured JSON

Build plans must be machine-readable, and a markdown chatbot reply is the wrong shape for that. Use Foundry's **provider-compatible LLM proxy** and force a tool call:

- **Endpoint:** `POST {foundryUrl}/api/v2/llm/proxy/anthropic/v1/messages`. It takes the native Anthropic Messages body, with `Authorization: Bearer <Foundry token>` from `auth()`.
- **`model`** = the **Model Catalog RID** of a Claude model enabled on the enrollment. Zero data retention (ZDR), georestriction and Resource Management metering all apply.
- **Helper:** `@osdk/language-models` provides `getAnthropicBaseUrl(foundryUrl)` and `createFetch(auth)`, so `@anthropic-ai/sdk` works unchanged. Alternatively, `@osdk/aip-core` provides `generateText` with tools.
- **Scope:** `api:use-language-models-execute`. Add it to `foundry/client.ts` and to the app in Developer Console.

```ts
tools: [{
  name: "submit_build_plan",
  input_schema: {
    type: "object",
    required: ["title", "origin", "cubes"],
    properties: {
      title:  { type: "string" },
      origin: { type: "object", properties: { x: {type:"integer"}, z: {type:"integer"} } },
      palette: { type: "array", items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, maxItems: 4 },
      cubes:  { type: "array", maxItems: 200,           // relative cells, y=0 is ground
                items: { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4 } } // [dx,dy,dz,paletteIndex]
    } } }],
tool_choice: { type: "tool", name: "submit_build_plan" }
```

Game logic validates the plan before any mark is published. It checks that each cell is inside `ARENA_HALF_SIZE` or open world, that there are ≤ 200 cubes, that nothing floats (`hasCube` below or terrain), and that the site is free. The same pattern (`choose_goal`, `negotiate`) covers goal selection and multi-agent coordination.

Docs: [LLM-provider-compatible APIs](https://www.palantir.com/docs/foundry/aip/llm-provider-compatible-apis/), [Anthropic messages proxy](https://www.palantir.com/docs/foundry/api/llm-apis/models/anthropic-messages-proxy), [supported LLMs](https://www.palantir.com/docs/foundry/aip/supported-llms).

> **Why not only the proxy?** Chat replies need persona, conversation memory, Ontology retrieval and auditable logging, and Chatbot Studio gives all of that without code. Plans need strict JSON, which only tool-forced calls give reliably. Both go through Foundry, so model governance, ZDR and metering are uniform.

---

## 4. Agent State Machine

The agent is always in exactly one primary behavioural state. Most transitions are driven by Jev (fast), with occasional confirmation or planning from the full LLM.

```
                    ┌─────────────┐
                    │    IDLE     │
                    │  (resting)  │
                    └──────┬──────┘
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │   EXPLORE   │  │   SOCIAL    │  │    BUILD    │
   │  (wander)   │  │  (talking)  │  │ (creating)  │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          └────────────────┼────────────────┘
                    ┌──────▼──────┐
                    │  REACTING   │  (short-lived, 1–3 ticks)
                    │ (interrupt) │
                    └─────────────┘
```

Implement it as a **pure reducer** (`agents/brain/stateMachine.ts`):
`(state, jevAnswers, events, now) → { state, intents[] }`
Intents are things like `MoveTo`, `Face`, `Say`, `RequestReply`, `RequestPlan`, `PlaceCube` and `Idle`. The reducer does no I/O, so it can be unit tested with Vitest, the same way `shared/geo.test.ts` is.

| State | Behaviour | Presence / effects |
|---|---|---|
| **IDLE** | Stands still, turns its head slowly toward the nearest player | Heartbeat every 2 s |
| **EXPLORE** | Picks a waypoint with Jev `choice` over 6–8 candidate points (open space, unvisited, near players, near builds) and paths there | Adaptive pose sampling, `vx`/`vz` |
| **SOCIAL** | Faces the speaker and closes to 3–6 m, asks the Chatbot (C1) for replies | `publishChat` with pose attached |
| **BUILD** | Walks to the plan origin and places one cube every ~0.6–1 s, in plan order (bottom-up) | One `kind:"cube"` mark per cube, batched every ~2 s |
| **REACTING** | Faces the stimulus and (optionally) plays a short "!" chat or shift in gaze, then hands off | — |

---

## 5. Transition Logic (who decides what)

| From | Trigger | Decided by | Jev question(s) | Notes |
|---|---|---|---|---|
| Any | A player speaks to me / says my name | Jev | `addressed_to_me` (noul > 0.7) | → REACTING → SOCIAL |
| Any | Interesting nearby activity | Jev | `next_state`, `urgency` | → EXPLORE or SOCIAL |
| IDLE | Boredom timer / random opportunity | Jev + light LLM | `next_state` | → EXPLORE, or BUILD via `choose_goal` (C2) |
| EXPLORE | Found a good build site and has a goal | Jev + LLM plan | `site_quality` (score) | → BUILD after `submit_build_plan` (C2) |
| EXPLORE | A player approaches or chats | Jev | `addressed_to_me`, `wants_interaction` | → SOCIAL |
| SOCIAL | Conversation ends / player leaves | Jev + game logic | `conversation_over` (noul) | Or the partner leaves the 32 m hearing radius → IDLE/EXPLORE |
| BUILD | Plan complete or stuck | Game logic + Jev | `stuck` (noul) | Complete = all cells present in the fold |
| BUILD | Urgent social interruption | Jev | `urgency` ≥ 3 | Pause the plan and keep its cursor |
| Any | Explicit new high-level goal | Full LLM / admin Action | — | The `set-agent-goal` Action or the Chatbot's `current_goal` update |

Hysteresis: a state must last at least 3 s before a Jev-driven change, unless `urgency ≥ 3`. This stops the agent flickering between states.

---

## 6. Concrete Decision Flows

### 6a. "Hey, want to help me build a tower?"

1. **WorldView** polls chat (500 ms, the same cadence as `useChat`). A `ChatRecord` arrives with `levelKey` matching, within 32 m, and `sessionId` ≠ own.
2. The event triggers an **immediate Jev tick** with `addressed_to_me`, `next_state`, `urgency` and `wants_collaboration` (noul). The answers come back as 0.94, `SOCIAL`, 3.6 and 0.88.
3. The reducer moves to REACTING and then SOCIAL, emitting `Face(speaker)`, `MoveTo(within 4 m)` and `RequestReply`.
4. **C1 Chatbot** `blockingContinue` receives `userInput: "Dana: Hey, want to help me build a tower?"`. It replies "Sure! Something tall by the lake?" and sets `current_goal` = "help Dana build a tower".
5. `parameterUpdates` shows a new goal, so the agent makes a **C2 `submit_build_plan`** call with the goal, the site summary and the palette of nearby cubes. Game logic validates the plan and the agent enters BUILD.
6. While building, a light Jev tick runs every ~1 s with `urgency`, `stuck` and `human_is_helping`, where the last one is judged from new cubes by Dana inside the plan's bounds.

### 6b. Two agents meet (preventing a loop)

- An agent treats another agent's chat as input like any other, but three rules keep them from talking forever:
  - an agent↔agent reply is only allowed if the thread has had ≤ 4 turns in the last 60 s
  - there is a 30 % Jev-gated chance of replying at all (`worth_replying` noul > 0.8)
  - a human speaking always pre-empts
- Agents are recognised by the `sessionId` prefix `agent:` (§8). No new field is needed.

---

## 7. Data the Agent Needs

### Continuous: WorldView, a non-React fold per level

| Data | Source | Cadence |
|---|---|---|
| Other players' poses | `readPresence(cursor)`, filtered on `levelKey` and ignoring own `sessionId`s | 150 ms (same as `usePresence`) |
| Chat in range | `readChat(cursor)`, distance-gated by `HEARING_RADIUS` / `SHOUT_RADIUS` | 500 ms |
| Marks | `loadRoomSnapshot` (from `foundry/snapshots.ts`, `[AP] Server History`) + `readMarksSince`, then `readMarks` | 1.5 s |
| Appearances (for describing people) | `readCharacters` | 10 s |
| Terrain | `buildTerrainSampler(craters, pads)`, local and pure | on mark change |

One host serves all its agents. The streams are polled **once per level, not once per agent**, and each agent reads the shared fold.

### The compact `state` sent to Jev and the LLM (target ≤ 1.5k tokens)

```json
{
  "self": { "name": "Echo", "state": "EXPLORE", "goal": "decorate the path", "pos": [12.4, 3.1, -8.0], "stateAgeS": 7 },
  "players": [ { "name": "Dana", "kind": "human", "dist": 6.2, "bearing": "front-left", "movingToward": true, "lastSaidS": 1.2 } ],
  "chat": [ { "from": "Dana", "text": "Hey, want to help me build a tower?", "ageS": 0.4, "dist": 6.2 } ],
  "nearby": { "cubes": 34, "topColors": ["#3f4247", "#e07a5f"], "freeFlatSites": [[20, -4], [8, 14]], "strokes": 3 },
  "build": { "active": false, "placed": 0, "total": 0 }
}
```

### Persistent data per agent: the Ontology (Tier 3)

| Object type | Backing | Key properties | Edited by |
|---|---|---|---|
| `DechoAgent` | Dataset (or stream-backed, for live edits) | `agentId`, `displayName`, `persona`, `levelKey`, `enabled`, `muted`, `currentGoal`, `chatbotRid`, `color`, `hat` | Actions `spawn-agent`, `set-agent-enabled`, `mute-agent`, `set-agent-goal` |
| `DechoAgentMemory` | Dataset + **embedding property** | `memoryId`, `agentId`, `text`, `aboutUser`, `createdAt`, `embedding` | Action `remember-fact` (Chatbot tool), reflection job |

- **Actions:**
  - Add **submission criteria** so only the Dechoverse admins group can spawn, enable or mute agents.
  - Use `remember-fact` as a function-backed action if deduplication is needed.
  - The host reads `DechoAgent` with OSDK (`client(DechoAgent).fetchPage()`) on start and every 30 s, so admins control agents from a small **Workshop** module without redeploying.
- **OSDK wiring:**
  - Generate the Ontology SDK for these types in Developer Console and add it to the app (per the comment already in `foundry/client.ts`).
  - Add the types and actions on the *Ontology SDK* tab. Scopes: `api:use-ontologies-read` and `api:use-ontologies-write`.
- **Reflection:** an Automate rule on a **time condition** (hourly minimum) runs an AIP Logic function that summarises each agent's recent chat log into new `DechoAgentMemory` objects. Slow, cheap and asynchronous, which is exactly what Automate is good at.

Docs: [Submission criteria](https://www.palantir.com/docs/foundry/action-types/submission-criteria/), [function-backed actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview/), [Automate](https://www.palantir.com/docs/foundry/automate/overview).

---

## 8. Identity, Safety & Control

**Identity on the wire** (no schema changes):
- `userId` = the display name, e.g. `"Echo 🤖"`. Suffixing makes AI players obvious in name labels, and `myspaceLevelKey(userId)` gives each agent its own MySpace for free.
- `sessionId` = `agent:<agentId>:<hostSessionUuid>`. Human clients ignore the format, while agents and future UI can detect `agent:`.
- One `publishCharacter` per agent on spawn, carrying body colour and hat, so humans see a distinct avatar.
- **Attribution:** every record is *written* with the host operator's OAuth token, so Foundry's audit log attributes it to the operator, while the record's `userId` names the agent. In the Compute Module phase the writer becomes a dedicated service user, which is the cleaner audit story.

**Guard rails:**
- **Level allow-list** per agent (default `["world:plains"]`, plus its own `myspace:`). Never write to another player's `myspace:` room; mirror the `readOnly` rule from `useMarkSync`.
- **Write budgets** enforced in the Body, not trusted to the model:

  | Output | Budget |
  |---|---|
  | Chat | ≤ 1 message per bubble lifetime + 3 s, and ≤ 200 chars |
  | Cubes | ≤ 20/min and ≤ 200 per plan |
  | Paint strokes | ≤ 4/min |
  | Doors, tags, dig, flatten | None in Tiers 1–2 |

  A dig or flatten mark permanently reshapes the shared terrain, so they stay off until Tier 3.
- **LLM budgets** (the proxy and Chatbot calls count against Resource Management):
  - ≤ 1 Chatbot turn per agent per 4 s
  - ≤ 1 plan per agent per 2 min
  - a global kill switch in the host UI
- **Moderation:** the Chatbot system prompt has content rules. The host also runs a Jev `noul` pre-publish check (`is_inappropriate`) on every outgoing line and drops anything above 0.3.
- **Undo:** "Erase all marks by agent" in the host UI writes `deleted: true` for every `markId` whose `userId` is the agent. This is the same erase path as `removeMarks`.
- **Mute / kick:** the `mute-agent` / `set-agent-enabled` Actions in Tier 3, and the host UI buttons before that.
- Everything stays visible and attributable through the normal streams. Chatbot session logging adds a full transcript.

---

## 9. Implementation Order (concrete tasks)

### Phase 0: spikes (½ day)
1. `fetch` Jev from the hosted site and **confirm CORS** plus a p50/p95 latency baseline.
2. In Chatbot Studio, create *Dechoverse Resident* with the application variables in §3C1 and publish v1.0. In **Developer Console**, add the chatbot project, enable the AIP Chatbots write operation, and add the scopes `api:aip-agents-read`, `api:aip-agents-write` and `api:use-language-models-execute` in both the console and `foundry/client.ts`. Everyone must sign in again after a scope change.
3. Call `Sessions.create` + `blockingContinue` and one Anthropic-proxy request from the browser to confirm auth and CORS for both.

### Phase 1: a single wandering agent (IDLE ↔ EXPLORE)
1. **Refactor.** Move the mark fold out of `useMarkSync.ts` into `game/domain/markFold.ts` (pure `foldMarks(records) → { cubes, strokes, objects, doors, craters, pads, … }`). Update the hook to use it and verify there is no visual change.
2. Create the new `agents/` tree:
   ```
   agents/
     host/AgentHost.ts        loop scheduler, one WorldView per level, N agents
     host/AgentConsole.tsx    /agents route: key entry, spawn/stop, live state & logs
     world/WorldView.ts       polls presence/chat/marks/characters, exposes a fold
     world/summarise.ts       fold → compact state (§7)
     body/Body.ts             kinematics via collision.ts, pose sampler → publishPresence
     body/pathing.ts          grid A* over blockedAt
     brain/stateMachine.ts    pure reducer (+ stateMachine.test.ts)
     brain/jev.ts             fetch client for /v1/systemone
     brain/questions.ts       question sets per state (§3B, §5)
     brain/chatbot.ts         AipAgents Sessions wrapper (C1)
     brain/planner.ts         LLM-proxy tool calls (C2) + plan validation
     config/personas.ts       seed personas until DechoAgent exists
   ```
3. Add the `/agents` route to `app/router.tsx`. Gate it behind a check that the signed-in user is in the agent-operators list, a hard-coded list until the Ontology exists.
4. Publish the agent's character on spawn. Walk it with EXPLORE waypoints chosen by Jev. Confirm humans see a smooth avatar.

### Phase 2: proximity chat (Jev + Chatbot)
1. Add chat to WorldView, then `addressed_to_me` → SOCIAL → `blockingContinue` → `publishChat` (pose attached).
2. Use `streamingContinue` and `cancel` to replace a reply that is now out of date.
3. Add the loop-prevention rules (§6b) and the moderation check (§8).

### Phase 3: basic cube building under a fixed goal
1. Add `planner.ts` with `submit_build_plan` and a validator, the BUILD state, and cube placement through `publishMarks` (`kind:"cube"`, `width` = opacity, as `addCube` does).
2. Track progress against the fold, which makes the agent tolerant of humans helping or griefing.

### Phase 4: the full state machine + Ontology control
1. Create the `DechoAgent` / `DechoAgentMemory` object types and Actions, plus a Workshop admin module (the "AIP Agent" widget can sit alongside it for talking to the chatbot directly).
2. Add Chatbot tools (`remember-fact`, `set-agent-goal`, object query) and Ontology retrieval context.
3. Set up the hourly Automate reflection.

### Phase 5: multi-agent coordination & always-on
1. Coordination through a shared `negotiate` tool call (C2) that assigns plan sections by cell ranges.
2. Move the host into a **Compute Module**:
   - **Mode:** pipeline mode, min replicas 1, `@palantir/compute-module`. Pipeline mode gives job-token access to the streaming datasets as inputs and outputs.
   - **Jev egress:** add a **Data Connection REST source** for `api.typesafe.ai` with an **egress policy** and "Allow import into compute modules". Read the key with `getCredential(sourceApiName, "apiKey")`.
   - **Auth:** use *Application permissions*, which creates a service user for the Chatbot and proxy calls.
   - Keep `/agents` as a read-only dashboard.

Docs: [Compute modules](https://www.palantir.com/docs/foundry/compute-modules/overview/), [execution modes](https://www.palantir.com/docs/foundry/compute-modules/execution-modes/), [TypeScript SDK](https://www.palantir.com/docs/foundry/compute-modules/typescript-sdk/), [sources in compute modules](https://www.palantir.com/docs/foundry/compute-modules/sources/), [egress](https://www.palantir.com/docs/foundry/administration/configure-egress/).

---

## 10. Foundry Resource Checklist

| Resource | Where | Phase |
|---|---|---|
| Scopes `api:aip-agents-read`, `api:aip-agents-write`, `api:use-language-models-execute` | Developer Console app **and** `scopes` in `foundry/client.ts` | 0 |
| Chatbot project + "AIP Chatbots" write operation | Developer Console → Platform SDK tab | 0 |
| CSP `connect-src https://api.typesafe.ai` | Developer Console → Website hosting → CSP (**done**) | 0 |
| *Dechoverse Resident* chatbot (published, version pinned) | AIP Chatbot Studio | 0 |
| Claude model enabled for the proxy (note its Model Catalog RID) | AIP Model Catalog / Control Panel | 0 |
| Chatbot session logging → streaming dataset | Chatbot Studio → configure logging | 2 |
| `DechoAgent`, `DechoAgentMemory` object types + Actions with submission criteria | Ontology Manager | 4 |
| Ontology SDK generated and added to the app; Ontology SDK tab resources | Developer Console | 4 |
| Admin Workshop module | Workshop | 4 |
| Hourly reflection rule (AIP Logic effect) | Automate | 4 |
| Compute Module + Data Connection source for Jev with egress policy | Compute Modules, Data Connection, Control Panel egress | 5 |

---

## 11. Open Questions / Things to Verify

- **Jev CORS from the browser.** The SDK authors expect server-side calls. If CORS is refused, bring forward a TS v2 function with a Data Connection source (adds ~100–300 ms) or the Compute Module.
- **Rate limits and pricing for Jev** are from third-party pages. Confirm them in the TypeSafe dashboard for this key.
- **AIP Agents API maturity.** It is marked beta (preview), and the endpoints need `preview=true`. Pin the `@osdk/foundry.aipagents` version.
- **Chatbot session TTL** is undocumented. Handle not-found errors by recreating the session.
- **The exact scope label in Developer Console** for chatbots (`api:aip-agents-*` vs `api:use-aip-agents-*`). Use whatever the console shows.
- **Stream read endpoints** (`getRecords`, `getEndOffsets`) are beta, and the app already depends on them. `publishRecords` is GA.
- **Presence volume.** Each agent adds ~10 presence records/s while moving. Check the presence stream's partitioning and throughput before running more than ~10 agents.

---

## 12. Sources

- Foundry Platform SDK: `@osdk/foundry.aipagents`, `@osdk/foundry.streams`, `@osdk/foundry.functions`, `@osdk/foundry.languagemodels`. Source at [github.com/palantir/foundry-platform-typescript](https://github.com/palantir/foundry-platform-typescript).
- OSDK: [github.com/palantir/osdk-ts](https://github.com/palantir/osdk-ts). This covers `@osdk/language-models`, `@osdk/aip-core` and `@osdk/widget.*`.
- Palantir docs: [Chatbot Studio](https://www.palantir.com/docs/foundry/chatbot-studio/overview/), [chatbots as functions](https://www.palantir.com/docs/foundry/chatbot-studio/chatbots-as-functions/), [session logging](https://www.palantir.com/docs/foundry/chatbot-studio/session-logging/), [LLM proxies](https://www.palantir.com/docs/foundry/aip/llm-provider-compatible-apis/), [Developer Console scopes](https://www.palantir.com/docs/foundry/ontology-sdk/third_party_app_scopes), [website hosting](https://www.palantir.com/docs/foundry/developer-console/deploy-custom-application-on-foundry/), [custom widgets](https://www.palantir.com/docs/foundry/custom-widgets/overview/), [Automate streaming](https://www.palantir.com/docs/foundry/automate/streaming), [compute modules](https://www.palantir.com/docs/foundry/compute-modules/overview/), [functions: external API calls](https://www.palantir.com/docs/foundry/functions/api-calls/).
- Jev / TypeSafe AI: [typesafe.ai](https://typesafe.ai), [docs.typesafe.ai/api](https://docs.typesafe.ai/api), npm [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) (wire format verified from v0.6.0 source).

**Research caveat:** palantir.com was not directly reachable from the research environment. Foundry facts come from the official SDK source (v2.79.0), a June 2026 mirror of palantir.com/docs, and search results. docs.typesafe.ai was also blocked; the Jev wire format was verified from the official SDK code.
