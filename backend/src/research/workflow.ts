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
    // Retired or deleted jobs end without fetching sources or spending model quota.
    return { done: true };
  }
}
