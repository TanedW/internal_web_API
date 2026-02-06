// api/AdminLogin.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// สร้าง Instance ของ Permit (แนะนำให้ใช้ค่าจาก env)
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
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

      // 1. ตรวจสอบว่า User มีอยู่ในฐานข้อมูลเราหรือไม่
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email} LIMIT 1`;

      if (existingUser.length > 0) {
        const user = existingUser[0];

        // 2. เช็คว่า User ถูกระงับการใช้งาน (is_deleted) หรือไม่
        if (user.is_deleted === true) {
            await saveLoginLog(sql, {
                adminId: user.admin_id,
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

        // 3. ดึง Role จาก Permit.io โดยใช้ Email เป็น Key
        let userRole = 'guest'; // Default role
        try {
          const permitUser = await permit.api.getUser(email);
          if (permitUser && permitUser.roles && permitUser.roles.length > 0) {
            // ดึง Role แรกที่เจอ (เช่น 'admin' หรือ 'editor')
            userRole = permitUser.roles[0].role; 
          }
        } catch (permitError) {
          console.warn("Permit.io: User info not found, fallback to guest");
        }

        // 4. อัปเดตข้อมูลการ Login ล่าสุดลงฐานข้อมูล
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

        // 5. บันทึก Success Log
        await saveLoginLog(sql, {
          adminId: userData.admin_id, 
          email, first_name, last_name, ipAddress, userAgent,
          status: 'SUCCESS'
        });

        // 6. ส่งข้อมูลกลับพร้อม Role ที่ได้จาก Permit
        return new Response(JSON.stringify({
            ...userData,
            role: userRole
        }), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        // กรณีไม่พบอีเมลในระบบ (Unauthorized)
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
      console.error("API Error:", error);
      return new Response(JSON.stringify({ message: 'Internal Server Error', error: error.message }), { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), { 
      status: 405, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}