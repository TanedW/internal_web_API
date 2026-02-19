// api/AdminLogin.js

import { query } from './lib/db.js';
import { Permit } from "permitio";
import { writeAuditLog } from './lib/logging.js';

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
async function saveLoginLog({ adminId, ipAddress, status, email, first_name, last_name, userAgent }) {
  await writeAuditLog({
    adminId,
    email,
    firstName: first_name,
    lastName: last_name,
    actionType: 'ADMIN_LOGIN',
    status,
    ipAddress,
    userAgent
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

export default async function handler(req) {
  
  // จัดการ CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === 'POST') {
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
    const userAgent = req.headers['user-agent'];
    
    try {
      const body = await req.body;
      const { email, first_name, last_name, profile_url, access_token } = body;
      
      // 1. ค้นหา User ในฐานข้อมูลด้วย Email เพื่อดึง admin_id (UUID)
      const { rows: existingUser } = await query('SELECT * FROM admin_system WHERE "email" = $1 LIMIT 1', [email]);

      if (existingUser.length > 0) {
        const user = existingUser[0];
        const userUuid = user.admin_id; // UUID ที่ใช้เป็น User Key ใน Permit.io

        // 2. ตรวจสอบสถานะการถูกระงับใช้งาน
        if (user.is_deleted === true) {
            await saveLoginLog({
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
        let userRoles = 'guest'; // ค่าเริ่มต้นหากหาไม่เจอ
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
        const { rows: updatedUser } = await query(`
            UPDATE admin_system SET 
              "access_token" = $1, 
              "last_name" = $2, 
              "first_name" = $3,
              "profile_url" = $4
            WHERE "email" = $5
            RETURNING admin_id, email, first_name, last_name, profile_url;
          `, [access_token, last_name, first_name, profile_url, email]);
        
        const userData = updatedUser[0];

        // 5. บันทึกประวัติการ Login สำเร็จ
        await saveLoginLog({
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
        await saveLoginLog({
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
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 
            'Set-Cookie': `access_token=${access_token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=86400`
          }
      });
    }
  }

  // กรณี Method ไม่ใช่ POST
  return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), { 
      status: 405, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
