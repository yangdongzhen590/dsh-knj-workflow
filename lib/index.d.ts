export declare const name: string;
export declare const inject: string[];
export declare const Config: import('@deepseek-ai/schemastery').Schema<{
  dataRoot: string;
  httpPrefix: string;
  orchestratorScript: string;
}>;
export declare function apply(ctx: any, config: any): void;
