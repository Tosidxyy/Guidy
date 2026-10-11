import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { startJob, processSource, finishJob } from "./jobs.ts";
export class ResearchWorkflow extends WorkflowEntrypoint<
  { DB: D1Database },
  { jobId: string }
> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    const config = {
      retries: {
        limit: 2,
        delay: "35 seconds" as const,
        backoff: "constant" as const,
      },
      timeout: "30 seconds" as const,
    };
    const positions = await step.do("start", config, () =>
      startJob(this.env.DB, id),
    );
    for (const position of positions)
      await step.do(`source-${position}`, config, async () => {
        await processSource(this.env.DB, id, position);
        return { position };
      });
    await step.do("finish", config, async () => {
      await finishJob(this.env.DB, id);
      return { done: true };
    });
  }
}
