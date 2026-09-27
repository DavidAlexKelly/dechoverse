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

## Implementation status

Phases 1–3 are built, along with the parts of Phases 4–5 that can be done in code. Everything else has to be created inside Foundry.

**Built in this repository:**

| Piece | Where |
|---|---|
| LLM functions, to copy into a TypeScript v1 repository on the Accenture Ontology | `llmfunctions/` (see `llmfunctions/README.md`) |
| Mark fold shared by the game and the agents | `game/state/markFold.ts` (`useMarkSync` now uses it) |
| OSDK client for the queries (`ontologyClient`), plus the `api:ontologies-read` scope | `foundry/client.ts` |
| Brain query client (`foundryModelCall`, looked up by name, full errors, permission detection) | `agents/data/brainClient.ts` |
| Jev on OpenRouter's Decisions API, question sets, reflexes | `agents/brain/jev.ts`, `agents/brain/questions.ts` |
| State machine as a pure reducer | `agents/brain/stateMachine.ts` |
| Prompt builders and parsers/validators | `agents/brain/prompts.ts`, `agents/brain/parse.ts` |
| Per-agent memory (localStorage for now) | `agents/brain/memory.ts` |
| World view per room (presence, chat, marks and characters streams, and the fold) | `agents/world/WorldView.ts` |
| Build-site search, Jev state summary, allowed rooms | `agents/world/sites.ts`, `summarise.ts`, `levels.ts` |
| Body (swept collision), A* pathing, pose sampler | `agents/body/` |
| Agent and host (loops, batching, budgets, moderation, erase, despawn) | `agents/host/Agent.ts`, `agents/host/AgentHost.ts` |
| `/agents` console (key entry, spawn/despawn, model/room/hat/colour, live state, log, spend) | `agents/host/AgentConsole.tsx`, route in `app/router.tsx` |
| Residents and operators | `agents/config/personas.ts`, `agents/config/operators.ts` |
| Tests | `*.test.ts` next to the state machine, parsers, Jev client, pathing/sites and mark fold |

