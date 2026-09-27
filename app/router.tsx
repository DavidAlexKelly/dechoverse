import { createBrowserRouter } from "react-router-dom";
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
      // This is the route defined in your application's redirect URL
      path: "/auth/callback",
      element: <AuthCallback />,
    },
  ],
  { basename: import.meta.env.BASE_URL },
);
