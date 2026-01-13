export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log ลง Database
// ----------------------------------------------------------------------
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    // แปลง details object เป็น JSON string (หรือส่ง object ตรงๆ ถ้า driver รองรับ)
    // แต่เพื่อความชัวร์ในบาง driver การส่ง object เข้าไปใน column JSONB มักจะทำได้เลย
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId},       -- ID ของผู้กระทำ (Actor)
        ${email},         -- Email ของผู้กระทำ
        ${first_name},    -- ชื่อ ของผู้กระทำ
        ${last_name},     -- นามสกุล ของผู้กระทำ
        ${action_type}, 
        ${status}, 
        ${ipAddress || null}, 
        ${userAgent || null},
        ${details}        -- ข้อมูลรายละเอียด (เช่น ข้อมูลของคนใหม่ที่ถูกสร้าง) เก็บเป็น JSONB
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
  // Handle CORS Preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id'); // Target ID (สำหรับ PUT/DELETE)

  // ดึง IP และ User Agent
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล Admin ทั้งหมด
    // =================================================================
    if (req.method === 'GET') {
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        ORDER BY created_at DESC; -- หรือเรียงตาม admin_id
      `;
      return new Response(JSON.stringify(admins), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // อ่าน Body ครั้งเดียวสำหรับ method ที่ต้องใช้ (POST, PUT, DELETE)
    // หมายเหตุ: DELETE ปกติไม่ส่ง Body แต่ถ้า Client คุณส่งมาเพื่อระบุตัวตนก็ใช้ได้
    let body = {};
    if (req.method !== 'GET') {
        try {
            body = await req.json();
        } catch (e) {
            // กรณีไม่มี body ส่งมา
        }
    }
    
    // ตรวจสอบ Actor (ผู้กระทำ) สำหรับ POST, PUT, DELETE
    // ต้องส่ง "current_admin_id" มาใน JSON Body เสมอ
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        
        if (!current_admin_id) {
            return new Response(JSON.stringify({ message: 'current_admin_id is required for auditing' }), { 
                status: 400, 
                headers: corsHeaders 
            });
        }

        // ค้นหาข้อมูลผู้กระทำจาก DB
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
      const { email, first_name, last_name } = body;

      if (!email || !first_name || !last_name) {
        return new Response(JSON.stringify({ message: 'Email, first_name, and last_name are required' }), { status: 400, headers: corsHeaders });
      }

      // สร้าง Admin คนใหม่ (Target)
      const newUser = await sql`
        INSERT INTO admin_system (email, first_name, last_name) 
        VALUES (${email}, ${first_name}, ${last_name}) 
        RETURNING *;
      `;

      // บันทึก Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,       // ผู้กระทำ
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
            new_admin_name: `${newUser[0].first_name} ${newUser[0].last_name}`
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

      // อัปเดตข้อมูล
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

      // บันทึก Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,       // ผู้กระทำ
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
    // DELETE: ลบ Admin
    // =================================================================
    if (req.method === 'DELETE') {
      if (!id) return new Response(JSON.stringify({ message: 'Target Admin ID is required' }), { status: 400, headers: corsHeaders });

      // ลบข้อมูล
      const deletedUser = await sql`
        DELETE FROM admin_system 
        WHERE admin_id = ${id}
        RETURNING *;
      `;

      if (deletedUser.length === 0) {
        // กรณีลบไม่เจอ ก็ Log Failed ไว้ด้วย
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

      // บันทึก Log Success
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,       // ผู้กระทำ
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