// เทสสส
import pg from 'pg';

const { Pool } = pg;

// ============================================================
// 🗄️ DATABASE POOL (ใช้ env เดียวกับ db.js ของโปรเจค)
// ============================================================
const pool = new Pool({
  host:              process.env.API_PY_HOST,
  user:              process.env.API_PY_USER,
  database:          process.env.API_PY_DBNAME,
  password:          process.env.API_PY_PASS,
  port:              parseInt(process.env.API_PY_PORT || '5432'),
  ssl:               { rejectUnauthorized: false },
  max:               10,
  idleTimeoutMillis: 60000,
});

pool.on('error', (err) => {
  console.error('[richmenu] Unexpected DB error:', err.message);
});

// ============================================================
// 🔑 HELPER: ดึง Channel Token จาก DB ด้วย botKey
// ============================================================
async function getBotToken(botKey) {
  try {
    const result = await pool.query(
      'SELECT channel_token FROM line_bots WHERE bot_key = $1',
      [botKey]
    );
    return result.rows[0]?.channel_token || null;
  } catch (error) {
    console.error('[getBotToken] Error:', error.message);
    return null;
  }
}

// ============================================================
// 📡 HELPER: เรียก LINE API
// ============================================================
async function callLineAPI(url, method, data, token, isImage = false) {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    let body;

    if (method === 'POST' || method === 'PUT') {
      if (isImage) {
        body = data;
        headers['Content-Type'] = 'image/jpeg';
      } else {
        body = JSON.stringify(data);
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, { method, headers, body });
    const raw = await response.text();

    let parsedResponse = null;
    try { parsedResponse = JSON.parse(raw); } catch { /* not JSON */ }

    return { code: response.status, response: parsedResponse, raw };
  } catch (error) {
    console.error('[callLineAPI] Error:', error.message);
    return { code: 500, response: null, raw: error.message };
  }
}

