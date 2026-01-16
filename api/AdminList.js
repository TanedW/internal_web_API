// api/AdminList.js

// 1. เปลี่ยน Runtime เป็น nodejs เพื่อให้ SDK ทำงานเสถียรที่สุด
export const config = {
  runtime: 'nodejs',
};

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio"; // Import Permit SDK

// 2. Initialize Permit
// ตรวจสอบว่าได้ใส่ PERMIT_API_KEY ในไฟล์ .env แล้ว
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log ลง Database
// ----------------------------------------------------------------------
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId},
        ${email},
        ${first_name},
        ${last_name},
        ${action_type}, 
        ${status}, 
        ${ipAddress || null}, 
        ${userAgent || null},
        ${details}
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url, 'http://localhost'); // เพิ่ม base url กัน error ใน nodejs environment
  const id = searchParams.get('id'); 

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล Admin ทั้งหมด
    // =================================================================
    if (req.method === 'GET') {
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name ,profile_url
        FROM admin_system 
        ORDER BY join_at DESC;
      `;
      return new Response(JSON.stringify(admins), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // อ่าน Body
    let body = {};
    if (req.method !== 'GET') {
        try {
            body = await req.json();
        } catch (e) {}
    }
    
    // ตรวจสอบ Actor (ผู้กระทำ)
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        
        if (!current_admin_id) {
            return new Response(JSON.stringify({ message: 'current_admin_id is required for auditing' }), { 
                status: 400, 
                headers: corsHeaders 
            });
        }

        const actors = await sql`
            SELECT admin_id, email, first_name, last_name 
            FROM admin_system 
            WHERE admin_id = ${current_admin_id}
        `;

        if (actors.length === 0) {
            return new Response(JSON.stringify({ message: 'Current Admin (Actor) not found in system' }), { 
                status: 403, 
                headers: corsHeaders 
            });
        }
        actorAdmin = actors[0];
    }

    // =================================================================
    // POST: สร้าง Admin ใหม่
    // =================================================================
    if (req.method === 'POST') {
      const { email } = body;

      if (!email) {
        return new Response(JSON.stringify({ message: 'Email is required' }), { status: 400, headers: corsHeaders });
      }

      // 1. สร้างใน DB
      const newUser = await sql`
        INSERT INTO admin_system (email) 
        VALUES (${email}) 
        RETURNING *;
      `;

      // 2. [NEW] Sync ไปยัง Permit.io ทันที เพื่อให้มีข้อมูลUserในระบบ
      try {
        await permit.api.users.sync({
           key: String(newUser[0].admin_id),
           email: newUser[0].email,
           // กำหนด Role เริ่มต้น (Optional: แก้เป็น role ที่คุณต้องการ)
           roles: [{ role: "member", tenant: "default" }] 
        });
      } catch (permitError) {
         console.error("Permit Sync Error:", permitError);
         // ไม่ return error เพราะถือว่าสร้างใน DB สำเร็จแล้ว (อาจจะไป sync manual ทีหลัง)
      }

      // 3. Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'ADMIN_ADD',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'new_admin_created',
            new_admin_id: newUser[0].admin_id,
            new_admin_email: newUser[0].email,
        }
      });

      return new Response(JSON.stringify(newUser[0]), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // =================================================================
    // PUT: แก้ไขข้อมูล Admin
    // =================================================================
    if (req.method === 'PUT') {
      if (!id) return new Response(JSON.stringify({ message: 'Target Admin ID is required' }), { status: 400, headers: corsHeaders });

      const { first_name, last_name, email } = body;

      const updatedUser = await sql`
        UPDATE admin_system 
        SET 
          first_name = ${first_name}, 
          last_name = ${last_name},
          email = ${email}
        WHERE admin_id = ${id}
        RETURNING *;
      `;

      if (updatedUser.length === 0) {
        return new Response(JSON.stringify({ message: 'Target Admin not found' }), { status: 404, headers: corsHeaders });
      }

      // (Optional) ถ้ามีการแก้ Email อาจจะต้อง Sync ไป Permit ด้วย

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'ADMIN_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'admin_updated',
            target_admin_id: id,
            updated_data: { email, first_name, last_name }
        }
      });

      return new Response(JSON.stringify(updatedUser[0]), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // =================================================================
    // DELETE: ลบ Admin (จุดสำคัญ)
    // =================================================================
    if (req.method === 'DELETE') {
      if (!id) return new Response(JSON.stringify({ message: 'Target Admin ID is required' }), { status: 400, headers: corsHeaders });

      // [NEW] Check Permission with Permit.io
      // ตรวจสอบว่า "คนกดลบ" (actorAdmin) มีสิทธิ์ delete บน resource "Admin_Users" หรือไม่
      const isPermitted = await permit.check(
        String(actorAdmin.admin_id), // User Key
        "delete",                    // Action
        "Admin_Users"                // Resource Key (ต้องตรงกับใน Console เป๊ะๆ)
      );

      if (!isPermitted) {
        // บันทึก Log ว่า Access Denied
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'ADMIN_DELETE',
            status: 'FAILED', // หรือ FORBIDDEN
            ipAddress,
            userAgent,
            details: { message: 'Permission denied by Permit.io', target_id: id }
        });

        return new Response(JSON.stringify({ message: 'Forbidden: You do not have permission to delete admins.' }), { 
            status: 403, // ส่ง 403 กลับไป
            headers: corsHeaders 
        });
      }

      // ถ้าผ่าน -> ลบข้อมูล
      const deletedUser = await sql`
        DELETE FROM admin_system 
        WHERE admin_id = ${id}
        RETURNING *;
      `;

      if (deletedUser.length === 0) {
        // ลบไม่เจอ
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'ADMIN_DELETE',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { message: 'Target admin not found', target_id: id }
        });
        return new Response(JSON.stringify({ message: 'Admin not found' }), { status: 404, headers: corsHeaders });
      }

      // ลบสำเร็จ
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'ADMIN_DELETE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'admin_deleted',
            deleted_admin_id: id,
            deleted_admin_email: deletedUser[0].email
        }
      });

      // (Optional) อาจจะสั่ง permit.api.users.delete(...) เพื่อลบ User ใน Permit ด้วยก็ได้

      return new Response(JSON.stringify({ message: 'Admin deleted successfully' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ message: 'An error occurred', error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}