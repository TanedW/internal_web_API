// ============================================================
// API ROUTE — สำหรับหน้า richmenu-home (page.jsx) เท่านั้น
//
// Actions ที่รองรับ:
//   GET  ?action=list_bots          → ดึงรายการบอททั้งหมด
//   GET  ?action=current&botKey=... → ดึงเมนูที่ active + imageUrl
//   POST ?action=verify_token       → ตรวจสอบ Channel Access Token
//   POST ?action=add_bot            → เพิ่มบอทใหม่เข้าระบบ
//   POST ?action=delete_bot         → Soft Delete บอท
//   POST ?action=sync               → Sync Rich Menu จาก LINE → DB
// ============================================================

import { query } from '../lib/db.js';

// ----------------------------------------------------------------------
// Helper: ดึงข้อมูล Admin จาก admin_system โดยใช้ email (Firebase email)
// คืน { admin_id, email, first_name, last_name } หรือ null
// ----------------------------------------------------------------------
async function getAdminByEmail(email) {
  if (!email) return null;
  try {
    const { rows } = await query(
      `SELECT admin_id, email, first_name, last_name, profile_url
       FROM admin_system
       WHERE email = $1 AND is_deleted = false
       LIMIT 1`,
      [email]
    );
    return rows[0] || null;
  } catch (e) {
    console.warn('[getAdminByEmail] error:', e.message);
    return null;
  }
}

