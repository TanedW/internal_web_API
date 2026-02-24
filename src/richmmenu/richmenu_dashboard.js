// src/richmmenu/richmenu_dashboard.js
// ============================================================
// RICHMENU DASHBOARD — Express Handler
//
// แก้ไขจากเวอร์ชัน Next.js App Router:
//   ❌ export async function GET(req)   → ✅ export default handler(req, res)
//   ❌ export async function POST(req)  → ✅ export default handler(req, res)
//   ❌ import { primaryPool }           → ✅ import { pool }
//   ❌ import('@/lib/lineApi')          → ✅ import { callLineAPI } from '../lib/lineApi.js'
//   ❌ new URL(req.url).searchParams    → ✅ req.query
//   ❌ await req.json()                 → ✅ req.body
//   ❌ await req.formData()             → ✅ req.body + req.file (multer)
//   ❌ Response.json(data, {status})    → ✅ res.status().json()
//
// Actions ที่รองรับ:
//   GET  ?action=current&botKey=...           → ดึงเมนูที่ active + imageUrl
//   GET  ?action=list&botKey=...              → ดึงรายการเมนูของบอท + auto sync
//   GET  ?action=switch&botKey=...&menuId=... → เปลี่ยน Default Rich Menu
//   GET  ?action=details&botKey=...&menuId=.. → ดูโครงสร้าง JSON ของเมนู
//   GET  ?action=image&botKey=...&menuId=...  → Proxy รูปภาพจาก LINE
//   GET  ?action=audit_logs&botKey=...        → ดึง Audit Log ของบอท
//   POST ?action=upload                       → สร้าง Rich Menu + อัปโหลดรูป (multer)
//   POST ?action=save_flow                    → บันทึก Flow (state + action-list)
//   POST ?action=delete                       → ลบ Rich Menu จาก LINE และ DB
// ============================================================

import { query, pool }    from '../lib/db.js';
import { writeAuditLog }  from '../lib/logging.js';
import { callLineAPI }    from '../lib/lineApi.js';  // ✅ relative path แทน @/

// ============================================================
// HELPERS
// ============================================================

/** บันทึก Audit Log */
async function saveAdminLog({
  adminId, email, first_name, last_name,
  action_type, status, ipAddress, userAgent, details,
}) {
  await writeAuditLog(
    {
      adminId,
      email,
      firstName:  first_name,
      lastName:   last_name,
      actionType: action_type,
      status,
      ipAddress,
      userAgent,
      details,
    },
    status === 'SUCCESS' ? 'INFO' : 'WARNING'
  );
}

/** ดึง IP / User-Agent จาก Express req */
function getRequestMeta(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded
    ? (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0])
    : req.socket?.remoteAddress ?? null;
  const userAgent = req.headers['user-agent'] ?? null;
  return { ipAddress, userAgent };
}

/** ดึง channel_access_token จาก DB */
async function getTokenFromDB(botKey) {
  const { rows } = await query(
    'SELECT channel_token FROM line_bots WHERE bot_key = $1 OR id::text = $1 LIMIT 1',
    [String(botKey)]
  );
  if (rows[0]?.channel_token) return rows[0].channel_token;
  console.error(`[Dashboard] ไม่พบ token สำหรับ botKey: "${botKey}"`);
  return null;
}

