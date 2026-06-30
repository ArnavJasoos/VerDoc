import { router } from "../trpc";
import { assignmentsRouter } from "./assignments";
import { authRouter } from "./auth";
import { documentsRouter } from "./documents";

export const appRouter = router({
  auth: authRouter,
  documents: documentsRouter,
  assignments: assignmentsRouter,
});

export type AppRouter = typeof appRouter;
