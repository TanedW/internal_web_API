// api/manage_case.js

import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';
//
// ----------------------------------------------------------------------
// Helper Function: บันทึก Log
// ----------------------------------------------------------------------
async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog({
    adminId,
    email,
    firstName: first_name,
    lastName: last_name,
    actionType: action_type,
    status,
    ipAddress,
    userAgent,
    details
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id: case_id_raw } = req.query;
  let case_id = case_id_raw ? case_id_raw.replace(/[^a-zA-Z0-9-]/g, '') : null;

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  if (!case_id) {
    return res.status(400).json({ message: 'Case ID is required' });
  }

  try {
    const { current_admin_id, photo_id, file_url, description, viewed, old_url } = req.body;
    
    if (!current_admin_id || !photo_id || !file_url) {
         return res.status(400).json({ message: 'Missing required fields' });
    }

    const cleanPhotoId = photo_id.toString().replace(/[^a-zA-Z0-9-]/g, '');

    // [UNIFIED] 1. ตรวจสอบ Admin จาก DB
    const { rows: actors } = await query(`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        WHERE admin_id = $1
    `, [current_admin_id]);

    if (actors.length === 0) {
        return res.status(403).json({ message: 'Unauthorized: Admin not found' });
    }
    const actorAdmin = actors[0];

    // [UNIFIED] 2. Update ข้อมูลใน DB
    const { rows: updatedMedia } = await query(`
        UPDATE voice_attachment
        SET 
            photo = $1,
            viewed = $2, 
            updated_on = NOW()
        WHERE id = $3  
        AND id IN (
            SELECT attachment_id 
            FROM voice_message_photos 
            WHERE message_id = $4
        )
        RETURNING id, photo, updated_on;
    `, [file_url, viewed, cleanPhotoId, case_id]);

    if (updatedMedia.length === 0) {
        await saveAdminLog({
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'CASE_MEDIA_UPDATE',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { 
                reason: 'Photo ID not found or mismatch case',
                case_id: case_id, 
                attachment_id: cleanPhotoId
            }
        });

        return res.status(404).json({ 
            message: 'Update failed. Photo ID not found or mismatch.' 
        });
    }

    // 3. Save Success Log
    await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'CASE_MEDIA_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'voice_attachment',
            case_id: case_id, 
            attachment_id: cleanPhotoId,
            new_url: file_url,
            new_type_code: viewed,
            old_url: old_url || null,
            description: description || "No reason provided"
        }
    });

    return res.status(200).json({ 
        success: true, 
        data: updatedMedia[0]
    });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
