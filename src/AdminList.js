// api/AdminList.js
import { Permit } from "permitio";
import * as db from './lib/db.js'; 
import { writeAuditLog } from './lib/logging.js';

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY, 
});

// Helper: บันทึก Log
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
  // CORS Configuration
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
    // =================================================================
    // GET: ดึงข้อมูล + ดึง Roles (Array) จาก Permit
    // =================================================================
    if (req.method === 'GET') {
      const [canDelete, dbResult] = await Promise.all([
        requester_id 
          ? permit.check(String(requester_id), "delete", { type: "Admin_Users", tenant: "default" }).catch(() => false)
          : Promise.resolve(false),
        db.query(`
          SELECT admin_id, email, first_name, last_name, profile_url
          FROM admin_system 
          WHERE is_deleted = false
          ORDER BY join_at DESC;
        `)
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

      return res.status(200).json({
        data: adminsWithRoles, 
        meta: { can_delete: canDelete }
      });
    }

    // Common logic for POST, PUT, DELETE to find Actor
    const body = req.body || {};
    let actorAdmin = null;
    const { current_admin_id } = body;
    if (current_admin_id) {
        const { rows: actors } = await db.query('SELECT * FROM admin_system WHERE admin_id = $1', [current_admin_id]);
        if (actors.length > 0) actorAdmin = actors[0];
    }

    // =================================================================
    // POST: เพิ่ม User / Reactivate / อัปเดต Multiple Roles
    // =================================================================
    if (req.method === 'POST') {
      const { email, roles, role } = body; 
      if (!email) return res.status(400).json({ message: 'Email required' });

      const validRolesList = [
        'admin', 'editor', 'editor_manage_case', 'editor_manage_menu',
        'editor_manage_flex', 'editor_search_org', 'editor_file_search',
        'editor_search_duplicate_org', 'editor_mange_user'
      ];

      // รองรับทั้งการส่ง roles (Array) หรือ role (String)
      const rawInput = Array.isArray(roles) ? roles : (role ? [role] : ['editor']);
      const finalRolesToAssign = rawInput.filter(r => validRolesList.includes(r));

      if (finalRolesToAssign.length === 0) {
        finalRolesToAssign.push('editor'); // Default role
      }

      try {
        const { rows: existing } = await db.query('SELECT * FROM admin_system WHERE email = $1 LIMIT 1', [email]);
        let targetUser;
        let actionStatus = 'ADMIN_ADD';

        if (existing.length > 0) {
          targetUser = existing[0];
          if (targetUser.is_deleted) {
            const { rows: updated } = await db.query('UPDATE admin_system SET is_deleted = false WHERE email = $1 RETURNING *', [email]);
            targetUser = updated[0];
            actionStatus = 'ADMIN_REACTIVATE';
          } else {
            actionStatus = 'ADMIN_UPDATE_ROLE';
          }
        } else {
          const { rows: inserted } = await db.query('INSERT INTO admin_system (email) VALUES ($1) RETURNING *', [email]);
          targetUser = inserted[0];
          actionStatus = 'ADMIN_CREATE_NEW';
        }

        // --- Permit.io Operations ---
        try {
          // 1. Sync User Info
          await permit.api.users.sync({
            key: String(targetUser.admin_id),
            email: targetUser.email,
            first_name: targetUser.first_name || "",
            last_name: targetUser.last_name || ""
          });

          // 2. ดึง Role ปัจจุบันมาเทียบ (ป้องกันการ assign ซ้ำ)
          const currentAssigned = await permit.api.users.getAssignedRoles({ 
              user: String(targetUser.admin_id), 
              tenant: "default" 
          });
          const currentRoleNames = currentAssigned.map(r => r.role);

          // 3. วนลูป Assign เฉพาะตัวที่ยังไม่มี
          for (const roleName of finalRolesToAssign) {
            if (!currentRoleNames.includes(roleName)) {
              await permit.api.users.assignRole({
                user: String(targetUser.admin_id),
                role: roleName,
                tenant: "default"
              });
            }
          }
        } catch (e) {
          console.error("Permit Sync/Assign Error:", e);
        }

        if (actorAdmin) {
            await saveAdminLog({
              adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
              action_type: actionStatus, status: 'SUCCESS', ipAddress, userAgent,
              details: { target_id: targetUser.admin_id, target_email: targetUser.email, assigned_roles: finalRolesToAssign }
            });
        }

        return res.status(200).json({ 
          ...targetUser, 
          message: 'Success',
          roles: finalRolesToAssign 
        });

      } catch (dbError) {
        return res.status(500).json({ message: 'Database Error', error: dbError.message });
      }
    }

    // =================================================================
    // PUT: อัปเดตข้อมูลพื้นฐาน (ชื่อ-นามสกุล)
    // =================================================================
    if (req.method === 'PUT') {
        if (!id) return res.status(400).json({ message: 'ID required' });
        const { first_name, last_name, email } = body;
        
        if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });
  
        const { rows: updatedUser } = await db.query(`
          UPDATE admin_system SET first_name=$1, last_name=$2, email=$3
          WHERE admin_id = $4 RETURNING *;
        `, [first_name, last_name, email, id]);
  
        if (updatedUser.length === 0) return res.status(404).json({ message: 'Not found' });
  
        await saveAdminLog({
          adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
          action_type: 'ADMIN_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
          details: { target_id: id, updated_data: { email, first_name, last_name } }
        });
  
        return res.status(200).json(updatedUser[0]);
    }

    // =================================================================
    // DELETE: Soft Delete + ลบ User ออกจาก Permit เพื่อตัดสิทธิ์ทันที
    // =================================================================
    if (req.method === 'DELETE') {
        if (!id) return res.status(400).json({ message: 'ID required' });
        if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });

        const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");
        if (!isPermitted) return res.status(403).json({ message: 'Forbidden' });

        const { rows: deletedUser } = await db.query(`
          UPDATE admin_system SET is_deleted = true WHERE admin_id = $1 RETURNING *;
        `, [id]);

        if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });

        try {
          await permit.api.users.delete(String(id));
        } catch(e) {
          console.error("Permit Delete Error:", e);
        }

        await saveAdminLog({
          adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
          action_type: 'ADMIN_DELETE_SOFT', status: 'SUCCESS', ipAddress, userAgent,
          details: { deleted_id: id, deleted_email: deletedUser[0].email }
        });

        return res.status(200).json({ message: 'User deactivated successfully' });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("Critical API Error:", error);
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}