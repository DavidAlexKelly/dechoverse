Here's a clear design document + state model for AI players in Dechoverse.

---

# Dechoverse AI Players – Design Document

**Goal**  
Add autonomous, LLM-backed “players” that can inhabit DechoWorld (and optionally other levels). They should feel alive: walk around, talk to humans and each other, react to events, and collaboratively or independently build simple structures. The design is deliberately inspired by Mindcraft but heavily simplified to match Dechoverse’s much smaller action space and stream-based multiplayer model.

---

## 1. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     AI Agent Process                         │
│                                                              │
│  Perception  →  Decision Layers  →  Action Execution         │
│                                                              │
│  • Presence stream                                           │
│  • Chat stream                                               │
│  • Marks stream (world state)                                │
│  • Local spatial queries                                     │
│                                                              │
│  Decision layers (from fastest to slowest):                  │
│  1. Standard Game Logic                                      │
│  2. Jev (System-1 reactive decisions)                        │
│  3. Full LLM (Claude / GPT / Grok / etc.)                    │
└──────────────────────────────────────────────────────────────┘
```

Everything the AI does ultimately results in the same records a human client would publish:
- Presence records (pose)
- Chat records
- Mark records (cubes, paint strokes, tags, doors, props, flatten/dig, erasures)

No special server-side privileges are required for the MVP.

---

## 2. Capability Tiers (Phased Roll-out)

| Tier | Name              | Capabilities                                      | Priority |
|------|-------------------|---------------------------------------------------|----------|
| 1    | Social NPC        | Walk, look, proximity chat, react to players      | First    |
| 2    | Builder           | + place/erase cubes, paint, simple props          | Next     |
| 3    | Full Agent        | + goals, multi-agent coordination, doors, memory  | Later    |

---

## 3. Division of Labour

### A. Standard Game Logic (deterministic, no AI)
Handles everything that does not require judgment:

- Movement physics / collision / gravity
- Pose sampling & publishing cadence
- Cooldowns (door, prop, tag)
- Spatial queries (“what is within 8 m?”, “is this cell free?”)
- Pathfinding / steering toward a target point
- Animation / avatar rendering
- Basic timeout / heartbeat logic
- Enforcing level boundaries and write permissions

### B. Jev – Fast Reactive Layer (System-1)
Runs at high frequency (every 200–800 ms).  
Receives a compact structured state and answers multiple typed questions in parallel.  
Extremely cheap and low-latency.

Typical questions Jev answers:
- Is there a player nearby who just spoke to me?
- Should I reply to this chat message right now?
- Is the current goal still valid?
- Am I blocked / stuck?
- Is this build location free and level enough?
- Which of these 4 colours fits the nearby palette best?
- Should I switch from Explore → Social / Build / Idle?
- Is this player’s message directed at me or just ambient?
- Urgency score of the current situation (0–10)

Jev never writes free text or complex plans. It only returns choices, scores, or yes/no probabilities.

### C. Full LLM (Claude / GPT / Grok / etc.) – Deliberative Layer
Called only when necessary (new goal, complex social response, planning a structure, resolving ambiguity, multi-agent negotiation).  
Much higher latency and cost, so rate-limited.

Typical responsibilities:
- Generate natural chat replies (with personality)
- Decide on a new high-level goal (“build a small lookout tower”, “decorate the path”, “go find other players”)
- Produce a short plan or sequence of construction steps
- Resolve conflicts or negotiate with other AI agents
- Reflect on progress and update long-term memory
- Invent simple artistic or thematic building ideas

---

## 4. Agent State Machine

The agent always exists in exactly one primary behavioural state.  
Transitions are mostly driven by Jev (fast) with occasional confirmation or planning from the full LLM.

```
                    ┌─────────────┐
                    │    IDLE     │
                    │  (resting)  │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │   EXPLORE   │  │   SOCIAL    │  │    BUILD    │
   │  (wander)   │  │  (talking)  │  │ (creating)  │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼──────┐
                    │  REACTING   │  (short-lived)
                    │ (interrupt) │
                    └─────────────┘
