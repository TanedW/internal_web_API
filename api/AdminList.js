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

    // สำหรับ method อื่นๆ ดึง Body
    const body = req.body || {};
    
    // ตรวจสอบ Actor (คนทำรายการ)
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        
        // ถ้าไม่มีใน body ให้ลองดูใน query (สำหรับ DELETE)
        const checkId = current_admin_id; // หรือจะรับจาก query ก็ได้ถ้าต้องการ

        // หมายเหตุ: สำหรับ POST (Add User) บางครั้งอาจจะเป็น Public Register หรือ Admin Add Admin
        // ถ้าบังคับต้องมี current_admin_id เสมอ ให้เปิดบรรทัดนี้ไว้
        // if (!checkId) return res.status(400).json({ message: 'current_admin_id is required' });
        
        if (checkId) {
            const actors = await sql`SELECT * FROM admin_system WHERE admin_id = ${checkId}`;
            if (actors.length > 0) {
                actorAdmin = actors[0];
            }
        }
    }

    // =================================================================
    // POST: เพิ่ม Admin ใหม่ + Sync Permit
    // =================================================================
    if (req.method === 'POST') {
      const { email } = body;
      if (!email) return res.status(400).json({ message: 'Email required' });

      // 1. Insert ลง DB ก่อน
      const newUser = await sql`
        INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
      `;

      // 2. Sync กับ Permit.io (แยกขั้นตอน Sync และ Assign Role)
      try {
        // 2.1 สร้าง User ใน Permit (ห้ามใส่ Role ตรงนี้)
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           first_name: newUser[0].first_name || "",
           last_name: newUser[0].last_name || ""
        });

        // 2.2 กำหนด Role (แยกออกมาทำทีหลัง)
        await permit.api.users.assignRole({
            user: String(newUser[0].admin_id),
            role: "editor", // *** ตรวจสอบ Key ใน Permit: 'member' หรือ 'Member' ***
            tenant: "default"
        });

        console.log(`Permit Sync & Assign Role Success for: ${newUser[0].email}`);

      } catch (e) {
         console.error("Permit Sync Error:", e);
         // ถ้า Sync ไม่ผ่าน อาจจะ return 500 หรือลบ User ที่เพิ่งสร้างใน DB ทิ้ง
         // ในที่นี้ขอ return error ออกไปให้เห็นชัดๆ ช่วง debug
         return res.status(500).json({ 
            message: 'Permit Sync Failed', 
            error: e.message, 
            details: e.response?.data 
         });
      }

      // 3. Log (ถ้า actorAdmin เป็น null แปลว่าเป็น self-register หรือระบบไม่ได้ส่ง current_admin_id มา)
      if (actorAdmin) {
          await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
            details: { target: 'new_admin_created', new_id: newUser[0].admin_id, new_email: newUser[0].email }
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

      const updatedUser = await sql`
        UPDATE admin_system SET first_name=${first_name}, last_name=${last_name}, email=${email}
        WHERE admin_id = ${id} RETURNING *;
      `;

      if (updatedUser.length === 0) return res.status(404).json({ message: 'Not found' });

      // Optional: ถ้าแก้ Email อาจต้อง Sync ไป Permit ด้วย (แล้วแต่ requirement)

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

      // Optional: ควรลบ User ใน Permit ด้วย
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