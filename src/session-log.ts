import { loadSessions, nextId, saveSessions } from "./store.ts";
import { now } from "./types.ts";
import { captureFileHashes, projectFilePath } from "./git-state.ts";

export interface SessionInput {
  summary: string;
  files?: string[];
  next_steps?: string[];
  author?: string;
}

/** 调用方持有账本锁；共享显式会话与任务自动会话的同一记录方式。 */
export function appendSession(root: string, input: SessionInput, hashes?: Record<string, string>): string {
  const files = (input.files ?? []).map(projectFilePath);
  const fileHashes = hashes ?? captureFileHashes(root, files);
  const data = loadSessions(root);
  const id = nextId("S", data.seq, 4);
  data.seq += 1;
  data.sessions.push({ id, date: now(), author: input.author ?? "", summary: input.summary, files, next_steps: input.next_steps ?? [], file_hashes: fileHashes });
  saveSessions(root, data);
  return id;
}
