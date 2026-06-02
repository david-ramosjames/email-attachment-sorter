# RJL File Sorter

AI-assisted document filing workflow for **Ramos James Law**. Inbound emails with attachments are analyzed, matched to cases, queued in Slack for human review, and only saved to Dropbox after explicit approval.

**Human approval is required.** The system never autonomously files documents.

## Architecture

```
Inbound Email (webhook)
    → Email ingestion (provider adapters)
    → Case matcher (Supabase index, no free-form AI case invention)
    → AI classifier (restricted to candidate cases only)
    → Slack #file-sorter-queue (Block Kit + action buttons)
    → [Approve] → Dropbox upload → Case Slack channel confirmation
    → Full audit trail in Supabase
```

## Tech stack

- Node.js 20+ / TypeScript / Express
- Supabase (Postgres + optional temp file storage)
- OpenAI (structured JSON classification)
- Slack (primary UI)
- Dropbox (file storage)
- Railway (hosting)

## Project structure

```
src/
  config/          Environment validation
  db/              Supabase client & queries
  routes/          HTTP endpoints
  services/
    emailIngestion/   Provider adapters (generic, SendGrid)
    emailIngestionService.ts
    caseMatcher.ts
    aiClassifier.ts
    slackService.ts
    dropboxService.ts
    auditService.ts
    fileSorterWorkflow.ts
  types/
  utils/
supabase/migrations/
```

## Setup

### 1. Supabase

1. Create a **dedicated** Supabase project for File Sorter.
2. In SQL Editor, run **`supabase/FRESH_PROJECT_SETUP.sql`** once (see `supabase/MIGRATIONS.md` — do not run `001`–`004` or `010` on a new project).
3. Point Railway `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at this project.
4. Run [Slack case sync](#slack-case-index) (`POST /admin/sync-cases-from-slack`) or [Google Sheets](#google-sheets-case-index), then `POST /admin/sync-dropbox-structure` to link Dropbox folder names.

### 2. Slack app

1. Create a Slack app at [api.slack.com](https://api.slack.com/apps).
2. **OAuth scopes:** `chat:write`, `channels:read`, `groups:read` (private channels), `users:read`, `files:write`
3. Install to workspace; copy **Bot Token** → `SLACK_BOT_TOKEN`
4. **Interactivity:** enable and set Request URL to:
   `https://<your-railway-domain>/webhooks/slack/interactions`
5. Copy **Signing Secret** → `SLACK_SIGNING_SECRET`
6. Create `#file-sorter-queue`; copy channel ID → `SLACK_FILE_SORTER_QUEUE_CHANNEL_ID`
7. Invite the bot to the queue channel and all case channels.

### 3. Dropbox

1. Create a Dropbox app with **files.content.write** and **sharing.write** scopes.
2. Generate an access token → `DROPBOX_ACCESS_TOKEN`

### 4. OpenAI

Set `OPENAI_API_KEY` with access to `gpt-4o-mini` (structured outputs).

### 5. Environment

Copy `.env.example` to `.env` and fill in all values.

```bash
npm install
npm run dev    # local development
npm run build && npm start
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/webhooks/inbound-email` | Receive inbound email payloads |
| POST | `/webhooks/slack/events` | Slack Events API — auto-update case index |
| POST | `/webhooks/slack/interactions` | Slack button actions |
| GET | `/admin/file-sorter-items` | List items (`?status=&limit=`) |
| GET | `/admin/cases` | List cases |
| POST | `/admin/sync-cases-from-slack` | Sync `case_slack_channels` from Slack channels |
| GET | `/admin/slack-case-sync-status` | Last Slack case sync time |
| POST | `/admin/sync-cases-from-sheet` | Sync `case_slack_channels` from Google Sheet (optional) |
| GET | `/admin/case-sheet-sync-status` | Last sheet sync time / config status |
| POST | `/admin/sync-dropbox-structure` | Link Dropbox folder names + index subfolders |
| POST | `/admin/reindex-dropbox-folders` | Reindex one case’s Dropbox subfolders |

### Inbound email webhook

**Generic format** (default):

```json
{
  "gmailMessageId": "18abc123",
  "fromEmail": "records@hospital.com",
  "toEmails": ["file-sorter@ramosjameslaw.com"],
  "ccEmails": [],
  "subject": "Medical records - Maria Lopez",
  "bodyExcerpt": "Please find attached...",
  "receivedAt": "2026-05-24T12:00:00Z",
  "attachments": [
    {
      "filename": "records.pdf",
      "mimeType": "application/pdf",
      "size": 102400,
      "contentBase64": "..."
    }
  ]
}
```

Emails **without attachments are ignored** for MVP.

Optional header `X-Webhook-Secret` when `INBOUND_EMAIL_WEBHOOK_SECRET` is set.

### Slack review workflow

1. Item appears in `#file-sorter-queue` with AI suggestions.
2. **Approve** — saves to Dropbox, updates message, posts to case channel.
3. **Change** — reply in thread:
   ```
   case: Maria Lopez
   folder: Pleadings
   ```
   Then click **Approve**.
4. **Needs Attention** — flags item, keeps in queue.
5. **Do Not Sort** — marks ignored, no Dropbox action.

Confidence below **0.75** or no case match → `needs_attention`.

## Railway deployment

