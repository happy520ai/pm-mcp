/** 同步共享类型：sync.ts 与 CLI 之间避免循环依赖的最小契约（ADR-013）。 */

export interface SyncPushPrompt {
  remoteUrl: string | null;
  remote: string;
  branch: string;
  files: string[];
  warnings: string[];
}
