import { foundryUrl } from "@/foundry/client";

/** A Foundry application you can shoot in the hub room to open it. */
export interface AppLink {
  id: string;
  name: string;
  caption: string;
  color: string;
  url: string;
}

/**
 * Applications surfaced in the hub room. Add more entries here to put extra
 * blocks in the room — the layout adapts automatically.
 */
export const APP_LINKS: AppLink[] = [
  {
    id: "ontology-manager",
    name: "Ontology Manager",
    caption: "Open app",
    color: "#00ffb2",
    url: `${foundryUrl}/workspace/ontology/home/discover`,
  },
  {
    id: "workshop",
    name: "Workshop",
    caption: "Open app",
    color: "#ff8f4d",
    url: `${foundryUrl}/workspace/workshop/`,
  },
  {
    // This app's own /agents page, where AI players are spawned. It opens in
    // a new tab, which is what the agents need: they run in that tab while
    // you walk around in this one.
    id: "ai-players",
    name: "AI Players",
    caption: "Spawn residents",
    color: "#ff5c8a",
    url: `${window.location.origin}${import.meta.env.BASE_URL}agents`,
  },
];