// ============================================================
// 🛣️ MAIN HANDLER
//
// ทุกเส้นชี้มาที่  POST/GET /api/richmenu/richmenu?action=xxx
//
//   POST ?action=check-token    { token }
//   POST ?action=verify-token   { token }
//   POST ?action=create-bot     { bot_name, bot_key, channel_token, picture_url, creator_id }
//   GET  ?action=list
//   GET  ?action=sync           &botKey=xxx
//   POST ?action=sync           { botKey, creatorId }
//   GET  ?action=detail         &botKey=xxx&menuId=yyy
//   GET  ?action=switch         &botKey=xxx&menuId=yyy&type=batch
//   POST ?action=delete-menu    { botKey, menuId }
//   POST ?action=create-menu    FormData: { botKey, menuName, chatBarText, menuImage, areas, size, creatorId }
// ============================================================
export default async function handler(req, res) {
  // ----- CORS -----
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const method = req.method;

  console.log(`[richmenu] ${method} ?action=${action}`);

  try {
    if (method === 'GET') {
      if (action === 'list')   return await handleListBots(req, res);
      if (action === 'sync')   return await handleSyncGet(req, res);
      if (action === 'detail') return await handleDetailMenu(req, res);
      if (action === 'switch') return await handleSwitchMenu(req, res);
    }

    if (method === 'POST') {
      if (action === 'check-token')  return await handleCheckToken(req, res);
      if (action === 'verify-token') return await handleVerifyToken(req, res);
      if (action === 'create-bot')   return await handleCreateBot(req, res);
      if (action === 'sync')         return await handleSyncPost(req, res);
      if (action === 'delete-menu')  return await handleDeleteMenu(req, res);
      if (action === 'create-menu')  return await handleCreateMenu(req, res);
    }

    return res.status(400).json({ error: `Unknown action: "${action}" for method ${method}` });

  } catch (error) {
    console.error(`[richmenu] Unhandled error (action=${action}):`, error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// ============================================================
// 1. CHECK TOKEN
//    ตรวจว่า token มีในฐานข้อมูลของเราหรือไม่ (ใช้ตอน login)
//    POST ?action=check-token
//    Body: { token }
// ============================================================
async function handleCheckToken(req, res) {
  const { token } = req.body;

  if (!token?.trim()) {
    return res.status(400).json({ found: false });
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

// ============================================================
// 2. VERIFY TOKEN
//    ตรวจ token กับ LINE โดยตรง (ใช้ก่อนลงทะเบียนบอทใหม่)
//    POST ?action=verify-token
//    Body: { token }
// ============================================================
async function handleVerifyToken(req, res) {
  const { token } = req.body;

  if (!token?.trim()) {
    return res.status(400).json({ message: 'Token is required' });
  }

  const lineRes = await fetch('https://api.line.me/v2/bot/info', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await lineRes.json();

  if (!lineRes.ok) {
    return res.status(400).json({ message: data.message || 'Token ไม่ถูกต้อง' });
  }

  return res.status(200).json({
    name:       data.displayName,
    key:        data.basicId,
    pictureUrl: data.pictureUrl
  });
}

// ============================================================
// 3. CREATE BOT
//    ลงทะเบียนบอทใหม่ลงฐานข้อมูล
//    POST ?action=create-bot
//    Body: { bot_name, bot_key, channel_token, picture_url, creator_id }
// ============================================================
async function handleCreateBot(req, res) {
  const { bot_name, bot_key, channel_token, picture_url, creator_id } = req.body;

  if (!bot_key || !channel_token || !creator_id) {
    return res.status(400).json({ message: 'ข้อมูลไม่ครบ (bot_key, channel_token, creator_id)' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO line_bots
         (bot_name, bot_key, channel_token, picture_url, creator_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, created_at`,
      [bot_name || 'บอทใหม่', bot_key, channel_token, picture_url || null, creator_id]
    );

    return res.status(201).json({
      success: true,
      message: 'เพิ่มบอทสำเร็จ',
      data: {
        id:       result.rows[0].id,
        bot_name: bot_name || 'บอทใหม่'
      }
    });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'LINE ID นี้ถูกใช้ไปแล้ว' });
    }
    return res.status(500).json({ message: 'เกิดข้อผิดพลาดที่ฐานข้อมูล: ' + error.message });
  }
}

// ============================================================
// 4. LIST BOTS
//    ดึงรายชื่อบอททั้งหมด
//    GET ?action=list
// ============================================================
async function handleListBots(req, res) {
  const result = await pool.query(
    `SELECT id, nickname, bot_id FROM bot_config ORDER BY id ASC`
  );

  const bots = result.rows.map((row) => ({
    id:         row.id,
    name:       row.nickname,
    key:        row.bot_id,
    pictureUrl: null
  }));

  return res.status(200).json(bots);
}

// ============================================================
// 5. SYNC GET
//    ดึง Rich Menu จาก LINE + Sync เข้า DB + ส่งข้อมูลกลับ
//    GET ?action=sync&botKey=xxx
// ============================================================
async function handleSyncGet(req, res) {
  const { botKey } = req.query;

  if (!botKey) {
    return res.status(400).json({ error: 'botKey is required' });
  }

  const botRes = await pool.query(
    'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
    [botKey]
  );
  const bot = botRes.rows[0];
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  // ดึงรายการจาก LINE
  const lineRes   = await fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { Authorization: `Bearer ${bot.channel_token}` }
  });
  const lineData  = await lineRes.json();
  const lineMenus = lineData.richmenus || [];

  // ดึง ID ที่มีอยู่ใน DB
  const dbRes     = await pool.query(
    'SELECT rich_menu_id FROM bot_rich_menus WHERE bot_id = $1',
    [bot.id]
  );
  const dbMenuIds = dbRes.rows.map((row) => row.rich_menu_id);

  // Sync: เพิ่มเฉพาะรายการที่หายไป
  for (const menu of lineMenus) {
    if (!dbMenuIds.includes(menu.richMenuId)) {
      await pool.query(
        `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
         VALUES ($1, $2, $3, $4)`,
        [bot.id, menu.richMenuId, menu.name || 'Legacy Menu', 'system']
      );
    }
  }

  // ส่งข้อมูลรวมจาก DB กลับ (มี image_url ที่ LINE ไม่มี)
  const finalResult = await pool.query(
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

  return res.status(200).json({ richmenus: finalResult.rows });
}

// ============================================================
// 6. SYNC POST
//    Sync เมนูจาก LINE เข้า DB (ไม่ส่งรายการกลับ)
//    POST ?action=sync
//    Body: { botKey, creatorId }
// ============================================================
async function handleSyncPost(req, res) {
  const { botKey, creatorId } = req.body;

  if (!botKey) {
    return res.status(400).json({ error: 'botKey is required' });
  }

  const botRes = await pool.query(
    'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
    [botKey]
  );
  if (botRes.rows.length === 0) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลบอทในระบบ' });
  }

  const { id: botId, channel_token: token } = botRes.rows[0];

  const lineRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await lineRes.json();
  if (!lineRes.ok) throw new Error(data.message || 'ดึงข้อมูลจาก LINE ล้มเหลว');

  const menus = data.richmenus || [];

  for (const menu of menus) {
    await pool.query(
      `INSERT INTO bot_rich_menus (bot_id, rich_menu_id, menu_name, creator_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rich_menu_id) DO NOTHING`,
      [botId, menu.richMenuId, menu.name, creatorId || 'system']
    );
  }

  return res.status(200).json({
    success: true,
    message: `Sync สำเร็จ! พบเมนู ${menus.length} รายการ`
  });
}

// ============================================================
// 7. DETAIL MENU
//    ดึงรายละเอียด Rich Menu จาก LINE
//    GET ?action=detail&botKey=xxx&menuId=yyy
// ============================================================
async function handleDetailMenu(req, res) {
  const { botKey, menuId } = req.query;

  if (!botKey || !menuId) {
    return res.status(400).json({ error: 'Missing botKey or menuId' });
  }

  const token = await getBotToken(botKey);
  if (!token) {
    return res.status(404).json({ error: 'Token not found in database' });
  }

  const lineRes = await fetch(`https://api.line.me/v2/bot/richmenu/${menuId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await lineRes.json();

  if (!lineRes.ok) {
    return res.status(lineRes.status).json({ error: data.message || 'LINE API Error' });
  }

  return res.status(200).json(data);
}

// ============================================================
// 8. SWITCH MENU
//    เปลี่ยน Active Rich Menu + อัปเดต DB (Transaction)
//    GET ?action=switch&botKey=xxx&menuId=yyy&type=batch
// ============================================================
async function handleSwitchMenu(req, res) {
  const { botKey, menuId, type } = req.query;

  if (!botKey || !menuId) {
    return res.status(400).json({ error: 'Missing botKey or menuId' });
  }

  const client = await pool.connect();

  try {
    const botRes = await client.query(
      'SELECT id, channel_token FROM line_bots WHERE bot_key = $1',
      [botKey]
    );
    const bot = botRes.rows[0];

    if (!bot?.channel_token) {
      return res.status(404).json({ error: 'Bot token not found' });
    }

    if (type === 'batch') {
      const lineRes = await fetch(
        `https://api.line.me/v2/bot/user/all/richmenu/${menuId}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bot.channel_token}` }
        }
      );

      if (!lineRes.ok) {
        const errorData = await lineRes.json();
        return res.status(lineRes.status).json({
          error: errorData.message || 'Failed to switch menu on LINE API'
        });
      }

      // Transaction: ปิดทุก menu → เปิดเฉพาะ menu ที่เลือก
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

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unsupported switch type' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[handleSwitchMenu] Error:', error);
    return res.status(500).json({ error: error.message });

  } finally {
    client.release();
  }
}

// ============================================================
// 9. DELETE MENU
//    ลบ Rich Menu จาก LINE ก่อน แล้วลบจาก DB
//    POST ?action=delete-menu
//    Body: { botKey, menuId }
// ============================================================
async function handleDeleteMenu(req, res) {
  const { botKey, menuId } = req.body;

  if (!botKey || !menuId) {
    return res.status(400).json({ error: 'botKey and menuId are required' });
  }

  const decodedBotKey = decodeURIComponent(botKey);

  const token = await getBotToken(decodedBotKey);
  if (!token) {
    return res.status(400).json({ error: 'Invalid bot key' });
  }

  const result = await callLineAPI(
    `https://api.line.me/v2/bot/richmenu/${menuId}`,
    'DELETE',
    null,
    token
  );

  if (result.code === 200) {
    await pool.query(
      'DELETE FROM bot_rich_menus WHERE rich_menu_id = $1',
      [menuId]
    );
    return res.status(200).json({ success: true, message: 'Menu deleted successfully' });
  }

  return res.status(result.code || 400).json({
    error: result.response?.message || 'Failed to delete menu'
  });
}

// ============================================================
// 10. CREATE MENU
//     สร้าง Rich Menu ใหม่ (FormData เพราะมีไฟล์รูปภาพ)
//     POST ?action=create-menu
//     FormData: { botKey, menuName, chatBarText, menuImage, areas, size, creatorId }
//
//     STEP 1 → สร้างโครงสร้าง → ได้ richMenuId
//     STEP 2 → อัปโหลดรูป
//     STEP 3 → บันทึก DB
//     (ล้มเหลวที่ STEP ใด → Rollback ลบ menu จาก LINE)
// ============================================================
async function handleCreateMenu(req, res) {
  const formData = await req.formData?.();
  const get = (key) => formData ? formData.get(key) : req.body?.[key];

  let botKey        = get('botKey');
  const menuName    = get('menuName');
  const chatBarText = get('chatBarText') || 'เมนูหลัก';
  const menuImage   = get('menuImage');
  const creatorId   = get('creatorId') || 'system';
  const areasString = get('areas');
  const sizeString  = get('size');

  if (!botKey)      return res.status(400).json({ error: 'botKey is required' });
  if (!menuImage)   return res.status(400).json({ error: 'Menu image is required' });
  if (!areasString) return res.status(400).json({ error: 'Menu areas are required' });

  botKey = decodeURIComponent(botKey);

  const areas = JSON.parse(areasString);
  const size  = sizeString ? JSON.parse(sizeString) : { width: 2500, height: 843 };

  if (!areas?.length) {
    return res.status(400).json({ error: 'Menu areas cannot be empty' });
  }

  const token = await getBotToken(botKey);
  if (!token) {
    return res.status(400).json({ error: `Bot token not found for botKey: ${botKey}` });
  }

  const richMenuData = {
    size,
    selected:    true,
    name:        menuName || `Menu_${Date.now()}`,
    chatBarText,
    areas
  };

  // ── STEP 1 ──────────────────────────────────────────────────
  console.log('[handleCreateMenu] STEP 1: Creating Rich Menu structure...');
  const step1 = await callLineAPI(
    'https://api.line.me/v2/bot/richmenu', 'POST', richMenuData, token
  );

  if (step1.code !== 200 || !step1.response?.richMenuId) {
    return res.status(400).json({
      error:      'Failed to create menu structure',
      details:    step1.response?.message || 'Unknown error',
      statusCode: step1.code
    });
  }

  const richMenuId = step1.response.richMenuId;
  console.log('[handleCreateMenu] STEP 1 SUCCESS — richMenuId:', richMenuId);

  // ── STEP 2 ──────────────────────────────────────────────────
  console.log('[handleCreateMenu] STEP 2: Uploading image...');
  const imageBuffer = Buffer.from(await menuImage.arrayBuffer());
  const step2 = await callLineAPI(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    'POST', imageBuffer, token, true
  );

  if (step2.code !== 200) {
    await callLineAPI(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, 'DELETE', null, token);
    return res.status(400).json({
      error:   'Failed to upload image',
      details: step2.response?.message || 'Image upload failed'
    });
  }

  console.log('[handleCreateMenu] STEP 2 SUCCESS — image uploaded');

  // ── STEP 3 ──────────────────────────────────────────────────
  console.log('[handleCreateMenu] STEP 3: Saving to database...');
  try {
    const botResult = await pool.query(
      'SELECT id FROM line_bots WHERE bot_key = $1', [botKey]
    );

    if (botResult.rows.length === 0) {
      await callLineAPI(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, 'DELETE', null, token);
      return res.status(400).json({ error: 'Bot not found in database' });
    }

    const botId    = botResult.rows[0].id;
    const imageUrl = `/api/richmenu-image/${richMenuId}?botKey=${encodeURIComponent(botKey)}`;

    await pool.query(
      `INSERT INTO bot_rich_menus
         (bot_id, rich_menu_id, menu_name, image_url, is_active, creator_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [botId, richMenuId, menuName || `Menu_${Date.now()}`, imageUrl, false, creatorId]
    );

    console.log('[handleCreateMenu] STEP 3 SUCCESS — saved to database');

  } catch (dbError) {
    await callLineAPI(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, 'DELETE', null, token);
    return res.status(500).json({
      error:   'Failed to save to database',
      details: dbError.message
    });
  }

  return res.status(200).json({
    success:   true,
    richMenuId,
    message:   `Menu "${menuName}" created successfully. Go to "เปลี่ยน Rich Menu" to activate it.`
  });
}
