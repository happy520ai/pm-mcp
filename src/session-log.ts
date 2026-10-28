import { loadSessions, nextId, saveSessions } from "./store.ts";
import { now, type Session, type SessionsFile } from "./types.ts";
import { captureFileHashes, projectFilePath } from "./git-state.ts";

export interface SessionInput {
  summary: string;
  files?: string[];
  next_steps?: string[];
  author?: string;
}

/** 只改内存中的会话账本；调用方负责与任务写入一起提交/回滚。
 *  hashes 由调用方预先采集，避免这里再次触碰工作区。 */
export function appendSessionRecord(data: SessionsFile, input: SessionInput, hashes: Record<string, string> = {}): Session {
  const files = (input.files ?? []).map(projectFilePath);
  const id = nextId("S", data.seq, 4);
  data.seq += 1;
  const session: Session = { id, date: now(), author: input.author ?? "", summary: input.summary, files, next_steps: input.next_steps ?? [], file_hashes: hashes };
  data.sessions.push(session);
  return session;
}

/** 单独写会话时使用；调用方必须已持有账本锁。 */
export function appendSession(root: string, input: SessionInput, hashes?: Record<string, string>): string {
  const files = (input.files ?? []).map(projectFilePath);
  const fileHashes = hashes ?? captureFileHashes(root, files);
  const data = loadSessions(root);
  const session = appendSessionRecord(data, { ...input, files }, fileHashes);
  saveSessions(root, data);
  return session.id;
}
