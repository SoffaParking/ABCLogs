# Ingest API

Everything reaches apiloupe through one endpoint. The importer and (from M2)
the Node SDK use it; so can anything that can make an HTTP request.

## Authentication

Create a key in **Settings → Projects → your project**. Send it as a bearer
token:

```
Authorization: Bearer alk_<prefix>_<secret>
```

`GET /ingest/v1/check` answers `200 {"ok": true, "project": {...}}` for a
working key and `401` otherwise.

## `POST /ingest/v1/events`

Body: JSON, optionally gzip-compressed (`Content-Encoding: gzip`), at most
16 MB once decompressed.

```json
{
  "events": [
    {
      "type": "request",
      "id": "optional-dedup-key",
      "time": "2026-10-20T12:00:00.123Z",
      "service": "api",
      "method": "GET",
      "path": "/users/42",
      "route": "/users/:id",
      "status": 200,
      "durationMs": 12.5,
      "requestId": "r-42",
      "attrs": { "region": "eu-west-1" }
    },
    {
      "type": "log",
      "time": 1760961600123,
      "level": "error",
      "message": "payment failed",
      "requestId": "r-42",
      "error": { "type": "TimeoutError", "message": "gateway timeout", "stack": "TimeoutError: …" }
    }
  ]
}
```

A batch holds 1 to 1000 events.

| Field        | Events  | Notes                                                                                                                                |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type`       | all     | `request` or `log`.                                                                                                                  |
| `time`       | all     | ISO 8601 string, or epoch milliseconds. Must be within the retention period and no more than an hour ahead.                          |
| `id`         | all     | Optional. The same id at the same time is stored once, so resending is safe. Without an id, the event's content is its identity.     |
| `service`    | all     | Optional; lets one project hold several services.                                                                                    |
| `level`      | all     | A pino number (10–60) or a name: `trace`, `debug`, `info`, `warn`/`warning`, `error`, `fatal`/`critical` and other common spellings. |
| `requestId`  | all     | Links a request to the log lines written while serving it.                                                                           |
| `attrs`      | all     | Optional object of extra fields. Keys that look secret are masked; above 16 KB it is replaced by a marker.                           |
| `method`     | request | HTTP method.                                                                                                                         |
| `path`       | request | URL path; any query string is removed.                                                                                               |
| `route`      | request | The route pattern. Optional: when missing, ids are folded out of the path (`/users/42` → `/users/:id`).                              |
| `status`     | request | HTTP status code.                                                                                                                    |
| `durationMs` | request | Optional.                                                                                                                            |
| `message`    | log     | Required, may be empty. Cut at 8 KB.                                                                                                 |
| `error`      | log     | Optional `{type, message, stack}`. The stack is cut at 32 KB.                                                                        |

For a request, `level` defaults from the status: 5xx `error`, 4xx `warn`,
anything else `info`.

### Response

`202 Accepted`:

```json
{ "accepted": 1, "duplicates": 0, "rejected": [{ "index": 1, "reason": "time is in the future" }] }
```

Each event is checked on its own; one bad event does not lose the rest.

| Status | Meaning                                                                             |
| ------ | ----------------------------------------------------------------------------------- |
| 202    | Processed. Check `rejected`.                                                        |
| 400    | The batch itself is malformed (not JSON, no `events` array, more than 1000 events). |
| 401    | Missing, unknown or revoked key.                                                    |
| 413    | Body too large.                                                                     |
| 415    | Unsupported `Content-Type` or `Content-Encoding`.                                   |
| 429    | Rate limit; wait for `Retry-After` seconds.                                         |
| 503    | The server is busy writing other batches; retry after `Retry-After` seconds.        |

Retrying a batch after a timeout is always safe: events already stored come
back as `duplicates`.
