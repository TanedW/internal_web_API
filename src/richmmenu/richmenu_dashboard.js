// ============================================================
// API ROUTE — สำหรับหน้า manage-richmenu/[botKey] (page.jsx) เท่านั้น
//
// Actions ที่รองรับ:
//   GET  ?action=current&botKey=...              → ดึงเมนูที่ active อยู่ + imageUrl
//   GET  ?action=list&botKey=...                 → ดึงรายการเมนูของบอท + auto sync
//   GET  ?action=switch&botKey=...&menuId=...    → เปลี่ยน Default Rich Menu
//   GET  ?action=details&botKey=...&menuId=...   → ดูโครงสร้าง JSON ของเมนู
//   GET  ?action=image&botKey=...&menuId=...     → Proxy รูปภาพจาก LINE
//   GET  ?action=audit_logs&botKey=...           → ดึง Audit Log ของบอท
//   POST ?action=upload                          → สร้าง Rich Menu + อัปโหลดรูป
//   POST ?action=save_flow                       → บันทึก Flow (state + action-list)
//   POST ?action=delete                          → ลบ Rich Menu จาก LINE และ DB
// ============================================================

import { query, primaryPool } from '../lib/db.js';       // ✅ ใช้ shared pool แทนสร้างใหม่
import { writeAuditLog } from '../lib/logging.js';        // ✅ ใช้ shared logging

// ----------------------------------------------------------------------
// Helper: บันทึก Audit Log
// ----------------------------------------------------------------------
async function saveAdminLog({
  adminId, email, first_name, last_name,
  action_type, status, ipAddress, userAgent, details
}) {
  await writeAuditLog(
    {
      adminId,
      email,
      firstName: first_name,
      lastName: last_name,
      actionType: action_type,
      status,
      ipAddress,
      userAgent,
      details,
    },
    status === 'SUCCESS' ? 'INFO' : 'WARNING'
  );
}

// ----------------------------------------------------------------------
// Helper: ดึง IP / User-Agent จาก request headers
// ----------------------------------------------------------------------
function getRequestMeta(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers.get?.('x-forwarded-for');
  const ipAddress = forwarded
    ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0])
    : null;
  const userAgent = req.headers['user-agent'] || req.headers.get?.('user-agent') || null;
  return { ipAddress, userAgent };
}

// ----------------------------------------------------------------------
// Helper: ดึง channel_access_token จาก DB (ใช้ shared query)
// ----------------------------------------------------------------------
async function getTokenFromDB(botKey) {
  const { rows } = await query(
    'SELECT channel_token FROM line_bots WHERE bot_key = $1 OR id::text = $1 LIMIT 1',
    [String(botKey)]
  );
  if (rows[0]?.channel_token) {
    return rows[0].channel_token;
  }
  console.error(`ไม่พบ token สำหรับ botKey: "${botKey}"`);
  return null;
}

