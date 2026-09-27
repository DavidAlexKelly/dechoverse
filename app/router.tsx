import { createBrowserRouter } from "react-router-dom";
import AgentConsole from "@/agents/host/AgentConsole";
import AuthCallback from "@/app/AuthCallback";
import Game from "@/game/Game";

export const router = createBrowserRouter(
  [
    {
      // First person shooter that explores Foundry spaces and projects
      path: "/",
      element: <Game />,
    },
    {
      path: "/fps",
      element: <Game />,
    },
    {
      // Control panel for the AI players, who run in this tab while it is open
      path: "/agents",
      element: <AgentConsole />,
    },
    {
      // This is the route defined in your application's redirect URL
      path: "/auth/callback",
      element: <AuthCallback />,
    },
  ],
  { basename: import.meta.env.BASE_URL },
);
