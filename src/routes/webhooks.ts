import { Router, type Request, type Response } from 'express';
import { getEnv } from '../config/env.js';
import { verifySlackSignature } from '../utils/slackVerify.js';
import { processInboundEmail } from '../services/emailIngestionService.js';
import {
  handleApprove,
  handleChange,
  handleDoNotSort,
  handleNeedsAttention,
} from '../services/fileSorterWorkflow.js';
import {
  extractItemIdFromAction,
  slackActionType,
  slackService,
} from '../services/slackService.js';
import { logger } from '../utils/logger.js';
import { formatApproveError, isRecoverableApproveError } from '../utils/approveErrors.js';
import { handleSlackEventsWebhook } from '../services/slackCaseEventService.js';

export const webhooksRouter = Router();

webhooksRouter.post('/webhooks/inbound-email', async (req, res) => {
  try {
    const secret = getEnv().INBOUND_EMAIL_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'];
      if (provided !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const result = await processInboundEmail(
      req.headers as Record<string, string | string[] | undefined>,
      req.body
    );
    res.status(202).json({ accepted: true, ...result });
  } catch (err) {
    logger.error('Inbound email webhook failed', {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(400).json({ error: err instanceof Error ? err.message : 'Processing failed' });
  }
});

interface SlackInteractionPayload {
  type: string;
  user: { id: string; name?: string };
  channel?: { id: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id: string; value?: string }>;
  response_url?: string;
}

webhooksRouter.post('/webhooks/slack/interactions', async (req, res) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

  if (
    !verifySlackSignature(getEnv().SLACK_SIGNING_SECRET, signature, timestamp, rawBody)
  ) {
    res.status(401).send('Invalid signature');
    return;
  }

  const payloadStr = typeof req.body === 'object' && req.body.payload
    ? (req.body.payload as string)
    : rawBody.startsWith('payload=')
      ? decodeURIComponent(rawBody.replace(/^payload=/, ''))
      : rawBody;

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(
      payloadStr.startsWith('{') ? payloadStr : decodeURIComponent(payloadStr)
    ) as SlackInteractionPayload;
  } catch {
    res.status(400).send('Invalid payload');
    return;
  }

  if (payload.type !== 'block_actions' || !payload.actions?.length) {
    res.status(200).json({});
    return;
  }

  const action = payload.actions[0];
  const itemId = extractItemIdFromAction(action.action_id, action.value);
  const userId = payload.user.id;
  const channelId = payload.channel?.id;

  logger.info('Slack interaction received', {
    actionId: action.action_id,
    itemId,
    userId,
  });

  if (!itemId) {
    logger.warn('Slack interaction missing item id', { actionId: action.action_id });
    res.status(200).json({});
    return;
  }

  // Acknowledge immediately (Slack requires 200 within 3s)
  res.status(200).json({});

  (async () => {
    try {
      const actionType = slackActionType(action.action_id);
      const db = await import('../db/supabase.js');
      const item = await db.getFileSorterItem(itemId);
      const resolvedChannelId = channelId ?? item?.slack_queue_channel_id;
      const resolvedMessageTs =
        item?.slack_queue_message_ts ??
        payload.message?.thread_ts ??
        payload.message?.ts;
      const slackThread =
        resolvedChannelId && resolvedMessageTs
          ? { channelId: resolvedChannelId, messageTs: resolvedMessageTs }
          : undefined;

      switch (actionType) {
        case 'approve':
          await handleApprove(itemId, userId, slackThread);
          break;
        case 'change':
          await handleChange(itemId, userId, slackThread);
          break;
        case 'needs_attention':
          await handleNeedsAttention(itemId, userId);
          break;
        case 'do_not_sort':
          await handleDoNotSort(itemId, userId);
          break;
        default:
          logger.warn('Unknown Slack action', { actionId: action.action_id });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const userMessage = formatApproveError(err);
      logger.error('Slack action handler failed', {
        itemId,
        action: action.action_id,
        err: message,
        stack,
        recoverable: isRecoverableApproveError(err),
      });
      const db = await import('../db/supabase.js');
      const item = await db.getFileSorterItem(itemId);
      if (item) {
        const caseRow = item.suggested_case_number
          ? await db.getCaseById(item.suggested_case_number)
          : null;
        if (!isRecoverableApproveError(err)) {
          await db.updateFileSorterItem(itemId, { status: 'failed' });
          await slackService.updateQueueMessage({ ...item, status: 'failed' }, caseRow);
        } else {
          const refreshed = await db.getFileSorterItem(itemId);
          if (refreshed) {
            await slackService.updateQueueMessage(refreshed, caseRow);
          }
        }
      }
      if (channelId) {
        try {
          await slackService.postEphemeral(
            channelId,
            userId,
            `File Sorter error: ${userMessage}`
          );
        } catch {
          /* ignore */
        }
      }
    }
  })();
});

webhooksRouter.post('/webhooks/slack/events', async (req, res) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

  if (
    !verifySlackSignature(getEnv().SLACK_SIGNING_SECRET, signature, timestamp, rawBody)
  ) {
    res.status(401).send('Invalid signature');
    return;
  }

  const body =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};

  try {
    const result = await handleSlackEventsWebhook(body);
    if (typeof result.body === 'string') {
      res.status(result.status).send(result.body);
    } else {
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    logger.error('Slack events webhook failed', { err: String(err) });
    res.status(200).send('error');
  }
});
