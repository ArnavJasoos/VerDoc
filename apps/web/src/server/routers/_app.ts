import { router } from "../trpc";
import { assignmentsRouter } from "./assignments";
import { authRouter } from "./auth";
import { documentsRouter } from "./documents";
import { notificationsRouter } from "./notifications";
import { versionsRouter } from "./versions";

export const appRouter = router({
  auth: authRouter,
  documents: documentsRouter,
  assignments: assignmentsRouter,
  versions: versionsRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
