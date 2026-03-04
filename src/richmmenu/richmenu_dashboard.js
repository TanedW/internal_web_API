// src/richmmenu/richmenu_dashboard.js
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
//   POST ?action=delete                       → ลบ Rich Menu จาก LINE และ bot_config
//
// ⚠️  ไม่ใช้ตาราง line_bots และ bot_rich_menus แล้ว
//     ข้อมูลทั้งหมดอยู่ใน bot_config
//
// Columns ที่ใช้ใน bot_config:
//   id (INTEGER PK), nickname, bot_id (TEXT), channel_access_token,
//   picture_url, active_rich_menu_id, rich_menus (JSONB), richmenu_enabled
//
// โครงสร้างแต่ละ element ใน rich_menus JSONB:
//   { richMenuId, name, image_url, is_deleted }
//
// ✅ FIX NOTES:
//   - getTokenFromDB()  : รองรับทั้ง id (integer) และ bot_id (LINE User ID)
//   - getBotConfig()    : รองรับทั้ง id (integer) และ bot_id (LINE User ID)
//   - updateRichMenus() : ใช้ bot.id (integer PK) แทน botKey เสมอ
//   - action=current    : UPDATE ใช้ id แทน bot_id
//   - action=delete     : UPDATE active_rich_menu_id = NULL ใช้ id แทน bot_id
//   - action=upload     : สร้าง imageUrl ใช้ bot.id แทน botKey (ที่อาจเป็น string)
// ============================================================

import { query, pool } from "../lib/db.js";
import { callLineAPI } from "../lib/lineApi.js";
import { writeAuditLog } from "../lib/logging.js";

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

async function getAdminByEmail(email) {
  if (!email) return null;
  try {
    const { rows } = await query(
      `SELECT admin_id, email, first_name, last_name, profile_url
       FROM admin_system WHERE email = $1 AND is_deleted = false LIMIT 1`,
      [email],
    );
    return rows[0] || null;
  } catch (e) {
    console.warn("[getAdminByEmail] error:", e.message);
    return null;
  }
}

function adminDisplay(admin, fallback) {
  if (!admin) return fallback || "unknown";
  const name = [admin.first_name, admin.last_name].filter(Boolean).join(" ");
  return name ? `${name} <${admin.email}>` : admin.email;
}

