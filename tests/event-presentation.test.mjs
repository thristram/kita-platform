import assert from "node:assert/strict";
import test from "node:test";
import { calendarFile, dayKey, matchesSubject } from "../lib/eventPresentation.ts";
import { contentEditSchema } from "../lib/eventContentEdit.ts";
const id="8247b617-b022-410d-b40a-4a97116180be";
test("schedule groups midnight sessions using the venue timezone",()=>{
  assert.equal(dayKey("2026-10-10T02:00:00Z","America/New_York"),"2026-10-09");
  assert.equal(dayKey(null,"America/New_York"),"Undated");
});
test("fandom activities match canonical identity rather than labels or encoded IDs",()=>{
  assert.equal(matchesSubject({subjectTargets:[{canonicalKey:"bangumi:subject:400602"}]},"bangumi:subject:400602"),true);
  assert.equal(matchesSubject({title:"Frieren"},"bangumi:subject:400602"),false);
});
test("calendar preserves instants and escapes multiline event text",()=>{
  const file=calendarFile([{externalKey:"real-session",title:"A, B; C",description:"Line one\nLine two",startDate:"2026-10-09T15:00:00-04:00",endDate:"2026-10-09T16:00:00-04:00",room:"Room 1"}],"America/New_York");
  assert.match(file,/DTSTART:20261009T190000Z/);
  assert.match(file,/DTEND:20261009T200000Z/);
  assert.ok(file.includes("SUMMARY:A\\, B\\; C"));
  assert.ok(file.includes("DESCRIPTION:Line one\\nLine two"));
});
test("content editing accepts blankable dates but rejects invalid enums and malformed dates",()=>{
  assert.equal(contentEditSchema.safeParse({collection:"sessions",id,changes:{startDate:null,room:"Room 1"}}).success,true);
  assert.equal(contentEditSchema.safeParse({collection:"sessions",id,changes:{startDate:"not a date"}}).success,false);
  assert.equal(contentEditSchema.safeParse({collection:"sessions",id,changes:{sessionType:"BOGUS"}}).success,false);
});
test("content editing cannot change source evidence, external keys or canonical targets",()=>{
  for (const changes of [{sourceDocumentIds:[]},{externalKey:"different-key"},{confidence:0},{subjectTargets:[]}]) {
    assert.equal(contentEditSchema.safeParse({collection:"sessions",id,changes}).success,false);
  }
  assert.equal(contentEditSchema.safeParse({collection:"relatedSubjects",id:"bangumi:subject:400602",changes:{rawId:1}}).success,false);
});
test("related subject labels remain editable without replacing canonical identity",()=>{
  assert.equal(contentEditSchema.safeParse({collection:"relatedSubjects",id:"bangumi:subject:400602",changes:{label:"Frieren",featured:true}}).success,true);
});
