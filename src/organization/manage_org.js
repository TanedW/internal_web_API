// api/manage_org.js

import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

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
  'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id: group_id_raw } = req.query; 
  let group_id = group_id_raw ? group_id_raw.replace(/[^a-zA-Z0-9-]/g, '') : null;

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  if (!group_id) {
    return res.status(400).json({ message: 'Group ID is required' });
  }

  // ----------------------------------------------------------------------
  // CASE: SOFT DELETE (DELETE Method)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id, description } = req.body;

      if (!description || description.trim() === "") {
        return res.status(400).json({ message: 'Description is required for deletion' });
      }

      // [UNIFIED] 1. ตรวจสอบ Admin
      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      // [UNIFIED] 2. Update ข้อมูลใน DB
      const { rows: deletedGroup } = await query(`
        UPDATE voice_fonduegroup
        SET deleted_at = NOW(), updated_on = NOW()
        WHERE id = $1
        RETURNING id, name, deleted_at;
      `, [group_id]);

      if (deletedGroup.length === 0) return res.status(404).json({ message: 'Not found' });

      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'GROUP_DELETE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: { 
            target: 'voice_fonduegroup', 
            group_id, 
            action: 'soft_delete', 
            description: description 
        }
      });

      return res.status(200).json({ success: true, data: deletedGroup[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: UPDATE & RESTORE (PUT Method)
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    try {
      const { 
        current_admin_id, 
        name, 
        file_url, 
        description, 
        official_group, 
        download_csv,
        restore,
        old_name,
        old_url,
        old_official,
        old_download
      } = req.body;

      if (restore === true && (!description || description.trim() === "")) {
        return res.status(400).json({ message: 'Description is required for restoration' });
      }

      // [UNIFIED] 1. ตรวจสอบ Admin
      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      let logDetails = { 
          target: 'voice_fonduegroup',
          group_id: group_id,
          description: description || "ปรับปรุงข้อมูล"
      };

      let actions = [];

      if (restore === true) {
          actions.push("restore");
      } else {
          if (typeof official_group !== 'undefined' && official_group !== old_official) {
              actions.push(`switch official from ${old_official} to ${official_group}`);
          }
          if (typeof download_csv !== 'undefined' && download_csv !== old_download) {
              actions.push(`switch download_csv from ${old_download} to ${download_csv}`);
          }
          if (name && name !== old_name) {
              actions.push(`change name`);
              logDetails.old_name = old_name;
              logDetails.new_name = name;
          }
          if (file_url && file_url !== old_url) {
              actions.push(`change photo`);
              logDetails.old_url = old_url;
              logDetails.new_url = file_url;
          }
      }

      logDetails.action = actions.length > 0 ? actions.join(", ") : "update_info";

      // [UNIFIED] 2. Update ข้อมูลใน DB
      const { rows: updatedGroup } = await query(`
        UPDATE voice_fonduegroup
        SET 
          name = COALESCE($1, name),
          photo = COALESCE($2, photo),
          -- เพิ่ม ::boolean เพื่อระบุประเภทข้อมูลที่แน่นอน
          official_group = CASE WHEN ($3::boolean) IS NULL THEN official_group ELSE $3::boolean END,
          download_csv = CASE WHEN ($4::boolean) IS NULL THEN download_csv ELSE $4::boolean END,
          deleted_at = CASE WHEN $5::boolean = true THEN NULL ELSE deleted_at END,
          updated_on = NOW()
        WHERE id = $6
        RETURNING id, name, photo, official_group, download_csv, deleted_at, updated_on;
      `, [
        name || null, 
        file_url || null, 
        typeof official_group !== 'undefined' ? official_group : null,
        typeof download_csv !== 'undefined' ? download_csv : null,
        restore || false,
        group_id
      ]);

      if (updatedGroup.length === 0) return res.status(404).json({ message: 'Group not found' });

      await saveAdminLog({
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: restore ? 'GROUP_RESTORE' : 'GROUP_UPDATE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: logDetails
      });

      return res.status(200).json({ 
        success: true, 
        data: updatedGroup[0]
      });

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ message: 'Method not allowed' });
}
