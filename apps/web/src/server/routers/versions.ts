import { z } from "zod";
import { lineDiff } from "../versions/yjs-text";
import { versionsService } from "../versions/service";
import { protectedProcedure, router } from "../trpc";

export const versionsRouter = router({
  submit: protectedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      versionsService.submit(ctx.user, input.docId),
    ),

  approve: protectedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      versionsService.approve(ctx.user, input.docId),
    ),

  reject: protectedProcedure
    .input(
      z.object({
        docId: z.string().uuid(),
        recommendation: z.string().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      versionsService.reject(ctx.user, input.docId, input.recommendation),
    ),

  history: protectedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .query(({ ctx, input }) => versionsService.history(ctx.user, input.docId)),

  // Two-snapshot compare (plan §2.3). Decodes both versions' derived text and
  // returns a line diff.
  diff: protectedProcedure
    .input(
      z.object({
        docId: z.string().uuid(),
        beforeVersionId: z.string().uuid(),
        afterVersionId: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [before, after] = await Promise.all([
        versionsService.getText(ctx.user, input.docId, input.beforeVersionId),
        versionsService.getText(ctx.user, input.docId, input.afterVersionId),
      ]);
      return lineDiff(before, after);
    }),
});
