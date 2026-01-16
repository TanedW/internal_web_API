// api/AdminList.js

// ✅ ใช้ Node.js runtime เพื่อความเสถียรของ SDK
export const config = {
  runtime: 'nodejs',
};

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// ✅ Initialize Permit
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
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  // Parse URL & Query Params
  const url = new URL(req.url, 'http://localhost');
  const searchParams = url.searchParams;
  const id = searchParams.get('id');

  // Get Client Info
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล + เช็คสิทธิ์คนดู (Permission Check for UI)
    // =================================================================
    if (req.method === 'GET') {
      const requesterId = searchParams.get('requester_id'); // รับ ID คนที่กำลังเปิดหน้าเว็บ
      let canDelete = false;

      // ถ้ามี ID ส่งมา ให้ถาม Permit ว่าคนนี้มีสิทธิ์ 'delete' ไหม?
      if (requesterId) {
         try {
           canDelete = await permit.check(requesterId, "delete", "Admin_Users");
         } catch (e) {
           console.error("Permit Check Error:", e);
           // กรณี Error ให้ถือว่าไม่มีสิทธิ์ไว้ก่อน (Fail Safe)
           canDelete = false;
         }
      }

      const admins = await sql`
        SELECT admin_id, email, first_name, last_name ,profile_url
        FROM admin_system 
        ORDER BY join_at DESC;
      `;

      // ส่งกลับเป็น Object { data, meta }
      return new Response(JSON.stringify({
        data: admins,
        meta: { can_delete: canDelete } // ส่ง Flag ไปบอก Frontend
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // อ่าน Body สำหรับ method อื่นๆ
    let body = {};
    if (req.method !== 'GET') {
        try { body = await req.json(); } catch (e) {}
    }
    
    // ตรวจสอบ Actor (ผู้กระทำ)
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        if (!current_admin_id) {
            return new Response(JSON.stringify({ message: 'current_admin_id is required' }), { status: 400, headers: corsHeaders });
        }
        const actors = await sql`SELECT * FROM admin_system WHERE admin_id = ${current_admin_id}`;
        if (actors.length === 0) {
            return new Response(JSON.stringify({ message: 'Actor not found' }), { status: 403, headers: corsHeaders });
        }
        actorAdmin = actors[0];
    }

    // =================================================================
    // POST: สร้าง Admin ใหม่ + Sync Permit
    // =================================================================
    if (req.method === 'POST') {
      const { email } = body;
      if (!email) return new Response(JSON.stringify({ message: 'Email required' }), { status: 400, headers: corsHeaders });

      // 1. Insert DB
      const newUser = await sql`
        INSERT INTO admin_system (email) VALUES (${email}) RETURNING *;
      `;

      // 2. Sync to Permit (เพื่อให้ User ใหม่มีตัวตนในระบบ Permission)
      try {
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           roles: [{ role: "member", tenant: "default" }] // ให้ Role เริ่มต้นเป็น Member (ลบไม่ได้)
        });
      } catch (e) {
         console.error("Permit Sync Error:", e);
      }

      // 3. Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'ADMIN_ADD', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'new_admin_created', new_id: newUser[0].admin_id, new_email: newUser[0].email }
      });

      return new Response(JSON.stringify(newUser[0]), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // =================================================================
    // PUT: แก้ไข
    // =================================================================
    if (req.method === 'PUT') {
      if (!id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });
      const { first_name, last_name, email } = body;

      const updatedUser = await sql`
        UPDATE admin_system SET first_name=${first_name}, last_name=${last_name}, email=${email}
        WHERE admin_id = ${id} RETURNING *;
      `;

      if (updatedUser.length === 0) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: corsHeaders });

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'ADMIN_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'admin_updated', target_id: id, updated_data: { email, first_name, last_name } }
      });

      return new Response(JSON.stringify(updatedUser[0]), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // =================================================================
    // DELETE: ลบ Admin (Security Checkpoint)
    // =================================================================
    if (req.method === 'DELETE') {
      if (!id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });

      // ✅ 1. Check Permission
      const isPermitted = await permit.check(
        String(actorAdmin.admin_id), 
        "delete",                    
        "Admin_Users" // Key ต้องตรงกับ Permit Console (Admin_Users)
      );

      if (!isPermitted) {
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
            action_type: 'ADMIN_DELETE', status: 'FORBIDDEN', ipAddress, userAgent,
            details: { message: 'Permission denied by Permit.io', target_id: id }
        });
        return new Response(JSON.stringify({ message: 'Forbidden: No permission to delete.' }), { status: 403, headers: corsHeaders });
      }

      // ✅ 2. Delete
      const deletedUser = await sql`DELETE FROM admin_system WHERE admin_id = ${id} RETURNING *;`;

      if (deletedUser.length === 0) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: corsHeaders });

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'ADMIN_DELETE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'admin_deleted', deleted_id: id, deleted_email: deletedUser[0].email }
      });

      // (Optional) ลบ User ใน Permit ด้วย
      // try { await permit.api.users.delete(String(id)); } catch(e) {}

      return new Response(JSON.stringify({ message: 'Deleted successfully' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ message: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ message: 'Server Error', error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}