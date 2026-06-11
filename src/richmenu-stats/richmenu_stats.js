const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────────
// Configuration (อ่านจาก .env ทั้งหมด — ห้ามฝัง token ในโค้ด)
// ─────────────────────────────────────────────
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const BOT_ID = process.env.LINE_BOT_ID || 'Uf8841bc6a36cb709b87582a536150e8d';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Middleware
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Sync State
// ─────────────────────────────────────────────
let isSyncing = false;
let lastSyncTime = null;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 นาที

// Database Helpers
// ─────────────────────────────────────────────

/** upsert ข้อมูล rich menu ของ user — INSERT ถ้าไม่มี, UPDATE ถ้ามีอยู่แล้ว */
async function upsertUserRichMenu(botId, lineUserId, richMenuId) {
  await pool.query(
    `INSERT INTO app_data.bot_user_richmenus (bot_id, line_user_id, rich_menu_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (bot_id, line_user_id)
     DO UPDATE SET rich_menu_id = EXCLUDED.rich_menu_id, updated_at = NOW()`,
    [botId, lineUserId, richMenuId]
  );
}

/** query สถิติ rich menu จาก DB — group by bot + menu */
async function fetchRichMenuStats() {
  const { rows } = await pool.query(`
    SELECT
      bot_id        AS "botId",
      rich_menu_id  AS "richMenuId",
      COUNT(line_user_id)::int AS "userCount",
      MAX(updated_at) AS "lastUpdate"
    FROM app_data.bot_user_richmenus
    WHERE rich_menu_id IS NOT NULL
    GROUP BY bot_id, rich_menu_id
    ORDER BY "userCount" DESC
  `);
  return rows;
}

// LINE API Helpers
// ─────────────────────────────────────────────

/** ดึง rich menu ปัจจุบันของ user จาก LINE */
async function fetchUserRichMenuFromLINE(uid) {
  try {
    const { data } = await axios.get(
      `https://api.line.me/v2/bot/user/${uid}/richmenu`,
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` } }
    );
    return data.richMenuId || 'default';
  } catch (err) {
    if (err.response?.status === 404) return 'default';
    return 'error';
  }
}

/**
 * Background sync — ดึง follower ทั้งหมดจาก LINE แล้ว upsert ลง DB
 * fire-and-forget: ไม่ await, มี cooldown 5 นาที กัน sync ซ้ำ
 */
function syncDataFromLINE() {
  const now = Date.now();
  if (isSyncing || (lastSyncTime && now - lastSyncTime < SYNC_COOLDOWN_MS)) return;

  isSyncing = true;
  lastSyncTime = now;

  (async () => {
    try {
      console.log('Starting background sync with LINE API...');
      let next = null;

      do {
        const url = `https://api.line.me/v2/bot/followers/ids${next ? `?start=${next}` : ''}`;
        const { data } = await axios.get(url, {
          headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
        });

        for (const uid of data.userIds || []) {
          const rmId = await fetchUserRichMenuFromLINE(uid);
          await upsertUserRichMenu(BOT_ID, uid, rmId);
          await new Promise((r) => setTimeout(r, 100)); // rate limit 100ms
        }

        next = data.next || null;
      } while (next);

      console.log('Background sync completed.');
    } catch (err) {
      console.error('Sync error:', err.message);
    } finally {
      isSyncing = false;
    }
  })();
}

// Routes
// ─────────────────────────────────────────────

// 1. Stats — GET /api/stats/richmenu
app.get('/api/stats/richmenu', async (req, res) => {
  syncDataFromLINE(); // เปิด sync พื้นหลัง (ไม่ await)
  try {
    const stats = await fetchRichMenuStats();
    res.json(stats);
  } catch (err) {
    console.error('GetStats error:', err.message);
    res.status(500).json({ message: 'Database error' });
  }
});

// 2. Image Proxy — GET /api/richmenu/image/:id
app.get('/api/richmenu/image/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || id === 'default' || id === 'error') {
    return res.status(404).json({ message: 'No image for default/error menu' });
  }

  try {
    const { data, headers } = await axios.get(
      `https://api-data.line.me/v2/bot/richmenu/${id}/content`,
      {
        headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
        responseType: 'stream',
      }
    );
    res.setHeader('Content-Type', headers['content-type'] || 'image/jpeg');
    data.pipe(res); // stream ตรงไปให้ client — ไม่ buffer ทั้งไฟล์
  } catch (err) {
    res.status(404).json({ message: 'Image not found on LINE' });
  }
});

// 3. Webhook — POST /api/webhook
app.post('/api/webhook', async (req, res) => {
  const { botId, lineUserId, richMenuId } = req.body || {};

  if (!botId || !lineUserId || !richMenuId) {
    return res.status(400).json({
      message: 'Missing required fields: botId, lineUserId, richMenuId',
    });
  }

  try {
    await upsertUserRichMenu(botId, lineUserId, richMenuId);
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook DB error:', err.message);
    res.status(500).json({ message: 'Database error' });
  }
});

// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Rich Menu Backend running at http://localhost:${PORT}`);
});