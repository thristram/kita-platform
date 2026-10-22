export type CanonicalId = string;
export type EventType = "CONVENTION" | "CONCERT" | "COSPLAY" | "MEETUP" | "POPUP" | "EXHIBITION" | "DOUJIN" | "SCREENING" | "PANEL" | "SIGNING" | "OTHER";
export type EntityType = "WORK" | "CHARACTER" | "PERSON" | "ORGANIZATION" | "FRANCHISE";
export type CandidateStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "AUTO_ACCEPTED" | "SUPERSEDED";
export type MediaUsageScope = "INTERNAL_ONLY" | "EVIDENCE_ONLY" | "PUBLIC_READY";
export type ManualOverrideMode = "PINNED" | "PREFERRED";
export type JobPriority = "REALTIME" | "HIGH" | "NORMAL" | "BATCH";

export interface EventListing {
  eventId: CanonicalId;
  slug: string;
  eventType: EventType;
  title: string;
  startAt?: string;
  endAt?: string;
  city?: string;
  region?: string;
  primaryImageUrl?: string;
  primaryFandomIds: CanonicalId[];
  projectionVersion: number;
}

export interface WorkerLeaseRequest {
  capabilities: ("INGESTION" | "TEXT" | "VISION" | "HIGH_CONTEXT")[];
  limit: number;
}

export interface WorkerLease {
  jobId: CanonicalId;
  jobType: string;
  priority: JobPriority;
  payload: Record<string, unknown>;
  leaseExpiresAt: string;
}

export interface CandidateDecision {
  candidateId: CanonicalId;
  action: "APPROVE" | "REJECT" | "MERGE";
  editedPayload?: Record<string, unknown>;
  mergeTargetId?: CanonicalId;
}

export * from "./resolution-agent.js";
export * from "./anime-knowledge.js";
export * from "./token-budget.js";
export * from "./event-prompt.js";
