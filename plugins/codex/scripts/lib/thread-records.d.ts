export type RecordId = string;
export type RoundId = string;
export type ExecutorKey = string;

// Invariants for the thread-record model:
// - one record exists per (workspaceRoot, executorKey, threadId);
// - a round belongs to exactly one record;
// - seq is shared and strictly monotonic within a record;
// - jobId === roundId during the compatibility window;
// - recordId is the first dispatch job id assigned to the record.
export interface ThreadRound {
  jobId: string;
  firstSeq: string | null;
  lastSeq: string | null;
  executorTurnIds: string[];
  sessionId: string | null;
  prompt: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean };
  result: unknown | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RoundReceipt extends ThreadRound {
  schemaVersion: 1;
  recordId: RecordId;
  roundId: RoundId;
  job: Record<string, unknown>;
}

export interface ThreadRecordManifest {
  schemaVersion: 1;
  recordId: RecordId;
  workspaceRoot: string;
  executorKey: ExecutorKey;
  threadId: string | null;
  activeRoundId: RoundId | null;
  streamId: string;
  earliestSeq: string;
  committedSeq: string;
  continuity: "complete" | "partial";
  segments: Array<{
    file: string;
    bytes: number;
    firstSeq: string;
    lastSeq: string;
  }>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  closed?: boolean;
  writerPid?: number | null;
}

export interface ThreadRecordLiveView {
  schemaVersion: 1;
  recordId: RecordId;
  threadId: string | null;
  activeRoundId: RoundId | null;
  rounds: ThreadRound[];
  history: { committedSeq: string; continuity: "complete" | "partial" };
}

export interface ThreadIndexFile {
  schemaVersion: 1;
  workspaceRoot: string;
  executorKey: ExecutorKey;
  threadId: string;
  recordId: RecordId;
}

export interface JobIndexFile {
  schemaVersion: 1;
  jobId: string;
  roundId: RoundId;
  recordId: RecordId;
}

export interface LegacyHistoryCursor {
  protocolVersion: 1;
  jobId: string;
  streamId: string;
  lastAppliedSeq: string;
}

export interface ThreadRecordHistoryCursor {
  protocolVersion: 2;
  recordId: RecordId;
  streamId: string;
  lastAppliedSeq: string;
}

export type HistoryCursor = LegacyHistoryCursor | ThreadRecordHistoryCursor;
