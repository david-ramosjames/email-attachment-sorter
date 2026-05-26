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

1. Create a Supabase project.
2. Run `supabase/migrations/001_initial_schema.sql` in the SQL editor.
3. Create a **public** storage bucket named `file-sorter-temp` (for attachment staging).
4. Seed `cases` and `case_folders` with your active matters.

### 2. Slack app

1. Create a Slack app at [api.slack.com](https://api.slack.com/apps).
2. **OAuth scopes:** `chat:write`, `channels:read`, `users:read`
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
| POST | `/webhooks/slack/interactions` | Slack button actions |
| GET | `/admin/file-sorter-items` | List items (`?status=&limit=`) |
| GET | `/admin/cases` | List cases |
| POST | `/admin/reindex-dropbox-folders` | Sync Dropbox folders → `case_folders` |

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
