import type { CandidateReviewFailure } from "@/db/candidates";

type ErrorWithCode = Error & { code?: unknown };

// Database adapters wrap the useful PostgreSQL error in a query error's cause.
function underlyingError(error: unknown): unknown {
  const seen = new Set<unknown>();
  while (error instanceof Error && error.cause instanceof Error && !seen.has(error.cause)) {
    seen.add(error);
    error = error.cause;
  }
  return error;
}

const fallbackCodes: Record<CandidateReviewFailure["action"], string> = {
  MATERIALIZE: "REVIEW_EVENT_CREATE_FAILED",
  LINK: "REVIEW_EVENT_LINK_FAILED",
  REJECT: "REVIEW_CANDIDATE_REJECT_FAILED",
};

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected review operation failure";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]")
    .replace(/password=[^\s]+/gi, "password=[redacted]")
    .slice(0, 600);
}

export function candidateReviewFailure(action: CandidateReviewFailure["action"], error: unknown): CandidateReviewFailure {
  const cause = underlyingError(error);
  const providedCode = cause instanceof Error && typeof (cause as ErrorWithCode).code === "string"
    ? String((cause as ErrorWithCode).code).trim()
    : "";
  return {
    action,
    errorCode: providedCode || fallbackCodes[action],
    errorId: crypto.randomUUID(),
    message: safeMessage(cause),
    occurredAt: new Date().toISOString(),
  };
}

export function reviewFailureResponse(failure: CandidateReviewFailure, message: string) {
  return Response.json({
    error: `${message}: ${failure.message} · ${failure.errorCode} · reference ${failure.errorId}`,
    errorCode: failure.errorCode,
    errorId: failure.errorId,
  }, { status: 500 });
}
