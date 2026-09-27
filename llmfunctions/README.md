# Dechoverse Agent Brains: LLM functions

These are the language-model queries behind the AI players. They are **not part of the app build**. Copy them into a TypeScript v1 functions repository in Foundry and publish them from there. The app calls them through its generated OSDK, `@ap-homepage/sdk`.

## Publishing

1. **Create a TypeScript v1 functions repository on the Accenture Ontology.** This is the Ontology `@ap-homepage/sdk` is generated against, so the repository must import it. A query is resolved by API name *within an ontology*: on any other Ontology the app gets `QueryNotFound`, or publishing fails with `ViewOntologyPermissionDenied`.
2. **Copy this folder** to `functions-typescript/src/llmfunctions/`, and re-export it from that repository's `functions-typescript/src/index.ts`:
   ```ts
   export * from "./llmfunctions";
   ```
3. **Import the models through Resource Imports → Models:**
   - Claude 4.5 Haiku
   - GPT-5 mini
   - Gemini 2.5 Flash

   The file expects them as `AnthropicClaude_4_5_Haiku`, `GPT_5_Mini` and `Gemini_2_5_Flash` from `@foundry/models-api/language-models`. If the sidebar shows different identifiers, rename them in the import and in the `ask*` methods. Nothing else changes.
4. **Commit and tag a release.** API-named queries always run the latest tagged version.
5. **In Developer Console**, add `dechoAgentReply`, `dechoAgentPlan`, `dechoAgentDecide` and `dechoAgentModels` to the app's Ontology SDK resources. Then **generate a new SDK version** and install it in the app.

The `/agents` console lists any query the installed SDK is still missing. Until then, agents walk around but stay silent.

## The contract

Each query takes `(prompt: string, model: string, persona: string)` and returns the model's raw text. The app builds the prompts (`agents/brain/prompts.ts`) and validates every reply (`agents/brain/parse.ts`). An empty string means "unanswered".

| Query | Reply the brief asks for |
|---|---|
| `dechoAgentReply` | `{"say":"…","replyTo":"m1","remember":null}` |
| `dechoAgentPlan` | `{"title":"…","site":"a","palette":["#rrggbb"],"cubes":[[dx,dy,dz,colourIndex]]}` |
| `dechoAgentDecide` | `{"choice":"<key>","why":"…"}` |
| `dechoAgentModels` | `["claude-haiku-4-5","gpt-5-mini","gemini-2-5-flash"]` |

Adding a model takes three changes: add it to `MODELS` and the token tables here, and to `AGENT_MODELS` in `agents/data/brainClient.ts`.
