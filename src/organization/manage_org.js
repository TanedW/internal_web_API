// api/manage_org.js

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
// Helper Function: บันทึก Log ภายในระบบ
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

export default async function handler(req, res) {
  const { id: group_id_raw } = req.query; 
  let group_id = group_id_raw ? group_id_raw.replace(/[^a-zA-Z0-9-]/g, '') : null;

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  if (!group_id) {
    return res.status(400).json({ message: 'Group ID is required' });
  }

  // ----------------------------------------------------------------------
  // CASE: DELETE (Soft Delete)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id, description } = req.body;
      if (!description || description.trim() === "") {
        return res.status(400).json({ message: 'Description is required for deletion' });
      }

      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      // ดึงข้อมูลเดิมก่อนลบเพื่อทำ Log
      const { rows: oldData } = await query('SELECT name, deleted_at FROM voice_fonduegroup WHERE id = $1', [group_id]);
      if (oldData.length === 0) return res.status(404).json({ message: 'Not found' });

      const { rows: deletedGroup } = await query(`
        UPDATE voice_fonduegroup
        SET deleted_at = NOW(), updated_on = NOW()
        WHERE id = $1
        RETURNING id, name, deleted_at;
      `, [group_id]);

      // --- External Log (DELETE) ---
      await sendExternalLog({
        actor_id: String(actorAdmin.admin_id),
        actor_type: "ADMIN",
        actor_name: `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim(),
        source_channel: "Internal Portal",
        target_id: String(group_id),
        action: "GROUP_SOFT_DELETE",
        reason: description,
        payload: {
          actions_performed: ["soft_delete"],
          status_changes: {
            deleted_at: {
              old_value: oldData[0].deleted_at,
              new_value: deletedGroup[0].deleted_at
            }
          },
          group_name: deletedGroup[0].name
        },
        client_ip: ipAddress,
        user_agent: userAgent
      });

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'GROUP_DELETE', status: 'SUCCESS', ipAddress, userAgent,
        details: { group_id, action: "soft_delete", description, group_name: deletedGroup[0].name }
      });

      return res.status(200).json({ success: true, data: deletedGroup[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: PUT (Update & Restore)
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    try {
      const { 
        current_admin_id, name, file_url, description, 
        official_group, download_csv, restore,
        old_name, old_url, old_official, old_download, old_deleted_at
      } = req.body;

      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      let actions = [];
      let status_changes = {};
      let logActionType = restore ? "GROUP_RESTORE" : "GROUP_UPDATE_INFO";

      if (restore === true) {
          if (!description || description.trim() === "") {
            return res.status(400).json({ message: 'Description is required for restoration' });
          }
          actions.push("restore");
          status_changes.deleted_at = {
              old_value: old_deleted_at || "previously_deleted",
              new_value: null
          };
      } else {
          if (name && name !== old_name) {
              actions.push(`change name`);
              status_changes.name = { old_value: old_name, new_value: name };
          }
          if (file_url && file_url !== old_url) {
              actions.push(`change photo`);
              status_changes.photo = { old_value: old_url, new_value: file_url };
          }
          if (typeof official_group !== 'undefined' && official_group !== old_official) {
              actions.push(`switch official`);
              status_changes.official_group = { old_status: old_official, new_status: official_group };
          }
          if (typeof download_csv !== 'undefined' && download_csv !== old_download) {
              actions.push(`switch download_csv`);
              status_changes.download_csv = { old_status: old_download, new_status: download_csv };
          }
      }

      const { rows: updatedGroup } = await query(`
        UPDATE voice_fonduegroup
        SET 
          name = COALESCE($1, name),
          photo = COALESCE($2, photo),
          official_group = CASE WHEN ($3::boolean) IS NULL THEN official_group ELSE $3::boolean END,
          download_csv = CASE WHEN ($4::boolean) IS NULL THEN download_csv ELSE $4::boolean END,
          deleted_at = CASE WHEN $5::boolean = true THEN NULL ELSE deleted_at END,
          updated_on = NOW()
        WHERE id = $6
        RETURNING id, name, photo, official_group, download_csv, deleted_at, updated_on;
      `, [
        name || null, file_url || null, 
        typeof official_group !== 'undefined' ? official_group : null,
        typeof download_csv !== 'undefined' ? download_csv : null,
        restore || false, group_id
      ]);

      if (updatedGroup.length === 0) return res.status(404).json({ message: 'Group not found' });

      // --- External Log (PUT) ---
      await sendExternalLog({
        actor_id: String(actorAdmin.admin_id),
        actor_type: "ADMIN",
        actor_name: `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim(),
        source_channel: "Internal Portal",
        target_id: String(group_id),
        action: logActionType,
        reason: description || null,
        payload: {
          actions_performed: actions,
          status_changes: status_changes,
          updated_data: updatedGroup[0]
        },
        client_ip: ipAddress,
        user_agent: userAgent
      });

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: restore ? 'GROUP_RESTORE' : 'GROUP_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { group_id, action: actions.join(", "), status_changes, description }
      });

      return res.status(200).json({ success: true, data: updatedGroup[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ message: 'Method not allowed' });
}