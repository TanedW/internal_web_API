// api/richmenu/richmenu.js
// รวม Richmenu API ทุก endpoint ไว้ในไฟล์เดียว
// Pattern เดียวกับ AdminList.js / AdminLogin.js

import pg from 'pg';
const { Pool } = pg;

// ============================================================
// DB Connection - Fondue PostgreSQL
// ============================================================
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: { rejectUnauthorized: false },
});

// ============================================================
// Helper: ดึง token จาก bot_config ด้วย bot_id
// ============================================================
async function getTokenByBotId(botId) {
  const result = await pool.query(
    `SELECT channel_access_token FROM bot_config WHERE bot_id = $1 LIMIT 1`,
    [decodeURIComponent(botId)]
  );
  return result.rows[0]?.channel_access_token || null;
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {

  // --- CORS ---
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, botKey, menuId } = req.query;

  try {

    // ================================================================
    // GET ?action=bots
    // ดึงรายการบอททั้งหมดจาก bot_config
    // ================================================================
    if (action === 'bots') {
      if (req.method !== 'GET') return res.status(405).json({ message: 'Method Not Allowed' });

      const result = await pool.query(
        `SELECT id, nickname, bot_id FROM bot_config ORDER BY id ASC`
      );

      const bots = result.rows.map(row => ({
        id: row.id,
        name: row.nickname,
        key: row.bot_id,
        pictureUrl: null,
      }));

      return res.status(200).json(bots);
    }

    // ================================================================
    // POST ?action=check-token
    // เช็คว่ามี token นี้ใน bot_config หรือเปล่า
    // Body: { token: string }
    // ================================================================
    if (action === 'check-token') {
      if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

      const { token } = req.body;
      if (!token?.trim()) {
        return res.status(400).json({ found: false, message: 'Token is required' });
      }

      const result = await pool.query(
        `SELECT id, nickname, bot_id
         FROM bot_config
         WHERE TRIM(channel_access_token) = TRIM($1)
         LIMIT 1`,
        [token.trim()]
      );

      if (result.rows.length === 0) {
        return res.status(200).json({ found: false });
      }

      const row = result.rows[0];
      return res.status(200).json({
        found: true,
        bot: { id: row.id, name: row.nickname, key: row.bot_id }
      });
    }

    // ================================================================
    // POST ?action=verify-token
    // ตรวจสอบ token กับ LINE API โดยตรง (fallback กรณีไม่พบใน DB)
    // Body: { token: string }
    // ================================================================
    if (action === 'verify-token') {
      if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

      const { token } = req.body;
      if (!token) return res.status(400).json({ message: 'Token is required' });

      const lineRes = await fetch('https://api.line.me/v2/bot/info', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await lineRes.json();
      if (!lineRes.ok) {
        return res.status(400).json({ message: data.message || 'Token ไม่ถูกต้อง' });
      }

      return res.status(200).json({
        name: data.displayName,
        key: data.basicId,
        pictureUrl: data.pictureUrl,
      });
    }

    // ================================================================
    // GET ?action=current&botKey=Uxxxx
    // ดึง Rich Menu ที่กำลังใช้งานอยู่ของบอทนั้น
    // ================================================================
    if (action === 'current') {
      if (req.method !== 'GET') return res.status(405).json({ message: 'Method Not Allowed' });
      if (!botKey) return res.status(400).json({ error: 'botKey is required' });

      const token = await getTokenByBotId(botKey);
      if (!token) return res.status(404).json({ error: `ไม่พบ Token สำหรับบอท: ${botKey}` });

      const lineRes = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await lineRes.json();
      return res.status(200).json({ currentMenuId: data.richMenuId || null });
    }

    // ================================================================
    // GET ?action=image&botKey=Uxxxx&menuId=richmenu-xxx
    // Proxy ดึงรูปภาพ Rich Menu จาก LINE API
    // ================================================================
    if (action === 'image') {
      if (req.method !== 'GET') return res.status(405).json({ message: 'Method Not Allowed' });
      if (!botKey || !menuId) return res.status(400).send('Missing botKey or menuId');

      const token = await getTokenByBotId(botKey);
      if (!token) return res.status(404).send('Token not found');

      const lineRes = await fetch(
        `https://api-data.line.me/v2/bot/richmenu/${menuId}/content`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!lineRes.ok) return res.status(lineRes.status).send('Failed to fetch image from LINE');

      const imageBuffer = Buffer.from(await lineRes.arrayBuffer());
      res.setHeader('Content-Type', lineRes.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(imageBuffer);
    }

    // ================================================================
    // ไม่พบ action
    // ================================================================
    return res.status(400).json({
      message: `Unknown action: "${action}"`,
      available: ['bots', 'check-token', 'verify-token', 'current', 'image']
    });

  } catch (error) {
    console.error(`[Richmenu] action=${action} Error:`, error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
}