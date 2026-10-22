import { z } from "zod";
import { eventSessionSchema, eventExhibitorSchema, eventUpdateSchema, eventGuestSchema, eventActivitySchema, eventTicketOfferSchema, eventFactSchema } from "@kita/contracts";
const sourced = { sourceDocumentIds: true, confidence: true } as const;
const identity = { ...sourced, externalKey: true } as const;
const recordId = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/,"Enter an ISO date or timestamp with timezone").refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid ISO date or timestamp").nullable();
const timed = { startDate: z.string().datetime({offset:true}).nullable(), endDate: z.string().datetime({offset:true}).nullable() };
const configs = {
  sessions: { table: "session", fields: { title:"title",sessionType:"session_type",description:"description",startDate:"start_at",endDate:"end_at",timezone:"timezone",venueName:"venue_name",room:"room",ageRating:"age_rating",organizationNames:"organization_names",tags:"tags",imageMediaCandidateId:"image_media_candidate_id" } },
  exhibitors: { table:"exhibitor",fields:{name:"name",description:"description",booth:"booth",categories:"categories",featured:"featured",websiteUrl:"website_url",organizationNames:"organization_names",logoMediaCandidateId:"logo_media_candidate_id"} },
  updates: { table:"event_update",fields:{title:"title",summary:"summary",publishedAt:"published_at",category:"category",sourceName:"source_name",sourceUrl:"source_url",imageMediaCandidateId:"image_media_candidate_id"} },
  guests: {table:"guest",fields:{name:"name",description:"description",role:"role",organizationNames:"organization_names",imageMediaCandidateId:"image_media_candidate_id"}},
  activities: {table:"activity",fields:{title:"title",description:"description",activityType:"activity_type",startDate:"start_at",endDate:"end_at",location:"location",organizationNames:"organization_names",mediaCandidateIds:"media_candidate_ids"}},
  ticketOffers: {table:"ticket_offer",fields:{name:"name",description:"description",purchaseUrl:"purchase_url",priceText:"price_text",availability:"availability",validFrom:"valid_from",validThrough:"valid_through"}},
  facts: {table:"event_fact",fields:{label:"label",value:"value_json",unit:"unit"}},
  relatedSubjects: {table:"related_subject",fields:{label:"label",description:"description",featured:"featured"}},
} as const;
export const eventContentConfigs = configs;
// Only explicitly editable fields can be written; provenance and canonical IDs stay attached.
const only = (schema: z.ZodObject<z.ZodRawShape>, collection: keyof typeof configs) => z.object(Object.fromEntries(Object.keys(configs[collection].fields).map((key) => [key,schema.shape[key]]))).partial().strict();
export const contentEditSchema = z.discriminatedUnion("collection", [
  z.object({collection:z.literal("sessions"),id:recordId,changes:only(eventSessionSchema.omit(identity).extend(timed),"sessions")}),
  z.object({collection:z.literal("exhibitors"),id:recordId,changes:only(eventExhibitorSchema.omit(identity),"exhibitors")}),
  z.object({collection:z.literal("updates"),id:recordId,changes:only(eventUpdateSchema.omit(identity).extend({publishedAt:date}),"updates")}),
  z.object({collection:z.literal("guests"),id:recordId,changes:only(eventGuestSchema.omit(identity),"guests")}),
  z.object({collection:z.literal("activities"),id:recordId,changes:only(eventActivitySchema.omit(identity).extend(timed),"activities")}),
  z.object({collection:z.literal("ticketOffers"),id:recordId,changes:only(eventTicketOfferSchema.omit(identity).extend({validFrom:date,validThrough:date}),"ticketOffers")}),
  z.object({collection:z.literal("facts"),id:recordId,changes:only(eventFactSchema.omit(sourced),"facts")}),
  z.object({collection:z.literal("relatedSubjects"),id:z.string().regex(/^bangumi:(subject|person|character|episode):\d+$/),changes:z.object({label:z.string().min(1),description:z.string(),featured:z.boolean()}).partial().strict()}),
]);
