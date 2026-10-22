# Console Events list

The `/events` operator page reads canonical Events from the database with server-side pagination. It does not reuse the small Overview highlight list. All records, including past and undated Events, are included by default; the Overview continues to request only its next four highlights.

## URL contract

| Parameter | Values | Default |
| --- | --- | --- |
| `page` | Positive integer | `1` |
| `pageSize` | `25`, `50`, `100` | `25` |
| `q` | Event name, type, status, venue location, or linked fandom name | Empty |
| `type` | Event type shown in the filter menu | All |
| `status` | Event status shown in the filter menu | All |
| `time` | `all`, `upcoming`, `past`, `undated` | `all` |
| `origin` | `all`, `LIVE`, `MOCK` | `all` |
| `sort` | `title`, `type`, `date`, `fandom`, `source`, `state` | `date` |
| `direction` | `asc`, `desc` | `desc` |

Changing a filter or sort returns to page 1. Out-of-range pages clamp to the last available page. Database queries return the total and only the requested page, with `event.id` as a stable secondary sort key. Type and status filter options come from the complete Event table, not just the current page. Linked fandom labels and distinct evidence-source counts are calculated for the displayed rows.

Search and pagination apply to the canonical Event list, not the public `/discover` page or other Console queues. The separate Media Library, crawler dashboard, resolution dashboard, and existing-event chooser still have their own query limits; they are not covered by this Events-list contract.
