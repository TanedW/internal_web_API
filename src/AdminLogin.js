// api/AdminLogin.js

import { query } from './lib/db.js';
import { Permit } from "permitio";
import { writeAuditLog } from './lib/logging.js';

// สร้าง Instance ของ Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

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

export default async function handler(req, res) {
  if (req.method === 'POST') {
    // ดึง IP และ User Agent จาก Headers (Node.js style)
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || null;
    
    try {
      // ดึงข้อมูลจาก req.body (Vercel จะ Parse JSON มาให้แล้ว ไม่ต้องใช้ await req.json())
      const { email, first_name, last_name, profile_url, access_token } = req.body;

      if (!email) {
        return res.status(400).json({ message: 'Email is required' });
      }
      
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

            return res.status(403).json({ 
                message: 'Access Denied: This account has been deactivated.' 
            });
        }

        // 3. ดึง Role จาก Permit.io โดยใช้ UUID (User Key)
        let userRoles = ['guest']; // ค่าเริ่มต้น
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

        // 6. ส่งข้อมูลกลับไปยัง Frontend (Node.js style)
        return res.status(200).json({
            admin_id: userData.admin_id,
            email: userData.email,
            first_name: userData.first_name,
            last_name: userData.last_name,
            profile_url: userData.profile_url,
            roles: userRoles
        });

      } else {
        // กรณีไม่พบ Email นี้ในฐานข้อมูลระบบ
        await saveLoginLog({
          adminId: null, email, first_name, last_name, ipAddress, userAgent, 
          status: 'FAILED_UNAUTHORIZED'
        });

        return res.status(403).json({ 
            message: 'Access Denied: Your email is not authorized.' 
        });
      }

    } catch (error) {
      console.error("API Critical Error:", error);
      return res.status(500).json({ 
          message: 'Internal Server Error', 
          error: error.message 
      });
    }
  }

  // กรณี Method ไม่ใช่ POST
  return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
}