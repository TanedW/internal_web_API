// api/AdminLogin.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// สร้าง Instance ของ Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY, // ตรวจสอบว่าได้ตั้งค่า API Key ใน Environment Variables แล้ว
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ฟังก์ชันบันทึก Log การเข้าใช้งาน
async function saveLoginLog(sql, { adminId, ipAddress, status, email, first_name, last_name, userAgent }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, ip_address, status, action_type, first_name, last_name, user_agent)
      VALUES (
        ${adminId}, 
        ${email}, 
        ${ipAddress}, 
        ${status}, 
        'ADMIN_LOGIN', 
        ${first_name || null}, 
        ${last_name || null}, 
        ${userAgent}
      );
    `;
  } catch (e) {
    console.error("Error saving log:", e);
  }
}

export default async function handler(req) {
  
  // จัดการ CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === 'POST') {
    const forwarded = req.headers.get('x-forwarded-for');
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
    const userAgent = req.headers.get('user-agent') || null;
    
    try {
      const body = await req.json();
      const { email, first_name, last_name, profile_url, access_token } = body;
      
      const sql = neon(process.env.DATA_BASE_URL);

      // 1. ค้นหา User ในฐานข้อมูล Neon DB ด้วย Email เพื่อดึง admin_id (UUID)
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email} LIMIT 1`;

      if (existingUser.length > 0) {
        const user = existingUser[0];
        const userUuid = user.admin_id; // UUID ที่ใช้เป็น User Key ใน Permit.io

        // 2. ตรวจสอบสถานะการถูกระงับใช้งาน
        if (user.is_deleted === true) {
            await saveLoginLog(sql, {
                adminId: userUuid,
                email, first_name, last_name, ipAddress, userAgent, 
                status: 'FAILED_DELETED'
            });

            return new Response(JSON.stringify({ 
                message: 'Access Denied: This account has been deactivated.' 
            }), { 
                status: 403, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // 3. ดึง Role จาก Permit.io โดยใช้ UUID (User Key)
        let userRole = 'guest'; // ค่าเริ่มต้นหากหาไม่เจอ
        try {
          const permitUser = await permit.api.getUser(userUuid.toString());
          if (permitUser && permitUser.roles && permitUser.roles.length > 0) {
            userRoles = permitUser.roles.map(r => 
              typeof r === 'object' ? r.role : r
            );
          }
        } catch (permitError) {
          console.error(`Permit.io Error for UUID ${userUuid}:`, permitError.message);
        }

        // 4. อัปเดตข้อมูลการเข้าใช้งานล่าสุดใน DB
        const updatedUser = await sql`
            UPDATE admin_system SET 
              "access_token" = ${access_token}, 
              "last_name" = ${last_name}, 
              "first_name" = ${first_name},
              "profile_url" = ${profile_url}
            WHERE "email" = ${email} 
            RETURNING admin_id, email, first_name, last_name, profile_url;
          `;
        
        const userData = updatedUser[0];

        // 5. บันทึกประวัติการ Login สำเร็จ
        await saveLoginLog(sql, {
          adminId: userUuid, 
          email, first_name, last_name, ipAddress, userAgent,
          status: 'SUCCESS'
        });

        // 6. ส่งข้อมูลทั้งหมดพร้อม Role กลับไปยัง Frontend
        return new Response(JSON.stringify({
            admin_id: userData.admin_id,
            email: userData.email,
            first_name: userData.first_name,
            last_name: userData.last_name,
            profile_url: userData.profile_url,
            roles: userRoles // ส่งค่าเป็น Array เช่น ["admin", "editor_manage_case"]
        }), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        // กรณีไม่พบ Email นี้ในฐานข้อมูลระบบ
        await saveLoginLog(sql, {
          adminId: null, email, first_name, last_name, ipAddress, userAgent, 
          status: 'FAILED_UNAUTHORIZED'
        });

        return new Response(JSON.stringify({ 
            message: 'Access Denied: Your email is not authorized.' 
        }), { 
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error("API Critical Error:", error);
      return new Response(JSON.stringify({ message: 'Internal Server Error', error: error.message }), { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // กรณี Method ไม่ใช่ POST
  return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), { 
      status: 405, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}