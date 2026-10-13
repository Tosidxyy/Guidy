/** The background planning workflow accepts a persisted job, never user content. */
export interface WorkflowBinding {
  create(options: { id: string; params: { jobId: string } }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