// ========================================
// GET Handler
// ========================================
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const { ipAddress, userAgent } = getRequestMeta(req);

  console.log('[API] GET action:', action);

  // --------------------------------------------------
  // action=current → ดู Rich Menu ที่ active + imageUrl
  // --------------------------------------------------
  if (action === 'current') {
    try {
      const botKey = searchParams.get('botKey');

      if (!botKey) {
        return Response.json({ error: 'botKey is required' }, { status: 400 });
      }

      const { rows: botRows } = await query(
        'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
        [botKey]
      );

      if (botRows.length === 0) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }

      const { id: botId, channel_token: token } = botRows[0];

      // ดึง currentMenuId จาก LINE API
      const lineRes = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await lineRes.json();
      const currentMenuId = lineRes.ok ? (data.richMenuId || null) : null;

      // สร้าง imageUrl — ลองหาจาก DB ก่อน, fallback เป็น proxy
      let imageUrl = null;
      if (currentMenuId) {
        const { rows: menuRows } = await query(
          'SELECT image_url FROM bot_rich_menus WHERE rich_menu_id = $1 AND bot_id = $2',
          [currentMenuId, botId]
        );
        imageUrl = menuRows[0]?.image_url
          || `/api/richmenu?action=image&botKey=${encodeURIComponent(botKey)}&menuId=${currentMenuId}`;
      }

      return Response.json({ currentMenuId, imageUrl });
    } catch (error) {
      console.error('[current] Error:', error);
      return Response.json(
        { error: 'Failed to fetch current menu', details: error.message },
        { status: 500 }
      );
    }
  }

  // --------------------------------------------------
  // action=list → ดูรายการ Rich Menu ของบอท + auto sync
  // --------------------------------------------------
  if (action === 'list') {
    const botKey = searchParams.get('botKey');

    if (!botKey) {
      return Response.json({ error: 'botKey is required' }, { status: 400 });
    }

    try {
      const { rows: botRows } = await query(
        'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
        [botKey]
      );
      const bot = botRows[0];

      if (!bot) {
        return Response.json({ error: 'Bot not found' }, { status: 404 });
      }

      // ดึงรายการจาก LINE API
      const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: `Bearer ${bot.channel_token}` },
      });
      const lineData = await lineRes.json();
      const lineMenus = lineData.richmenus || [];

      // ดึง ID ที่มีใน DB
      const { rows: dbRows } = await query(
        'SELECT rich_menu_id FROM bot_rich_menus WHERE bot_id = $1',
        [bot.id]
      );
      const dbMenuIds = dbRows.map((row) => row.rich_menu_id);

      // SYNC: ถ้ามีใน LINE แต่ไม่มีใน DB ให้เพิ่ม
      for (const menu of lineMenus) {
        if (!dbMenuIds.includes(menu.richMenuId)) {
          await query(
            `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
             VALUES ($1, $2, $3, $4)`,
            [bot.id, menu.richMenuId, menu.name || 'Legacy Menu', 'system']
          );
        }
      }

      // ดึงข้อมูลสุดท้ายจาก DB
      const { rows: finalRows } = await query(
        `SELECT
            rich_menu_id AS "richMenuId",
            menu_name    AS "name",
            image_url    AS "image_url",
            is_active,
            created_at
         FROM bot_rich_menus
         WHERE bot_id = $1
         ORDER BY created_at DESC`,
        [bot.id]
      );

      return Response.json({ richmenus: finalRows });
    } catch (error) {
      console.error('[list] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=switch → เปลี่ยน Default Rich Menu (type=batch)
  // ใช้ transaction เพื่อให้ is_active update พร้อมกัน
  // --------------------------------------------------
  if (action === 'switch') {
    // ✅ ใช้ primaryPool.connect() เพื่อ transaction — เหมือนเดิมแต่ใช้ shared pool
    const client = await primaryPool.connect();
    try {
      const botKey = searchParams.get('botKey');
      const menuId = searchParams.get('menuId');
      const type   = searchParams.get('type');
      const adminId = searchParams.get('adminId') || null;

      if (!botKey || !menuId) {
        return Response.json({ error: 'Missing botKey or menuId' }, { status: 400 });
      }

      const { rows: botRows } = await client.query(
        'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
        [botKey]
      );
      const bot = botRows[0];

      if (!bot?.channel_token) {
        return Response.json({ error: 'Bot token not found' }, { status: 404 });
      }

      const token = bot.channel_token;

      if (type === 'batch') {
        // เรียก LINE API เพื่อ set default rich menu
        const lineRes = await fetch(
          `https://api.line.me/v2/bot/user/all/richmenu/${menuId}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!lineRes.ok) {
          const errorData = await lineRes.json();

          await saveAdminLog({
            adminId,
            email: null,
            first_name: null,
            last_name: null,
            action_type: 'RICHMENU_SWITCH',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { reason: errorData.message, botKey, menuId },
          });

          return Response.json(
            { error: errorData.message || 'Failed to switch menu on LINE API' },
            { status: lineRes.status }
          );
        }

        // Transaction: อัป is_active
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

        // ✅ Log SUCCESS
        await saveAdminLog({
          adminId,
          email: null,
          first_name: null,
          last_name: null,
          action_type: 'RICHMENU_SWITCH',
          status: 'SUCCESS',
          ipAddress,
          userAgent,
          details: { botKey, bot_id: bot.id, new_active_menu: menuId },
        });

        return Response.json({ success: true });
      }

      return Response.json({ error: 'Unsupported switch type' }, { status: 400 });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[switch] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------
  // action=details → ดูรายละเอียด Rich Menu จาก LINE API
  // --------------------------------------------------
  if (action === 'details') {
    try {
      const botKey = searchParams.get('botKey');
      const menuId = searchParams.get('menuId');

      if (!botKey || !menuId) {
        return Response.json({ error: 'Missing botKey or menuId' }, { status: 400 });
      }

      const { rows: dbRows } = await query(
        'SELECT channel_token FROM line_bots WHERE bot_key = $1',
        [botKey]
      );
      const token = dbRows[0]?.channel_token;

      if (!token) {
        return Response.json({ error: 'Token not found in database' }, { status: 404 });
      }

      const lineRes = await fetch(`https://api.line.me/v2/bot/richmenu/${menuId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await lineRes.json();

      if (!lineRes.ok) {
        return Response.json(
          { error: data.message || 'LINE API Error' },
          { status: lineRes.status }
        );
      }

      return Response.json(data);
    } catch (error) {
      console.error('[details] Error:', error);
      return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=image → Proxy รูปภาพ Rich Menu จาก LINE
  // --------------------------------------------------
  if (action === 'image') {
    try {
      let botKey = searchParams.get('botKey');
      const richMenuId = searchParams.get('richMenuId') || searchParams.get('menuId');

      if (!richMenuId) return new Response('Rich Menu ID is required', { status: 400 });
      if (!botKey)     return new Response('Bot key is required', { status: 400 });

      botKey = decodeURIComponent(botKey);
      const token = await getTokenFromDB(botKey);

      if (!token) return new Response('Invalid bot key', { status: 400 });

      const lineRes = await fetch(
        `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!lineRes.ok) {
        const errText = await lineRes.text();
        return new Response(`LINE API error: ${lineRes.status} - ${errText}`, {
          status: lineRes.status,
        });
      }

      const imageBuffer = await lineRes.arrayBuffer();
      return new Response(imageBuffer, {
        status: 200,
        headers: {
          'Content-Type': lineRes.headers.get('Content-Type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (error) {
      console.error('[image] Error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=audit_logs → ดึง Audit Log ของบอท
  // --------------------------------------------------
  if (action === 'audit_logs') {
    try {
      const botKey = searchParams.get('botKey');
      if (!botKey) {
        return Response.json({ error: 'botKey is required' }, { status: 400 });
      }

      const { rows } = await query(
        `SELECT
           al.id,
           al.admin_id,
           COALESCE(a.first_name || ' ' || a.last_name, a.email, al.admin_id) AS admin_name,
           a.profile_url AS admin_avatar,
           al.action,
           al.bot_key,
           al.bot_name,
           al.menu_id_from,
           al.menu_id_to,
           al.menu_name,
           al.detail,
           al.created_at
         FROM audit_logs al
         LEFT JOIN admin_system a ON a.admin_id::text = al.admin_id
         WHERE al.bot_key = $1
         ORDER BY al.created_at DESC
         LIMIT 200`,
        [decodeURIComponent(botKey)]
      );

      return Response.json({ logs: rows });
    } catch (error) {
      console.error('[audit_logs] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}

// ========================================
// POST Handler
// ========================================
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const { ipAddress, userAgent } = getRequestMeta(req);

  console.log('[API] POST action:', action);

  // --------------------------------------------------
  // action=upload → สร้าง Rich Menu + อัปโหลดรูปภาพ
  // --------------------------------------------------
  if (action === 'upload') {
    try {
      const { callLineAPI } = await import('@/lib/lineApi');
      const formData = await req.formData();
      let botKey      = formData.get('botKey');
      const menuName  = formData.get('menuName');
      const chatBarText = formData.get('chatBarText') || 'เมนูหลัก';
      const menuImage = formData.get('menuImage');
      const creatorId = formData.get('creatorId') || 'system';

      if (!botKey)     return Response.json({ error: 'Bot key is required' }, { status: 400 });
      if (!menuImage)  return Response.json({ error: 'Menu image is required' }, { status: 400 });

      botKey = decodeURIComponent(botKey);

      const areas = JSON.parse(formData.get('areas'));
      const size  = formData.get('size')
        ? JSON.parse(formData.get('size'))
        : { width: 2500, height: 843 };

      if (!areas || areas.length === 0) {
        return Response.json({ error: 'Menu areas are required' }, { status: 400 });
      }

      // ดึง Admin info สำหรับ Log
      const { rows: actors } = await query(
        'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
        [creatorId]
      );
      const actorAdmin = actors[0] || { admin_id: creatorId, email: null, first_name: null, last_name: null };

      const token = await getTokenFromDB(botKey);
      if (!token) {
        return Response.json({ error: 'Bot token not found' }, { status: 400 });
      }

      const richMenuData = {
        size,
        selected: true,
        name: menuName || `Menu_${Date.now()}`,
        chatBarText,
        areas,
      };

      // STEP 1: สร้างโครงสร้าง Rich Menu
      const step1 = await callLineAPI(
        'https://api.line.me/v2/bot/richmenu',
        'POST',
        richMenuData,
        token
      );

      if (step1.code !== 200 || !step1.response?.richMenuId) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'RICHMENU_UPLOAD',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { reason: 'Failed to create menu structure', botKey, menuName },
        });

        return Response.json(
          { error: 'Failed to create menu structure', details: step1.response?.message || 'Unknown error' },
          { status: 400 }
        );
      }

      const richMenuId = step1.response.richMenuId;

      // STEP 2: อัปโหลดรูปภาพ
      const imageBuffer = Buffer.from(await menuImage.arrayBuffer());
      const step2 = await callLineAPI(
        `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
        'POST',
        imageBuffer,
        token,
        true
      );

      if (step2.code !== 200) {
        // Rollback: ลบเมนูที่เพิ่งสร้างออกจาก LINE
        await callLineAPI(
          `https://api.line.me/v2/bot/richmenu/${richMenuId}`,
          'DELETE',
          null,
          token
        );

        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'RICHMENU_UPLOAD',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { reason: 'Failed to upload image', botKey, richMenuId },
        });

        return Response.json(
          { error: 'Failed to upload image', details: step2.response?.message },
          { status: 400 }
        );
      }

      // STEP 3: บันทึกลงฐานข้อมูล
      const { rows: botRows } = await query(
        'SELECT id FROM line_bots WHERE bot_key = $1',
        [botKey]
      );

      if (botRows.length === 0) {
        await callLineAPI(
          `https://api.line.me/v2/bot/richmenu/${richMenuId}`,
          'DELETE',
          null,
          token
        );
        return Response.json({ error: 'Bot not found in database' }, { status: 400 });
      }

      const botId   = botRows[0].id;
      const imageUrl = `/api/richmenu?action=image&botKey=${encodeURIComponent(botKey)}&menuId=${richMenuId}`;

      await query(
        `INSERT INTO bot_rich_menus
           (bot_id, rich_menu_id, menu_name, image_url, is_active, creator_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [botId, richMenuId, menuName || `Menu_${Date.now()}`, imageUrl, false, creatorId]
      );

      // ✅ Log SUCCESS
      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'RICHMENU_UPLOAD',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { botKey, bot_id: botId, richMenuId, menuName },
      });

      return Response.json({
        success: true,
        richMenuId,
        message: `Menu "${menuName}" created successfully.`,
      });
    } catch (error) {
      console.error('[upload] Error:', error);
      return Response.json(
        { error: 'Internal server error', details: error.message },
        { status: 500 }
      );
    }
  }

  // --------------------------------------------------
  // action=save_flow → บันทึก Flow (state + action-list)
  // --------------------------------------------------
  if (action === 'save_flow') {
    try {
      const body = await req.json();
      const { botKey, botName, flowSteps, creatorId } = body;

      if (!botKey || !flowSteps || flowSteps.length === 0) {
        return Response.json(
          { error: 'botKey and flowSteps are required' },
          { status: 400 }
        );
      }

      const { rows: botRows } = await query(
        'SELECT bot_user_id, bot_name FROM line_bots WHERE bot_key = $1 OR id::text = $1 LIMIT 1',
        [String(botKey)]
      );
      const botUserId        = botRows[0]?.bot_user_id;
      const resolvedBotName  = botName || botRows[0]?.bot_name || botKey;

      if (!botUserId) {
        return Response.json(
          { error: 'ไม่พบ bot_user_id กรุณาเพิ่มบอทใหม่อีกครั้ง' },
          { status: 400 }
        );
      }

      // ดึง Admin info สำหรับ Log
      const { rows: actors } = await query(
        'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
        [creatorId]
      );
      const actorAdmin = actors[0] || { admin_id: creatorId, email: null, first_name: null, last_name: null };

      let savedCount = 0;

      for (const step of flowSteps) {
        const postbackData = step.postbackData || step.stateName;

        const { rows: existingRows } = await query(
          `SELECT "stateID" FROM state WHERE "postbackData" = $1 AND "botID" = $2 LIMIT 1`,
          [postbackData, botUserId]
        );

        let stateID = existingRows[0]?.stateid ?? existingRows[0]?.stateID;

        if (stateID) {
          await query(
            `UPDATE state SET
               "stateName"        = $1,
               "nextStateName"    = $2,
               "botName"          = $3,
               "eventType"        = $4,
               "eventMessageType" = $5
             WHERE "stateID" = $6`,
            [
              step.stateName,
              step.nextStateName || '',
              resolvedBotName,
              step.eventType || 'postback',
              step.msgType || 'text',
              stateID,
            ]
          );
        } else {
          const { rows: maxRows } = await query(
            `SELECT COALESCE(MAX("stateID"), 0) + 1 AS next_id FROM state`
          );
          const newStateID = Number(maxRows[0].next_id);

          await query(
            `INSERT INTO state
               ("stateID", "stateName", "nextStateName", "botID", "botName",
                "eventType", "eventMessageType", "postbackData")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              newStateID,
              step.stateName,
              step.nextStateName || '',
              botUserId,
              resolvedBotName,
              step.eventType || 'postback',
              step.msgType || 'text',
              postbackData,
            ]
          );
          stateID = newStateID;
        }

        if (!stateID) continue;

        await query(`DELETE FROM "action-list" WHERE action = $1`, [stateID]);

        for (const act of step.actions || []) {
          await query(
            `INSERT INTO "action-list"
               ("actionID", "order", "actionType", payload, action)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              act.id || Date.now(),
              act.order || 1,
              act.type || 'text',
              act.payload || '',
              stateID,
            ]
          );
        }

        savedCount++;
      }

      // ✅ Log SUCCESS
      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'RICHMENU_SAVE_FLOW',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { botKey, botUserId, savedCount, totalSteps: flowSteps.length },
      });

      return Response.json({
        success: true,
        message: `บันทึก ${savedCount} states สำเร็จ`,
      });
    } catch (error) {
      console.error('[save_flow] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=delete → ลบ Rich Menu จาก LINE และ DB
  // --------------------------------------------------
  if (action === 'delete') {
    try {
      const { callLineAPI } = await import('@/lib/lineApi');
      const { botKey: rawBotKey, menuId, current_admin_id } = await req.json();

      if (!rawBotKey || !menuId) {
        return Response.json(
          { error: 'botKey and menuId are required' },
          { status: 400 }
        );
      }

      const decodedBotKey = decodeURIComponent(rawBotKey);

      // ดึง Admin info สำหรับ Log
      const { rows: actors } = await query(
        'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
        [current_admin_id]
      );
      const actorAdmin = actors[0] || { admin_id: current_admin_id, email: null, first_name: null, last_name: null };

      const { rows: botRows } = await query(
        'SELECT channel_token FROM line_bots WHERE bot_key = $1',
        [decodedBotKey]
      );

      if (botRows.length === 0) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'RICHMENU_DELETE',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { reason: 'Invalid bot key', botKey: decodedBotKey, menuId },
        });

        return Response.json({ error: 'Invalid bot key' }, { status: 400 });
      }

      const token  = botRows[0].channel_token;
      const result = await callLineAPI(
        `https://api.line.me/v2/bot/richmenu/${menuId}`,
        'DELETE',
        null,
        token
      );

      if (result.code === 200) {
        await query(
          'DELETE FROM bot_rich_menus WHERE rich_menu_id = $1',
          [menuId]
        );

        // ✅ Log SUCCESS
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'RICHMENU_DELETE',
          status: 'SUCCESS',
          ipAddress,
          userAgent,
          details: { botKey: decodedBotKey, menuId },
        });

        return Response.json({ success: true, message: 'Menu deleted successfully' });
      }

      // LINE API ตอบ error
      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'RICHMENU_DELETE',
        status: 'FAILED',
        ipAddress,
        userAgent,
        details: { reason: result.response?.message, botKey: decodedBotKey, menuId },
      });

      return Response.json(
        { error: result.response?.message || 'Failed to delete menu' },
        { status: result.code || 400 }
      );
    } catch (error) {
      console.error('[delete] Error:', error);
      return Response.json(
        { error: 'Internal server error', details: error.message },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}