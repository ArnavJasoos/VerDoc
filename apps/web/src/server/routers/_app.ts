import { router } from "../trpc";
import { authRouter } from "./auth";
import { documentsRouter } from "./documents";

export const appRouter = router({
  auth: authRouter,
  documents: documentsRouter,
});

export type AppRouter = typeof appRouter;
