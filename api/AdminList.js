// api/AdminList.js

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

// Helper: บันทึก Log
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId}, ${email}, ${first_name}, ${last_name},
        ${action_type}, ${status}, 
        ${ipAddress || null}::inet, 
        ${userAgent || null}, 
        ${details}
      );
    `;
    console.log("Admin log saved.");
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATA_BASE_URL);
  const { id, requester_id } = req.query; 

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล + ดึง Roles (Array) สดๆ จาก Permit
    // =================================================================
    if (req.method === 'GET') {
      let canDelete = false;

      if (requester_id) {
         try {
           canDelete = await permit.check(String(requester_id), "delete", "Admin_Users");
         } catch (e) {
           console.error("Permit Check Error:", e);
           canDelete = false;
         }
      }

      // 1. ดึง User จาก DB
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name, profile_url
        FROM admin_system 
        WHERE is_deleted = false
        ORDER BY join_at DESC;
      `;

      // 2. วนลูปถาม Permit เพื่อดึง Role ทั้งหมด
      const adminsWithRoles = await Promise.all(admins.map(async (admin) => {
        try {
            // ดึง Role ที่ Assign ไว้กับ User นี้ทั้งหมดจาก Permit
            const assignedRoles = await permit.api.users.getAssignedRoles({ 
                user: String(admin.admin_id), 
                tenant: "default" 
            });

            // ✅ CHANGED: Map เอา Role ทั้งหมดมาเป็น Array
            const roles = assignedRoles.map(r => r.role); 
            
            return {
                ...admin,
                // ส่งกลับเป็น array เสมอ (ถ้าไม่มีให้ default เป็น editor)
                roles: roles.length > 0 ? roles : ['editor'] 
            };
        } catch (error) {
            console.error(`Failed to fetch role for ${admin.email}:`, error);
            // Fallback กรณี Permit Error
            return { ...admin, roles: ['editor'] }; 
        }
      }));

      return res.status(200).json({
        data: adminsWithRoles, 
        meta: { can_delete: canDelete }
      });
    }

    // ส่วนอื่นๆ (POST, PUT, DELETE)
    const body = req.body || {};
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        if (current_admin_id) {
            const actors = await sql`SELECT * FROM admin_system WHERE admin_id = ${current_admin_id}`;
            if (actors.length > 0) actorAdmin = actors[0];
        }
    }

    // =================================================================
    // POST
    // =================================================================
    if (req.method === 'POST') {
      const { email, role } = body; 
      if (!email) return res.status(400).json({ message: 'Email required' });

      // แม้รับมาค่าเดียว แต่เราจะ Treat เป็น Array ตอน Return
      const validRoles = ['admin', 'editor', 'editor_manage_email', 'editor_manage_case', 'editor_manage_menu'];
      const assignedRole = validRoles.includes(role) ? role : 'editor';

      // 1. เช็คก่อนว่ามีอีเมลนี้อยู่ในระบบหรือยัง (รวมคนที่ถูกลบด้วย)
      const existing = await sql`SELECT * FROM admin_system WHERE email = ${email} LIMIT 1`;
      
      let targetUser;

      if (existing.length > 0) {
        const user = existing[0];
          // --- กรณีที่ 1: มีอีเมลอยู่แล้ว -> ทำการ Reactivate ---
          if (user.is_deleted === false) {
      // ✅ ถ้า is_deleted เป็น false ให้แจ้งเตือนว่ามีอยู่แล้ว
      return res.status(400).json({ 
        message: 'อีเมลนี้มีอยู่ในระบบและกำลังใช้งานอยู่แล้ว' 
          });
        } else {
          // ✅ ถ้า is_deleted เป็น true ให้ทำการ "คืนชีพ" (Reactivate)
          const updated = await sql`
            UPDATE admin_system 
            SET is_deleted = false 
            WHERE email = ${email} 
            RETURNING *;
          `;
          targetUser = updated[0];
        }
        } else {
          // --- กรณีที่ 2: ไม่เคยมีอีเมลนี้เลย -> INSERT ใหม่ ---
          const inserted = await sql`
            INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
          `;
          targetUser = inserted[0];
        }

      // 2. Sync Permit + Assign Role
      try {
        await permit.api.users.sync({
           key: String(targetUser.admin_id),
           email: targetUser.email,
           first_name: targetUser.first_name || "",
           last_name: targetUser.last_name || ""
        });

        await permit.api.users.assignRole({
            user: String(targetUser.admin_id),
            role: assignedRole, 
            tenant: "default"
        });

      } catch (e) {
         console.error("Permit Sync Error:", e);
      }

      if (actorAdmin) {
          await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
            details: { target: 'new_admin_created', new_id: targetUser.admin_id, new_email: targetUser.email, assigned_role: assignedRole }
          });
      }

      // ✅ CHANGED: Return เป็น roles array เพื่อให้ Frontend รับค่าไป display ต่อได้เลยโดยไม่ต้อง refresh
      return res.status(201).json({ ...targetUser, roles: [assignedRole] });
    }

    // =================================================================
    // PUT
    // =================================================================
    if (req.method === 'PUT') {
        if (!id) return res.status(400).json({ message: 'ID required' });
        const { first_name, last_name, email } = body;
        
        if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });
  
        const updatedUser = await sql`
          UPDATE admin_system SET first_name=${first_name}, last_name=${last_name}, email=${email}
          WHERE admin_id = ${id} RETURNING *;
        `;
  
        if (updatedUser.length === 0) return res.status(404).json({ message: 'Not found' });
  
        await saveAdminLog(sql, {
          adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
          action_type: 'ADMIN_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
          details: { target: 'admin_updated', target_id: id, updated_data: { email, first_name, last_name } }
        });
  
        return res.status(200).json(updatedUser[0]);
    }

    // // =================================================================
    // // DELETE
    // // =================================================================
    // if (req.method === 'DELETE') {
    //     if (!id) return res.status(400).json({ message: 'ID required' });
    //     if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });
  
    //     // Check Permit
    //     const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");
  
    //     if (!isPermitted) {
    //       await saveAdminLog(sql, {
    //           adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
    //           action_type: 'ADMIN_DELETE', status: 'FORBIDDEN', ipAddress, userAgent,
    //           details: { message: 'Permission denied', target_id: id }
    //       });
    //       return res.status(403).json({ message: 'Forbidden: No permission to delete.' });
    //     }
  
    //     const deletedUser = await sql`DELETE FROM admin_system WHERE admin_id = ${id} RETURNING *;`;
  
    //     if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });
  
    //     try {
    //        await permit.api.users.delete(String(id));
    //     } catch(e) {
    //        console.error("Failed to delete user in Permit:", e);
    //     }
  
    //     await saveAdminLog(sql, {
    //       adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
    //       action_type: 'ADMIN_DELETE', status: 'SUCCESS', ipAddress, userAgent,
    //       details: { target: 'admin_deleted', deleted_id: id, deleted_email: deletedUser[0].email }
    //     });
  
    //     return res.status(200).json({ message: 'Deleted successfully' });
    // }

        // =================================================================
        // DELETE (เปลี่ยนเป็น Soft Delete)
        // =================================================================
        if (req.method === 'DELETE') {
            if (!id) return res.status(400).json({ message: 'ID required' });
            if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });

            // 1. Check Permission จาก Permit.io เหมือนเดิม
            const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");

            if (!isPermitted) {
              await saveAdminLog(sql, {
                  adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
                  action_type: 'ADMIN_DELETE_SOFT', status: 'FORBIDDEN', ipAddress, userAgent,
                  details: { message: 'Permission denied', target_id: id }
              });
              return res.status(403).json({ message: 'Forbidden: No permission to delete.' });
            }

            // 2. เปลี่ยนจาก DELETE เป็น UPDATE is_deleted = true
            const deletedUser = await sql`
              UPDATE admin_system 
              SET is_deleted = true 
              WHERE admin_id = ${id} 
              RETURNING *;
            `;

            if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });

            // 3. จัดการกับ Permit (แนะนำให้ลบ User ออกจาก Permit เพื่อตัดสิทธิ์การเข้าถึงทันที)
            try {
              await permit.api.users.delete(String(id));
            } catch(e) {
              console.error("Failed to delete user in Permit:", e);
            }

            // 4. บันทึก Log
            await saveAdminLog(sql, {
              adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
              action_type: 'ADMIN_DELETE_SOFT', status: 'SUCCESS', ipAddress, userAgent,
              details: { target: 'admin_soft_deleted', deleted_id: id, deleted_email: deletedUser[0].email }
            });

            return res.status(200).json({ message: 'User deactivated successfully' });
        }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}