// ----------------------------------------------------------------------
// Helper: บันทึก Log ลงตาราง audit_logs โดยตรง
// audit_logs: admin_id(TEXT), action, bot_key, bot_name,
//             menu_id_from, menu_id_to, menu_name, detail
// ----------------------------------------------------------------------
async function saveAuditLog({
  admin,          // object จาก getAdminByEmail: { admin_id(UUID), email, first_name, last_name, profile_url }
  action,
  bot_key, bot_name,
  menu_id_from, menu_id_to, menu_name,
  detail,
}) {
  try {
    const adminUuid   = admin?.admin_id    ?? null;   // UUID
    const adminEmail  = admin?.email       ?? null;
    const adminName   = admin
      ? ([admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.email)
      : null;
    const adminAvatar = admin?.profile_url ?? null;

    await query(
      `INSERT INTO audit_logs
         (admin_id, admin_email, admin_name, admin_avatar,
          action, bot_key, bot_name,
          menu_id_from, menu_id_to, menu_name, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        adminUuid, adminEmail, adminName, adminAvatar,
        action,
        bot_key      ?? null,
        bot_name     ?? null,
        menu_id_from ?? null,
        menu_id_to   ?? null,
        menu_name    ?? null,
        detail       ?? null,
      ]
    );
  } catch (e) {
    console.error('[saveAuditLog] error:', e.message);
  }
}

// ----------------------------------------------------------------------
// Helper: สร้าง display string จาก admin object
// ตัวอย่าง: "สมชาย ใจดี <somchai@email.com>"
// ----------------------------------------------------------------------
function adminDisplay(admin, fallbackEmail) {
  if (!admin) return fallbackEmail || 'unknown';
  const name = [admin.first_name, admin.last_name].filter(Boolean).join(' ');
  return name ? `${name} <${admin.email}>` : admin.email;
}

// ========================================
// GET Handler
// ========================================
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  console.log('[richmenu_home] GET action:', action);

  // action=list_bots
  if (action === 'list_bots') {
    try {
      const { rows } = await query(
        'SELECT * FROM line_bots WHERE is_deleted = false ORDER BY created_at DESC'
      );
      return Response.json(rows.map((row) => ({
        id: row.id, name: row.bot_name, key: row.bot_key,
        pictureUrl: row.picture_url, creator_id: row.creator_id,
      })));
    } catch (error) {
      console.error('[list_bots] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // action=current
  if (action === 'current') {
    try {
      const botKey = searchParams.get('botKey');
      if (!botKey) return Response.json({ error: 'botKey is required' }, { status: 400 });

      const { rows: botRows } = await query(
        'SELECT id, channel_token FROM line_bots WHERE bot_key = $1', [botKey]
      );
      if (botRows.length === 0) return Response.json({ error: 'Bot not found' }, { status: 404 });

      const { id: botId, channel_token: token } = botRows[0];
      const lineRes = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await lineRes.json();
      const currentMenuId = lineRes.ok ? (data.richMenuId || null) : null;

      let imageUrl = null;
      if (currentMenuId) {
        const { rows: menuRows } = await query(
          'SELECT image_url FROM bot_rich_menus WHERE rich_menu_id = $1 AND bot_id = $2',
          [currentMenuId, botId]
        );
        // ดึง backend origin จาก req.url เพื่อสร้าง full URL — ไม่ต้องใช้ env var
        const backendOrigin = new URL(req.url).origin;
        const storedUrl = menuRows[0]?.image_url || null;
        if (storedUrl && storedUrl.startsWith('http')) {
          // full URL อยู่แล้ว ใช้ตรงๆ
          imageUrl = storedUrl;
        } else if (storedUrl) {
          // relative path → ต่อ backend origin
          imageUrl = `${backendOrigin}${storedUrl}`;
        } else {
          // ไม่มีใน DB → สร้างจาก menuId
          imageUrl = `${backendOrigin}/src/richmmenu/richmenu_dashboard?action=image&botKey=${encodeURIComponent(botKey)}&menuId=${currentMenuId}`;
        }
      }
      return Response.json({ currentMenuId, imageUrl });
    } catch (error) {
      console.error('[current] Error:', error);
      return Response.json({ error: 'Failed to fetch current menu', details: error.message }, { status: 500 });
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
  console.log('[richmenu_home] POST action:', action);

  // action=verify_token
  if (action === 'verify_token') {
    try {
      const { token } = await req.json();
      if (!token) return Response.json({ message: 'กรุณาใส่ Token' }, { status: 400 });

      const { rows: configRows } = await query(
        'SELECT * FROM bot_config WHERE channel_access_token = $1 LIMIT 1', [token]
      );
      if (configRows.length === 0) {
        return Response.json({ message: 'ไม่พบ Token นี้ในระบบ กรุณาติดต่อผู้ดูแล' }, { status: 404 });
      }

      const botConfig = configRows[0];
      const lineRes = await fetch('https://api.line.me/v2/bot/info', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
      });
      const lineData = await lineRes.json();

      if (!lineRes.ok) {
        return Response.json({ message: lineData.message || 'Token ไม่ถูกต้องหรือหมดอายุ' }, { status: 400 });
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
      return Response.json({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=add_bot
  // frontend ส่งมา: bot_name, bot_key, channel_token,
  //                 picture_url, admin_email, bot_user_id
  // --------------------------------------------------
  if (action === 'add_bot') {
    try {
      const { bot_name, bot_key, channel_token, picture_url, admin_email, bot_user_id } = await req.json();

      if (!bot_key || !channel_token) {
        return Response.json({ message: 'ข้อมูลไม่ครบ (bot_key, channel_token)' }, { status: 400 });
      }

      // ✅ ดึงข้อมูล Admin จาก admin_system ด้วย email
      const admin      = await getAdminByEmail(admin_email);
      const adminId    = admin ? admin.admin_id.toString() : (admin_email || 'unknown');
      const adminLabel = adminDisplay(admin, admin_email);

      // ตรวจสอบ token ใน bot_config
      const { rows: configCheck } = await query(
        'SELECT id FROM bot_config WHERE channel_access_token = $1 LIMIT 1', [channel_token]
      );
      if (configCheck.length === 0) {
        await saveAuditLog({
          admin, action: 'BOT_ADD_FAILED',
          bot_key, bot_name: bot_name || null,
          detail: `Token ไม่พบในระบบ bot_config | โดย: ${adminLabel}`,
        });
        return Response.json({ message: 'ไม่พบ Token นี้ในระบบ bot_config กรุณาติดต่อผู้ดูแล' }, { status: 403 });
      }

      // Upsert ลง line_bots (creator_id เก็บ email เพราะ column เป็น VARCHAR)
      const { rows: upsertRows } = await query(
        `INSERT INTO line_bots (bot_name, bot_key, channel_token, picture_url, creator_id, bot_user_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (bot_key) DO UPDATE SET
           bot_name = EXCLUDED.bot_name, channel_token = EXCLUDED.channel_token,
           picture_url = EXCLUDED.picture_url, bot_user_id = EXCLUDED.bot_user_id,
           updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [bot_name || 'บอทใหม่', bot_key, channel_token, picture_url || null, admin_email || null, bot_user_id || null]
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
            await query('UPDATE line_bots SET bot_user_id = $1 WHERE id = $2', [resolvedBotUserId, lineBotId]);
          }
        } catch (e) {
          console.warn('[add_bot] ดึง bot userId ไม่ได้:', e.message);
        }
      }

      // Sync rich menus จาก LINE → DB
      const lineRes  = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: `Bearer ${channel_token}` },
      });
      const lineData = await lineRes.json();
      const menus    = lineData.richmenus || [];
      let syncCount  = 0;

      for (const menu of menus) {
        await query(
          `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (rich_menu_id) DO NOTHING`,
          [lineBotId, menu.richMenuId, menu.name || 'Imported Menu']
        );

        // ✅ Log: ใครเพิ่มเมนูเข้าบอทตัวไหน
        await saveAuditLog({
          admin, action: 'MENU_SYNCED',
          bot_key, bot_name: bot_name || 'บอทใหม่',
          menu_id_to: menu.richMenuId, menu_name: menu.name || 'Imported Menu',
          detail: `Sync เมนูจาก LINE เข้าระบบ | โดย: ${adminLabel}`,
        });
        syncCount++;
      }

      // ✅ Log: ใครเพิ่มบอทตัวไหน
      await saveAuditLog({
        admin, action: 'BOT_ADD',
        bot_key, bot_name: bot_name || 'บอทใหม่',
        detail: `เพิ่มบอทสำเร็จ sync เมนู ${syncCount} รายการ | โดย: ${adminLabel}`,
      });

      return Response.json(
        { success: true, message: `เพิ่มบอทสำเร็จ และ sync เมนู ${syncCount} รายการ`, data: { id: lineBotId, bot_name, synced: syncCount } },
        { status: 201 }
      );
    } catch (error) {
      console.error('[add_bot] Error:', error);
      return Response.json({ message: 'เกิดข้อผิดพลาดที่ฐานข้อมูล: ' + error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=delete_bot
  // frontend ส่งมา: bot_key, admin_email
  // --------------------------------------------------
  if (action === 'delete_bot') {
    try {
      const { bot_key, admin_email } = await req.json();
      if (!bot_key) return Response.json({ message: 'bot_key is required' }, { status: 400 });

      // ✅ ดึงข้อมูล Admin จาก admin_system ด้วย email
      const admin      = await getAdminByEmail(admin_email);
      const adminId    = admin ? admin.admin_id.toString() : (admin_email || 'unknown');
      const adminLabel = adminDisplay(admin, admin_email);

      const { rows: botRows } = await query(
        'SELECT id, bot_name FROM line_bots WHERE bot_key = $1 AND is_deleted = false', [bot_key]
      );
      if (botRows.length === 0) {
        await saveAuditLog({
          admin, action: 'BOT_DELETE_FAILED',
          bot_key, detail: `ไม่พบบอทในระบบ | โดย: ${adminLabel}`,
        });
        return Response.json({ message: 'ไม่พบบอทในระบบ' }, { status: 404 });
      }

      const botName = botRows[0].bot_name;
      await query(
        'UPDATE line_bots SET is_deleted = true, updated_at = CURRENT_TIMESTAMP WHERE bot_key = $1', [bot_key]
      );

      // ✅ Log: ใครลบบอทตัวไหน
      await saveAuditLog({
        admin, action: 'BOT_DELETE',
        bot_key, bot_name: botName,
        detail: `ลบบอทออกจากระบบ | โดย: ${adminLabel}`,
      });

      return Response.json({ success: true, message: 'ลบบอทสำเร็จ' });
    } catch (error) {
      console.error('[delete_bot] Error:', error);
      return Response.json({ message: 'เกิดข้อผิดพลาด: ' + error.message }, { status: 500 });
    }
  }

  // --------------------------------------------------
  // action=sync
  // frontend ส่งมา: botKey, admin_email
  // --------------------------------------------------
  if (action === 'sync') {
    try {
      const { botKey, admin_email } = await req.json();

      const { rows: botRows } = await query(
        'SELECT id, bot_name, channel_token FROM line_bots WHERE bot_key = $1', [botKey]
      );
      if (botRows.length === 0) return Response.json({ error: 'ไม่พบข้อมูลบอทในระบบ' }, { status: 404 });

      const { id: botId, bot_name: botName, channel_token: token } = botRows[0];

      // ✅ ดึงข้อมูล Admin จาก admin_system ด้วย email
      const admin      = await getAdminByEmail(admin_email);
      const adminId    = admin ? admin.admin_id.toString() : (admin_email || 'system');
      const adminLabel = adminDisplay(admin, admin_email);

      const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await lineRes.json();
      if (!lineRes.ok) throw new Error(data.message || 'ดึงข้อมูลจาก LINE ล้มเหลว');

      const menus    = data.richmenus || [];
      let savedCount = 0;

      for (const menu of menus) {
        const result = await query(
          `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (rich_menu_id) DO NOTHING
           RETURNING rich_menu_id`,
          [botId, menu.richMenuId, menu.name || 'Imported Menu']
        );

        // Log เฉพาะเมนูใหม่จริงๆ
        if (result.rows.length > 0) {
          await saveAuditLog({
            admin, action: 'MENU_SYNCED',
            bot_key: botKey, bot_name: botName,
            menu_id_to: menu.richMenuId, menu_name: menu.name || 'Imported Menu',
            detail: `Sync เมนูจาก LINE | โดย: ${adminLabel}`,
          });
          savedCount++;
        }
      }

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

// ============================================================
// Default export — routes by HTTP method (required by index.js vercelAdapter)
// ============================================================
export default async function richmenuHandler(req, res) {
  if (req.method === 'GET')  return GET(req, res);
  if (req.method === 'POST') return POST(req, res);
  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}