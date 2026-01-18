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
// Main Handler (Node.js Style)
// ----------------------------------------------------------------------
export default async function handler(req, res) {
  // 1. Setup CORS manually (Node.js API Route ไม่ได้จัดการ CORS ให้ auto ในบางกรณี)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle Preflight Request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sql = neon(process.env.DATA_BASE_URL);

  // 2. ดึงข้อมูลจาก req แบบ Node.js (ง่ายกว่าเดิม)
  // Query Params (เช่น ?id=1) อยู่ใน req.query เลย
  const { id, requester_id } = req.query; 

  // Headers ใช้แบบ array index
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล + เช็คสิทธิ์
    // =================================================================
    if (req.method === 'GET') {
      let canDelete = false;

      // เช็คสิทธิ์กับ Permit
      if (requester_id) {
         try {
           canDelete = await permit.check(String(requester_id), "delete", "Admin_Users");
         } catch (e) {
           console.error("Permit Check Error:", e);
           canDelete = false;
         }
      }

      const admins = await sql`
        SELECT admin_id, email, first_name, last_name ,profile_url
        FROM admin_system 
        ORDER BY join_at DESC;
      `;

      return res.status(200).json({
        data: admins,
        meta: { can_delete: canDelete }
      });
    }

    // สำหรับ method อื่นๆ ดึง Body ได้เลย (req.body เป็น object แล้ว ไม่ต้อง await req.json())
    const body = req.body || {};
    
    // ตรวจสอบ Actor
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        
        // พิเศษ: ถ้า DELETE บางที body อาจไม่ถูกส่งมากับ request บางประเภท
        // ถ้าไม่มีใน body ให้ลองดูใน query (เผื่อไว้)
        const checkId = current_admin_id; 

        if (!checkId) {
            return res.status(400).json({ message: 'current_admin_id is required' });
        }
        
        const actors = await sql`SELECT * FROM admin_system WHERE admin_id = ${checkId}`;
        if (actors.length === 0) {
            return res.status(403).json({ message: 'Actor not found' });
        }
        actorAdmin = actors[0];
    }

    // =================================================================
    // POST
    // =================================================================
    if (req.method === 'POST') {
      const { email } = body;
      if (!email) return res.status(400).json({ message: 'Email required' });

      const newUser = await sql`
        INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
      `;

      // Sync Permit
      try {
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           roles: [{ role: "Member", tenant: "default" }]
        });
      } catch (e) {
        //  console.error("Permit Sync Error:", e);
         // [เพิ่ม] ส่ง Error กลับไปที่หน้าเว็บเพื่อดูสาเหตุ
         console.log("Permit Error Details:", JSON.stringify(e.response?.data, null, 2)); 
  
          return res.status(500).json({ 
            message: 'Permit Sync Failed', 
            error: e.message,
            details: e.response?.data 
          });
      }

      // Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'new_admin_created', new_id: newUser[0].admin_id, new_email: newUser[0].email }
      });

      return res.status(201).json(newUser[0]);
    }

    // =================================================================
    // PUT
    // =================================================================
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ message: 'ID required' });
      const { first_name, last_name, email } = body;

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