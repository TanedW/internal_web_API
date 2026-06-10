// src/richmmenu/richmenu_webhook.js
// แปลงจาก main.go — LineWebhookHandler

import { query } from '../lib/db.js';

/**
 * LineWebhookHandler
 * เทียบกับ func LineWebhookHandler(w http.ResponseWriter, r *http.Request)
 * รับ payload แล้ว upsert ลง DB
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { botId, lineUserId, richMenuId } = req.body || {};

  if (!botId || !lineUserId || !richMenuId) {
    return res.status(400).json({ message: 'Missing required fields: botId, lineUserId, richMenuId' });
  }

  try {
    await query(
      `INSERT INTO bot_user_richmenus (bot_id, line_user_id, rich_menu_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (bot_id, line_user_id)
       DO UPDATE SET rich_menu_id = EXCLUDED.rich_menu_id, updated_at = NOW()`,
      [botId, lineUserId, richMenuId]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook DB error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
}
