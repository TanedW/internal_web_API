// ============================================================
// API ROUTE — สำหรับหน้า richmenu-home (page.jsx) เท่านั้น
//
// Actions ที่รองรับ:
//   GET  ?action=list_bots          → ดึงรายการบอททั้งหมด
//   GET  ?action=current&botKey=... → ดึงเมนูที่ active + imageUrl
//   POST ?action=sync               → Sync Rich Menu จาก LINE → DB (background)
//   POST ?action=verify_token       → ตรวจสอบ Channel Access Token
//   POST ?action=add_bot            → เพิ่มบอทใหม่เข้าระบบ
//   POST ?action=delete_bot         → Soft Delete บอท
// ============================================================

import { query } from '../lib/db.js';           // ✅ ใช้ shared pool แทนสร้างใหม่
import { writeAuditLog } from '../lib/logging.js'; // ✅ ใช้ shared logging

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log (เหมือน manage_case.js)
// ----------------------------------------------------------------------
async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
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

// ========================================
// GET Handler
// ========================================
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const { ipAddress, userAgent } = getRequestMeta(req);

  console.log('[API] GET action:', action);

  // --------------------------------------------------
  // action=list_bots → ดึงบอททั้งหมดที่ยังไม่ถูกลบ
  // --------------------------------------------------
  if (action === 'list_bots') {
    try {
      const { rows } = await query(
        'SELECT * FROM line_bots WHERE is_deleted = false ORDER BY created_at DESC'
      );

      const bots = rows.map((row) => ({
        id: row.id,
        name: row.bot_name,
        key: row.bot_key,
        pictureUrl: row.picture_url,
        creator_id: row.creator_id,
      }));

      return Response.json(bots);
    } catch (error) {
      console.error('[list_bots] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=current → ดู Rich Menu ที่ active อยู่ + imageUrl
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

      // สร้าง imageUrl
      let imageUrl = null;
      if (currentMenuId) {
        // ลองหาจาก DB ก่อน
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
  // action=verify_token → เช็ค token ใน bot_config + ดึงข้อมูลจาก LINE
  // --------------------------------------------------
  if (action === 'verify_token') {
    try {
      const { token } = await req.json();

      if (!token) {
        return Response.json({ message: 'กรุณาใส่ Token' }, { status: 400 });
      }

      // เช็คใน bot_config
      const { rows: configRows } = await query(
        'SELECT * FROM bot_config WHERE channel_access_token = $1 LIMIT 1',
        [token]
      );

      if (configRows.length === 0) {
        return Response.json(
          { message: 'ไม่พบ Token นี้ในระบบ กรุณาติดต่อผู้ดูแล' },
          { status: 404 }
        );
      }

      const botConfig = configRows[0];

      // ดึงข้อมูลบอทจาก LINE API
      const lineRes = await fetch('https://api.line.me/v2/bot/info', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      const lineData = await lineRes.json();

      if (!lineRes.ok) {
        return Response.json(
          { message: lineData.message || 'Token ไม่ถูกต้องหรือหมดอายุ' },
          { status: 400 }
        );
      }

      return Response.json({
        name: lineData.displayName || botConfig.nickname,
        key: botConfig.bot_id,
        pictureUrl: lineData.pictureUrl,
        botConfigId: botConfig.id,
        channel_access_token: token,
        botUserId: lineData.userId || null,
      });
    } catch (error) {
      console.error('[verify_token] Error:', error);
      return Response.json(
        { message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + error.message },
        { status: 500 }
      );
    }
  }

  // --------------------------------------------------
  // action=add_bot → เพิ่มบอทใหม่ + sync rich menus
  // --------------------------------------------------
  if (action === 'add_bot') {
    try {
      const body = await req.json();
      const { bot_name, bot_key, channel_token, picture_url, creator_id, bot_user_id } = body;

      if (!bot_key || !channel_token || !creator_id) {
        return Response.json(
          { message: 'ข้อมูลไม่ครบ (bot_key, channel_token, creator_id)' },
          { status: 400 }
        );
      }

      // ดึงข้อมูล Admin สำหรับ Log
      const { rows: actors } = await query(
        'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
        [creator_id]
      );
      const actorAdmin = actors[0] || { admin_id: creator_id, email: 'unknown', first_name: null, last_name: null };

      // ตรวจสอบ token ใน bot_config อีกครั้ง
      const { rows: configCheck } = await query(
        'SELECT id FROM bot_config WHERE channel_access_token = $1 LIMIT 1',
        [channel_token]
      );

      if (configCheck.length === 0) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'BOT_ADD',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { reason: 'Token ไม่พบในระบบ bot_config', bot_key },
        });

        return Response.json(
          { message: 'ไม่พบ Token นี้ในระบบ bot_config กรุณาติดต่อผู้ดูแล' },
          { status: 403 }
        );
      }

      // Upsert ลง line_bots
      const { rows: upsertRows } = await query(
        `INSERT INTO line_bots (
           bot_name, bot_key, channel_token, picture_url,
           creator_id, bot_user_id, status, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (bot_key) DO UPDATE SET
           bot_name      = EXCLUDED.bot_name,
           channel_token = EXCLUDED.channel_token,
           picture_url   = EXCLUDED.picture_url,
           bot_user_id   = EXCLUDED.bot_user_id,
           updated_at    = CURRENT_TIMESTAMP
         RETURNING id`,
        [bot_name || 'บอทใหม่', bot_key, channel_token, picture_url || null, creator_id, bot_user_id || null]
      );

      const lineBotId = upsertRows[0].id;

      // ดึง bot userId จาก LINE API (ถ้ายังไม่มี)
      let resolvedBotUserId = bot_user_id || null;
      if (!resolvedBotUserId) {
        try {
          const botInfoRes = await fetch('https://api.line.me/v2/bot/info', {
            headers: { Authorization: `Bearer ${channel_token}` },
          });
          const botInfo = await botInfoRes.json();
          resolvedBotUserId = botInfo.userId || null;

          if (resolvedBotUserId) {
            await query(
              'UPDATE line_bots SET bot_user_id = $1 WHERE id = $2',
              [resolvedBotUserId, lineBotId]
            );
          }
        } catch (e) {
          console.warn('[add_bot] ดึง bot userId ไม่ได้:', e.message);
        }
      }

      // Sync rich menus จาก LINE → DB
      const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: `Bearer ${channel_token}` },
      });
      const lineData = await lineRes.json();
      const menus = lineData.richmenus || [];
      let syncCount = 0;

      for (const menu of menus) {
        await query(
          `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (rich_menu_id) DO NOTHING`,
          [lineBotId, menu.richMenuId, menu.name || 'Imported Menu', creator_id]
        );
        syncCount++;
      }

      // ✅ Log SUCCESS
      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'BOT_ADD',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { bot_key, bot_name: bot_name || 'บอทใหม่', lineBotId, synced: syncCount },
      });

      return Response.json(
        {
          success: true,
          message: `เพิ่มบอทสำเร็จ และ sync เมนู ${syncCount} รายการ`,
          data: { id: lineBotId, bot_name, synced: syncCount },
        },
        { status: 201 }
      );
    } catch (error) {
      console.error('[add_bot] Error:', error);
      return Response.json(
        { message: 'เกิดข้อผิดพลาดที่ฐานข้อมูล: ' + error.message },
        { status: 500 }
      );
    }
  }

  // --------------------------------------------------
  // action=delete_bot → Soft Delete บอท (is_deleted = true)
  // --------------------------------------------------
  if (action === 'delete_bot') {
    try {
      const { bot_key, current_admin_id } = await req.json();

      if (!bot_key) {
        return Response.json({ message: 'bot_key is required' }, { status: 400 });
      }

      // ดึงข้อมูล Admin สำหรับ Log
      const { rows: actors } = await query(
        'SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1',
        [current_admin_id]
      );
      const actorAdmin = actors[0] || { admin_id: current_admin_id, email: 'unknown', first_name: null, last_name: null };

      const { rows: botRows } = await query(
        'SELECT id FROM line_bots WHERE bot_key = $1 AND is_deleted = false',
        [bot_key]
      );

      if (botRows.length === 0) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'BOT_DELETE',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { reason: 'ไม่พบบอทในระบบ', bot_key },
        });

        return Response.json({ message: 'ไม่พบบอทในระบบ' }, { status: 404 });
      }

      await query(
        'UPDATE line_bots SET is_deleted = true, updated_at = CURRENT_TIMESTAMP WHERE bot_key = $1',
        [bot_key]
      );

      // ✅ Log SUCCESS
      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'BOT_DELETE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { bot_key, bot_id: botRows[0].id },
      });

      return Response.json({ success: true, message: 'ลบบอทสำเร็จ' });
    } catch (error) {
      console.error('[delete_bot] Error:', error);
      return Response.json(
        { message: 'เกิดข้อผิดพลาด: ' + error.message },
        { status: 500 }
      );
    }
  }

  // --------------------------------------------------
  // action=sync → Sync Rich Menu จาก LINE → DB (background)
  // --------------------------------------------------
  if (action === 'sync') {
    try {
      const { botKey, creatorId } = await req.json();

      const { rows: botRows } = await query(
        'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
        [botKey]
      );

      if (botRows.length === 0) {
        return Response.json({ error: 'ไม่พบข้อมูลบอทในระบบ' }, { status: 404 });
      }

      const { id: botId, channel_token: token } = botRows[0];

      const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await lineRes.json();
      if (!lineRes.ok) throw new Error(data.message || 'ดึงข้อมูลจาก LINE ล้มเหลว');

      const menus = data.richmenus || [];
      let savedCount = 0;

      for (const menu of menus) {
        await query(
          `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (rich_menu_id) DO NOTHING`,
          [botId, menu.richMenuId, menu.name, creatorId]
        );
        savedCount++;
      }

      // ✅ Log sync action
      await saveAdminLog({
        adminId: creatorId,
        email: null,
        first_name: null,
        last_name: null,
        action_type: 'RICHMENU_SYNC',
        status: 'SUCCESS',
        ipAddress: null,
        userAgent: null,
        details: { botKey, bot_id: botId, total: menus.length, saved: savedCount },
      });

      return Response.json({
        success: true,
        message: `Sync สำเร็จ! พบเมนู ${menus.length} รายการ, บันทึกใหม่ ${savedCount} รายการ`,
      });
    } catch (error) {
      console.error('[sync] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}