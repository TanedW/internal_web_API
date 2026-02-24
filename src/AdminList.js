// api/AdminList.js
import { Permit } from "permitio";
import * as db from './lib/db.js'; 
import { writeAuditLog } from './lib/logging.js';

const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY, 
});

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
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end(); 
  }

  const { id, requester_id } = req.query; 
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // GET: ดึงข้อมูล Admin พร้อม Roles ทั้งหมด
    if (req.method === 'GET') {
      const [canDelete, dbResult] = await Promise.all([
        requester_id 
          ? permit.check(String(requester_id), "delete", { type: "Admin_Users", tenant: "default" }).catch(() => false)
          : Promise.resolve(false),
        db.query(`SELECT admin_id, email, first_name, last_name, profile_url FROM admin_system WHERE is_deleted = false ORDER BY join_at DESC;`)
      ]);

      const { rows: admins } = dbResult;

      const adminsWithRoles = await Promise.all(admins.map(async (admin) => {
        try {
            const assignedRoles = await permit.api.users.getAssignedRoles({ 
                user: String(admin.admin_id), 
                tenant: "default" 
            });
            return {
                ...admin,
                roles: assignedRoles.length > 0 ? assignedRoles.map(r => r.role) : ['editor'] 
            };
        } catch (error) {
            return { ...admin, roles: ['editor'] }; 
        }
      }));

      return res.status(200).json({ data: adminsWithRoles, meta: { can_delete: canDelete } });
    }

    const body = req.body || {};
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        if (current_admin_id) {
            const { rows: actors } = await db.query('SELECT * FROM admin_system WHERE admin_id = $1', [current_admin_id]);
            if (actors.length > 0) actorAdmin = actors[0];
        }
    }

    // POST: จัดการ Multi-role (Add / Reactivate / Update Roles)
    if (req.method === 'POST') {
      const { email, roles } = body; // รับ roles เป็น Array จาก page.jsx
      if (!email || !Array.isArray(roles)) {
          return res.status(400).json({ message: 'Email and roles array are required' });
      }

      // กรองเฉพาะ Role ที่อนุญาต
      const validRolesList = [
        'admin', 
        'editor', 
        'editor_manage_case', 
        'editor_manage_menu', 
        'editor_manage_flex', 
        'editor_search_org_info', 
        'editor_file_search', 
        'editor_search_duplicate_org', 
        'editor_manage_user'
      ];
      const assignedRoles = roles.filter(r => validRolesList.includes(r.toLowerCase()));
      if (assignedRoles.length === 0) assignedRoles.push('editor');

      const { rows: existing } = await db.query('SELECT * FROM admin_system WHERE email = $1 LIMIT 1', [email]);
      
      let targetUser;
      let actionStatus = 'ADMIN_ADD';

      if (existing.length > 0) {
        targetUser = existing[0];
        if (targetUser.is_deleted) {
          const { rows: updated } = await db.query(`UPDATE admin_system SET is_deleted = false WHERE email = $1 RETURNING *;`, [email]);
          targetUser = updated[0];
          actionStatus = 'ADMIN_REACTIVATE';
        } else {
          actionStatus = 'ADMIN_UPDATE_ROLE';
        }
      } else {
        const { rows: inserted } = await db.query(`INSERT INTO admin_system (email) VALUES ($1) RETURNING *;`, [email]);
        targetUser = inserted[0];
        actionStatus = 'ADMIN_CREATE_NEW';
      }

      // --- Sync กับ Permit.io สำหรับ Multi-role ---
      try {
        await permit.api.users.sync({
          key: String(targetUser.admin_id),
          email: targetUser.email,
          first_name: targetUser.first_name || "",
          last_name: targetUser.last_name || ""
        });

        // 1. ดึงบทบาทปัจจุบันใน Permit ออกมา
        const currentAssigned = await permit.api.users.getAssignedRoles({ 
            user: String(targetUser.admin_id), 
            tenant: "default" 
        });
        const currentRoleKeys = currentAssigned.map(r => r.role);

        // 2. ลบบทบาทที่ไม่ได้อยู่ใน List ใหม่ (กรณี Update)
        for (const oldRole of currentRoleKeys) {
            if (!assignedRoles.includes(oldRole)) {
                await permit.api.users.unassignRole({
                    user: String(targetUser.admin_id),
                    role: oldRole,
                    tenant: "default"
                });
            }
        }

        // 3. เพิ่มบทบาทใหม่ที่ยังไม่มี
        for (const newRole of assignedRoles) {
            if (!currentRoleKeys.includes(newRole)) {
                await permit.api.users.assignRole({
                    user: String(targetUser.admin_id),
                    role: newRole,
                    tenant: "default"
                });
            }
        }
      } catch (e) {
        console.error("Permit Multi-role Sync Error:", e);
      }

      if (actorAdmin) {
          await saveAdminLog({
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: actionStatus, status: 'SUCCESS', ipAddress, userAgent,
            details: { target_id: targetUser.admin_id, assigned_roles: assignedRoles }
          });
      }

      return res.status(200).json({ ...targetUser, roles: assignedRoles });
    }

    // DELETE (Soft Delete)
    if (req.method === 'DELETE') {
        if (!id || !actorAdmin) return res.status(400).json({ message: 'Invalid Request' });

        const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");
        if (!isPermitted) return res.status(403).json({ message: 'Forbidden' });

        const { rows: deletedUser } = await db.query(`UPDATE admin_system SET is_deleted = true WHERE admin_id = $1 RETURNING *;`, [id]);
        if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });

        try { await permit.api.users.delete(String(id)); } catch(e) {}

        await saveAdminLog({
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_DELETE_SOFT', status: 'SUCCESS', ipAddress, userAgent,
            details: { deleted_id: id }
        });

        return res.status(200).json({ message: 'User deactivated' });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}