# Multilingual Alias Arrays Design

## Intent

One concept may have several valid names in the same language. For example, a
single work has two English titles, one Japanese title, and one Simplified
Chinese title. Every listed name must be usable as an exact lookup input.

The service is not deployed, so this change deliberately replaces the current
single-string translation contract instead of retaining a compatibility layer.

## API contract

`translations` is a map of BCP 47-style language tags to non-empty arrays of
non-empty strings. `en` and `zh-Hans` remain required. The first item in an
array is the preferred display name; later items are alternate names with equal
lookup authority.

```json
{
  "translations": {
    "en": [
      "Rascal Does Not Dream of Bunny Girl Senpai",
      "Seishun Buta Yarou wa Bunny Girl Senpai no Yume o Minai"
    ],
    "ja": ["青春ブタ野郎はバニーガール先輩の夢を見ない"],
    "zh-Hans": ["青春猪头少年不会梦到兔女郎学长"]
  },
  "parentId": null
}
```

`POST /v1/terms` is a create-only endpoint: it validates this shape, checks all
submitted names for conflicts, and returns the complete arrays. It returns
`409 term_conflict` if any preferred or alternate name already belongs to an
existing term in the same language; it never silently overwrites that term.
`GET
/v1/terms` accepts any preferred or alternate name in `q` and returns complete
arrays. Its `translation` field is the entire target-language array, or `null`
when the target language is absent. Parent summaries use the same array shape.

Search responses contain `id`, which the caller uses to append one name without
resubmitting the full term:

```http
POST /v1/terms/:id/names
```

```json
{ "language": "en", "value": "Rascal Does Not Dream of Bunny Girl Senpai" }
```

For example, a caller searches for `Seishun Buta Yarou wa Bunny Girl Senpai no
Yume o Minai`, reads the returned `id`, and posts this request to append the
official English title. The endpoint preserves the existing first English name,
every other translation, and the parent relationship. It returns the complete
updated term with status `200`; reposting the same normalized name to the same
term is idempotent and also returns `200`.

After authentication, this endpoint first loads `:id`. If the term does not
exist, it stops with `404 term_not_found`; it does not inspect or write the
submitted language/value. Only an existing term proceeds to language/value
validation, duplicate detection, and the atomic append.

## Uniqueness and updates

Within one payload, the same normalized text cannot occur twice in a language
array. Across the database, a normalized name may belong to only one term for
its language tag, whether that name is preferred or alternate. Creation checks
every submitted name before writing, and a collision returns `409 term_conflict`.
This preserves deterministic exact lookup.

Creation, append-name conflict detection, and `GET /v1/terms?q=...` all use the
same normalization: Unicode NFKC, trimming, and English lowercasing. Therefore
`Rascal Does Not Dream of Bunny Girl Senpai` and
`rascal does not dream of bunny girl senpai` are the same English name for both
duplicate detection and exact search.

The append-name endpoint returns `404 term_not_found` for an unknown ID,
`400 validation_error` for an invalid language or value, and `409 term_conflict`
if that normalized name already belongs to a different term in the same
language.

The normalized first English name is the preferred display name but does not
grant overwrite authority. A future explicit update endpoint can replace full
arrays and parent data; it is outside this change. The append-name endpoint is
the supported mutation for adding one new name.

## SQLite migration

Database schema version 4 converts every existing scalar translation value in
`terms.translations_json` to a one-element array. It rebuilds
`term_translations` so the primary key includes `normalized_value`, allowing
multiple names for one `(term_id, language_tag)`, while retaining the global
unique constraint on `(language_tag, normalized_value)`.

The v4 lookup table uses:

```sql
PRIMARY KEY (term_id, language_tag, normalized_value)
UNIQUE (language_tag, normalized_value)
```

The unique composite index directly serves exact case-insensitive alias search
and duplicate checks (`WHERE language_tag = ? AND normalized_value = ?`), while
the primary key serves a term's complete name collection. `terms.english_key`
continues to have its unique identity index, and `terms.parent_id` has a normal
index for hierarchy reads. The superseded standalone lookup index is removed
during migration rather than duplicated.

The migration runs in one transaction. It aborts without mutation if a stored
JSON value is malformed, required translation arrays would be invalid, or a
rebuilt lookup row conflicts with another term. Existing parent relationships
are unchanged.

## Error handling and tests

Invalid language values, empty arrays, non-string array members, or local
duplicates return `400 validation_error`. Cross-term name collisions return
`409 term_conflict`. The test suite must prove multi-English-title creation,
lookup through each English title, array target responses, parent summaries,
local and cross-term collision rejection, and migration of a version 3 database
with a parent relationship.

## Non-goals

There is no per-name metadata, locale-specific ranking, fuzzy search, or name
removal endpoint. Those are possible later additions on top of the array model.
