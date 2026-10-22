import { encodeLegacyBangumiId } from "@kita/contracts";

export type BangumiEntityType = "subject" | "person" | "character" | "episode";

export { encodeLegacyBangumiId };

export function bangumiReference(entityType: BangumiEntityType, rawId: number) {
  return {
    provider: "bangumi" as const,
    entityType,
    rawId,
    encodedId: encodeLegacyBangumiId(rawId),
    canonicalKey: `bangumi:${entityType}:${rawId}`,
  };
}

export function bangumiIdentityWarning(): string {
  return "encodedId is a legacy compatibility value and is not globally unique; canonicalKey or (provider, entityType, rawId) is the identity.";
}