```

### State Descriptions

**IDLE**  
- Standing still or very slow idle animation  
- Low energy / waiting for something interesting  
- Still publishes presence heartbeats  
- Jev periodically checks “is there a reason to leave idle?”

**EXPLORE**  
- Wandering, looking around, moving toward interesting features or open space  
- Primary way the agent discovers the world and other players  
- Can be interrupted by nearby chat or a new goal

**SOCIAL**  
- Oriented toward one or more players  
- Actively listening / replying to chat  
- May walk closer or gesture  
- Highest priority when a human is directly addressing the agent

**BUILD**  
- Focused on placing cubes, paint, props, etc. according to a current plan  
- May still react to chat but with lower priority  
- Periodically re-evaluates progress

**REACTING** (transient)  
- Very short-lived state entered when something urgent happens  
- Examples: player says the agent’s name, someone starts building next to it, path is blocked, another AI proposes collaboration  
- Usually lasts only 1–3 decision cycles before returning to a primary state

---

## 5. Transition Logic (Who Decides What)

| From State | Trigger                              | Decided by          | Notes |
|------------|--------------------------------------|---------------------|-------|
| Any        | Player speaks to me / says my name   | Jev                 | High priority → SOCIAL |
| Any        | Interesting nearby activity          | Jev                 | → EXPLORE or SOCIAL |
| IDLE       | Boredom timer / random opportunity   | Jev + light LLM     | → EXPLORE or BUILD |
| EXPLORE    | Found good build location + goal     | Jev + LLM plan      | → BUILD |
| EXPLORE    | Player approaches / chats            | Jev                 | → SOCIAL |
| SOCIAL     | Conversation ends / player leaves    | Jev                 | → IDLE or EXPLORE |
| BUILD      | Plan complete or stuck               | Jev + LLM           | → IDLE / EXPLORE / new BUILD |
| BUILD      | Urgent social interruption           | Jev                 | → REACTING → SOCIAL |
| Any        | Explicit new high-level goal         | Full LLM            | Can force any state |

---

## 6. Example Decision Flow (Concrete)

**Situation**: Agent is in EXPLORE. A player walks up and says “Hey, want to help me build a tower?”

1. **Game Logic** continuously updates local world state and presence.
2. **Jev** (every ~400 ms) sees:
   - New chat message containing the agent’s name / directed language
   - Player is within 12 m
   - Current state = EXPLORE  
   → Outputs: “Should reply now?” = Yes (0.91), “Switch to SOCIAL?” = Yes
3. Agent enters SOCIAL (or REACTING → SOCIAL).
4. **Full LLM** is called once with conversation history + personality + current goal context and generates a natural reply + decides whether to accept the collaboration.
5. If it accepts, LLM produces a short shared plan → agent transitions to BUILD (possibly coordinating with the human or other AIs).
6. While building, Jev keeps watching for new interruptions or progress checks.

---

## 7. Data the Agent Needs

**Continuous (local fold of streams)**
- Own pose + recent path
- Nearby players (id, pose, last chat, distance)
- Recent chat messages in range
- Spatial summary of marks (cubes, paint density, free cells, terrain height)

**Persistent (per agent)**
- Personality / system prompt
- Current high-level goal
- Short-term memory / conversation history
- Optional long-term project memory

---

## 8. Safety & Control

- AIs can be restricted to specific levelKeys (e.g. only `world:plains` + their own MySpace).
- Write rate limits and cooldowns still apply.
- Human players (or admins) can mute / kick / delete an AI’s marks.
- All AI actions remain fully visible and attributable via the normal streams.

---

## 9. Next Steps (Implementation Order)

1. Single agent that can publish presence and do simple wandering (IDLE ↔ EXPLORE).
2. Add proximity chat reaction loop (Jev + LLM).
3. Add basic cube placement under a fixed goal.
4. Introduce the full state machine and goal system.
5. Multi-agent coordination and richer building.

---

This design keeps the expensive LLM calls rare and meaningful, pushes almost all reactive and gating decisions to Jev, and leaves pure mechanics to ordinary game code. The result should feel responsive and alive without becoming prohibitively expensive or complex.