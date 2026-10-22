import assert from "node:assert/strict";
import test from "node:test";
import { candidateReviewFailure } from "../lib/reviewErrors.ts";

test("reports PostgreSQL diagnostics through query wrappers without exposing query parameters", () => {
  const databaseError = Object.assign(new Error("could not determine data type of parameter $12"), { code: "42P18" });
  const queryError = new Error("Failed query: WITH locked AS (...) params: private data", { cause: databaseError });
  const failure = candidateReviewFailure("MATERIALIZE", new Error("Adapter failed", { cause: queryError }));
  assert.equal(failure.errorCode, "42P18");
  assert.equal(failure.message, databaseError.message);
  assert.doesNotMatch(failure.message, /private data|WITH locked/);
});

test("redacts credentials from underlying errors and keeps the action fallback", () => {
  const failure = candidateReviewFailure("LINK", new Error("Query failed", {
    cause: new Error("Connect to postgres://user:secret@example.com/db password=secret failed"),
  }));
  assert.equal(failure.errorCode, "REVIEW_EVENT_LINK_FAILED");
  assert.doesNotMatch(failure.message, /secret|user/);
  assert.match(failure.message, /database-url-redacted/);
});

test("handles plain failures and circular error causes", () => {
  assert.equal(candidateReviewFailure("REJECT", new Error("Rejected")).message, "Rejected");
  assert.equal(candidateReviewFailure("REJECT", null).message, "Unexpected review operation failure");
  const first = new Error("First");
  const second = new Error("Second", { cause: first });
  first.cause = second;
  assert.equal(candidateReviewFailure("MATERIALIZE", first).message, "Second");
});