1. Push this repo to GitHub.
2. In [Railway](https://railway.app), **New Project → Deploy from GitHub**.
3. Add environment variables from `.env.example`.
4. Railway uses `railway.json`:
   - Build: `npm run build`
   - Start: `npm start`
   - Health check: `GET /health`
5. Copy the public URL for:
   - Slack interactivity webhook
   - Google Workspace / email provider inbound route

### Recommended Railway variables

```
PORT=3000
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_FILE_SORTER_QUEUE_CHANNEL_ID=
DROPBOX_ACCESS_TOKEN=
INBOUND_EMAIL_WEBHOOK_SECRET=
```

## Slack case index (recommended)

If case channels follow a naming pattern with the matter number (e.g. `javiermejias-etal-625` or `276-regina-peek`), the bot can build the case index from Slack — **no Google Sheet required**.

### Requirements

1. Bot has **`channels:read`**, **`groups:read`**, and **`channels:manage`** (for events) scopes.
2. Bot is **invited to every case channel** (private channels are invisible otherwise).
3. Channel names end with **`-{caseNumber}`** (e.g. `javiermejias-etal-625`) — same rule as the legacy Google Sheet script.
4. Optional status in channel topic inside parentheses, e.g. `Attorney: @ryan | (Pre-Lit)`.

### Real-time updates (replaces Sheet webhook)

In your Slack app → **Event Subscriptions**:

1. Enable events.
2. Request URL: `https://YOUR-APP.up.railway.app/webhooks/slack/events`
3. Subscribe to bot events:
   - `channel_created`
   - `channel_rename`
   - `member_joined_channel`
   - `message.channels` (for topic/name changes)
   - `message.groups` (private channels)

When a case channel is created, renamed, or its topic changes, Supabase updates immediately (same events the Apps Script listened for).

### Scheduled backfill

Every **4 hours** (`SLACK_CASE_SYNC_INTERVAL_MINUTES=240`) the app re-lists all channels — same as `backfillExistingCaseChannels()` in the old script.

### Run sync

```powershell
Invoke-RestMethod -Method POST -Uri "https://YOUR-APP.up.railway.app/admin/sync-cases-from-slack"
```

Then Dropbox structure sync. By default this runs every 6 hours (`SLACK_CASE_SYNC_INTERVAL_MINUTES=360`).

Skipped channels (no case number in name, `#file-sorter-queue`, `general`, `random`) are listed in the response under `skippedChannels`.

---

## Google Sheets case index (optional)

Use this if you already maintain a spreadsheet or need fields Slack does not have. The app reads the sheet and upserts into `case_slack_channels`. Dropbox sync only adds `dropbox_folder_name` for rows that already exist.

### 1. Google Cloud service account

1. [Google Cloud Console](https://console.cloud.google.com/) → create or select a project.
2. Enable **Google Sheets API**.
3. **IAM → Service Accounts** → Create → Keys → **Add key → JSON**.
4. Copy the JSON into Railway as `GOOGLE_SERVICE_ACCOUNT_JSON` (single line), or set `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`.

### 2. Share the spreadsheet

Open the case sheet → **Share** → add the service account email (from the JSON `client_email`) as **Viewer**.

### 3. Railway variables

```
GOOGLE_SHEETS_SPREADSHEET_ID=   # from the sheet URL: /d/THIS_PART/edit
GOOGLE_SHEETS_RANGE=Cases!A:F   # tab name + columns
GOOGLE_SERVICE_ACCOUNT_JSON=    # full JSON, one line
CASE_SHEET_SYNC_INTERVAL_MINUTES=360
```

### 4. Sheet columns

First row should be **headers**. Recognized names (any of these):

| Field | Example header names |
|-------|----------------------|
| Case number | `Case Number`, `Case #`, `case_number` |
| Slack channel / client name | `Slack Channel`, `Channel Name`, `Client`, `Case Name` |
| Slack channel ID | `Channel ID`, `slack_channel_id` (optional) |
| Stage | `Stage`, `Topic`, `topic_stage` (optional) |
| Dropbox folder | `Dropbox Folder`, `dropbox` (optional) |

If there is no header row, columns are read as: **A** = case number, **B** = channel name, **C** = channel ID, **D** = stage, **E** = Dropbox folder.

### 5. Run sync

```powershell
Invoke-RestMethod -Method POST -Uri "https://YOUR-APP.up.railway.app/admin/sync-cases-from-sheet"
```

Then run Dropbox structure sync so folder names link:

```powershell
Invoke-RestMethod -Method POST -Uri "https://YOUR-APP.up.railway.app/admin/sync-dropbox-structure"
```

## Google Workspace email routing

Configure Workspace to **copy** (not redirect) inbound mail with attachments to `file-sorter@yourdomain.com`, then forward to your webhook via:

- SendGrid Inbound Parse
- Google Apps Script posting to `/webhooks/inbound-email`
- Or another ESP with `X-Email-Provider: sendgrid` header for the SendGrid adapter

The original recipient still receives the email.

## Status values

`file_sorter_items.status`:

| Status | Meaning |
|--------|---------|
| `pending_review` | Awaiting Slack review |
| `needs_attention` | Low confidence or duplicate |
| `approved` | Approved, upload in progress |
| `saved` | Stored in Dropbox |
| `ignored` | Reviewer declined to sort |
| `failed` | Processing error |

## Future expansion

Designed for:

- Quo ingestion
- Slack file ingestion
- Auto-save rules
- Admin web UI

## License

Proprietary — Ramos James Law internal use.
