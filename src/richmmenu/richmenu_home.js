// ============================================================
// API ROUTE — สำหรับหน้า richmenu-home (page.jsx) เท่านั้น
//
// Actions ที่รองรับ:
//   GET  ?action=list_bots          → ดึงรายการบอทที่ richmenu_enabled = true
//   GET  ?action=current&botKey=... → ดึงเมนูที่ active + imageUrl
//   POST ?action=verify_token       → ตรวจสอบ Channel Access Token
//   POST ?action=add_bot            → set richmenu_enabled = true + sync เมนู
//   POST ?action=delete_bot         → set richmenu_enabled = false (ซ่อนออกจากหน้า)
//   POST ?action=sync               → Sync Rich Menu จาก LINE → bot_config.rich_menus
//
// ⚠️  ไม่ใช้ตาราง line_bots และ bot_rich_menus แล้ว
//     ข้อมูลทั้งหมดอยู่ใน bot_config
//
// Columns ที่ใช้ใน bot_config:
//   id, nickname, bot_id (ใช้แทน bot_key), channel_access_token,
//   picture_url, richmenu_enabled,
//   active_rich_menu_id, rich_menus (JSONB array ของ rich menu)
//
// โครงสร้างแต่ละ element ใน rich_menus JSONB:
//   { richMenuId, name, image_url, is_deleted }
// ============================================================

import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

// ----------------------------------------------------------------------
// Helper: ดึงข้อมูล Admin จาก admin_system โดยใช้ email (Firebase email)
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
// Helper: บันทึก Log ลงตาราง audit_logs + Google Cloud Logging
// ----------------------------------------------------------------------
async function saveAuditLog({
  admin,
  action,
  bot_key, bot_name,
  menu_id_from, menu_id_to, menu_name,
  detail,
  ipAddress,
  userAgent,
}) {
  try {
    const adminUuid   = admin?.admin_id    ?? null;
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

    const isFailed = action?.includes('_FAILED');
    await writeAuditLog(
      {
        adminId:    adminUuid,
        email:      adminEmail,
        firstName:  admin?.first_name,
        lastName:   admin?.last_name,
        actionType: action,
        status:     isFailed ? 'FAILED' : 'SUCCESS',
        ipAddress:  ipAddress ?? null,
        userAgent:  userAgent ?? null,
        details:    { bot_key, bot_name, menu_id_from, menu_id_to, menu_name, detail },
      },
      isFailed ? 'WARNING' : 'INFO',
    );
  } catch (e) {
    console.error('[saveAuditLog] error:', e.message);
  }
}

function adminDisplay(admin, fallbackEmail) {
  if (!admin) return fallbackEmail || 'unknown';
  const name = [admin.first_name, admin.last_name].filter(Boolean).join(' ');
  return name ? `${name} <${admin.email}>` : admin.email;
}

