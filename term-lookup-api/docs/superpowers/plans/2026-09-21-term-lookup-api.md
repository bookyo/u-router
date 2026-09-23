# Term Lookup API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small PM2-deployable Node.js service for authenticated creation and exact cross-language lookup of professional terms.

**Architecture:** A Node core HTTP server owns JSON parsing, authentication, and route dispatch. A SQLite repository persists each term plus normalized per-language lookup keys, so new BCP 47 language tags require data only rather than schema changes.

**Tech Stack:** Node.js 25, `node:http`, `node:sqlite`, `node:crypto`, `node:test`, PM2.

**Spec:** `term-lookup-api/docs/superpowers/specs/2026-09-21-term-lookup-api-design.md`

## Global Constraints

- Create files only below `term-lookup-api/`; do not modify the existing `master/`, `edge/`, or `ro-analysis/` work.
- Require non-empty `zh-Hans` and `en` translation strings on every create request.
- Accept extensible BCP 47-style language tags such as `zh-Hant`, `ja`, and `ko`.
- Require an API key on all term routes and use port 4444 by default.
- Keep credentials in `.env`, never in source or PM2 configuration.

## Review Focus

- An API request with an incorrect key must receive 401 and must not reach storage.
- A create request missing either required language must receive 400.
- A duplicate English term must update rather than create a second record.
- Querying a stored source translation for an absent target language must be successful with `translation: null`.
- Invalid JSON and over-size request bodies must receive JSON errors rather than crash the server.

### Task 1: Establish the service contract and persistence boundary

**Files:**
- Create: `term-lookup-api/package.json`
- Create: `term-lookup-api/test/api.test.js`
- Create: `term-lookup-api/src/app.js`
- Create: `term-lookup-api/src/term-repository.js`

**Interfaces:**
- Produces: `createApp({ apiKey, databasePath })`, returning a Node request handler.
- Produces: `TermRepository` with `upsert(translations)` and `find({ value, from })`.

- [ ] **Step 1: Write failing integration tests**

```js
test('creates a required bilingual term and queries en to zh-Hans', async () => {
  const created = await request('POST', '/v1/terms', apiKey, {
    translations: { en: 'container orchestration', 'zh-Hans': '容器编排' }
  });
  assert.equal(created.status, 201);
  const found = await request('GET', '/v1/terms?q=container%20orchestration&from=en&to=zh-Hans', apiKey);
  assert.equal(found.body.translation, '容器编排');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: failure because the service entry point does not yet exist.

- [ ] **Step 3: Implement the smallest real server and SQLite repository**

Create the schema at startup, normalize stored lookup values with `NFKC` plus
locale-independent lowercasing, and return JSON responses for `POST /v1/terms`
and `GET /v1/terms`.

- [ ] **Step 4: Run the full test command**

Run: `npm test`
Expected: all contract tests pass.

### Task 2: Add validation, authentication, and update semantics

**Files:**
- Modify: `term-lookup-api/test/api.test.js`
- Modify: `term-lookup-api/src/app.js`
- Modify: `term-lookup-api/src/term-repository.js`

**Interfaces:**
- Consumes: `createApp` and `TermRepository` from Task 1.
- Produces: validation errors, 401 authentication responses, and English-keyed upsert behavior.

- [ ] **Step 1: Write failing tests for invalid input, wrong credentials, duplicate upsert, extensible tags, and missing target translations**

```js
assert.equal((await request('POST', '/v1/terms', apiKey, { translations: { en: 'cache' } })).status, 400);
assert.equal((await request('GET', '/v1/terms?q=cache&from=en&to=zh-Hans', 'wrong-key')).status, 401);
```

- [ ] **Step 2: Run the test suite to verify these contracts fail**

Run: `npm test`
Expected: failure on the newly added cases.

- [ ] **Step 3: Add minimal validation and timing-safe API-key comparison**

Validate string maps and tags, use a constant-time comparison after equal-length
checking, and update the original term row when normalized `en` matches.

- [ ] **Step 4: Run the full test command**

Run: `npm test`
Expected: all tests pass.

### Task 3: Package configuration and deployment documentation

**Files:**
- Create: `term-lookup-api/.env.example`
- Create: `term-lookup-api/.gitignore`
- Create: `term-lookup-api/ecosystem.config.cjs`
- Create: `term-lookup-api/README.md`
- Modify: `term-lookup-api/test/api.test.js`

**Interfaces:**
- Consumes: app environment variables `API_KEY`, `PORT`, and `DATABASE_PATH`.
- Produces: PM2 startup configuration and repeatable local/deployment instructions.

- [ ] **Step 1: Write a failing test for the public health route and request-size protection**

```js
assert.equal((await request('GET', '/health')).status, 200);
assert.equal((await oversizedCreateRequest()).status, 413);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: failure on missing health or request-size behavior.

- [ ] **Step 3: Implement health and bounded body parsing, then add deployment files**

Set `PORT=4444` in PM2's production environment, load `.env` in the entry
point without overwriting supplied process variables, and document `npm test`
and `pm2 start ecosystem.config.cjs`.

- [ ] **Step 4: Run syntax, full test, and start-up smoke checks**

Run: `npm test && node --check src/server.js && API_KEY=test PORT=4444 node src/server.js`
Expected: tests and syntax pass; the process listens on port 4444 until stopped.

## Self-review

- Spec coverage: Tasks 1-3 cover required fields, extensible tags, authenticated create/query, SQLite persistence, port 4444, PM2, and operational documentation.
- Placeholder scan: no deferred implementation markers are present.
- Type consistency: `createApp` is the testable HTTP boundary; `TermRepository` is the persistence boundary used by it.
- Review focus: each listed failure mode is explicitly assigned to Tasks 2 or 3 tests.
