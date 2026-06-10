// src/richmmenu/richmenu_stats.js
// แปลงจาก main.go — GetStatsHandler + SyncDataFromLINE + fetchUserRichMenuFromLINE

import { query } from '../lib/db.js';

// ── Sync state (เทียบกับ global vars ใน Go) ──
let isSyncing = false;
let lastSyncTime = null;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 นาที

// ── LINE API ──
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const BOT_ID = process.env.LINE_BOT_ID;

/**
 * UpsertUserRichMenu
 * เทียบกับ func UpsertUserRichMenu(botID, lineUserID, richMenuID string) error
 */
async function upsertUserRichMenu(botId, lineUserId, richMenuId) {
  await query(
    `INSERT INTO bot_user_richmenus (bot_id, line_user_id, rich_menu_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (bot_id, line_user_id)
     DO UPDATE SET rich_menu_id = EXCLUDED.rich_menu_id, updated_at = NOW()`,
    [botId, lineUserId, richMenuId]
  );
}

/**
 * fetchUserRichMenuFromLINE
 * เทียบกับ func fetchUserRichMenuFromLINE(uid string) string
 */
async function fetchUserRichMenuFromLINE(uid) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/user/${uid}/richmenu`, {
      headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
    });
    if (res.status === 404) return 'default';
    const data = await res.json();
    return data.richMenuId || 'default';
  } catch {
    return 'error';
  }
}

/**
 * syncDataFromLINE — background sync
 * เทียบกับ func SyncDataFromLINE() + goroutine ใน Go
 * ใช้ flag + timestamp แทน sync.Mutex
 */
function syncDataFromLINE() {
  const now = Date.now();
  if (isSyncing || (lastSyncTime && now - lastSyncTime < SYNC_COOLDOWN_MS)) return;

  isSyncing = true;
  lastSyncTime = now;

  // fire-and-forget (เทียบกับ go func(){...}() ใน Go)
  (async () => {
    try {
      console.log('Starting background sync with LINE API...');
      let next = null;

      do {
        const url = next
          ? `https://api.line.me/v2/bot/followers/ids?start=${next}`
          : 'https://api.line.me/v2/bot/followers/ids';

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
        });
        const data = await res.json();
        const userIds = data.userIds || [];

        for (const uid of userIds) {
          const rmId = await fetchUserRichMenuFromLINE(uid);
          await upsertUserRichMenu(BOT_ID, uid, rmId);
          // Rate limit — เทียบกับ time.Sleep(100ms) ใน Go
          await new Promise((r) => setTimeout(r, 100));
        }

        next = data.next || null;
      } while (next);

      console.log('Background sync completed.');
    } catch (err) {
      console.error('Sync error:', err);
    } finally {
      isSyncing = false;
    }
  })();
}

/**
 * FetchRichMenuStats
 * เทียบกับ func FetchRichMenuStats() ([]RichMenuStat, error)
 */
async function fetchRichMenuStats() {
  const { rows } = await query(`
    SELECT
      bot_id       AS "botId",
      rich_menu_id AS "richMenuId",
      COUNT(line_user_id)::int AS "userCount",
      MAX(updated_at) AS "lastUpdate"
    FROM bot_user_richmenus
    WHERE rich_menu_id IS NOT NULL
    GROUP BY bot_id, rich_menu_id
    ORDER BY "userCount" DESC
  `);
  return rows;
}

// ── Handler ──
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // trigger sync แบบ non-blocking (เหมือน Go ที่ไม่ await)
  syncDataFromLINE();

  try {
    const stats = await fetchRichMenuStats();
    return res.status(200).json(stats);
  } catch (err) {
    console.error('GetStats error:', err);
    return res.status(500).json({ message: 'Failed to fetch stats' });
  }
}
