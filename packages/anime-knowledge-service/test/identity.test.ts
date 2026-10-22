import assert from "node:assert/strict";
import test from "node:test";
import { bangumiReference, encodeLegacyBangumiId } from "../src/identity/bangumi.js";

test("legacy Bangumi ids remain compatible with uniqueIdHelper", () => {
  assert.equal(encodeLegacyBangumiId(1), 639290955);
  assert.equal(encodeLegacyBangumiId(123), 402970710);
  assert.equal(encodeLegacyBangumiId(1000), 89422729);
  assert.equal(encodeLegacyBangumiId(999999999), 419019496);
  assert.equal(bangumiReference("subject", 123).canonicalKey, "bangumi:subject:123");
});
