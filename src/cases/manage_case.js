import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

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
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  if (!case_id) return res.status(400).json({ message: 'Case ID is required' });

  try {
    const { 
      current_admin_id, photo_id, file_url, description, 
      viewed, old_url, is_hidden, is_cover 
    } = req.body;

    if (!current_admin_id) return res.status(400).json({ message: 'Admin ID is required' });

    const { rows: actors } = await query(`
        SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1
    `, [current_admin_id]);

    if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
    const actorAdmin = actors[0];

    // --- METHOD: POST ---
    if (req.method === 'POST') {
      if (!file_url) return res.status(400).json({ message: 'Missing file_url' });

      const { rows: newAttachment } = await query(`
          INSERT INTO voice_attachment (photo, viewed, note, updated_on, status, is_hidden, is_cover)
          VALUES ($1, $2, $3, NOW(), 'active', $4, $5) RETURNING id, photo;
      `, [file_url, viewed || 0, description || null, is_hidden || false, is_cover || false]);

      await query(`INSERT INTO voice_message_photos (message_id, attachment_id) VALUES ($1, $2);`, [case_id, newAttachment[0].id]);
      
      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'CREATE_ATTACHMENT', status: 'SUCCESS', ipAddress, userAgent,
        details: { case_id, attachment_id: newAttachment[0].id, url: file_url, is_cover }
      });

      return res.status(201).json({ success: true, data: newAttachment[0] });
    }

    // --- METHOD: PUT ---
    if (req.method === 'PUT') {
      if (!photo_id) return res.status(400).json({ message: 'Missing photo_id' });
      const cleanPhotoId = photo_id.toString().replace(/[^a-zA-Z0-9-]/g, '');

      // STEP A: ถ้าจะตั้งรูปนี้เป็น Cover ให้ Reset รูปอื่นในเคสนี้ก่อน
      if (is_cover === true) {
        await query(`
          UPDATE voice_attachment
          SET is_cover = false
          WHERE id IN (SELECT attachment_id FROM voice_message_photos WHERE message_id = $1)
        `, [case_id]);
      }

      // STEP B: อัปเดตข้อมูลรูปปัจจุบัน
      const { rows: updatedMedia } = await query(`
          UPDATE voice_attachment
          SET 
            photo = COALESCE($1, photo), 
            viewed = COALESCE($2, viewed),
            note = COALESCE($3, note),
            is_hidden = COALESCE($4, is_hidden),
            is_cover = COALESCE($5, is_cover),
            updated_on = NOW()
          WHERE id = $6  
          AND id IN (SELECT attachment_id FROM voice_message_photos WHERE message_id = $7)
          RETURNING id, photo, viewed, note, is_hidden, is_cover, updated_on;
      `, [
        file_url || null, viewed !== undefined ? viewed : null, description || null,
        is_hidden !== undefined ? is_hidden : null, is_cover !== undefined ? is_cover : null,
        cleanPhotoId, case_id
      ]);

      if (updatedMedia.length === 0) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id, 
          email: actorAdmin.email, 
          first_name: actorAdmin.first_name, 
          last_name: actorAdmin.last_name,
          action_type: 'CASE_MEDIA_UPDATE', 
          status: 'FAILED', ipAddress, 
          userAgent,
          details: { reason: 'Not found', case_id, attachment_id: cleanPhotoId }
        });
        return res.status(404).json({ message: 'Update failed' });
      }

      await saveAdminLog({
        adminId: actorAdmin.admin_id, 
        email: actorAdmin.email, 
        first_name: actorAdmin.first_name, 
        last_name: actorAdmin.last_name,
        action_type: 'CASE_MEDIA_UPDATE', 
        status: 'SUCCESS', 
        ipAddress, 
        userAgent,
        details: { case_id, attachment_id: cleanPhotoId, new_data: { is_hidden, is_cover }, old_url }
      });

      return res.status(200).json({ success: true, data: updatedMedia[0] });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}