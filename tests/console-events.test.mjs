import assert from "node:assert/strict";
import test from "node:test";
import { parseEventListQuery } from "../db/consoleEvents.ts";

test("event list defaults to the complete, first page", () => {
  assert.deepEqual(parseEventListQuery(), {
    page: 1,
    pageSize: 25,
    search: "",
    type: "",
    status: "",
    origin: "all",
    time: "all",
    sort: "date",
    direction: "desc",
  });
});

test("event list accepts paging, search, filters, and sorting", () => {
  assert.deepEqual(parseEventListQuery({
    page: "3", pageSize: "100", q: "  WasabiCon  ", type: "CONVENTION",
    status: "PUBLISHED", origin: "LIVE", time: "past", sort: "title", direction: "asc",
  }), {
    page: 3,
    pageSize: 100,
    search: "WasabiCon",
    type: "CONVENTION",
    status: "PUBLISHED",
    origin: "LIVE",
    time: "past",
    sort: "title",
    direction: "asc",
  });
});

test("event list rejects unsupported pagination and sort values", () => {
  const query = parseEventListQuery({ page: "-2", pageSize: "5000", sort: "sql", direction: "up", origin: "UNKNOWN" });
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 25);
  assert.equal(query.sort, "date");
  assert.equal(query.direction, "desc");
  assert.equal(query.origin, "all");
});
