// api/AdminList.js

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

// Helper: บันทึก Log (เหมือนเดิม)
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
    // GET: ดึงข้อมูล + ดึง Role สดๆ จาก Permit
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

      // 1. ดึง User จาก DB (❌ ไม่เอา column role แล้ว เพราะไม่มีใน DB)
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name, profile_url
        FROM admin_system 
        ORDER BY join_at DESC;
      `;

      // 2. วนลูปถาม Permit ว่าแต่ละคนมี Role อะไร (Parallel Requests)
      // วิธีนี้ Role จะแม่นยำตาม Permit เสมอ
      const adminsWithRoles = await Promise.all(admins.map(async (admin) => {
        try {
            // ดึง Role ที่ Assign ไว้กับ User นี้จาก Permit
            const assignedRoles = await permit.api.users.getAssignedRoles({ 
                user: String(admin.admin_id), 
                tenant: "default" 
            });

            // หา Role ที่เราสนใจ (ถ้ามีหลาย Role ให้หยิบตัวแรก หรือตัวที่ตรงเงื่อนไข)
            const roleObj = assignedRoles.find(r => r.role); 
            
            return {
                ...admin,
                role: roleObj ? roleObj.role : 'editor' // ถ้าหาไม่เจอ Default เป็น editor
            };
        } catch (error) {
            console.error(`Failed to fetch role for ${admin.email}:`, error);
            return { ...admin, role: 'editor' }; // Fallback กรณี Permit Error
        }
      }));

      return res.status(200).json({
        data: adminsWithRoles, // ✅ ส่งข้อมูลที่มี Role แล้วกลับไป
        meta: { can_delete: canDelete }
      });
    }

    // ส่วนอื่นๆ (POST, PUT, DELETE) ...
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

      const validRoles = ['admin', 'editor', 'editor_manage_email', 'editor_manage_case', 'editor_manage_menu'];
      const assignedRole = validRoles.includes(role) ? role : 'editor';

      // 1. Insert ลง DB (❌ ไม่เก็บ role ลง DB)
      const newUser = await sql`
        INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
      `;

      // 2. Sync Permit + Assign Role
      try {
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           first_name: newUser[0].first_name || "",
           last_name: newUser[0].last_name || ""
        });

        await permit.api.users.assignRole({
            user: String(newUser[0].admin_id),
            role: assignedRole, 
            tenant: "default"
        });

      } catch (e) {
         console.error("Permit Sync Error:", e);
         // อาจต้อง Handle กรณี Sync ไม่ผ่าน
      }

      if (actorAdmin) {
          await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
            details: { target: 'new_admin_created', new_id: newUser[0].admin_id, new_email: newUser[0].email, assigned_role: assignedRole }
          });
      }

      // Return ข้อมูลกลับไปพร้อม Role เพื่อให้ Frontend แสดงผลทันที
      return res.status(201).json({ ...newUser[0], role: assignedRole });
    }

    // =================================================================
    // PUT
    // =================================================================
    if (req.method === 'PUT') {
        // ... (โค้ดเดิม) ...
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

    // =================================================================
    // DELETE
    // =================================================================
    if (req.method === 'DELETE') {
        // ... (โค้ดเดิม) ...
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