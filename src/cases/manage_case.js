import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

// ----------------------------------------------------------------------
// Helper Function: ส่ง Log ไปยัง External API
// ----------------------------------------------------------------------
async function sendExternalLog(logData) {
  try {
    const response = await fetch(process.env.LOGING_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LOGING_JWT_TOKEN}`
      },
      body: JSON.stringify(logData)
    });
    if (!response.ok) {
      console.error('Failed to send external log:', await response.text());
    }
  } catch (error) {
    console.error('External Logging API Error:', error);
  }
}

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log ภายในระบบ (Audit Log)
// ----------------------------------------------------------------------
async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog({
    adminId, email, firstName: first_name, lastName: last_name,
    actionType: action_type, status, ipAddress, userAgent, details
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).set(corsHeaders).end();

  const { id: case_id_raw } = req.query;
  let case_id = case_id_raw ? case_id_raw.replace(/[^a-zA-Z0-9-]/g, '') : null;
  
  // ดึง IP Address (รองรับ X-Forwarded-For สำหรับ Proxy/Load Balancer)
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded 
    ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) 
    : req.socket.remoteAddress || '127.0.0.1';
    
  const userAgent = req.headers['user-agent'] || null;

  if (!case_id) return res.status(400).json({ message: 'Case ID is required' });

  try {
    const { 
      current_admin_id, photo_id, file_url, description, 
      viewed, is_hidden, is_cover,
      old_is_hidden, old_is_cover 
    } = req.body;

    if (!current_admin_id) return res.status(400).json({ message: 'Admin ID is required' });

    // 1. ดึงข้อมูล Admin และ ticket_id จากตาราง voice_message พร้อมกัน
    const [adminRes, caseRes] = await Promise.all([
      query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]),
      query('SELECT ticket_id FROM voice_message WHERE id = $1', [case_id])
    ]);

    if (adminRes.rows.length === 0) return res.status(403).json({ message: 'Unauthorized' });
    if (caseRes.rows.length === 0) return res.status(404).json({ message: 'Case not found' });

    const actorAdmin = adminRes.rows[0];
    const actorName = `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim();
    const ticketId = caseRes.rows[0].ticket_id; // ใช้ตัวนี้เป็น target_id ใน External Log

    // --- METHOD: POST (อัปโหลดรูปใหม่เพื่อ "แทนที่" รูปเดิม) ---
// --- ในไฟล์ manage_case.js (ส่วน POST) ---
if (req.method === 'POST') {
  const { current_admin_id, old_photo_id, file_url, description, is_cover } = req.body;

  // 1. ดึง ticket_id เพื่อทำ Log
  const [adminRes, caseRes] = await Promise.all([
    query('SELECT admin_id, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]),
    query('SELECT ticket_id FROM voice_message WHERE id = $1', [case_id])
  ]);

  const ticketId = caseRes.rows[0]?.ticket_id;

  // STEP 1: แทนที่รูปเก่า (ถ้ามี old_photo_id ส่งมา)
  if (old_photo_id) {
    await query(`
      UPDATE voice_attachment 
      SET status = 'inactive', updated_on = NOW() 
      WHERE id = $1
    `, [old_photo_id]);
  }

  // STEP 2: เพิ่มรูปใหม่เข้าไปเป็น 'active'
  const { rows: newAttachment } = await query(`
    INSERT INTO voice_attachment (photo, status, note, updated_on, is_cover)
    VALUES ($1, 'active', $2, NOW(), $3) RETURNING id, photo;
  `, [file_url, description, is_cover || false]);

  // STEP 3: ผูกรูปใหม่กับ Case เดิม
  await query(`INSERT INTO voice_message_photos (message_id, attachment_id) VALUES ($1, $2)`, [case_id, newAttachment[0].id]);

  // ส่ง External Log (target_id = ticket_id)
  sendExternalLog({
    actor_id: String(current_admin_id),
    target_id: String(ticketId),
    action: "UPDATE_PICTURE_INFO_CASE",
    payload: { old_id: old_photo_id, new_id: newAttachment[0].id, url: file_url }
    // ... ค่าอื่นๆ ตาม format
  });

  return res.status(201).json({ success: true, data: newAttachment[0] });
}

    // --- METHOD: PUT (Update Info / Cover / Hidden / Reactive) ---
    if (req.method === 'PUT') {
      if (!photo_id) return res.status(400).json({ message: 'Missing photo_id' });
      const cleanPhotoId = photo_id.toString().replace(/[^a-zA-Z0-9-]/g, '');

      // แยก Action Type ตามการเปลี่ยนแปลง
      let actionType = 'UPDATE_PICTURE_INFO_CASE';
      let actions_performed = [];

      if (is_cover === true && old_is_cover !== true) {
        actionType = 'UPDATE_COVER_PICTURE_CASE';
        actions_performed.push('set_as_cover');
      } else if (is_hidden === true && old_is_hidden !== true) {
        actionType = 'HIDDEN_PICTURE_CASE';
        actions_performed.push('hide_picture');
      } else if (is_hidden === false && old_is_hidden === true) {
        actionType = 'REACTIVE_PICTURE_CASE';
        actions_performed.push('unhide_picture');
      }

      // Reset cover อื่นๆ ถ้ามีการตั้งรูปใหม่เป็น cover
      if (is_cover === true) {
        await query(`
          UPDATE voice_attachment SET is_cover = false
          WHERE id IN (SELECT attachment_id FROM voice_message_photos WHERE message_id = $1)
        `, [case_id]);
      }

      const { rows: updatedMedia } = await query(`
          UPDATE voice_attachment
          SET 
            photo = COALESCE($1, photo), viewed = COALESCE($2, viewed),
            note = COALESCE($3, note), is_hidden = COALESCE($4, is_hidden),
            is_cover = COALESCE($5, is_cover), updated_on = NOW()
          WHERE id = $6 AND id IN (SELECT attachment_id FROM voice_message_photos WHERE message_id = $7)
          RETURNING id, photo, is_hidden, is_cover;
      `, [file_url || null, viewed, description, is_hidden, is_cover, cleanPhotoId, case_id]);

      if (updatedMedia.length === 0) {
        return res.status(404).json({ message: 'Update failed' });
      }

      // External Log: ใช้ ticketId เป็น target_id
      sendExternalLog({
        actor_id: String(actorAdmin.admin_id),
        actor_type: "ADMIN",
        actor_name: actorName,
        source_channel: "Internal Portal",
        target_id: String(ticketId), 
        action: actionType,
        reason: description || "No reason provided",
        payload: {
          attachment_id: cleanPhotoId,
          actions_performed,
          status_changes: {
            is_hidden: { old: old_is_hidden, new: is_hidden },
            is_cover: { old: old_is_cover, new: is_cover }
          },
          internal_case_uuid: case_id
        },
        client_ip: ipAddress,
        user_agent: userAgent
      });

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: actionType, status: 'SUCCESS', ipAddress, userAgent,
        details: { case_id, ticket_id: ticketId, attachment_id: cleanPhotoId }
      });

      return res.status(200).json({ success: true, data: updatedMedia[0] });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}