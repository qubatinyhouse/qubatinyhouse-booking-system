import crypto from 'node:crypto';
import { db, json, text } from '../lib/_lib.mjs';

function header(event, name) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function requestBody(event) {
  return event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifySignature(rawBody, signature, appSecret) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(signature, expected);
}

export const handler = async (event) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const appSecret = process.env.META_APP_SECRET;

  if (event.httpMethod === 'GET') {
    if (!verifyToken) return text(503, 'Webhook verification is not configured.');
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    if (mode === 'subscribe' && safeEqual(token, verifyToken) && typeof challenge === 'string') {
      return text(200, challenge);
    }
    return text(403, 'Forbidden');
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (!verifyToken || !appSecret) return json(503, { error: 'Webhook is not configured.' });

  const rawBody = requestBody(event);
  const signature = header(event, 'x-hub-signature-256');
  if (!verifySignature(rawBody, signature, appSecret)) {
    return json(401, { error: 'Invalid webhook signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(400, { error: 'Invalid JSON.' });
  }

  if (payload.object !== 'whatsapp_business_account') return json(404, { error: 'Unsupported webhook object.' });

  const rows = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const contacts = new Map((value.contacts || []).map((contact) => [
        contact.wa_id,
        contact.profile?.name || null
      ]));

      for (const message of value.messages || []) {
        if (!message.id || !message.from) continue;
        let messageText = null;
        if (message.type === 'text') messageText = message.text?.body || null;
        else if (message.type === 'button') messageText = message.button?.text || null;
        else if (message.type === 'interactive') {
          messageText = message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || null;
        }

        rows.push({
          message_id: message.id,
          wa_id: message.from,
          profile_name: contacts.get(message.from) || null,
          message_type: message.type || 'unknown',
          message_text: typeof messageText === 'string' ? messageText.slice(0, 4000) : null,
          received_at: message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : new Date().toISOString()
        });
      }
    }
  }

  try {
    if (rows.length) {
      const client = db();
      const { error } = await client
        .from('whatsapp_inbox')
        .upsert(rows, { onConflict: 'message_id', ignoreDuplicates: true });
      if (error) throw error;
    }
    return json(200, { success: true, received: rows.length });
  } catch (error) {
    console.error('WhatsApp webhook persistence failed', error?.message || error);
    return json(500, { error: 'Webhook processing failed.' });
  }
};
