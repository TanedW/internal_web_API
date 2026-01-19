// api/AdminList.js

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

// ----------------------------------------------------------------------
// Helper: บันทึก Log
// ----------------------------------------------------------------------
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId}, ${email}, ${first_name}, ${last_name},
        ${action_type}, ${status}, ${ipAddress || null}, ${userAgent || null}, ${details}
      );
    `;
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

// ----------------------------------------------------------------------
// Main Handler
// ----------------------------------------------------------------------
export default async function handler(req, res) {
  // 1. Setup CORS manually
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle Preflight Request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sql = neon(process.env.DATA_BASE_URL);

  // 2. ดึงข้อมูลจาก req
  const { id, requester_id } = req.query; 

  // Headers
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล + เช็คสิทธิ์ (ใช้สำหรับแสดงรายการ Admin)
    // =================================================================
    if (req.method === 'GET') {
      let canDelete = false;

      // เช็คสิทธิ์กับ Permit ว่าคนเรียก (requester_id) ลบ user ได้ไหม
      if (requester_id) {
         try {
           canDelete = await permit.check(String(requester_id), "delete", "Admin_Users");
         } catch (e) {
           console.error("Permit Check Error:", e);
           canDelete = false;
         }
      }

      // ✅ [FIX] เพิ่ม field 'role' ใน SELECT เพื่อส่งกลับไปให้ Frontend ใช้เช็ค Navbar
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name, profile_url, role
        FROM admin_system 
        ORDER BY join_at DESC;
      `;

      return res.status(200).json({
        data: admins,
        meta: { can_delete: canDelete }
      });
    }

    // สำหรับ method อื่นๆ ดึง Body
    const body = req.body || {};
    
    // ตรวจสอบ Actor (คนทำรายการ)
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        
        if (current_admin_id) {
            const actors = await sql`SELECT * FROM admin_system WHERE admin_id = ${current_admin_id}`;
            if (actors.length > 0) {
                actorAdmin = actors[0];
            }
        }
    }

    // =================================================================
    // POST: เพิ่ม Admin ใหม่ + Sync Permit + Assign Role
    // =================================================================
    if (req.method === 'POST') {
      const { email, role } = body; 
      
      if (!email) return res.status(400).json({ message: 'Email required' });

      // ตรวจสอบ Role ที่ส่งมาว่าถูกต้องหรือไม่ (Whitelist)
      const validRoles = [
        'admin', 
        'editor', 
        'editor_manage_email', 
        'editor_manage_case', 
        'editor_manage_menu'
      ];
      // ถ้า role ที่ส่งมาไม่อยู่ใน list ให้ default เป็น 'editor'
      const assignedRole = validRoles.includes(role) ? role : 'editor';

      // ✅ [FIX] Insert role ลงใน database ด้วย (ต้องแน่ใจว่าตาราง admin_system มี column 'role')
      const newUser = await sql`
        INSERT INTO admin_system (email, role) 
        VALUES (${email}, ${assignedRole}) 
        RETURNING *;
      `;

      // 2. Sync กับ Permit.io
      try {
        // 2.1 สร้าง User ใน Permit
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           first_name: newUser[0].first_name || "",
           last_name: newUser[0].last_name || ""
        });

        // 2.2 กำหนด Role ตามที่เลือก (assignedRole)
        await permit.api.users.assignRole({
            user: String(newUser[0].admin_id),
            role: assignedRole, 
            tenant: "default"
        });

        console.log(`Permit Sync & Assign Role (${assignedRole}) Success for: ${newUser[0].email}`);

      } catch (e) {
         console.error("Permit Sync Error:", e);
         // หมายเหตุ: ถึง Permit Error แต่ DB Insert สำเร็จแล้ว อาจต้อง handle rollback ใน production จริง
      }

      // 3. Log
      if (actorAdmin) {
          await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
            details: { target: 'new_admin_created', new_id: newUser[0].admin_id, new_email: newUser[0].email, assigned_role: assignedRole }
          });
      }

      return res.status(201).json(newUser[0]);
    }

    // =================================================================
    // PUT
    // =================================================================
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ message: 'ID required' });
      const { first_name, last_name, email } = body;
      
      if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });

      // หมายเหตุ: ถ้าต้องการให้แก้ Role ได้ด้วย ต้องเพิ่ม role=${role} ใน UPDATE
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

    // =================================================================
    // DELETE
    // =================================================================
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ message: 'ID required' });
      if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });

      // Check Permit
      const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");

      if (!isPermitted) {
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_DELETE', status: 'FORBIDDEN', ipAddress, userAgent,
            details: { message: 'Permission denied', target_id: id }
        });
        return res.status(403).json({ message: 'Forbidden: No permission to delete.' });
      }

      const deletedUser = await sql`DELETE FROM admin_system WHERE admin_id = ${id} RETURNING *;`;

      if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });

      // ลบ User ใน Permit ด้วย
      try {
         await permit.api.users.delete(String(id));
      } catch(e) {
         console.error("Failed to delete user in Permit:", e);
      }

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'ADMIN_DELETE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'admin_deleted', deleted_id: id, deleted_email: deletedUser[0].email }
      });

      return res.status(200).json({ message: 'Deleted successfully' });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}