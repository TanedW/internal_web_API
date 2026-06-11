import pg from 'pg';
const { Pool } = pg;
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────
// Configuration
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

// Sync State
// ─────────────────────────────────────────────
let isSyncing = false;
let lastSyncTime = null;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 นาที

// ─────────────────────────────────────────────
// Database Helpers
// ─────────────────────────────────────────────

/** upsert ข้อมูล rich menu ของ user */
async function upsertUserRichMenu(botId, lineUserId, richMenuId) {
  await pool.query(
    `INSERT INTO app_data.bot_user_richmenus (bot_id, line_user_id, rich_menu_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (bot_id, line_user_id)
     DO UPDATE SET rich_menu_id = EXCLUDED.rich_menu_id, updated_at = NOW()`,
    [botId, lineUserId, richMenuId]
  );
}

/** query สถิติ rich menu จาก DB */
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

// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// ✅ Export default handler (ใช้กับ vercelAdapter ใน index.js)
// ─────────────────────────────────────────────
export default async function richmenuStatsHandler(req, res) {
  const method = req.method?.toUpperCase();

  // GET /src/richmenu-stats — ดึงสถิติ
  if (method === 'GET') {
    syncDataFromLINE(); // fire-and-forget background sync
    try {
      const stats = await fetchRichMenuStats();
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('GetStats error:', err.message);
      return new Response(JSON.stringify({ message: 'Database error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /src/richmenu-stats/webhook — รับ webhook update
  if (method === 'POST') {
    const body = await req.json();
    const { botId, lineUserId, richMenuId } = body || {};

    if (!botId || !lineUserId || !richMenuId) {
      return new Response(
        JSON.stringify({ message: 'Missing required fields: botId, lineUserId, richMenuId' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      await upsertUserRichMenu(botId, lineUserId, richMenuId);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('Webhook DB error:', err.message);
      return new Response(JSON.stringify({ message: 'Database error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}