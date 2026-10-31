export interface KnjWorkflowChoice {
    id: string;
    name: string;
    revision?: number;
}
export interface KnjWorkflowScheduledTaskInput {
    workflowId: string;
    title: string;
    description?: string;
    /** Optional user-story code exposed to workflow prompts as ${storyCode}. */
    storyCode?: string;
    cwd: string;
}
export interface KnjWorkflowScheduledTaskLaunch {
    taskId: string;
    parentSessionId?: string;
    runId: string;
}
export interface KnjWorkflowSchedulerService {
    listWorkflows(): Promise<KnjWorkflowChoice[]>;
    createAndStartScheduledTask(input: KnjWorkflowScheduledTaskInput): Promise<KnjWorkflowScheduledTaskLaunch>;
}
export declare function createKnjWorkflowSchedulerService(store: any, bridge: any): KnjWorkflowSchedulerService;
export declare const name: string;
export declare const inject: string[];
export declare const Config: import('@deepseek-ai/schemastery').Schema<{
  dataRoot: string;
  httpPrefix: string;
  orchestratorScript: string;
}>;
export declare function apply(ctx: any, config: any): void;