// ============================================================
// EXPORT DEFAULT — Express handler
// ============================================================
export default async function handler(req, res) {

  // ─── CORS ──────────────────────────────────────────────────
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // req.query มาจาก Express (แทน searchParams)
  const action = req.query.action ?? null;
  const { ipAddress, userAgent } = getRequestMeta(req);

  console.log(`[RichMenu Dashboard] ${req.method} action=${action}`);

  // ============================================================
  // GET
  // ============================================================
  if (req.method === 'GET') {

    // ── current ──────────────────────────────────────────────
    if (action === 'current') {
      try {
        const botKey = req.query.botKey;
        if (!botKey) return res.status(400).json({ error: 'botKey is required' });

        const { rows: botRows } = await query(
          'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
          [botKey]
        );
        if (botRows.length === 0) return res.status(404).json({ error: 'Bot not found' });

        const { id: botId, channel_token: token } = botRows[0];

        const lineRes       = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data          = await lineRes.json();
        const currentMenuId = lineRes.ok ? (data.richMenuId || null) : null;

        let imageUrl = null;
        if (currentMenuId) {
          const { rows: menuRows } = await query(
            'SELECT image_url FROM bot_rich_menus WHERE rich_menu_id = $1 AND bot_id = $2',
            [currentMenuId, botId]
          );
          imageUrl = menuRows[0]?.image_url
            || `/src/richmenu_dashboard?action=image&botKey=${encodeURIComponent(botKey)}&menuId=${currentMenuId}`;
        }

        return res.status(200).json({ currentMenuId, imageUrl });

      } catch (error) {
        console.error('[current]', error);
        return res.status(500).json({ error: 'Failed to fetch current menu', details: error.message });
      }
    }

    // ── list ─────────────────────────────────────────────────
    if (action === 'list') {
      try {
        const botKey = req.query.botKey;
        if (!botKey) return res.status(400).json({ error: 'botKey is required' });

        const { rows: botRows } = await query(
          'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
          [botKey]
        );
        const bot = botRows[0];
        if (!bot) return res.status(404).json({ error: 'Bot not found' });

        const lineRes   = await fetch('https://api.line.me/v2/bot/richmenu/list', {
          headers: { Authorization: `Bearer ${bot.channel_token}` },
        });
        const lineData  = await lineRes.json();
        const lineMenus = lineData.richmenus || [];

        const { rows: dbRows } = await query(
          'SELECT rich_menu_id FROM bot_rich_menus WHERE bot_id = $1',
          [bot.id]
        );
        const dbMenuIds = dbRows.map(r => r.rich_menu_id);

        // AUTO SYNC: เพิ่มเมนูที่มีใน LINE แต่ยังไม่มีใน DB
        for (const menu of lineMenus) {
          if (!dbMenuIds.includes(menu.richMenuId)) {
            await query(
              `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
               VALUES ($1, $2, $3, $4)`,
              [bot.id, menu.richMenuId, menu.name || 'Legacy Menu', 'system']
            );
          }
        }

        const { rows: finalRows } = await query(
          `SELECT
             rich_menu_id AS "richMenuId",
             menu_name    AS "name",
             image_url,
             is_active,
             created_at
           FROM bot_rich_menus WHERE bot_id = $1 ORDER BY created_at DESC`,
          [bot.id]
        );

        return res.status(200).json({ richmenus: finalRows });

      } catch (error) {
        console.error('[list]', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ── switch ───────────────────────────────────────────────
    if (action === 'switch') {
      const client = await pool.connect(); // ✅ pool แทน primaryPool
      try {
        const { botKey, menuId, type, adminId = null } = req.query;

        if (!botKey || !menuId) {
          client.release();
          return res.status(400).json({ error: 'Missing botKey or menuId' });
        }

        const { rows: botRows } = await client.query(
          'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
          [botKey]
        );
        const bot = botRows[0];

        if (!bot?.channel_token) {
          client.release();
          return res.status(404).json({ error: 'Bot token not found' });
        }

        if (type === 'batch') {
          const lineRes = await fetch(
            `https://api.line.me/v2/bot/user/all/richmenu/${menuId}`,
            { method: 'POST', headers: { Authorization: `Bearer ${bot.channel_token}` } }
          );

          if (!lineRes.ok) {
            const errorData = await lineRes.json();
            await saveAdminLog({
              adminId, email: null, first_name: null, last_name: null,
              action_type: 'RICHMENU_SWITCH', status: 'FAILED',
              ipAddress, userAgent,
              details: { reason: errorData.message, botKey, menuId },
            });
            client.release();
            return res.status(lineRes.status).json({ error: errorData.message || 'Failed to switch menu' });
          }

          // Transaction: อัปเดต is_active
          await client.query('BEGIN');
          await client.query(
            'UPDATE bot_rich_menus SET is_active = FALSE WHERE bot_id = $1',
            [bot.id]
          );
          await client.query(
            'UPDATE bot_rich_menus SET is_active = TRUE WHERE rich_menu_id = $1 AND bot_id = $2',
            [menuId, bot.id]
          );
          await client.query('COMMIT');

          await saveAdminLog({
            adminId, email: null, first_name: null, last_name: null,
            action_type: 'RICHMENU_SWITCH', status: 'SUCCESS',
            ipAddress, userAgent,
            details: { botKey, bot_id: bot.id, new_active_menu: menuId },
          });

          return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Unsupported switch type' });

      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[switch]', error);
        return res.status(500).json({ error: error.message });
      } finally {
        client.release();
      }
    }

    // ── details ──────────────────────────────────────────────
    if (action === 'details') {
      try {
        const { botKey, menuId } = req.query;
        if (!botKey || !menuId) return res.status(400).json({ error: 'Missing botKey or menuId' });

        const { rows } = await query(
          'SELECT channel_token FROM line_bots WHERE bot_key = $1',
          [botKey]
        );
        const token = rows[0]?.channel_token;
        if (!token) return res.status(404).json({ error: 'Token not found in database' });

        const lineRes = await fetch(`https://api.line.me/v2/bot/richmenu/${menuId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await lineRes.json();

        if (!lineRes.ok) return res.status(lineRes.status).json({ error: data.message || 'LINE API Error' });
        return res.status(200).json(data);

      } catch (error) {
        console.error('[details]', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }
    }

    // ── image proxy ──────────────────────────────────────────
    if (action === 'image') {
      try {
        let botKey       = req.query.botKey;
        const richMenuId = req.query.richMenuId || req.query.menuId;

        if (!richMenuId) return res.status(400).send('Rich Menu ID is required');
        if (!botKey)     return res.status(400).send('Bot key is required');

        botKey      = decodeURIComponent(botKey);
        const token = await getTokenFromDB(botKey);
        if (!token) return res.status(400).send('Invalid bot key');

        const lineRes = await fetch(
          `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!lineRes.ok) {
          const errText = await lineRes.text();
          return res.status(lineRes.status).send(`LINE API error: ${errText}`);
        }

        const imageBuffer = Buffer.from(await lineRes.arrayBuffer());
        res.setHeader('Content-Type', lineRes.headers.get('Content-Type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(imageBuffer);

      } catch (error) {
        console.error('[image proxy]', error);
        return res.status(500).send('Internal server error');
      }
    }

    // ── audit_logs ───────────────────────────────────────────
    if (action === 'audit_logs') {
      try {
        const botKey = req.query.botKey;
        if (!botKey) return res.status(400).json({ error: 'botKey is required' });

        const { rows } = await query(
          `SELECT
             al.id, al.admin_id,
             COALESCE(a.first_name || ' ' || a.last_name, a.email, al.admin_id) AS admin_name,
             a.profile_url AS admin_avatar,
             al.action, al.bot_key, al.bot_name,
             al.menu_id_from, al.menu_id_to, al.menu_name,
             al.detail, al.created_at
           FROM audit_logs al
           LEFT JOIN admin_system a ON a.admin_id::text = al.admin_id
           WHERE al.bot_key = $1
           ORDER BY al.created_at DESC LIMIT 200`,
          [decodeURIComponent(botKey)]
        );

        return res.status(200).json({ logs: rows });

      } catch (error) {
        console.error('[audit_logs]', error);
        return res.status(500).json({ error: error.message });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  // ============================================================
  // POST
  // ============================================================
  if (req.method === 'POST') {

    // ── upload ───────────────────────────────────────────────
    // req.file มาจาก multer (optionalMulter ใน index.js)
    if (action === 'upload') {
      try {
        let botKey        = req.body?.botKey;
        const menuName    = req.body?.menuName;
        const chatBarText = req.body?.chatBarText || 'เมนูหลัก';
        const creatorId   = req.body?.creatorId || 'system';
        const menuImage   = req.file; // Buffer จาก multer.memoryStorage()

        if (!botKey)    return res.status(400).json({ error: 'Bot key is required' });
        if (!menuImage) return res.status(400).json({ error: 'Menu image is required' });

        botKey      = decodeURIComponent(botKey);
        const areas = JSON.parse(req.body?.areas || '[]');
        const size  = req.body?.size ? JSON.parse(req.body.size) : { width: 2500, height: 843 };

        if (!areas.length) return res.status(400).json({ error: 'Menu areas are required' });

        // ดึง Admin info สำหรับ Log
        const { rows: actors } = await query(
          'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
          [creatorId]
        );
        const actor = actors[0] || { admin_id: creatorId, email: null, first_name: null, last_name: null };

        const token = await getTokenFromDB(botKey);
        if (!token) return res.status(400).json({ error: 'Bot token not found' });

        // STEP 1: สร้างโครงสร้าง Rich Menu
        const step1 = await callLineAPI(
          'https://api.line.me/v2/bot/richmenu',
          'POST',
          { size, selected: true, name: menuName || `Menu_${Date.now()}`, chatBarText, areas },
          token
        );

        if (step1.code !== 200 || !step1.response?.richMenuId) {
          await saveAdminLog({
            adminId: actor.admin_id, email: actor.email,
            first_name: actor.first_name, last_name: actor.last_name,
            action_type: 'RICHMENU_UPLOAD', status: 'FAILED',
            ipAddress, userAgent,
            details: { reason: 'Failed to create menu structure', botKey, menuName },
          });
          return res.status(400).json({
            error:   'Failed to create menu structure',
            details: step1.response?.message || 'Unknown error',
          });
        }

        const richMenuId = step1.response.richMenuId;

        // STEP 2: อัปโหลดรูปภาพ (menuImage.buffer จาก multer)
        const step2 = await callLineAPI(
          `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
          'POST',
          menuImage.buffer,
          token,
          true // isImage
        );

        if (step2.code !== 200) {
          await callLineAPI(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, 'DELETE', null, token);
          await saveAdminLog({
            adminId: actor.admin_id, email: actor.email,
            first_name: actor.first_name, last_name: actor.last_name,
            action_type: 'RICHMENU_UPLOAD', status: 'FAILED',
            ipAddress, userAgent,
            details: { reason: 'Failed to upload image', botKey, richMenuId },
          });
          return res.status(400).json({ error: 'Failed to upload image', details: step2.response?.message });
        }

        // STEP 3: บันทึกลง DB
        const { rows: botRows } = await query(
          'SELECT id FROM line_bots WHERE bot_key = $1', [botKey]
        );

        if (botRows.length === 0) {
          await callLineAPI(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, 'DELETE', null, token);
          return res.status(400).json({ error: 'Bot not found in database' });
        }

        const botId    = botRows[0].id;
        const imageUrl = `/src/richmenu_dashboard?action=image&botKey=${encodeURIComponent(botKey)}&menuId=${richMenuId}`;

        await query(
          `INSERT INTO bot_rich_menus
             (bot_id, rich_menu_id, menu_name, image_url, is_active, creator_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [botId, richMenuId, menuName || `Menu_${Date.now()}`, imageUrl, false, creatorId]
        );

        await saveAdminLog({
          adminId: actor.admin_id, email: actor.email,
          first_name: actor.first_name, last_name: actor.last_name,
          action_type: 'RICHMENU_UPLOAD', status: 'SUCCESS',
          ipAddress, userAgent,
          details: { botKey, bot_id: botId, richMenuId, menuName },
        });

        return res.status(200).json({
          success: true, richMenuId,
          message: `Menu "${menuName}" created successfully.`,
        });

      } catch (error) {
        console.error('[upload]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
      }
    }

    // ── save_flow ────────────────────────────────────────────
    if (action === 'save_flow') {
      try {
        // ✅ req.body แทน await req.json()
        const { botKey, botName, flowSteps, creatorId } = req.body;

        if (!botKey || !flowSteps?.length) {
          return res.status(400).json({ error: 'botKey and flowSteps are required' });
        }

        const { rows: botRows } = await query(
          'SELECT bot_user_id, bot_name FROM line_bots WHERE bot_key = $1 OR id::text = $1 LIMIT 1',
          [String(botKey)]
        );
        const botUserId       = botRows[0]?.bot_user_id;
        const resolvedBotName = botName || botRows[0]?.bot_name || botKey;

        if (!botUserId) {
          return res.status(400).json({ error: 'ไม่พบ bot_user_id กรุณาเพิ่มบอทใหม่อีกครั้ง' });
        }

        const { rows: actors } = await query(
          'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
          [creatorId]
        );
        const actor = actors[0] || { admin_id: creatorId, email: null, first_name: null, last_name: null };

        let savedCount = 0;

        for (const step of flowSteps) {
          const postbackData = step.postbackData || step.stateName;

          const { rows: existingRows } = await query(
            `SELECT "stateID" FROM state WHERE "postbackData" = $1 AND "botID" = $2 LIMIT 1`,
            [postbackData, botUserId]
          );
          // pg คืน key lowercase เมื่อ column ไม่ได้ double-quote ใน schema
          let stateID = existingRows[0]?.stateid ?? existingRows[0]?.stateID;

          if (stateID) {
            await query(
              `UPDATE state SET
                 "stateName"=$1, "nextStateName"=$2, "botName"=$3,
                 "eventType"=$4, "eventMessageType"=$5
               WHERE "stateID"=$6`,
              [
                step.stateName, step.nextStateName || '', resolvedBotName,
                step.eventType || 'postback', step.msgType || 'text', stateID,
              ]
            );
          } else {
            const { rows: maxRows } = await query(
              `SELECT COALESCE(MAX("stateID"), 0) + 1 AS next_id FROM state`
            );
            const newStateID = Number(maxRows[0].next_id);

            await query(
              `INSERT INTO state
                 ("stateID","stateName","nextStateName","botID","botName",
                  "eventType","eventMessageType","postbackData")
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                newStateID, step.stateName, step.nextStateName || '',
                botUserId, resolvedBotName,
                step.eventType || 'postback', step.msgType || 'text', postbackData,
              ]
            );
            stateID = newStateID;
          }

          if (!stateID) continue;

          await query(`DELETE FROM "action-list" WHERE action = $1`, [stateID]);

          for (const act of step.actions || []) {
            await query(
              `INSERT INTO "action-list"
                 ("actionID","order","actionType",payload,action)
               VALUES ($1,$2,$3,$4,$5)`,
              [act.id || Date.now(), act.order || 1, act.type || 'text', act.payload || '', stateID]
            );
          }

          savedCount++;
        }

        await saveAdminLog({
          adminId: actor.admin_id, email: actor.email,
          first_name: actor.first_name, last_name: actor.last_name,
          action_type: 'RICHMENU_SAVE_FLOW', status: 'SUCCESS',
          ipAddress, userAgent,
          details: { botKey, botUserId, savedCount, totalSteps: flowSteps.length },
        });

        return res.status(200).json({ success: true, message: `บันทึก ${savedCount} states สำเร็จ` });

      } catch (error) {
        console.error('[save_flow]', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ── delete ───────────────────────────────────────────────
    if (action === 'delete') {
      try {
        // ✅ req.body แทน await req.json()
        const { botKey: rawBotKey, menuId, current_admin_id } = req.body;

        if (!rawBotKey || !menuId) {
          return res.status(400).json({ error: 'botKey and menuId are required' });
        }

        const decodedBotKey = decodeURIComponent(rawBotKey);

        const { rows: actors } = await query(
          'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
          [current_admin_id]
        );
        const actor = actors[0] || { admin_id: current_admin_id, email: null, first_name: null, last_name: null };

        const { rows: botRows } = await query(
          'SELECT channel_token FROM line_bots WHERE bot_key = $1',
          [decodedBotKey]
        );

        if (botRows.length === 0) {
          await saveAdminLog({
            adminId: actor.admin_id, email: actor.email,
            first_name: actor.first_name, last_name: actor.last_name,
            action_type: 'RICHMENU_DELETE', status: 'FAILED',
            ipAddress, userAgent,
            details: { reason: 'Invalid bot key', botKey: decodedBotKey, menuId },
          });
          return res.status(400).json({ error: 'Invalid bot key' });
        }

        const token  = botRows[0].channel_token;
        const result = await callLineAPI(
          `https://api.line.me/v2/bot/richmenu/${menuId}`,
          'DELETE', null, token
        );

        if (result.code === 200) {
          await query('DELETE FROM bot_rich_menus WHERE rich_menu_id = $1', [menuId]);

          await saveAdminLog({
            adminId: actor.admin_id, email: actor.email,
            first_name: actor.first_name, last_name: actor.last_name,
            action_type: 'RICHMENU_DELETE', status: 'SUCCESS',
            ipAddress, userAgent,
            details: { botKey: decodedBotKey, menuId },
          });

          return res.status(200).json({ success: true, message: 'Menu deleted successfully' });
        }

        await saveAdminLog({
          adminId: actor.admin_id, email: actor.email,
          first_name: actor.first_name, last_name: actor.last_name,
          action_type: 'RICHMENU_DELETE', status: 'FAILED',
          ipAddress, userAgent,
          details: { reason: result.response?.message, botKey: decodedBotKey, menuId },
        });

        return res.status(result.code || 400).json({
          error: result.response?.message || 'Failed to delete menu',
        });

      } catch (error) {
        console.error('[delete]', error);
        return res.status(500).json({ error: 'Internal server error', details: error.message });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}