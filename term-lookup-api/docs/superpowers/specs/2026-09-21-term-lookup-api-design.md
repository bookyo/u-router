# Term Lookup API Design

## Goal

Provide a small authenticated HTTP API for storing professional terms and
retrieving their equivalents across language tags. It must be deployable as a
single PM2 process on port 4444 and leave room for a future web platform.

## Data model

Each term is an object with a `translations` map keyed by BCP 47 language tags
and an optional `parentId` pointing to one existing term.
`zh-Hans` and `en` are required. Other keys, such as `zh-Hant`, `ja`, and `ko`,
are accepted without code changes. A term is unique by its `en` value after
NFKC normalization, trimming, and English lowercasing; submitting the same
English term updates its translations. Full Unicode case folding is not part of
this initial service. A normalized translation value is unique within its
language tag, so lookup always has one canonical result.

SQLite stores one row per term and one searchable row per translation value.
The latter lets the query API look up any supported input language without
depending on SQLite JSON extensions.

## HTTP contract

All routes except `GET /health` require `X-API-Key: <key>` or
`Authorization: Bearer <key>`. The key comes only from `API_KEY` in the
environment; it is never committed.

- `POST /v1/terms` accepts `{ "translations": { "zh-Hans": "...", "en":
  "..." }, "parentId": 1 }`, validates language tags and non-empty string
  values, and creates or updates the English-keyed term. The parent is optional,
  must exist, and cannot form a self-reference or cycle; omitted or `null`
  clears the parent relationship.
- `GET /v1/terms?q=<value>&from=<tag>&to=<tag>` performs exact normalized
  lookup in the declared source language. It returns the matched translations,
  `parentId`, and a parent translation summary when present; `translation` is
  `null` when the requested target tag is not yet present.
- `GET /health` returns service status without exposing database contents or
  credentials.

Malformed requests return JSON with a stable `error` code. Authentication
failures return 401; a missing record returns 404.

## Runtime and deployment

Use Node.js 25 built-ins only: `node:http`, `node:sqlite`, `node:test`, and
`node:crypto`. The SQLite file defaults to `data/terms.sqlite`; `PORT` defaults
to 4444 and `HOST` defaults to `127.0.0.1`. `ecosystem.config.cjs` starts a single fork-mode PM2 instance and
relies on the service's `.env` loader for `API_KEY` rather than putting secrets
in PM2 configuration.

## Non-goals

No web UI, fuzzy matching, bulk import, user accounts, or rate limiting are
included in this initial service. The versioned API and language-map schema
reserve room for those additions.
