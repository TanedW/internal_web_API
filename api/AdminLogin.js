// api/AdminLogin.js

// 1. ลบ config runtime: 'edge' ออก เพื่อใช้ Node.js Runtime ปกติ
import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

// สร้าง Instance ของ Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY, 
});

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

export default async function handler(req, res) {
  // จัดการ CORS สำหรับ Node.js Runtime
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // จัดการ CORS Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    // แก้ไข: ดึง Header แบบ Object (Node.js style)
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || null;
    
    try {
      // แก้ไข: Vercel Node.js จะ parse JSON body มาให้แล้วใน req.body
      const { email, first_name, last_name, profile_url, access_token } = req.body;
      
      if (!email) {
          return res.status(400).json({ message: "Email is required" });
      }

      const sql = neon(process.env.DATA_BASE_URL);

      // 1. ค้นหา User
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email} LIMIT 1`;

      if (existingUser.length > 0) {
        const user = existingUser[0];
        const userUuid = user.admin_id;

        // 2. ตรวจสอบสถานะการถูกระงับ
        if (user.is_deleted === true) {
            await saveLoginLog(sql, {
                adminId: userUuid,
                email, first_name, last_name, ipAddress, userAgent, 
                status: 'FAILED_DELETED'
            });
            return res.status(403).json({ message: 'Access Denied: This account has been deactivated.' });
        }

        // 3. ดึง Role จาก Permit.io
        let userRoles = ['guest']; 
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

        // 4. อัปเดตข้อมูลการเข้าใช้งาน
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

        // 5. บันทึกประวัติ
        await saveLoginLog(sql, {
          adminId: userUuid, 
          email, first_name, last_name, ipAddress, userAgent,
          status: 'SUCCESS'
        });

        // 6. ส่ง Response กลับแบบ Node.js
        return res.status(200).json({
            admin_id: userData.admin_id,
            email: userData.email,
            first_name: userData.first_name,
            last_name: userData.last_name,
            profile_url: userData.profile_url,
            roles: userRoles
        });

      } else {
        await saveLoginLog(sql, {
          adminId: null, email, first_name, last_name, ipAddress, userAgent, 
          status: 'FAILED_UNAUTHORIZED'
        });
        return res.status(403).json({ message: 'Access Denied: Your email is not authorized.' });
      }

    } catch (error) {
      console.error("API Critical Error:", error);
      return res.status(500).json({ 
          message: 'Internal Server Error', 
          error: error.message 
      });
    }
  }

  return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
}