# Supabase migrations

## New Supabase project (recommended)

Run **one file** in the SQL editor:

**`supabase/FRESH_PROJECT_SETUP.sql`**

Then skip `001`–`010`.

Populate cases via Railway `POST /admin/sync-dropbox-structure` (or copy `case_slack_channels` from your old project).

---

## If you run numbered files instead

| File | Run on fresh project? | Notes |
|------|----------------------|--------|
| 001–004 | **Skip** | Old / alternate schemas |
| **003** | **Yes** (before 006) | Creates `case_slack_channels` |
| **005** | **Yes** | `file_sorter_items`, `audit_events`, `case_folders` |
| **006** | **Yes** (after 003) | Adds `dropbox_folder_name` — fails without 003 |
| **007** | **Yes** | Storage bucket `file-sorter-temp` |
| **008** | **Yes** (after 005) | `email_received_at` column |
| **009** | **Yes** (after 003) | Creates `matching_hints` |
| **010** | **Skip** | Only upgrades old DBs that ran 009 *before* `hint_type` existed |

### Why 010 failed

`010` **alters** `matching_hints`. On a fresh project that table is created by **`009`** with the final schema already. Running `010` without `009` → `relation "matching_hints" does not exist`.

### Why 006 failed

`006` **alters** `case_slack_channels`. Run **`003`** first (or use `FRESH_PROJECT_SETUP.sql`).

---

## Old project (File Sorter added to existing Supabase)

Run **005** only, then **006–009** as needed. Run **010** only if `matching_hints` exists but has no `hint_type` column.
