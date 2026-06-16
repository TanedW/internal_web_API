import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

// --- Helper Functions ---
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

async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog({
    adminId, email, firstName: first_name, lastName: last_name,
    actionType: action_type, status, ipAddress, userAgent, details
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

export default async function handler(req, res) {
  const { id: case_id_raw } = req.query;
  let case_id = case_id_raw ? case_id_raw.replace(/[^a-zA-Z0-9-]/g, '') : null;
  
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || null;

  if (req.method === 'PUT') {
    try {
      const { 
        current_admin_id, 
        photo_id, 
        file_url, 
        viewed,      
        is_hidden, 
        is_cover,
        description // 🟢 1. รับค่าเหตุผลการแก้ไข (description) จาก Frontend
      } = req.body;

      if (!current_admin_id || !photo_id) {
        return res.status(400).json({ message: 'Missing required fields' });
      }

      // 1. ดึงข้อมูลปัจจุบันเพื่อเปรียบเทียบและทำ Log
      const [adminRes, currentData] = await Promise.all([
        query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]),
        query(`
          SELECT a.photo, a.note, a.is_hidden, a.is_cover, a.viewed, m.ticket_id 
          FROM voice_attachment a
          JOIN voice_message_photos mp ON a.id = mp.attachment_id
          JOIN voice_message m ON mp.message_id = m.id
          WHERE a.id = $1 AND m.id = $2
        `, [photo_id, case_id])
      ]);

      if (adminRes.rows.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      if (currentData.rows.length === 0) return res.status(404).json({ message: 'Photo not found in this case' });

      const oldData = currentData.rows[0];
      const actorAdmin = adminRes.rows[0];

      // 2. จัดการเรื่องหน้าปก (Cover)
      if (is_cover === true) {
        await query(`
          UPDATE voice_attachment SET is_cover = false
          WHERE id IN (SELECT attachment_id FROM voice_message_photos WHERE message_id = $1)
        `, [case_id]);
      }

      // 3. UPDATE ข้อมูลลง Database
      const { rows: updatedAttachment } = await query(`
        UPDATE voice_attachment
        SET 
          photo = COALESCE($1, photo),
          viewed = COALESCE($2, viewed),
          is_hidden = COALESCE($3, is_hidden),
          is_cover = COALESCE($4, is_cover)
        WHERE id = $5
        RETURNING id, photo, viewed, is_hidden, is_cover, note, updated_on;
      `, [
        file_url !== undefined ? file_url : null,
        viewed !== undefined ? viewed : null,
        is_hidden !== undefined ? is_hidden : null,
        is_cover !== undefined ? is_cover : null,
        photo_id
      ]);

      // --- Identify Changes for Logging ---
      let actions = [];
      let status_changes = {};

      if (file_url !== undefined && file_url !== oldData.photo) {
        actions.push('change photo');
        status_changes.photo = { old_value: oldData.photo, new_value: file_url };
      }
      if (viewed !== undefined && viewed !== oldData.viewed) {
        actions.push('change viewed status');
        status_changes.viewed = { old_value: oldData.viewed, new_value: viewed };
      }
      if (is_hidden !== undefined && is_hidden !== oldData.is_hidden) {
        actions.push('change hidden status');
        // 🟢 ปรับโครงสร้าง key ย่อยให้เป็น old_value และ new_value เหมือนกันทุกอันเพื่อให้ Frontend แกะง่าย
        status_changes.is_hidden = { old_value: oldData.is_hidden, new_value: is_hidden };
      }
      if (is_cover !== undefined && is_cover !== oldData.is_cover) {
        actions.push('change cover status');
        status_changes.is_cover = { old_value: oldData.is_cover, new_value: is_cover };
      }

      // 4. External Log (ส่งข้อมูลเข้าสู่ตารางฐานข้อมูลกลาง)
      await sendExternalLog({
        actor_id: String(actorAdmin.admin_id),
        actor_type: "ADMIN",
        actor_name: `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim(),
        source_channel: "Internal Portal",
        target_id: String(oldData.ticket_id),
        action: 'CASE_UPDATE_INFO',
        reason: description || null, // 🟢 2. เพิ่มฟิลด์ reason ระดับบนสุด (สอดคล้องกับหน้า manage-org)
        payload: {
          attachment_id: photo_id,
          actions_performed: actions,
          status_changes: status_changes,
          updated_data: updatedAttachment[0],
          description: description || null, // 🟢 3. คงค่า description ไว้ใน payload เพื่อความปลอดภัย
          context_info: {
            note: oldData.note,
            // 🟢 4. แนบรูปภาพพิกัดเดิม/ใหม่เข้าไปเสริมในกรณีซ่อนภาพหรือปรับหน้าปก
            photo_url: updatedAttachment[0].photo 
          }
        },
        client_ip: ipAddress,
        user_agent: userAgent
      });

      // 5. Internal Audit Log
      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email,
        first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'UPDATE_ATTACHMENT', status: 'SUCCESS', ipAddress, userAgent,
        details: { 
          case_id, 
          photo_id, 
          action: actions.join(", "), 
          status_changes,
          reason: description || null // 🟢 5. แนบเข้า Internal Log ด้วย
        }
      });

      return res.status(200).json({ success: true, data: updatedAttachment[0] });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Internal Server Error' });
    }
  }
  return res.status(405).json({ message: 'Method Not Allowed' });
}