**Still to do in Foundry (can't be done from code):**
1. Copy `llmfunctions/` into a TypeScript v1 functions repository on the **Accenture Ontology**. Import the three models through Resource Imports and fix the identifiers if they differ. Publish and tag a release.
2. In Developer Console, add `dechoAgentReply`, `dechoAgentPlan`, `dechoAgentDecide` and `dechoAgentModels` to the app's Ontology SDK resources. Generate a new `@ap-homepage/sdk` version and install it. Make sure the app allows the `api:ontologies-read` scope.

**Not needed.** Apart from the functions, nothing else uses the Ontology. Agents read and write only the existing streams, and the Ontology parts of Phase 4 are optional extras:
- `DechoAgent` / `DechoAgentMemory` object types and Actions (shared memory, and admin control from Workshop)
- the Automate reflection rule

Personas stay in `agents/config/personas.ts`, and memories stay in the console browser's localStorage. The Compute Module (Phase 5) is also optional. It only matters if agents should keep running with no `/agents` tab open.

**Where the code differs from the plan above:**
- **EXPLORE waypoints are chosen by game logic, not Jev.** It prefers unvisited, dry ground within about 60 m of home, which saves one `choice` question per tick.
- **Rooms:** agents live in DechoWorld (`world:plains`) or their own Space. DechoWorld 2's DEM terrain is not supported yet.
- **Build sites** relax from level 7×7 to sloped 7×7, then to 5×5. DechoWorld is too hilly for strictly level sites.
- **Without a Jev key,** agents still run on simple heuristics. They answer someone who says their name or talks to them from very close, and they wander when bored.
- **Background tabs:** keep the `/agents` tab visible. Browsers throttle timers in background tabs.

---

## 0. What the app is on Foundry (and why that matters)

Dechoverse is a **Developer Console application** of type *Client-facing*. It uses a public OAuth client with PKCE (`createPublicOauthClient` in `foundry/client.ts`) and is served through **Developer Console → Website hosting**. It is *not* a Workshop **custom widget** in the Foundry sense (a widget set built with `@osdk/widget.client`). That difference decides what AI players can do:

| | Developer Console hosted website (what we have) | Workshop custom widget (`@osdk/widget.*`) |
|---|---|---|
| Platform APIs (Streams, Datasets, Ontology query execution) | ✅ via `createPlatformClient` | ❌ "Non-Ontology APIs are not supported" |
| External requests (Jev via OpenRouter) | ✅ CSP rules are configurable per website (already done for Jev) | ❌ widget CSP cannot be configured |
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
│   chat.ts      readChat ─────┼──▶  │  Layer 2: Jev (OpenRouter) │ ─▶ publishChat           │
│   marks.ts     readMarks ────┤     │  Layer 3: Foundry @Query   │    publishMarks          │
│   snapshots.ts (cold start) ─┘     └────────────────────────────┘    publishCharacter      │
│   worldgen.ts / collision.ts (pure, local)                                                 │
└──────────────┬──────────────────────────────┬──────────────────────────────┬───────────────┘
               │ Platform SDK (OAuth token)   │ fetch (OpenRouter key)       │ Platform SDK (OAuth token)
               ▼                              ▼                              ▼
   Foundry Streams (high-scale)     openrouter.ai/api/alpha/decisions  /api/v2/ontologies/{ont}/queries/
   /v2/highScale/streams/…          model: typesafe/jev-1.13           dechoAgent*/execute
                                                                       → TS v1 functions repo
                                                                       → Haiku / GPT mini / Gemini Flash
```

**The same split as the BGWS commanders.** The app owns the rules. It builds the prompt, lists what is legal (cells, colours, who to face, which chat to answer), and **discards** anything the model returns that is not on that list. The Foundry function is a thin pipe: prompt in, raw completion out. A model can therefore only choose badly, never cheat. The prompt builders and parsers can be unit tested without calling a model, and swapping models is a parameter rather than a rewrite.

### Where the loop runs

| Phase | Runtime | Auth | Why |
|---|---|---|---|
| **MVP (Tiers 1–2)** | An **Agent Host** page at `/agents` in the existing website, running N agents in one tab | The signed-in operator's OAuth token (existing public client). An OpenRouter key for Jev. | Reuses every stream module, `worldgen.ts` and `collision.ts` unchanged. No new infrastructure. Easy to debug. |
| **Later (Tier 3, always-on)** | A **Compute Module** in *pipeline mode* with **min replicas ≥ 1**, built with `@palantir/compute-module` | Job token / *Application permissions* service user. The OpenRouter key sits in a Data Connection source. | Agents keep living when nobody has the host tab open. It is the same TS code, just bundled into a container. |

Automate (object-change or time triggers) was considered and **rejected** for the loop. Time conditions run at most hourly, and "live" evaluation takes seconds to minutes. That is fine for hourly reflection jobs but far too slow for a 400 ms reactive tick. ([Automate: streaming](https://www.palantir.com/docs/foundry/automate/streaming), [time conditions](https://www.palantir.com/docs/foundry/automate/condition-time))

---

## 2. Capability Tiers (phased roll-out)

| Tier | Name | Capabilities | Foundry pieces used |
|---|---|---|---|
| 1 | Social NPC | Walk, look, proximity chat, react to players | Streams (presence, chat, characters), Jev via OpenRouter, `dechoAgentReply` query |
| 2 | Builder | + place/erase cubes, paint strokes, props | + mark stream writes, `dechoAgentPlan` query |
| 3 | Full Agent | + goals, memory, multi-agent coordination, doors, admin control | + Ontology object types, Actions, Automate reflection, Compute Module |

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

### B. Layer 2: Jev via OpenRouter, the fast reactive layer (System-1)

**What it is.** Jev is TypeSafe AI's "System One" model. It never produces free text. One request carries a `state` plus a map of named, typed questions, and it answers all of them in a single parallel pass:

| Jev type | Returns | Use it for |
|---|---|---|
| `noul` | `{ noul: 0..1 }`, the probability that a statement is true | "Is this message addressed to me?", "Am I stuck?" |
| `choice` (≤ 255 labels) | `{ choice, confidence?, probabilities? }` | "Next state: IDLE / EXPLORE / SOCIAL / BUILD", "which waypoint", "which colour fits" |
| `score` (2–10 ordered levels) | `{ score (can fall between levels), confidence?, legend?, probabilities? }` | Urgency, "how good is this build site" |

**Calling it through OpenRouter.** Jev is **not** served on OpenRouter's `/api/v1/chat/completions`. OpenRouter's Jev guide says chat-completions SDKs will not work with it. It has its own endpoint:

```http
POST https://openrouter.ai/api/alpha/decisions          ← OpenRouter "Decisions API" (alpha)
Authorization: Bearer sk-or-v1-…
Content-Type: application/json
X-Title: Dechoverse                                     ← optional attribution

{
  "model": "typesafe/jev-1.13",          // pinned; "~typesafe/jev-latest" is the moving alias
  "user": "agent:echo",                  // per-agent attribution in OpenRouter's activity log
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

The response has answers at the top level. There is no `choices[0].message.content`:

```json
{ "id": "gen-dec-…", "model": "typesafe/jev-1.13-20260917", "provider": "TypeSafe",
  "answers": {
    "addressed_to_me": { "type": "noul", "noul": 0.94 },
    "next_state": { "type": "choice", "choice": "SOCIAL", "confidence": 0.88, "probabilities": { "…": 0 } },
    "urgency": { "type": "score", "score": 3.6, "confidence": 0.7 } },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.00002 } }
```

`confidence`, `probabilities` and `legend` are optional in the schema, so read them defensively. Log `id` and `usage.cost` with every decision.

An **alternative route** is `POST https://openrouter.ai/api/v1/systemone`. It takes the native TypeSafe body with a bare model ID (`"jev-latest"`), which means the official `@typesafe-ai/sdk` works with `baseURL: "https://openrouter.ai/api"` and an OpenRouter key. The SDK refuses to run in a browser without `dangerouslyAllowBrowser: true`, so a ~60-line `fetch` wrapper against `/api/alpha/decisions` is simpler. Put it in `agents/brain/jev.ts`.

**Client rules** (`agents/brain/jev.ts`):
- **One request in flight per agent.** Measured median latency is ~450 ms, so a fixed 400 ms timer would stack requests. Tick when the summarised `state` hash changes, never faster than the previous answer returns, and at least once every 5 s. A chat arrival or a player entering 12 m triggers the next tick at once.
- **Timeout** of 2 s with `AbortController`, because a late System-1 answer is worthless. Retry **once** on 429/5xx, honouring `Retry-After`. On **402** (credits exhausted), stop all agents and show it on the host UI.
- **Pin the model.** Use `typesafe/jev-1.13` rather than `~typesafe/jev-latest`, so a new Jev release can't silently change behaviour. Bump it deliberately.
- **Escalate when unsure**, the same way the BGWS `bgwsCommanderDecide` does. If a decision that matters comes back uncertain, send it to the LLM through `dechoAgentDecide` (§3C). Uncertain means a `choice` whose `confidence` is below 0.55, or a `noul` between 0.4 and 0.6 on `addressed_to_me`. Everything else Jev decides alone.

**Deployment facts:**
- The CSP entry for OpenRouter is already in place. **Phase 0 must still confirm CORS** on `/api/alpha/decisions` specifically: OpenRouter allows browser calls on chat completions, but that is unconfirmed for the decisions route.
- **Key handling.** Don't put the OpenRouter key in a `VITE_*` variable. Vite inlines those into the bundle that every Dechoverse player downloads. Instead:
  - The `/agents` page asks the operator to paste the key, and keeps it in memory or at most `sessionStorage`.
  - Use a **dedicated OpenRouter key with a credit limit** set in the OpenRouter dashboard, so a leaked key has a capped cost.
  - In the Compute Module phase (§9, Phase 5), the key moves into a Data Connection source credential.

**Budget:**
- Jev costs **$0.042 per 1M input tokens, and output is free**. That is about $0.00002 per call.
- One agent ticking about 2×/s makes about 7,200 calls an hour, which is **≈ $0.15 per agent-hour**.
- No Jev-specific rate limit is published. OpenRouter's general credit-based limits apply, and the decisions route is alpha. Watch for 429s when running more than a handful of agents per key.
- Context is 32k tokens. The §7 state is kept to about 1–1.5k.

Typical question sets per state are in §5. Jev never writes chat, names or plans.

### C. Layer 3: Foundry `@Query` functions, the deliberative layer

The LLM is called only for things that need language or judgement: chat replies, choosing a goal, build plans, and decisions Jev was unsure about. It goes through a **TypeScript v1 functions repository** that works exactly like the BGWS commanders. Each `@Query` is a thin pipe that takes a prompt the app built and returns the model's raw text, using fast models from Resource Imports.

#### C1. The repository: *[DV] Dechoverse Agent Brains*

**Where it lives.** It must be **on the same Ontology as the app's Ontology SDK**. A query is resolved by API name *within an ontology*, and the BGWS work already hit every failure you get otherwise: `QueryNotFound` when no API name is published, and `ViewOntologyPermissionDenied` when the repository imports an Ontology it has no rights over. For Dechoverse that is the **Accenture Ontology**, the one its generated SDK `@ap-homepage/sdk` was made against.

**Queries:**

| Query (`apiName`) | Used in | Parameters | Returns (raw text, parsed by the app) | Temp. |
|---|---|---|---|---|
| `dechoAgentReply` | SOCIAL | `prompt`, `model`, `persona` | `{"say":"…","replyTo":"<messageId>","remember":"…"\|null}` | 0.8 |
| `dechoAgentPlan` | BUILD | `prompt`, `model`, `persona` | `{"title":"…","origin":"<siteKey>","palette":[…],"cubes":[[dx,dy,dz,p],…]}` | 0.4 |
| `dechoAgentDecide` | Jev escalation, and goal choice | `prompt`, `model`, `persona` | `{"choice":"<key>","why":"<one sentence>"}` | 0 |
| `dechoAgentModels` | the host UI's model picker | — | `string[]` | — |

Separate queries rather than a flag on one, for the same reason as BGWS: **the brief is what differs**, and the brief is what a reader of the file needs to see.

**Temperature is not 0 across the board.** BGWS wants reproducible orders, but a resident that says the same line to every greeting feels dead. So chat is warm (0.8), plans are moderate (0.4), and escalated decisions stay at 0.

**Models.** Use fast, cheap models, chosen per agent so they can be compared the way BGWS compares commanders:

| `model` value | Model | How it's called in TS v1 | Response shape |
|---|---|---|---|
| `"claude-haiku-4-5"` | Claude 4.5 Haiku | `createGenericChatCompletion` | `response.completion` |
| `"gpt-5-mini"` | GPT-5 mini (or GPT-4.1 mini) | `createChatCompletion` | `response.choices[0].message.content` |
| `"gemini-2-5-flash"` | Gemini 2.5 Flash (or 3 Flash) | `createGenericChatCompletion` | `response.completion` |

- **Import names.** Add each model through **Resource Imports → Models** and copy the identifier from the sidebar snippet. The names are not documented anywhere I could reach. By analogy with `AnthropicClaude_4_6_Sonnet` / `GPT_5_2` they are probably `AnthropicClaude_4_5_Haiku`, `GPT_5_Mini` and `Gemini_2_5_Flash`, but check.
- **No JSON-schema mode.** Gemini in Foundry doesn't support JSON-schema response formats, which is another reason the app does all parsing and validation. Every brief ends "Reply with JSON only. No prose, no code fences."
- **GPT-5 mini is a reasoning model.** As with `MAX_TOKENS_JEV["gpt-5-2"]`, give it a much larger `maxTokens` so hidden reasoning doesn't truncate the JSON.
- **An empty reply is returned empty.** This is the BGWS lesson: a failed call must never look like "the model decided to say nothing". The app counts an empty string as unanswered and the agent just carries on.

**Skeleton** (the real file is `llmfunctions/dechoAgentFunctions.ts`; same style as the BGWS file):

```ts
import { Query, UserFacingError } from "@foundry/functions-api";
// Added through Resource Imports; copy the exact identifiers from the sidebar.
import {
  AnthropicClaude_4_5_Haiku,
  GPT_5_Mini,
  Gemini_2_5_Flash,
} from "@foundry/models-api/language-models";

export type AgentModel = "claude-haiku-4-5" | "gpt-5-mini" | "gemini-2-5-flash";
const MODELS: AgentModel[] = ["claude-haiku-4-5", "gpt-5-mini", "gemini-2-5-flash"];

/** A spoken line is at most 200 characters (MAX_MESSAGE_LENGTH in speech.ts). */
const MAX_TOKENS_REPLY: Record<AgentModel, number> = {
  "claude-haiku-4-5": 200, "gpt-5-mini": 2000, "gemini-2-5-flash": 400 };
const MAX_TOKENS_PLAN: Record<AgentModel, number> = {
  "claude-haiku-4-5": 2500, "gpt-5-mini": 8000, "gemini-2-5-flash": 4000 };
const MAX_TOKENS_DECIDE: Record<AgentModel, number> = {
  "claude-haiku-4-5": 200, "gpt-5-mini": 2000, "gemini-2-5-flash": 400 };

const REPLY_BRIEF = [
  "You are a resident of Dechoverse, a shared 3D world where people walk, talk and build with cubes.",
  "You speak out loud to whoever is near you. Keep it to one or two short sentences, at most 200 characters.",
  "Stay in character (your persona is below). Never claim to be human if asked directly.",
  "Answer only one of the messages listed, by its id.",
  'If you learn something worth remembering about someone, put it in "remember"; otherwise null.',
  "",
  'Reply with JSON only, on one line: {"say":"…","replyTo":"<messageId>","remember":null}',
].join("\n");

const PLAN_BRIEF = [ /* cells are relative to a site chosen from the list given;
  y=0 is ground; at most 200 cubes; colours by palette index; nothing may float;
  JSON only. */ ].join("\n");

const DECIDE_BRIEF = [
  "You are a resident of Dechoverse. Your fast reflexes were unsure about the decision below.",
  "Choose exactly one of the option keys given. A key that was not offered is ignored.",
  'Reply with JSON only, on one line: {"choice":"<key>","why":"<one sentence>"}',
].join("\n");

export class DechoAgentFunctions {
  @Query({ apiName: "dechoAgentReply" })
  public async reply(prompt: string, model: string, persona: string): Promise<string> {
    return this.run(this.modelFor(model), this.compose(REPLY_BRIEF, persona, prompt), 0.8,
      MAX_TOKENS_REPLY);
  }

  @Query({ apiName: "dechoAgentPlan" })
  public async plan(prompt: string, model: string, persona: string): Promise<string> {
    return this.run(this.modelFor(model), this.compose(PLAN_BRIEF, persona, prompt), 0.4,
      MAX_TOKENS_PLAN);
  }

  @Query({ apiName: "dechoAgentDecide" })
  public async decide(prompt: string, model: string, persona: string): Promise<string> {
    return this.run(this.modelFor(model), this.compose(DECIDE_BRIEF, persona, prompt), 0,
      MAX_TOKENS_DECIDE);
  }

  @Query({ apiName: "dechoAgentModels" })
  public models(): string[] { return MODELS.slice(); }

  // modelFor / compose (brief + "YOUR PERSONA" + prompt, as one USER turn) and the
  // empty-prompt UserFacingError are exactly as in BgwsCommanderFunctions.

  private async run(chosen: AgentModel, content: string, temperature: number,
                    limits: Record<AgentModel, number>): Promise<string> {
    const params = { temperature, maxTokens: limits[chosen] };
    const messages = [{ role: "USER" as const, contents: [{ text: content }] }];
    if (chosen === "gpt-5-mini") {
      const r = await GPT_5_Mini.createChatCompletion({ params, messages });
      return r.choices.length > 0 ? r.choices[0].message.content ?? "" : "";
    }
    const model = chosen === "claude-haiku-4-5" ? AnthropicClaude_4_5_Haiku : Gemini_2_5_Flash;
    const r = await model.createGenericChatCompletion({ params, messages });
    return r.completion ?? "";
  }
}
```

**Limits and cost:**
- TS v1 functions have a **60 s** wall-clock limit by default, which can be changed in the function's configuration, and a fixed **30 s** CPU limit. Waiting on a model is I/O, not CPU, so fast models finish well inside both.
- LLM calls are **metered as AIP compute** per token and **rate-limited per enrollment and per model** (TPM/RPM), on top of the function's own limits. The §8 budgets keep a room of agents far below those limits.

#### C2. Calling the queries from the app: the generated OSDK, as in `commanderClient.ts`

⚠ **Queries are ontology-scoped.** The endpoint is `POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute`, in the ontologies service. It is **not** `/v2/functions/queries/{name}/execute`, which returns a 404 `QueryNotFound` that looks exactly like an unpublished function. BGWS lost four debugging rounds to this. The fix is to call queries through the **generated OSDK**, which knows the Ontology, the API names and the parameter types, so none of them can be wrong.

**1. Add an OSDK `Client` next to the existing `PlatformClient`** in `foundry/client.ts`. Both share the same `auth`, and the stream and dataset code keeps using `PlatformClient` unchanged:

```ts
import { type Client, createClient, createPlatformClient } from "@osdk/client";
import { $ontologyRid } from "@ap-homepage/sdk";   // the app's generated SDK (Accenture Ontology)

export const client: PlatformClient = createPlatformClient(foundryUrl, auth);   // streams, datasets (unchanged)
export const ontologyClient: Client = createClient(foundryUrl, $ontologyRid, auth); // queries, objects, actions
```

**2. Create `agents/data/brainClient.ts`**, the one impure function behind an agent's brain. It follows the same design as `bgws/data/commanderClient.ts`:
- `prompts.ts` / `parse.ts` are pure, and all they need is a `ModelCall = (prompt: string) => Promise<string>`.
- It looks queries up **by name at runtime**, not by named import. A named import of a query the SDK doesn't have yet fails the build. Looked up at runtime, a new brief (say `dechoAgentPlan`) takes over once the SDK is regenerated, and until then the caller gets a clear error rather than a broken build.
- It reports **everything the platform said**: `errorCode`, `errorName`, `parameters` and `errorInstanceId`. The OSDK's default "Failed to fetch 400 Bad Request" doesn't help. Extend the existing `describeError` in `foundry/errors.ts` to match `describeApiError`.
- It flags **permission problems** as their own error with a fix-it message ("add *[DV] Dechoverse Agent Brains* as a permitted resource on this app in Developer Console").
- It **refuses non-string results**. The contract is a string, and anything else means the published query and the caller have drifted.

```ts
import * as sdk from "@ap-homepage/sdk";
import { ontologyClient } from "@/foundry/client";
import { describeError } from "@/foundry/errors";
import type { ModelCall } from "@/agents/brain/prompts";

/** Models the published queries accept. Kept in step with dechoAgentModels by hand. */
export const AGENT_MODELS = ["claude-haiku-4-5", "gpt-5-mini", "gemini-2-5-flash"] as const;
export type AgentModelName = (typeof AGENT_MODELS)[number];

export type BrainQueryKind = "reply" | "plan" | "decide";
const QUERY_NAMES: Record<BrainQueryKind, string> = {
  reply: "dechoAgentReply",
  plan: "dechoAgentPlan",
  decide: "dechoAgentDecide",
};

type ExecutableQuery = Parameters<typeof ontologyClient>[0];

/** Looked up by name, not imported: see above. */
function queryFor(kind: BrainQueryKind): { query: ExecutableQuery; name: string } {
  const name = QUERY_NAMES[kind];
  const found = (sdk as unknown as Record<string, unknown>)[name];
  if (!found) {
    throw new BrainCallError(
      `${name} is not in the generated SDK yet. Publish the functions and regenerate the SDK.`, false);
  }
  return { query: found as ExecutableQuery, name };
}

export class BrainCallError extends Error {
  constructor(message: string, readonly permissionDenied: boolean) {
    super(message);
    this.name = "BrainCallError";
  }
}

const looksLikePermissionProblem = (err: unknown): boolean =>
  /permission|denied|403|forbidden|scope|unauthor/i.test(String((err as Error)?.message ?? err));

/** Model and persona are bound per agent: an agent's brain does not change mid-conversation. */
export function foundryModelCall(model: AgentModelName, persona: string, kind: BrainQueryKind): ModelCall {
  return async (prompt) => {
    const { query, name } = queryFor(kind);
    let result: unknown;
    try {
      result = await ontologyClient(query).executeFunction({ prompt, model, persona });
    } catch (err) {
      const denied = looksLikePermissionProblem(err);
      throw new BrainCallError(
        denied
          ? `No access to "${name}". Add [DV] Dechoverse Agent Brains as a permitted resource on this app in Developer Console.`
          : `Brain query ${name} failed: ${describeError(err)}`,
        denied,
      );
    }
    if (typeof result !== "string") {
      throw new BrainCallError(`Expected a string from ${name}, got ${typeof result}. The published query and this caller may have drifted.`, false);
    }
    return result;   // "" = unanswered; parse.ts treats it as such
  };
}
```

**3. Handle errors in the agent.**
- A `BrainCallError` with `permissionDenied` **stops that agent** and shows the message on `/agents`, because retrying won't fix a missing grant.
- Any other failure leaves the agent silent for that exchange, counts one failure, and backs off (2 s, then 4 s, then 8 s).

**Setup** (details in §9, Phase 0):
- **Developer Console:** the app already has an Ontology SDK (`@ap-homepage/sdk`, Accenture Ontology), so the brains repository goes on that Ontology.
  - Add the four queries as resources, so they become permitted resources and appear in the generated package.
  - Install the package with the npm instructions on the SDK's page.
  - **Regenerate the SDK whenever a query is added or its signature changes.**
- **Scope:** add `api:ontologies-read` to `scopes` in `foundry/client.ts`, or `api:use-ontologies-read` if the console shows restricted scopes. Everyone signs in again after a scope change.
- **Versions:** API-named queries always run the **latest tagged version**, so tag a release to ship a brief change.
- **Permissions:** operators also need view permission on the functions repository's project.

#### C3. What the app builds and validates (`agents/brain/prompts.ts`, `agents/brain/parse.ts`)

These are pure functions with Vitest tests, like `rules/llmCommander.ts` in BGWS.

- **`buildReplyPrompt(agent, fold)`** lists the recent audible messages with ids, who is nearby, the agent's goal, the last 6 lines of this conversation, and up to 5 memories about the speaker (§7).
  - **`parseReply`** checks that `replyTo` is one of the listed ids, strips markdown, clamps to `MAX_MESSAGE_LENGTH`, and runs the moderation check (§8). Anything invalid means the agent says nothing.
- **`buildPlanPrompt(agent, fold)`** offers 3–5 **candidate sites as keys** (e.g. `site:a` = a flat 7×7 area at (20, −4)). The app picks these from free, flat cells, so the model never invents coordinates. It also lists the nearby palette.
  - **`parsePlan`** drops any cube that is not above ground or another cube, outside the site bounds, beyond 200 cubes, or using an unknown palette index. It then orders the cubes bottom-up.
- **`buildDecidePrompt(question, options)`** covers Jev escalations and goal selection. The app generates keyed options such as `goal:build-near-dana`, `goal:explore-north`, `goal:decorate-path` and `reply:m-123` / `reply:ignore`.
  - **`parseDecide`** accepts only an offered key. Otherwise Jev's top answer stands and the fallback is logged.

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
| **SOCIAL** | Faces the speaker and closes to 3–6 m, asks `dechoAgentReply` (§3C) for replies | `publishChat` with pose attached |
| **BUILD** | Walks to the plan origin and places one cube every ~0.6–1 s, in plan order (bottom-up) | One `kind:"cube"` mark per cube, batched every ~2 s |
| **REACTING** | Faces the stimulus and (optionally) plays a short "!" chat or shift in gaze, then hands off | — |

---

## 5. Transition Logic (who decides what)

| From | Trigger | Decided by | Jev question(s) | Notes |
|---|---|---|---|---|
| Any | A player speaks to me / says my name | Jev | `addressed_to_me` (noul > 0.7) | → REACTING → SOCIAL |
| Any | Interesting nearby activity | Jev | `next_state`, `urgency` | → EXPLORE or SOCIAL |
| IDLE | Boredom timer / random opportunity | Jev + light LLM | `next_state` | → EXPLORE, or BUILD via a goal picked by `dechoAgentDecide` |
| EXPLORE | Found a good build site and has a goal | Jev + LLM plan | `site_quality` (score) | → BUILD after `dechoAgentPlan` |
| EXPLORE | A player approaches or chats | Jev | `addressed_to_me`, `wants_interaction` | → SOCIAL |
| SOCIAL | Conversation ends / player leaves | Jev + game logic | `conversation_over` (noul) | Or the partner leaves the 32 m hearing radius → IDLE/EXPLORE |
| BUILD | Plan complete or stuck | Game logic + Jev | `stuck` (noul) | Complete = all cells present in the fold |
| BUILD | Urgent social interruption | Jev | `urgency` ≥ 3 | Pause the plan and keep its cursor |
| Any | Explicit new high-level goal | Full LLM / admin Action | — | The `set-agent-goal` Action, or a goal picked by `dechoAgentDecide` |

Hysteresis: a state must last at least 3 s before a Jev-driven change, unless `urgency ≥ 3`. This stops the agent flickering between states.

---

## 6. Concrete Decision Flows

### 6a. "Hey, want to help me build a tower?"

1. **WorldView** polls chat every 500 ms, the same cadence as `useChat`. A `ChatRecord` arrives with a matching `levelKey`, within 32 m, and a `sessionId` that isn't the agent's own.
2. The event triggers an **immediate Jev tick** on OpenRouter. The answers come back as:

   | Question | Answer |
   |---|---|
   | `addressed_to_me` | 0.94 |
   | `next_state` | `SOCIAL` (confidence 0.88) |
   | `urgency` | 3.6 |
   | `wants_collaboration` | 0.88 |

   All four are confident, so nothing is escalated.
3. The reducer moves to REACTING and then SOCIAL, emitting `Face(speaker)`, `MoveTo(within 4 m)` and `RequestReply`.
4. The app calls **`dechoAgentReply`** with the agent's model. The prompt lists message `m-7f3` from Dana, the nearby players, the goal "decorate the path", and the memory "Dana likes towers". The reply is `{"say":"Sure! Something tall by the lake?","replyTo":"m-7f3","remember":null}`. `parseReply` validates it, and the line goes to `publishChat` with the agent's pose attached.
5. Because `wants_collaboration` was high, the app calls **`dechoAgentDecide`** with the goal options `goal:help-dana-build`, `goal:keep-decorating` and `goal:explore`, and gets back `goal:help-dana-build`.
6. **`dechoAgentPlan`** is given the goal, three candidate sites near Dana (`site:a`, `site:b`, `site:c`) and the palette of nearby cubes. `parsePlan` removes any invalid cells, and the agent enters BUILD.
7. While building, a light Jev tick runs about every 1 s, asking `urgency`, `stuck` and `human_is_helping`. The last one is judged from new cubes by Dana inside the plan's bounds, and the agent skips any cell someone else has already filled.

### 6b. Two agents meet (preventing a loop)

- An agent treats another agent's chat as input like any other, but three rules keep them from talking forever:
  - an agent↔agent reply is only allowed if the thread has had ≤ 4 turns in the last 60 s
  - Jev must rate the reply as worthwhile (`worth_replying` noul > 0.8)
  - a human speaking always pre-empts
- Agents are recognised by the `sessionId` prefix `agent:` (§8). No new field is needed.
- Running different models on different agents (Haiku vs GPT mini vs Flash) makes agent-to-agent conversation a free side-by-side comparison, the same experiment BGWS runs with its commanders.

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

Until Tier 3, personas live in `agents/config/personas.ts` and memories live in this browser's localStorage (`agents/brain/memory.ts`). Later they move into object types on the Accenture Ontology:

| Object type | Backing | Key properties | Edited by |
|---|---|---|---|
| `DechoAgent` | Dataset | `agentId`, `displayName`, `persona`, `model` (`claude-haiku-4-5` / `gpt-5-mini` / `gemini-2-5-flash`), `levelKey`, `enabled`, `muted`, `currentGoal`, `color`, `hat` | Actions `spawn-agent`, `set-agent-enabled`, `mute-agent`, `set-agent-goal` |
| `DechoAgentMemory` | Dataset | `memoryId`, `agentId`, `text`, `aboutUser`, `createdAt` | Action `remember-fact`, and the hourly reflection job |

- **Actions:**
  - Add **submission criteria** so only a Dechoverse admins group can spawn, enable, mute or re-goal agents.
  - When a `dechoAgentReply` result has a non-null `remember`, the host applies `remember-fact`.
- **The host uses the same generated OSDK and `ontologyClient` as the brain queries (§3C2).** Add the new object types and actions to the Ontology SDK resources and regenerate the SDK. Then:
  - `ontologyClient(DechoAgent).fetchPage()` on start and every 30 s.
  - `ontologyClient(DechoAgentMemory).where({ agentId, aboutUser: speaker }).fetchPage({ $pageSize: 5 })` when building a reply prompt.
  - `ontologyClient(rememberFact).applyAction({...})` for remembered facts.
  - Scopes needed: `api:ontologies-read` / `api:ontologies-write`, or the `api:use-*` equivalents.
- **Admin UI:** a small **Workshop** module over `DechoAgent`, so admins can mute, re-goal or swap an agent's model without redeploying.
- **Reflection:** an **Automate** rule on a **time condition** (at most hourly) runs a function-backed action. The action reads each agent's recent lines from the chat stream archive, calls the same fast model with a "summarise what you learned" brief, and writes new `DechoAgentMemory` objects. Slow, cheap and asynchronous, which is what Automate is good at.

Docs: [Submission criteria](https://www.palantir.com/docs/foundry/action-types/submission-criteria/), [function-backed actions](https://www.palantir.com/docs/foundry/action-types/function-actions-overview/), [Automate](https://www.palantir.com/docs/foundry/automate/overview).

---

## 8. Identity, Safety & Control

**Identity on the wire** (no schema changes):
- `userId` = the display name, e.g. `"Echo 🤖"`. The suffix makes AI players obvious in name labels, and `myspaceLevelKey(userId)` gives each agent its own MySpace for free.
- `sessionId` = `agent:<agentId>:<hostSessionUuid>`. Human clients ignore the format, while agents and future UI can detect `agent:`.
- One `publishCharacter` per agent on spawn, carrying body colour and hat, so humans see a distinct avatar.
- **Attribution:** every stream record and every query run is performed with the host operator's OAuth token, so Foundry's audit log attributes it to the operator, while the record's `userId` names the agent. In the Compute Module phase the caller becomes a dedicated service user, which is the cleaner audit story. Jev calls are attributed per agent on OpenRouter through the `user` field.

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
- **LLM budgets.** Query runs are metered as AIP compute and rate-limited per enrollment.

  | Query | Limit per agent |
  |---|---|
  | `dechoAgentReply` | 1 per 4 s |
  | `dechoAgentPlan` | 1 per 2 min |
  | `dechoAgentDecide` | 1 per 10 s |

  Only **one query in flight per agent**. The host UI also has a global kill switch, and a spend meter that adds up Jev's `usage.cost`.
- **Moderation:** the reply brief has content rules. The host also runs a Jev `noul` pre-publish check (`is_inappropriate`) on every outgoing line and drops anything above 0.3.
- **Undo:** "Erase all marks by agent" in the host UI writes `deleted: true` for every `markId` whose `userId` is the agent. This is the same erase path as `removeMarks`.
- **Mute / kick:** the `mute-agent` / `set-agent-enabled` Actions in Tier 3, and the host UI buttons before that.
- Everything stays visible and attributable through the normal streams.

---

## 9. Implementation Order (concrete tasks)

### Phase 0: Foundry setup and spikes (½–1 day)
1. **The Ontology is the Accenture Ontology**, which `@ap-homepage/sdk` is already generated against. Nothing to choose.
2. **Create the functions repository** *[DV] Dechoverse Agent Brains* (TypeScript v1) **on that Ontology**, in the Dechoverse project:
   - Import the three fast models through **Resource Imports → Models** and copy their identifiers.
   - Implement `dechoAgentReply` / `dechoAgentPlan` / `dechoAgentDecide` / `dechoAgentModels` (§3C1).
   - Tag a release.
3. In Developer Console, **add the four queries** to the Ontology SDK resources, **generate a new SDK version** and install it. Add `api:ontologies-read` (and `-write` for Tier 3) to the app **and** to `scopes` in `foundry/client.ts`.
4. **Spike from the hosted site:**
   - Install the generated SDK, add `ontologyClient` (§3C2), and call `foundryModelCall(model, persona, "reply")("hello")` for each model. Record p50/p95 latency; a fast model is expected to take about 1–3 s through a function.
   - `fetch` `https://openrouter.ai/api/alpha/decisions` with `typesafe/jev-1.13`. **Confirm CORS** and measure latency.

### Phase 1: a single wandering agent (IDLE ↔ EXPLORE)
1. **Refactor.** Move the mark fold out of `useMarkSync.ts` into `game/domain/markFold.ts` (pure `foldMarks(records) → { cubes, strokes, objects, doors, craters, pads, … }`). Update the hook to use it and verify there is no visual change.
2. Create the new `agents/` tree:
   ```
   agents/
     host/AgentHost.ts        loop scheduler, one WorldView per level, N agents
     host/AgentConsole.tsx    /agents route: OpenRouter key entry, spawn/stop, model picker, live state, cost & logs
     world/WorldView.ts       polls presence/chat/marks/characters, exposes a fold
     world/summarise.ts       fold → compact state (§7)
     body/Body.ts             kinematics via collision.ts, pose sampler → publishPresence
     body/pathing.ts          grid A* over blockedAt
     brain/stateMachine.ts    pure reducer (+ stateMachine.test.ts)
     brain/jev.ts             fetch client for openrouter.ai/api/alpha/decisions
     brain/questions.ts       Jev question sets per state (§3B, §5)
     brain/prompts.ts         prompt builders for the three queries (+ tests)
     brain/parse.ts           reply / plan / decide parsers and validators (+ tests)
     config/personas.ts       seed personas and their models, until DechoAgent exists
     data/brainClient.ts      foundryModelCall → ontologyClient(query).executeFunction (§3C2)
   foundry/client.ts          + ontologyClient = createClient(foundryUrl, $ontologyRid, auth)
   ```
3. Add the `/agents` route to `app/router.tsx`. Gate it behind a check that the signed-in user is in the agent-operators list, a hard-coded list until the Ontology exists.
4. Publish the agent's character on spawn. Walk it with EXPLORE waypoints chosen by Jev (`choice` over the candidate waypoints). Confirm humans see a smooth avatar.

### Phase 2: proximity chat (Jev + `dechoAgentReply`)
1. Add chat to WorldView, then `addressed_to_me` → SOCIAL → `dechoAgentReply` → `parseReply` → `publishChat` (pose attached).
2. If a newer message from the same speaker arrives while a reply is in flight, drop the stale reply instead of speaking it. Queries can't be cancelled, so the app simply discards the answer.
3. Add Jev escalation to `dechoAgentDecide`, the loop-prevention rules (§6b) and the moderation check (§8).

### Phase 3: basic cube building under a fixed goal
1. Add `dechoAgentPlan` with `buildPlanPrompt` / `parsePlan`, the BUILD state, and cube placement through `publishMarks` (`kind:"cube"`, `width` = opacity, as `addCube` does).
2. Track progress against the fold, which makes the agent tolerant of humans helping or griefing.

### Phase 4: the full state machine + Ontology control
1. Create the `DechoAgent` / `DechoAgentMemory` object types and Actions, plus a Workshop admin module.
2. Wire up the `remember` → `remember-fact` path and memory retrieval in `buildReplyPrompt`.
3. Set up the hourly Automate reflection.

### Phase 5: multi-agent coordination & always-on
1. Coordination: a `dechoAgentDecide` round in which each agent picks plan sections from keyed cell ranges offered by the app.
2. Move the host into a **Compute Module**:
   - **Mode:** pipeline mode, min replicas 1, `@palantir/compute-module`. Pipeline mode gives job-token access to the streaming datasets as inputs and outputs.
   - **Jev egress:** add a **Data Connection REST source** for `openrouter.ai` with an **egress policy** and "Allow import into compute modules". Read the key with `getCredential(sourceApiName, "apiKey")`.
   - **Auth:** use *Application permissions*, which creates a service user, to call the same queries.
   - Keep `/agents` as a read-only dashboard.

Docs: [Compute modules](https://www.palantir.com/docs/foundry/compute-modules/overview/), [execution modes](https://www.palantir.com/docs/foundry/compute-modules/execution-modes/), [TypeScript SDK](https://www.palantir.com/docs/foundry/compute-modules/typescript-sdk/), [sources in compute modules](https://www.palantir.com/docs/foundry/compute-modules/sources/), [egress](https://www.palantir.com/docs/foundry/administration/configure-egress/).

---

## 10. Foundry & OpenRouter Resource Checklist

| Resource | Where | Phase |
|---|---|---|
| `@ap-homepage/sdk` (Accenture Ontology) regenerated after the queries are added, and the new version installed | Developer Console → Ontology SDK tab | 0 |
| *[DV] Dechoverse Agent Brains* TS v1 repository **on that Ontology**, with a tagged release | Code Repositories | 0 |
| Fast models imported (Haiku, GPT mini, Gemini Flash) | Repository → Resource Imports → Models | 0 |
| `dechoAgentReply`, `dechoAgentPlan`, `dechoAgentDecide`, `dechoAgentModels` added as app resources | Developer Console → Ontology SDK tab | 0 |
| Scope `api:ontologies-read` (Tier 3: `-write`) | Developer Console app **and** `scopes` in `foundry/client.ts` | 0 |
| CSP `connect-src https://openrouter.ai` | Developer Console → Website hosting → CSP (**done**) | 0 |
| Dedicated OpenRouter key with a credit limit | OpenRouter dashboard | 0 |
| `DechoAgent`, `DechoAgentMemory` object types + Actions with submission criteria | Ontology Manager | 4 |
| Admin Workshop module | Workshop | 4 |
| Hourly reflection rule | Automate | 4 |
| Compute Module + Data Connection source for OpenRouter with an egress policy | Compute Modules, Data Connection, Control Panel egress | 5 |

---

## 11. Open Questions / Things to Verify

- **CORS on `openrouter.ai/api/alpha/decisions`.** It is confirmed for chat completions but not for the decisions route. If it is refused, try the `/api/v1/systemone` compatibility route. After that, the fallback is a query that calls OpenRouter through a Data Connection source, which adds latency.
- **The Decisions API is alpha.** Its shape may change, so pin the model slug and keep the parser defensive.
- **Jev rate limits on OpenRouter** are unpublished. Measure 429s with several agents.
- **Exact model import identifiers and methods.** Check whether `createGenericChatCompletion` is available on the Haiku and GPT mini bindings, and which response shape each returns, from the Resource Imports sidebar snippet. If the repository uses the newer `@foundry/languagemodelservice/models` bindings instead, the calls become `createChatCompletion` returning a Result (`response.type === "ok" ? response.value.completion : …`).
- **Query latency.** A function run adds overhead on top of the model call, so measure it in Phase 0. If SOCIAL replies feel slow, show a "…" bubble locally when the reply is requested.
- **Which scope family the app uses.** Unrestricted apps use `api:ontologies-read`; restricted Developer Console apps use `api:use-ontologies-read`. Use whatever the console shows.
- **Stream read endpoints** (`getRecords`, `getEndOffsets`) are beta, and the app already depends on them. `publishRecords` is GA.
- **Presence volume.** Each agent adds about 10 presence records/s while moving. Check the presence stream's throughput before running more than about 10 agents.

---

## 12. Sources

- **OpenRouter / Jev:**
  - [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev)
  - [Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
  - [TypeSafe SDK via OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk)
  - [typesafe/jev-1.13](https://openrouter.ai/typesafe/jev-1.13)
  - npm [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) (wire format verified from the v0.6.0 source)
  - [github.com/souvikr/jev-test](https://github.com/souvikr/jev-test) (latency and cost measurements)
- **Foundry functions:**
  - [Query functions](https://www.palantir.com/docs/foundry/functions/query-functions/)
  - [Language models in functions](https://www.palantir.com/docs/foundry/functions/language-models)
  - [Supported LLMs](https://www.palantir.com/docs/foundry/aip/supported-llms)
  - [Manage functions (limits)](https://www.palantir.com/docs/foundry/functions/manage-functions/)
  - [Execute query API](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/queries/execute-query/)
  - OSDK `executeFunction` calls `/v2/ontologies/{ontology}/queries/{apiName}/execute` internally (`packages/client/src/queries/applyQuery.ts` in [osdk-ts](https://github.com/palantir/osdk-ts)).
- **Other Foundry docs:**
  - [Developer Console: create application](https://www.palantir.com/docs/foundry/developer-console/create-application/)
  - [Scopes](https://www.palantir.com/docs/foundry/ontology-sdk/third_party_app_scopes)
  - [Website hosting](https://www.palantir.com/docs/foundry/developer-console/deploy-custom-application-on-foundry/)
  - [Custom widgets](https://www.palantir.com/docs/foundry/custom-widgets/overview/)
  - [Automate streaming](https://www.palantir.com/docs/foundry/automate/streaming)
  - [Compute modules](https://www.palantir.com/docs/foundry/compute-modules/overview/)
- **The BGWS LLM Commanders repository and `bgws/data/commanderClient.ts`** are the pattern for §3C.

**Research caveat:** palantir.com, openrouter.ai and docs.typesafe.ai were not directly reachable from the research environment. The facts come from the official SDK source code (foundry-platform-typescript v2.79.0, osdk-ts, `@typesafe-ai/sdk` 0.6.0), a June 2026 mirror of palantir.com/docs, OpenRouter's published skills repository, and search results. Items that could not be confirmed are listed in §11.