function getClientInfo(req) {
  const forwarded = req.headers['x-forwarded-for'] ?? req.headers.get?.('x-forwarded-for');
  const ipAddress = forwarded
    ? (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0])
    : (req.socket?.remoteAddress ?? null);
  const userAgent = req.headers['user-agent'] ?? req.headers.get?.('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// ========================================
// GET Handler
// ========================================
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const { ipAddress, userAgent } = getClientInfo(req);
  console.log('[richmenu_home] GET action:', action);

  // ──────────────────────────────────────────────────────────────────
  // action=list_bots
  // ดึงเฉพาะบอทที่ถูกเพิ่มเข้าระบบ richmenu แล้ว (richmenu_enabled = true)
  // ──────────────────────────────────────────────────────────────────
  if (action === 'list_bots') {
    try {
      const { rows } = await query(
        `SELECT id, nickname, bot_id, picture_url
         FROM bot_config
         WHERE richmenu_enabled = true
         ORDER BY id DESC`
      );
      return Response.json(rows.map((row) => ({
        id:         row.id,
        name:       row.nickname,
        key:        row.bot_id,      // bot_id ใช้แทน bot_key
        pictureUrl: row.picture_url,
      })));
    } catch (error) {
      console.error('[list_bots] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // action=current
  // ดึง active menu จาก LINE API
  // หา image_url จาก bot_config.rich_menus JSONB
  // ──────────────────────────────────────────────────────────────────
  if (action === 'current') {
    try {
      const botKey = searchParams.get('botKey');
      if (!botKey) return Response.json({ error: 'botKey is required' }, { status: 400 });

      const { rows: botRows } = await query(
        `SELECT channel_access_token, active_rich_menu_id, rich_menus
         FROM bot_config
         WHERE bot_id = $1 AND richmenu_enabled = true
         LIMIT 1`,
        [botKey]
      );
      if (botRows.length === 0) return Response.json({ error: 'Bot not found' }, { status: 404 });

      const bot   = botRows[0];
      const token = bot.channel_access_token;

      // เรียก LINE API เพื่อดู default rich menu ปัจจุบัน
      const lineRes = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await lineRes.json();
      const currentMenuId = lineRes.ok ? (data.richMenuId || null) : null;

      // หา image_url จาก rich_menus JSONB
      let imageUrl = null;
      if (currentMenuId) {
        const richMenus = Array.isArray(bot.rich_menus) ? bot.rich_menus : [];
        const found     = richMenus.find((m) => m.richMenuId === currentMenuId);
        const backendOrigin = new URL(req.url).origin;

        if (found?.image_url?.startsWith('http')) {
          imageUrl = found.image_url;
        } else if (found?.image_url) {
          imageUrl = `${backendOrigin}${found.image_url}`;
        } else {
          // fallback: proxy image จาก LINE
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
  const { ipAddress, userAgent } = getClientInfo(req);
  console.log('[richmenu_home] POST action:', action);

  // ──────────────────────────────────────────────────────────────────
  // action=verify_token
  // ตรวจว่า token อยู่ใน bot_config แล้วตรวจสอบกับ LINE API
  // ──────────────────────────────────────────────────────────────────
  if (action === 'verify_token') {
    try {
      const { token } = await req.json();
      if (!token) return Response.json({ message: 'กรุณาใส่ Token' }, { status: 400 });

      const { rows: configRows } = await query(
        'SELECT * FROM bot_config WHERE channel_access_token = $1 LIMIT 1',
        [token]
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
        name:                 lineData.displayName || botConfig.nickname,
        key:                  botConfig.bot_id,
        pictureUrl:           lineData.pictureUrl,
        botConfigId:          botConfig.id,
        channel_access_token: token,
        botUserId:            lineData.userId || null,
      });
    } catch (error) {
      console.error('[verify_token] Error:', error);
      return Response.json({ message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + error.message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // action=add_bot
  // อัปเดต bot_config ด้วยข้อมูลจาก LINE (ไม่ insert แถวใหม่)
  // frontend ส่งมา: bot_name, bot_key (=bot_id), channel_token,
  //                 picture_url, admin_email, bot_user_id
  // ──────────────────────────────────────────────────────────────────
  if (action === 'add_bot') {
    try {
      const { bot_name, bot_key, channel_token, picture_url, admin_email, bot_user_id } = await req.json();

      if (!bot_key || !channel_token) {
        return Response.json({ message: 'ข้อมูลไม่ครบ (bot_key, channel_token)' }, { status: 400 });
      }

      const admin      = await getAdminByEmail(admin_email);
      const adminLabel = adminDisplay(admin, admin_email);

      // ตรวจสอบ channel_access_token ใน bot_config
      const { rows: configCheck } = await query(
        'SELECT id FROM bot_config WHERE channel_access_token = $1 LIMIT 1',
        [channel_token]
      );
      if (configCheck.length === 0) {
        await saveAuditLog({
          admin, action: 'BOT_ADD_FAILED',
          bot_key, bot_name: bot_name || null,
          detail: `Token ไม่พบในระบบ bot_config | โดย: ${adminLabel}`,
          ipAddress, userAgent,
        });
        return Response.json({ message: 'ไม่พบ Token นี้ในระบบ bot_config กรุณาติดต่อผู้ดูแล' }, { status: 403 });
      }

      const lineHeaders = { Authorization: `Bearer ${channel_token}` };

      // ดึง bot info + rich menu list พร้อมกัน (parallel)
      const [botInfoRes, lineMenuRes] = await Promise.all([
        bot_user_id
          ? Promise.resolve(null)
          : fetch('https://api.line.me/v2/bot/info', { headers: lineHeaders }),
        fetch('https://api.line.me/v2/bot/richmenu/list', { headers: lineHeaders }),
      ]);

      let resolvedBotUserId  = bot_user_id || null;
      let resolvedPictureUrl = picture_url || null;

      if (botInfoRes) {
        try {
          const botInfo      = await botInfoRes.json();
          resolvedBotUserId  = botInfo.userId       || null;
          resolvedPictureUrl = resolvedPictureUrl   || botInfo.pictureUrl || null;
        } catch (e) {
          console.warn('[add_bot] ดึง bot info ไม่ได้:', e.message);
        }
      }

      // ดึง rich_menus เดิมเพื่อ merge (รักษา image_url)
      const { rows: existingRows } = await query(
        'SELECT rich_menus FROM bot_config WHERE bot_id = $1 LIMIT 1',
        [bot_key]
      );
      const existingMenus = Array.isArray(existingRows[0]?.rich_menus) ? existingRows[0].rich_menus : [];
      const existingMap   = Object.fromEntries(existingMenus.map((m) => [m.richMenuId, m]));

      const lineData  = await lineMenuRes.json();
      const menus     = lineData.richmenus || [];
      const syncCount = menus.length;

      const mergedMenus = menus.map((m) => ({
        richMenuId: m.richMenuId,
        name:       m.name || existingMap[m.richMenuId]?.name || 'Imported Menu',
        image_url:  existingMap[m.richMenuId]?.image_url || null,
        is_deleted: false,
      }));

      // อัปเดต bot_config + เปิด richmenu_enabled
      await query(
        `UPDATE bot_config SET
           nickname         = COALESCE($1, nickname),
           picture_url      = COALESCE($2, picture_url),
           bot_user_id      = COALESCE($3, bot_user_id),
           rich_menus       = $4::jsonb,
           richmenu_enabled = true
         WHERE bot_id = $5`,
        [
          bot_name || null,
          resolvedPictureUrl,
          resolvedBotUserId,
          JSON.stringify(mergedMenus),
          bot_key,
        ]
      );

      await saveAuditLog({
        admin, action: 'BOT_ADD',
        bot_key, bot_name: bot_name || 'บอทใหม่',
        detail: `เพิ่ม/อัปเดตบอทสำเร็จ sync เมนู ${syncCount} รายการ | โดย: ${adminLabel}`,
        ipAddress, userAgent,
      });

      return Response.json(
        { success: true, message: `เพิ่มบอทสำเร็จ และ sync เมนู ${syncCount} รายการ`, data: { bot_key, bot_name, synced: syncCount } },
        { status: 201 }
      );
    } catch (error) {
      console.error('[add_bot] Error:', error);
      return Response.json({ message: 'เกิดข้อผิดพลาดที่ฐานข้อมูล: ' + error.message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // action=delete_bot
  // เอาบอทออกจากหน้า richmenu: set richmenu_enabled = false
  // (บอทยังอยู่ใน bot_config ตามปกติ แค่ไม่แสดงในหน้านี้)
  // frontend ส่งมา: bot_key (=bot_id), admin_email
  // ──────────────────────────────────────────────────────────────────
  if (action === 'delete_bot') {
    try {
      const { bot_key, admin_email } = await req.json();
      if (!bot_key) return Response.json({ message: 'bot_key is required' }, { status: 400 });

      const admin      = await getAdminByEmail(admin_email);
      const adminLabel = adminDisplay(admin, admin_email);

      const { rows: botRows } = await query(
        `SELECT id, nickname FROM bot_config
         WHERE bot_id = $1 AND richmenu_enabled = true
         LIMIT 1`,
        [bot_key]
      );
      if (botRows.length === 0) {
        await saveAuditLog({
          admin, action: 'BOT_DELETE_FAILED',
          bot_key, detail: `ไม่พบบอทในระบบ | โดย: ${adminLabel}`,
          ipAddress, userAgent,
        });
        return Response.json({ message: 'ไม่พบบอทในระบบ' }, { status: 404 });
      }

      const botName = botRows[0].nickname;

      await query(
        'UPDATE bot_config SET richmenu_enabled = false WHERE bot_id = $1',
        [bot_key]
      );

      await saveAuditLog({
        admin, action: 'BOT_DELETE',
        bot_key, bot_name: botName,
        detail: `ลบบอทออกจากระบบ | โดย: ${adminLabel}`,
        ipAddress, userAgent,
      });

      return Response.json({ success: true, message: 'ลบบอทสำเร็จ' });
    } catch (error) {
      console.error('[delete_bot] Error:', error);
      return Response.json({ message: 'เกิดข้อผิดพลาด: ' + error.message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // action=sync
  // Sync rich menu list จาก LINE → bot_config.rich_menus (JSONB)
  // เมนูใหม่จาก LINE จะถูก merge; เมนูที่หายไปจาก LINE จะถูก soft delete
  // frontend ส่งมา: botKey (=bot_id), admin_email
  // ──────────────────────────────────────────────────────────────────
  if (action === 'sync') {
    try {
      const { botKey, admin_email } = await req.json();

      const { rows: botRows } = await query(
        `SELECT id, nickname, channel_access_token, rich_menus
         FROM bot_config
         WHERE bot_id = $1 AND richmenu_enabled = true
         LIMIT 1`,
        [botKey]
      );
      if (botRows.length === 0) return Response.json({ error: 'ไม่พบข้อมูลบอทในระบบ' }, { status: 404 });

      const bot     = botRows[0];
      const token   = bot.channel_access_token;
      const botName = bot.nickname;

      const admin      = await getAdminByEmail(admin_email);
      const adminLabel = adminDisplay(admin, admin_email);

      const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await lineRes.json();
      if (!lineRes.ok) throw new Error(data.message || 'ดึงข้อมูลจาก LINE ล้มเหลว');

      const lineMenus = data.richmenus || [];

      // Merge: รักษา image_url เดิม + เพิ่มเมนูใหม่
      const existingMenus = Array.isArray(bot.rich_menus) ? bot.rich_menus : [];
      const existingMap   = Object.fromEntries(existingMenus.map((m) => [m.richMenuId, m]));
      const lineMenuIds   = new Set(lineMenus.map((m) => m.richMenuId));

      const activeMenus = lineMenus.map((m) => ({
        richMenuId: m.richMenuId,
        name:       m.name || existingMap[m.richMenuId]?.name || 'Imported Menu',
        image_url:  existingMap[m.richMenuId]?.image_url || null,
        is_deleted: false,
      }));

      // เมนูที่หายจาก LINE → soft delete ใน JSONB
      const orphanMenus = existingMenus
        .filter((m) => !lineMenuIds.has(m.richMenuId) && !m.is_deleted)
        .map((m) => ({ ...m, is_deleted: true }));

      const newCount   = lineMenus.filter((m) => !existingMap[m.richMenuId]).length;
      const finalMenus = [...activeMenus, ...orphanMenus];

      await query(
        'UPDATE bot_config SET rich_menus = $1::jsonb WHERE bot_id = $2',
        [JSON.stringify(finalMenus), botKey]
      );

      if (newCount > 0) {
        await saveAuditLog({
          admin, action: 'MENU_SYNCED',
          bot_key: botKey, bot_name: botName,
          detail: `Sync เมนูใหม่ ${newCount} รายการจาก LINE | โดย: ${adminLabel}`,
          ipAddress, userAgent,
        });
      }

      return Response.json({
        success: true,
        message: `Sync สำเร็จ! พบเมนู ${lineMenus.length} รายการ, บันทึกใหม่ ${newCount} รายการ`,
      });
    } catch (error) {
      console.error('[sync] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}

// ============================================================
// Default export — routes by HTTP method
// ============================================================
export default async function richmenuHandler(req, res) {
  if (req.method === 'GET')  return GET(req, res);
  if (req.method === 'POST') return POST(req, res);
  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}