async function saveAuditLog({
  admin,
  action,
  bot_key,
  bot_name,
  menu_id_from,
  menu_id_to,
  menu_name,
  detail,
  ipAddress,
  userAgent,
}) {
  try {
    const adminUuid = admin?.admin_id ?? null;
    const adminEmail = admin?.email ?? null;
    const adminName = admin
      ? [admin.first_name, admin.last_name].filter(Boolean).join(" ") ||
        admin.email
      : null;
    const adminAvatar = admin?.profile_url ?? null;

    await query(
      `INSERT INTO audit_logs
         (admin_id, admin_email, admin_name, admin_avatar,
          action, bot_key, bot_name,
          menu_id_from, menu_id_to, menu_name, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        adminUuid,
        adminEmail,
        adminName,
        adminAvatar,
        action,
        bot_key ?? null,
        bot_name ?? null,
        menu_id_from ?? null,
        menu_id_to ?? null,
        menu_name ?? null,
        detail ?? null,
      ],
    );

    const isFailed = action?.includes("_FAILED");
    await writeAuditLog(
      {
        adminId: adminUuid,
        email: adminEmail,
        firstName: admin?.first_name,
        lastName: admin?.last_name,
        actionType: action,
        status: isFailed ? "FAILED" : "SUCCESS",
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        details: {
          bot_key,
          bot_name,
          menu_id_from,
          menu_id_to,
          menu_name,
          detail,
        },
      },
      isFailed ? "WARNING" : "INFO",
    );
  } catch (e) {
    console.error("[saveAuditLog] error:", e.message);
  }
}

function getRequestMeta(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ipAddress = forwarded
    ? typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : forwarded[0]
    : (req.socket?.remoteAddress ?? null);
  const userAgent = req.headers["user-agent"] ?? null;
  return { ipAddress, userAgent };
}

/**
 * ✅ FIX: รองรับทั้ง id (integer PK) และ bot_id (LINE User ID เช่น Udde271...)
 * แยก query เป็น 2 กรณีชัดเจน ป้องกัน PostgreSQL type mismatch กับ OR condition
 */
async function getTokenFromDB(botKey) {
  const key = String(botKey);
  const isNumeric = /^\d+$/.test(key);

  let rows;

  if (isNumeric) {
    // botKey เป็น integer id (PK)
    ({ rows } = await query(
      `SELECT channel_access_token FROM bot_config
       WHERE id = $1 AND richmenu_enabled = true
       LIMIT 1`,
      [parseInt(key, 10)],
    ));
  } else {
    // botKey เป็น LINE User ID (text)
    ({ rows } = await query(
      `SELECT channel_access_token FROM bot_config
       WHERE bot_id = $1 AND richmenu_enabled = true
       LIMIT 1`,
      [key],
    ));
  }

  if (rows[0]?.channel_access_token) return rows[0].channel_access_token;
  console.error(`[Dashboard] ไม่พบ token สำหรับ botKey: "${botKey}"`);
  return null;
}

/**
 * ✅ FIX: รองรับทั้ง id (integer PK) และ bot_id (LINE User ID)
 * แยก query เป็น 2 กรณีชัดเจน ป้องกัน PostgreSQL type mismatch
 */
async function getBotConfig(botKey) {
  const key = String(botKey);
  const isNumeric = /^\d+$/.test(key);

  let rows;

  if (isNumeric) {
    // botKey เป็น integer id (PK)
    ({ rows } = await query(
      `SELECT id, nickname, bot_id, channel_access_token,
              active_rich_menu_id, rich_menus
       FROM bot_config
       WHERE id = $1 AND richmenu_enabled = true
       LIMIT 1`,
      [parseInt(key, 10)],
    ));
  } else {
    // botKey เป็น LINE User ID (text)
    ({ rows } = await query(
      `SELECT id, nickname, bot_id, channel_access_token,
              active_rich_menu_id, rich_menus
       FROM bot_config
       WHERE bot_id = $1 AND richmenu_enabled = true
       LIMIT 1`,
      [key],
    ));
  }

  return rows[0] || null;
}

/**
 * ✅ FIX: ใช้ bot.id (integer PK) เสมอ ไม่ใช้ botKey ที่อาจเป็น bot_id (string)
 * ทุก caller ต้องส่ง bot.id มาแทน botKey raw
 */
async function updateRichMenus(botId, newMenus) {
  await query(
    "UPDATE bot_config SET rich_menus = $1::jsonb WHERE id = $2",
    [JSON.stringify(newMenus), botId],
  );
}

// ============================================================
// EXPORT DEFAULT — Express handler
// ============================================================
export default async function handler(req, res) {
  // ─── CORS ──────────────────────────────────────────────────
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action ?? null;
  const { ipAddress, userAgent } = getRequestMeta(req);

  console.log(`[RichMenu Dashboard] ${req.method} action=${action}`);

  // ============================================================
  // GET
  // ============================================================
  if (req.method === "GET") {
    // ── current ──────────────────────────────────────────────
    // ดึง active_rich_menu_id จาก DB ก่อน (เร็ว)
    // ถ้ายังเป็น NULL → fallback เรียก LINE API แล้ว sync ค่ากลับ DB
    if (action === "current") {
      try {
        const botKey = req.query.botKey;
        if (!botKey)
          return res.status(400).json({ error: "botKey is required" });

        const bot = await getBotConfig(botKey);
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        let currentMenuId = bot.active_rich_menu_id || null;

        // Fallback: ดึงจาก LINE API เมื่อ DB ยังไม่มีค่า
        if (!currentMenuId) {
          try {
            const lineRes = await fetch(
              "https://api.line.me/v2/bot/user/all/richmenu",
              {
                headers: {
                  Authorization: `Bearer ${bot.channel_access_token}`,
                },
              },
            );
            if (lineRes.ok) {
              const lineData = await lineRes.json();
              currentMenuId = lineData.richMenuId || null;
              // ✅ FIX: sync ค่ากลับ DB ใช้ id (integer PK) แทน bot_id
              if (currentMenuId) {
                await query(
                  "UPDATE bot_config SET active_rich_menu_id = $1 WHERE id = $2",
                  [currentMenuId, bot.id],
                );
              }
            }
          } catch (e) {
            console.warn("[current] LINE API fallback failed:", e.message);
          }
        }

        let imageUrl = null;
        if (currentMenuId) {
          const richMenus = Array.isArray(bot.rich_menus) ? bot.rich_menus : [];
          const found = richMenus.find((m) => m.richMenuId === currentMenuId);
          // ✅ FIX: fallback image URL ใช้ bot.id แทน botKey
          imageUrl =
            found?.image_url ||
            `/src/richmmenu/richmenu_dashboard?action=image&botKey=${encodeURIComponent(bot.id)}&menuId=${currentMenuId}`;
        }

        return res.status(200).json({ currentMenuId, imageUrl });
      } catch (error) {
        console.error("[current]", error);
        return res.status(500).json({
          error: "Failed to fetch current menu",
          details: error.message,
        });
      }
    }

    // ── list ─────────────────────────────────────────────────
    // ดึงรายการเมนูจาก bot_config.rich_menus
    if (action === "list") {
      try {
        const botKey = req.query.botKey;
        if (!botKey)
          return res.status(400).json({ error: "botKey is required" });

        const bot = await getBotConfig(botKey);
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const existingMenus = Array.isArray(bot.rich_menus)
          ? bot.rich_menus
          : [];

        const API_BASE =
          process.env.API_BASE_URL ||
          "https://internal-web-api-y4if.vercel.app";

        const visibleMenus = existingMenus
          .filter((m) => !m.is_deleted)
          .map((m) => ({
            richMenuId: m.richMenuId,
            name: m.name,
            // ✅ FIX: ถ้าไม่มี image_url ใน DB ให้ fallback ไปที่ proxy โดยใช้ bot.id
            image_url:
              m.image_url ||
              `${API_BASE}/src/richmmenu/richmenu_dashboard?action=image&botKey=${encodeURIComponent(bot.id)}&menuId=${m.richMenuId}`,
            is_active: m.richMenuId === bot.active_rich_menu_id,
            created_at: null,
          }));

        return res.status(200).json({ richmenus: visibleMenus });
      } catch (error) {
        console.error("[list]", error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ── switch ───────────────────────────────────────────────
    // เปลี่ยนเมนูให้ทุกคนพร้อมกันด้วย /richmenu/batch
    if (action === "switch") {
      try {
        const { botKey, menuId, adminId = null } = req.query;

        if (!botKey || !menuId) {
          return res.status(400).json({ error: "Missing botKey or menuId" });
        }

        const bot = await getBotConfig(botKey);
        if (!bot?.channel_access_token) {
          return res.status(404).json({ error: "Bot token not found" });
        }

        const token = bot.channel_access_token;
        const prevMenuId = bot.active_rich_menu_id || null;

        // STEP 1: set default ก่อน
        const setDefaultRes = await fetch(
          `https://api.line.me/v2/bot/user/all/richmenu/${menuId}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
        );

        if (!setDefaultRes.ok) {
          const errorData = await setDefaultRes.json();
          await saveAuditLog({
            admin: await getAdminByEmail(adminId),
            action: "MENU_SWITCH_FAILED",
            bot_key: botKey,
            bot_name: bot.nickname || null,
            menu_id_to: menuId,
            detail: `เปลี่ยนเมนูล้มเหลว: ${errorData.message}`,
            ipAddress,
            userAgent,
          });
          return res
            .status(setDefaultRes.status)
            .json({ error: errorData.message || "Failed to switch menu" });
        }

        // STEP 2: batch เฉพาะเมื่อมีเมนูเก่า
        if (prevMenuId && prevMenuId !== menuId) {
          const batchRes = await fetch(
            "https://api.line.me/v2/bot/richmenu/batch",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                operations: [{ type: "link", from: prevMenuId, to: menuId }],
              }),
            },
          );
          if (!batchRes.ok) {
            console.warn(
              "[switch] batch rate limited, default menu was set successfully",
            );
          }
        }

        // ✅ FIX: UPDATE ใช้ id (integer PK) เสมอ
        await query(
          "UPDATE bot_config SET active_rich_menu_id = $1 WHERE id = $2",
          [menuId, bot.id],
        );

        const switchAdmin = await getAdminByEmail(adminId);
        await saveAuditLog({
          admin: switchAdmin,
          action: "MENU_SWITCH",
          bot_key: botKey,
          bot_name: bot.nickname || null,
          menu_id_from: prevMenuId,
          menu_id_to: menuId,
          detail: `เปลี่ยนเมนูสำเร็จ (batch — ทุกคนเห็นเมนูใหม่)`,
          ipAddress,
          userAgent,
        });

        return res.status(200).json({ success: true });
      } catch (error) {
        console.error("[switch]", error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ── details ──────────────────────────────────────────────
    if (action === "details") {
      try {
        const { botKey, menuId } = req.query;
        if (!botKey || !menuId)
          return res.status(400).json({ error: "Missing botKey or menuId" });

        const token = await getTokenFromDB(botKey);
        if (!token)
          return res.status(404).json({ error: "Token not found in database" });

        const lineRes = await fetch(
          `https://api.line.me/v2/bot/richmenu/${menuId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const data = await lineRes.json();

        if (!lineRes.ok)
          return res
            .status(lineRes.status)
            .json({ error: data.message || "LINE API Error" });
        return res.status(200).json(data);
      } catch (error) {
        console.error("[details]", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    }

    // ── image proxy ──────────────────────────────────────────
    // ✅ FIX: getTokenFromDB รองรับทั้ง id และ bot_id แล้ว
    if (action === "image") {
      try {
        let botKey = req.query.botKey;
        const richMenuId = req.query.richMenuId || req.query.menuId;

        if (!richMenuId)
          return res.status(400).send("Rich Menu ID is required");
        if (!botKey) return res.status(400).send("Bot key is required");

        botKey = decodeURIComponent(botKey);
        const token = await getTokenFromDB(botKey);
        if (!token) return res.status(400).send("Invalid bot key");

        const lineRes = await fetch(
          `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
          { headers: { Authorization: `Bearer ${token}` } },
        );

        if (!lineRes.ok) {
          const errText = await lineRes.text();
          return res.status(lineRes.status).send(`LINE API error: ${errText}`);
        }

        const imageBuffer = Buffer.from(await lineRes.arrayBuffer());
        res.setHeader(
          "Content-Type",
          lineRes.headers.get("Content-Type") || "image/jpeg",
        );
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.status(200).send(imageBuffer);
      } catch (error) {
        console.error("[image proxy]", error);
        return res.status(500).send("Internal server error");
      }
    }

    // ── audit_logs ───────────────────────────────────────────
    if (action === "audit_logs") {
      try {
        const botKey = req.query.botKey;
        if (!botKey)
          return res.status(400).json({ error: "botKey is required" });

        const { rows } = await query(
          `SELECT
             al.id,
             al.action,
             al.bot_key,
             al.bot_name,
             al.menu_id_from,
             al.menu_id_to,
             al.menu_name,
             al.detail,
             to_char(
               al.created_at AT TIME ZONE 'Asia/Bangkok',
               'YYYY-MM-DD"T"HH24:MI:SS+07:00'
             ) AS created_at,
             COALESCE(al.menu_id_from, al.menu_id_from) AS menu_name_from,
             COALESCE(al.menu_name, al.menu_id_to)      AS menu_name_to,
             COALESCE(al.admin_email, a.email)          AS admin_email,
             COALESCE(al.admin_name,
               NULLIF(TRIM(CONCAT_WS(' ', a.first_name, a.last_name)), ''),
               a.email)                                 AS admin_name,
             COALESCE(al.admin_avatar, a.profile_url)   AS admin_avatar
           FROM audit_logs al
           LEFT JOIN admin_system a ON a.admin_id = al.admin_id
           WHERE al.bot_key = (
             SELECT bot_id FROM bot_config WHERE id = $1::int LIMIT 1
           )
           ORDER BY al.created_at DESC
           LIMIT 200`,
          [decodeURIComponent(botKey)],
        );

        return res.status(200).json({ logs: rows });
      } catch (error) {
        console.error("[audit_logs]", error);
        return res.status(500).json({ error: error.message });
      }
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  // ============================================================
  // POST
  // ============================================================
  if (req.method === "POST") {
    // ── upload ───────────────────────────────────────────────
    // สร้าง Rich Menu + อัปโหลดรูปผ่าน LINE API
    // แล้วบันทึก richMenuId + image_url ลง bot_config.rich_menus JSONB
    if (action === "upload") {
      try {
        let botKey = req.body?.botKey;
        const menuName = req.body?.menuName;
        const chatBarText = req.body?.chatBarText || "เมนูหลัก";
        const creatorId = req.body?.creatorId || "system";
        const menuImage = req.file; // Buffer จาก multer.memoryStorage()

        if (!botKey)
          return res.status(400).json({ error: "Bot key is required" });
        if (!menuImage)
          return res.status(400).json({ error: "Menu image is required" });

        botKey = decodeURIComponent(botKey);
        const areas = JSON.parse(req.body?.areas || "[]");
        const size = req.body?.size
          ? JSON.parse(req.body.size)
          : { width: 2500, height: 843 };

        if (!areas.length)
          return res.status(400).json({ error: "Menu areas are required" });

        const actor = await getAdminByEmail(creatorId);
        const actorLabel = adminDisplay(actor, creatorId);

        const token = await getTokenFromDB(botKey);
        if (!token)
          return res.status(400).json({ error: "Bot token not found" });

        // STEP 1: สร้างโครงสร้าง Rich Menu ที่ LINE
        const step1 = await callLineAPI(
          "https://api.line.me/v2/bot/richmenu",
          "POST",
          {
            size,
            selected: true,
            name: menuName || `Menu_${Date.now()}`,
            chatBarText,
            areas,
          },
          token,
        );

        if (step1.code !== 200 || !step1.response?.richMenuId) {
          await saveAuditLog({
            admin: actor,
            action: "MENU_UPLOAD_FAILED",
            bot_key: botKey,
            menu_name: menuName,
            detail: `สร้างโครงสร้างเมนูล้มเหลว`,
            ipAddress,
            userAgent,
          });
          return res.status(400).json({
            error: "Failed to create menu structure",
            details: step1.response?.message || "Unknown error",
          });
        }

        const richMenuId = step1.response.richMenuId;

        // STEP 2: อัปโหลดรูปภาพ
        const step2 = await callLineAPI(
          `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
          "POST",
          menuImage.buffer,
          token,
          true, // isImage
        );

        if (step2.code !== 200) {
          // rollback: ลบ rich menu ที่สร้างไว้
          await callLineAPI(
            `https://api.line.me/v2/bot/richmenu/${richMenuId}`,
            "DELETE",
            null,
            token,
          );
          await saveAuditLog({
            admin: actor,
            action: "MENU_UPLOAD_FAILED",
            bot_key: botKey,
            menu_name: menuName,
            detail: `อัปโหลดรูปภาพล้มเหลว`,
            ipAddress,
            userAgent,
          });
          return res.status(400).json({
            error: "Failed to upload image",
            details: step2.response?.message,
          });
        }

        // STEP 3: บันทึกลง bot_config.rich_menus JSONB
        // ✅ FIX: getBotConfig รองรับทั้ง id และ bot_id แล้ว
        const bot = await getBotConfig(botKey);
        if (!bot) {
          await callLineAPI(
            `https://api.line.me/v2/bot/richmenu/${richMenuId}`,
            "DELETE",
            null,
            token,
          );
          return res.status(400).json({ error: "Bot not found in database" });
        }

        const API_BASE =
          process.env.API_BASE_URL ||
          "https://internal-web-api-y4if.vercel.app";

        // ✅ FIX: imageUrl ใช้ bot.id (integer PK) แทน botKey ที่รับมา
        const imageUrl = `${API_BASE}/src/richmmenu/richmenu_dashboard?action=image&botKey=${encodeURIComponent(bot.id)}&menuId=${richMenuId}`;

        const existingMenus = Array.isArray(bot.rich_menus)
          ? bot.rich_menus
          : [];
        const newMenu = {
          richMenuId,
          name: menuName || `Menu_${Date.now()}`,
          image_url: imageUrl,
          is_deleted: false,
        };

        // ✅ FIX: ส่ง bot.id ไปที่ updateRichMenus แทน botKey
        await updateRichMenus(bot.id, [...existingMenus, newMenu]);

        await saveAuditLog({
          admin: actor,
          action: "MENU_UPLOAD",
          bot_key: botKey,
          menu_id_to: richMenuId,
          menu_name: menuName,
          detail: `สร้าง Rich Menu ใหม่สำเร็จ`,
          ipAddress,
          userAgent,
        });

        return res.status(200).json({
          success: true,
          richMenuId,
          message: `Menu "${menuName}" created successfully.`,
        });
      } catch (error) {
        console.error("[upload]", error);
        return res
          .status(500)
          .json({ error: "Internal server error", details: error.message });
      }
    }

    // ── save_flow ────────────────────────────────────────────
    // บันทึก Flow (state + action-list)
    if (action === "save_flow") {
      try {
        const { botKey, botName, flowSteps, creatorId } = req.body;

        if (!botKey || !flowSteps?.length) {
          return res
            .status(400)
            .json({ error: "botKey and flowSteps are required" });
        }

        // ดึง bot_id จาก bot_config (bot_id = LINE userId ของบอท ใช้แทน bot_user_id)
        const { rows: botRows } = await query(
          `SELECT bot_id, nickname FROM bot_config
           WHERE (bot_id = $1 OR id::text = $1)
           AND richmenu_enabled = true
           LIMIT 1`,
          [String(botKey)],
        );
        const botUserId = botRows[0]?.bot_id;
        const resolvedBotName = botName || botRows[0]?.nickname || botKey;

        if (!botUserId) {
          return res
            .status(400)
            .json({ error: "ไม่พบ bot_id กรุณาเพิ่มบอทใหม่อีกครั้ง" });
        }

        const actor = await getAdminByEmail(creatorId);
        const actorLabel = adminDisplay(actor, creatorId);

        let savedCount = 0;

        for (const step of flowSteps) {
          const postbackData = step.postbackData || step.stateName;

          const { rows: existingRows } = await query(
            `SELECT "stateID" FROM state WHERE "postbackData" = $1 AND "botID" = $2 LIMIT 1`,
            [postbackData, botUserId],
          );
          let stateID = existingRows[0]?.stateid ?? existingRows[0]?.stateID;

          if (stateID) {
            await query(
              `UPDATE state SET
                 "stateName"=$1, "nextStateName"=$2, "botName"=$3,
                 "eventType"=$4, "eventMessageType"=$5
               WHERE "stateID"=$6`,
              [
                step.stateName,
                step.nextStateName || "",
                resolvedBotName,
                step.eventType || "postback",
                step.msgType || "text",
                stateID,
              ],
            );
          } else {
            const { rows: maxRows } = await query(
              `SELECT COALESCE(MAX("stateID"), 0) + 1 AS next_id FROM state`,
            );
            const newStateID = Number(maxRows[0].next_id);

            await query(
              `INSERT INTO state
                 ("stateID","stateName","nextStateName","botID","botName",
                  "eventType","eventMessageType","postbackData")
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                newStateID,
                step.stateName,
                step.nextStateName || "",
                botUserId,
                resolvedBotName,
                step.eventType || "postback",
                step.msgType || "text",
                postbackData,
              ],
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
              [
                act.id || Date.now(),
                act.order || 1,
                act.type || "text",
                act.payload || "",
                stateID,
              ],
            );
          }

          savedCount++;
        }

        await saveAuditLog({
          admin: actor,
          action: "MENU_SAVE_FLOW",
          bot_key: botKey,
          bot_name: resolvedBotName || null,
          detail: `บันทึก Flow ${savedCount}/${flowSteps.length} states`,
          ipAddress,
          userAgent,
        });

        return res.status(200).json({
          success: true,
          message: `บันทึก ${savedCount} states สำเร็จ`,
        });
      } catch (error) {
        console.error("[save_flow]", error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ── delete ───────────────────────────────────────────────
    // ลบ Rich Menu จาก LINE + soft delete ใน bot_config.rich_menus JSONB
    if (action === "delete") {
      try {
        const { botKey: rawBotKey, menuId, current_admin_id } = req.body;

        if (!rawBotKey || !menuId) {
          return res
            .status(400)
            .json({ error: "botKey and menuId are required" });
        }

        const decodedBotKey = decodeURIComponent(rawBotKey);
        const actor = await getAdminByEmail(current_admin_id);

        // ✅ FIX: getBotConfig รองรับทั้ง id และ bot_id แล้ว
        const bot = await getBotConfig(decodedBotKey);
        if (!bot) {
          await saveAuditLog({
            admin: actor,
            action: "MENU_DELETE_FAILED",
            bot_key: decodedBotKey,
            menu_id_from: menuId,
            detail: `ลบเมนูล้มเหลว: Invalid bot key`,
            ipAddress,
            userAgent,
          });
          return res.status(400).json({ error: "Invalid bot key" });
        }

        const result = await callLineAPI(
          `https://api.line.me/v2/bot/richmenu/${menuId}`,
          "DELETE",
          null,
          bot.channel_access_token,
        );

        if (result.code === 200) {
          // Soft delete ใน JSONB: set is_deleted = true สำหรับ richMenuId นั้น
          const existingMenus = Array.isArray(bot.rich_menus)
            ? bot.rich_menus
            : [];
          const updatedMenus = existingMenus.map((m) =>
            m.richMenuId === menuId ? { ...m, is_deleted: true } : m,
          );

          // ✅ FIX: ส่ง bot.id ไปที่ updateRichMenus
          await updateRichMenus(bot.id, updatedMenus);

          // ✅ FIX: ล้าง active_rich_menu_id ใช้ id (integer PK) แทน bot_id
          if (bot.active_rich_menu_id === menuId) {
            await query(
              "UPDATE bot_config SET active_rich_menu_id = NULL WHERE id = $1",
              [bot.id],
            );
          }

          await saveAuditLog({
            admin: actor,
            action: "MENU_DELETE",
            bot_key: decodedBotKey,
            menu_id_from: menuId,
            detail: `ลบ Rich Menu สำเร็จ (soft delete)`,
            ipAddress,
            userAgent,
          });

          return res
            .status(200)
            .json({ success: true, message: "Menu deleted successfully" });
        }

        await saveAuditLog({
          admin: actor,
          action: "MENU_DELETE_FAILED",
          bot_key: decodedBotKey,
          menu_id_from: menuId,
          detail: `ลบเมนูล้มเหลว (LINE API): ${result.response?.message || "unknown error"}`,
          ipAddress,
          userAgent,
        });

        return res.status(result.code || 400).json({
          error: result.response?.message || "Failed to delete menu",
        });
      } catch (error) {
        console.error("[delete]", error);
        return res
          .status(500)
          .json({ error: "Internal server error", details: error.message });
      }
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  return res.status(405).json({ error: "Method Not Allowed" });
}