/**
 * RJL File Sorter — Google Workspace inbound email bridge
 *
 * Deploy on the file-sorter@ mailbox (or a dedicated processing account).
 * Polls for emails with attachments (read or unread) that lack the processed label.
 * By default only mail from the last hour is considered (LOOKBACK_HOURS).
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
  MAX_BODY_CHARS: 12000,
  /** Skip messages larger than this per attachment (bytes). Gmail/Apps Script limit ~25MB */
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
  /** From addresses to skip (lowercase); still marked processed so they are not retried */
  IGNORED_SENDER_EMAILS: ['listsender-ttlaadvocates@lyris.ttla.com'],
  /** To addresses to skip — personal staff inboxes, not the shared file-sorter mailbox */
  IGNORED_TO_EMAILS: ['laura@ramosjames.com', 'jon@ramosjames.com', 'david@ramosjames.com'],
  /** Only process mail received within this many hours (keeps each run fast) */
  LOOKBACK_HOURS: 1,
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
  var query =
    '(has:attachment OR "drive.google.com") in:inbox -in:trash -label:' + SCRIPT_CONFIG.PROCESSED_LABEL;
  var hours = SCRIPT_CONFIG.LOOKBACK_HOURS;
  if (hours && hours > 0) {
    query += ' newer_than:' + hours + 'h';
  }
  return query;
}

function isWithinLookback_(message) {
  var hours = SCRIPT_CONFIG.LOOKBACK_HOURS;
  if (!hours || hours <= 0) return true;
  var cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return message.getDate() >= cutoff;
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

/**
 * Process only the newest eligible message in the thread.
 * Avoids multiple Slack cards when a thread has several replies with attachments.
 */
function processThread_(thread) {
  const messages = thread.getMessages();
  for (var i = messages.length - 1; i >= 0; i--) {
    var message = messages[i];
    if (message.isInTrash()) continue;
    if (!isWithinLookback_(message)) continue;
    if (!message.getAttachments().length && !hasDriveLinksInBody_(message)) continue;
    if (hasLabel_(message, SCRIPT_CONFIG.PROCESSED_LABEL)) continue;

    if (!hasProcessableContent_(message)) {
      markProcessed_(message);
      Logger.log('Skipped (calendar invite only): %s (%s)', message.getSubject(), message.getId());
      return;
    }

    if (isIgnoredSender_(message)) {
      markProcessed_(message);
      Logger.log('Skipped (ignored sender): %s from %s', message.getSubject(), message.getFrom());
      return;
    }

    if (isIgnoredRecipient_(message)) {
      markProcessed_(message);
      Logger.log('Skipped (ignored To recipient): %s to %s', message.getSubject(), message.getTo());
      return;
    }

    try {
      postMessageToWebhook_(message);
      markProcessed_(message);
      Logger.log(
        'Processed: %s (%s, %s attachment(s))',
        message.getSubject(),
        message.getId(),
        message.getAttachments().length
      );
    } catch (err) {
      Logger.log('Failed: %s — %s', message.getSubject(), err);
    }
    return;
  }
}

function postMessageToWebhook_(message) {
  const attachments = message.getAttachments();
  const payloadAttachments = [];

  attachments.forEach(function (att) {
    if (isCalendarAttachment_(att)) {
      Logger.log('Skipping calendar attachment: %s', att.getName());
      return;
    }
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

  if (!payloadAttachments.length && !hasDriveLinksInBody_(message)) {
    throw new Error('No attachments within size limit and no Google Drive links in body');
  }

  const payload = {
    gmailMessageId: message.getId(),
    fromEmail: extractEmail_(message.getFrom()),
    toEmails: parseAddressList_(message.getTo()),
    ccEmails: parseAddressList_(message.getCc()),
    subject: message.getSubject() || '',
    bodyExcerpt: buildBodyExcerpt_(message),
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

/** Calendar invites (.ics) are not case documents — skip them. */
function isCalendarAttachment_(att) {
  const name = (att.getName() || '').toLowerCase();
  const mime = (att.getContentType() || '').toLowerCase();
  return (
    name.endsWith('.ics') ||
    mime === 'text/calendar' ||
    mime.indexOf('application/ics') !== -1
  );
}

function hasProcessableAttachments_(message) {
  return message.getAttachments().some(function (att) {
    if (isCalendarAttachment_(att)) return false;
    if (att.getSize() > SCRIPT_CONFIG.MAX_ATTACHMENT_BYTES) return false;
    return true;
  });
}

function buildBodyExcerpt_(message) {
  var plain = (message.getPlainBody() || '').replace(/\r\n/g, '\n').trim();
  var html = message.getBody() || '';
  var parts = [plain];

  var driveRe = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s"'<>]+/gi;
  var hrefRe = /href=["'](https?:\/\/(?:drive|docs)\.google\.com[^"']+)["']/gi;
  var seen = {};
  var match;

  while ((match = driveRe.exec(plain)) !== null) {
    seen[match[0]] = true;
  }
  while ((match = driveRe.exec(html)) !== null) {
    if (!seen[match[0]]) parts.push(match[0]);
    seen[match[0]] = true;
  }
  while ((match = hrefRe.exec(html)) !== null) {
    var href = match[1];
    if (href && !seen[href]) {
      parts.push(href);
      seen[href] = true;
    }
  }

  return parts.join('\n').replace(/\s+/g, ' ').trim().slice(0, SCRIPT_CONFIG.MAX_BODY_CHARS);
}

function hasDriveLinksInBody_(message) {
  var body = message.getPlainBody() || message.getBody() || '';
  return /drive\.google\.com\/file\/d\//i.test(body) || /docs\.google\.com\//i.test(body);
}

function hasProcessableContent_(message) {
  return hasProcessableAttachments_(message) || hasDriveLinksInBody_(message);
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

function isIgnoredSender_(message) {
  const from = extractEmail_(message.getFrom()).toLowerCase();
  const ignored = SCRIPT_CONFIG.IGNORED_SENDER_EMAILS || [];
  return ignored.some(function (addr) {
    return from === String(addr).toLowerCase();
  });
}

function isIgnoredRecipient_(message) {
  const ignored = SCRIPT_CONFIG.IGNORED_TO_EMAILS || [];
  if (!ignored.length) return false;
  var to = parseAddressList_(message.getTo());
  if (!to.length) return false;
  return to.every(function (addr) {
    return ignored.some(function (blocked) {
      return addr.toLowerCase() === String(blocked).toLowerCase();
    });
  });
}

function parseAddressList_(raw) {
  if (!raw) return [];
  return raw.split(',').map(function (part) {
    return extractEmail_(part.trim());
  }).filter(Boolean);
}
