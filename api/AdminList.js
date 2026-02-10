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
  // 1. ดึง Origin จาก Request ที่ส่งมา
  const origin = req.headers.origin;

  // 2. ตรวจสอบเงื่อนไข (เลือกใช้อย่างใดอย่างหนึ่ง)
  
  // แบบ A: ยืดหยุ่นที่สุด (ยอมรับทุก Origin ที่ส่ง Credentials มา)
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  // แบบ B: ปลอดภัยขึ้นมาหน่อย (เช็คเฉพาะที่เป็น localhost หรือ domain ของเรา)
  // if (origin && (origin.startsWith('http://localhost') || origin.endsWith('yourdomain.com'))) {
  //   res.setHeader('Access-Control-Allow-Origin', origin);
  // }

  res.setHeader('Access-Control-Allow-Credentials', 'true'); // จำเป็นสำหรับ HttpOnly Cookie
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // 3. สำคัญมาก: ต้องอนุญาตการส่ง Credentials (Cookies)
  res.setHeader('Access-Control-Allow-Credentials', 'true');

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
      // res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
      let canDelete = false;

      if (requester_id) {
         try {
           // 1. เช็คสิทธิ์การลบ
          canDelete = await permit.check(String(requester_id), "delete", {
            type: "Admin_Users",
            tenant: "default"
          });           
           
           // 2. ดึง Roles ทั้งหมดของคนเรียก (requester) มาดูเพื่อ Debug
           const userRoles = await permit.api.users.getAssignedRoles({ 
                user: String(requester_id), 
                tenant: "default" 
            });
           const roleNames = userRoles.map(r => r.role);

           console.log(`--- Debug Permission ---`);
           console.log(`Roles for ${requester_id}:`, roleNames);
           console.log(`Can Delete:`, canDelete);
           console.log(`------------------------`);

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

            console.log(assignedRoles)

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
    // POST: เพิ่ม User ใหม่, Reactivate หรือ อัปเดต Role ให้ User เดิม
    // =================================================================
    if (req.method === 'POST') {
      const { email, role } = body; 
      if (!email) return res.status(400).json({ message: 'Email required' });

      const validRoles = ['admin', 'editor', 'editor_manage_user', 'editor_manage_case', 'editor_manage_menu', 'editor_manage_org_info'];
      const assignedRole = validRoles.includes(role) ? role : 'editor';

      try {
        // 1. เช็คว่ามีอีเมลนี้อยู่ในระบบหรือไม่
        const existing = await sql`SELECT * FROM admin_system WHERE email = ${email} LIMIT 1`;
        
        let targetUser;
        let actionStatus = 'ADMIN_ADD';

        if (existing.length > 0) {
          targetUser = existing[0];
          
          if (targetUser.is_deleted === true) {
            // กรณีเคยถูกลบ: ให้คืนชีพ (Reactivate)
            const updated = await sql`
              UPDATE admin_system 
              SET is_deleted = false 
              WHERE email = ${email} 
              RETURNING *;
            `;
            targetUser = updated[0];
            actionStatus = 'ADMIN_REACTIVATE';
          } else {
            // กรณีมีอยู่ในระบบและใช้งานอยู่: เตรียมอัปเดต Role ใน Permit
            actionStatus = 'ADMIN_UPDATE_ROLE';
          }
        } else {
          // กรณีไม่เคยมีข้อมูลเลย: INSERT ใหม่
          const inserted = await sql`
            INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
          `;
          targetUser = inserted[0];
          actionStatus = 'ADMIN_CREATE_NEW';
        }

        // 2. Sync Permit + Assign Role (Permit จะจัดการ Overwrite หรือ Add Role ให้เอง)
        try {
          await permit.api.users.sync({
            key: String(targetUser.admin_id),
            email: targetUser.email,
            first_name: targetUser.first_name || "",
            last_name: targetUser.last_name || ""
          });

          // --- ทางเลือก A: ดึงมาเช็กก่อน Assign เพื่อป้องกัน Role ซ้ำซ้อน ---
          const currentAssignedRoles = await permit.api.users.getAssignedRoles({ 
              user: String(targetUser.admin_id), 
              tenant: "default" 
          });

          // ตรวจสอบว่ามี Role นี้อยู่แล้วหรือยัง
          const hasRole = currentAssignedRoles.some(r => r.role === assignedRole);

          if (!hasRole) {
              await permit.api.users.assignRole({
                  user: String(targetUser.admin_id),
                  role: assignedRole, 
                  tenant: "default"
              });
              console.log(`Assigned new role: ${assignedRole} to ${targetUser.email}`);
          } else {
              console.log(`User ${targetUser.email} already has role: ${assignedRole}`);
          }
          // -----------------------------------------------------------

        } catch (e) {
          console.error("Permit Sync/Assign Error:", e);
        }

        // 3. บันทึก Log ตาม Action ที่เกิดขึ้น
        if (actorAdmin) {
            await saveAdminLog(sql, {
              adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
              action_type: actionStatus, status: 'SUCCESS', ipAddress, userAgent,
              details: { 
                target: 'admin_role_assigned', 
                target_id: targetUser.admin_id, 
                target_email: targetUser.email, 
                assigned_role: assignedRole,
                previous_status: existing.length > 0 ? (existing[0].is_deleted ? 'deleted' : 'active') : 'new'
              }
            });
        }

        return res.status(200).json({ 
          ...targetUser, 
          message: actionStatus === 'ADMIN_UPDATE_ROLE' ? 'อัปเดตบทบาทเรียบร้อยแล้ว' : 'เพิ่มผู้ใช้งานเรียบร้อยแล้ว',
          roles: [assignedRole] 
        });

      } catch (dbError) {
        console.error("Database Error:", dbError);
        return res.status(500).json({ message: 'Database Error', error: dbError.message });
      }
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