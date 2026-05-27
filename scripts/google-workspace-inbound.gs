/**
 * RJL File Sorter — Google Workspace inbound email bridge
 *
 * Deploy on the file-sorter@ mailbox (or a dedicated processing account).
 * Polls for emails with attachments (read or unread) that lack the processed label.
 *
 * Setup:
 * 1. script.google.com → New project → paste this file
 * 2. Set SCRIPT_CONFIG below
 * 3. Run setup() once (authorize Gmail + create label)
 * 4. Run createTrigger() once (every 5 minutes)
 * 5. Test with testLatestEmail()
 */

const SCRIPT_CONFIG = {
  WEBHOOK_URL: 'https://YOUR-RAILWAY-DOMAIN/webhooks/inbound-email',
  WEBHOOK_SECRET: '', // must match INBOUND_EMAIL_WEBHOOK_SECRET in Railway (optional)
  PROCESSED_LABEL: 'file-sorter-processed',
  MAX_BODY_CHARS: 2000,
  /** Skip messages larger than this per attachment (bytes). Gmail/Apps Script limit ~25MB */
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
};

function setup() {
  if (SCRIPT_CONFIG.WEBHOOK_URL.indexOf('YOUR-RAILWAY-DOMAIN') !== -1) {
    throw new Error('Set SCRIPT_CONFIG.WEBHOOK_URL to your Railway URL before running.');
  }
  const labelName = SCRIPT_CONFIG.PROCESSED_LABEL;
  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
  }
  Logger.log('Ready. Label: %s', label.getName());
  Logger.log('Webhook: %s', SCRIPT_CONFIG.WHOOK_URL);
  Logger.log('Run createTrigger() then processInbox() or testLatestEmail() to test.');
}

/** Logs what Gmail sees — run this first if nothing is processing. */
function debugInbox() {
  const queries = {
    unprocessed: inboxQuery_(),
    allWithAttachments: 'has:attachment in:inbox',
    unprocessedCount: inboxQuery_(),
  };
  Logger.log('Inbox query: %s', queries.unprocessed);
  const threads = GmailApp.search(inboxQuery_(), 0, 10);
  Logger.log('Matching threads: %s', threads.length);
  threads.forEach(function (thread, i) {
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    Logger.log(
      '%s. subject=%s id=%s attachments=%s labels=%s',
      i + 1,
      msg.getSubject(),
      msg.getId(),
      msg.getAttachments().length,
      thread.getLabels().map(function (l) { return l.getName(); }).join(', ') || '(none)'
    );
  });
  if (!threads.length) {
    Logger.log('No matching threads. Common causes: email already has file-sorter-processed label, is in Trash, or has no real file attachment.');
  }
}

function inboxQuery_() {
  return 'has:attachment in:inbox -in:trash -label:' + SCRIPT_CONFIG.PROCESSED_LABEL;
}

function createTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('processInbox')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger created: processInbox every 5 minutes');
}

/**
 * Manual test — processes the most recent unprocessed inbox email with attachments.
 */
function testLatestEmail() {
  const threads = GmailApp.search(inboxQuery_(), 0, 1);
  if (!threads.length) {
    Logger.log('No unprocessed emails with attachments found. Run debugInbox() for details.');
    return;
  }
  processThread_(threads[0]);
}

function processInbox() {
  const query = inboxQuery_();
  const threads = GmailApp.search(query, 0, 20);
  Logger.log('Query: %s', query);
  Logger.log('Found %s thread(s) to process', threads.length);
  if (!threads.length) {
    Logger.log('Nothing to do. Run debugInbox() to inspect inbox.');
    return;
  }
  threads.forEach(processThread_);
}

function processThread_(thread) {
  const messages = thread.getMessages();
  messages.forEach(function (message) {
    if (message.isInTrash()) return;
    if (!message.getAttachments().length) return;
    if (hasLabel_(message, SCRIPT_CONFIG.PROCESSED_LABEL)) return;

    try {
      postMessageToWebhook_(message);
      markProcessed_(message);
      Logger.log('Processed: %s (%s)', message.getSubject(), message.getId());
    } catch (err) {
      Logger.log('Failed: %s — %s', message.getSubject(), err);
    }
  });
}

function postMessageToWebhook_(message) {
  const attachments = message.getAttachments();
  const payloadAttachments = [];

  attachments.forEach(function (att) {
    const size = att.getSize();
    if (size > SCRIPT_CONFIG.MAX_ATTACHMENT_BYTES) {
      Logger.log('Skipping oversized attachment: %s (%s bytes)', att.getName(), size);
      return;
    }
    payloadAttachments.push({
      filename: att.getName(),
      mimeType: att.getContentType() || 'application/octet-stream',
      size: size,
      contentBase64: Utilities.base64Encode(att.getBytes()),
    });
  });

  if (!payloadAttachments.length) {
    throw new Error('No attachments within size limit');
  }

  const payload = {
    gmailMessageId: message.getId(),
    fromEmail: extractEmail_(message.getFrom()),
    toEmails: parseAddressList_(message.getTo()),
    ccEmails: parseAddressList_(message.getCc()),
    subject: message.getSubject() || '',
    bodyExcerpt: (message.getPlainBody() || message.getBody() || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SCRIPT_CONFIG.MAX_BODY_CHARS),
    receivedAt: message.getDate().toISOString(),
    attachments: payloadAttachments,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (SCRIPT_CONFIG.WEBHOOK_SECRET) {
    headers['X-Webhook-Secret'] = SCRIPT_CONFIG.WEBHOOK_SECRET;
  }

  const response = UrlFetchApp.fetch(SCRIPT_CONFIG.WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Webhook HTTP ' + code + ': ' + body);
  }
  Logger.log('Webhook OK: %s', body);
}

function markProcessed_(message) {
  const labelName = SCRIPT_CONFIG.PROCESSED_LABEL;
  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) label = GmailApp.createLabel(labelName);
  message.getThread().addLabel(label);
}

function hasLabel_(message, labelName) {
  return message.getThread().getLabels().some(function (l) {
    return l.getName() === labelName;
  });
}

function extractEmail_(raw) {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim();
}

function parseAddressList_(raw) {
  if (!raw) return [];
  return raw.split(',').map(function (part) {
    return extractEmail_(part.trim());
  }).filter(Boolean);
}
