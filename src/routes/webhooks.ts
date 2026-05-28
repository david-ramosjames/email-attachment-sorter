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
    logger.error('Inbound email webhook failed', { err: String(err) });
    res.status(400).json({ error: err instanceof Error ? err.message : 'Processing failed' });
  }
});

interface SlackInteractionPayload {
  type: string;
  user: { id: string; name?: string };
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
    res.status(200).send();
    return;
  }

  const action = payload.actions[0];
  const itemId = extractItemIdFromAction(action.action_id, action.value);
  const userId = payload.user.id;

  if (!itemId) {
    res.status(400).send('Unknown action');
    return;
  }

  res.status(200).setHeader('Content-Type', 'text/plain').send('');

  (async () => {
    try {
      const actionType = slackActionType(action.action_id);
      switch (actionType) {
        case 'approve':
          await handleApprove(itemId, userId);
          break;
        case 'change':
          await handleChange(itemId, userId);
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
      logger.error('Slack action handler failed', {
        itemId,
        action: action.action_id,
        err: String(err),
      });
      const item = await import('../db/supabase.js').then((m) => m.getFileSorterItem(itemId));
      if (item) {
        await import('../db/supabase.js').then((m) =>
          m.updateFileSorterItem(itemId, { status: 'failed' })
        );
        const caseRow = item.suggested_case_number
          ? await import('../db/supabase.js').then((m) => m.getCaseById(item.suggested_case_number!))
          : null;
        await slackService.updateQueueMessage(
          { ...item, status: 'failed' },
          caseRow
        );
      }
    }
  })();
});
