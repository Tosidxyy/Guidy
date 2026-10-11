import {
  decidePlanning,
  researchPlanning,
  generatePlanning,
} from "../agent/planning-jobs.ts";
import type { AgentEnv } from "../agent/provider.ts";
import type { SearchEnv } from "./search-provider.ts";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { startJob, processSource, finishJob } from "./jobs.ts";
export class ResearchWorkflow extends WorkflowEntrypoint<
  { DB: D1Database } & AgentEnv & SearchEnv,
  { jobId: string }
> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    if (
      await this.env.DB.prepare("SELECT id FROM planning_jobs WHERE id=?")
        .bind(id)
        .first()
    ) {
      const config = {
        retries: { limit: 0, delay: "1 second" as const },
        timeout: "60 seconds" as const,
      };
      await step.do("planning-decide", config, async () => {
        await decidePlanning(this.env.DB, id, this.env);
        return { done: true };
      });
      await step.do("planning-research", config, async () => {
        await researchPlanning(this.env.DB, id, this.env);
        return { done: true };
      });
      await step.do("planning-generate", config, async () => {
        await generatePlanning(this.env.DB, id, this.env);
        return { done: true };
      });
      return { done: true };
    }
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
