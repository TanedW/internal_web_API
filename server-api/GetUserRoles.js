// api/GetUserRoles.js
import { Permit } from "permitio";
import * as db from '../api/lib/db.js';

// Initialize Permit (ดึง PDP และ Token เหมือน AdminList.js)
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

export default async function handler(req, res) {
  // 1. CORS Setup (รองรับ Credentials สำหรับดึง Cookie)
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    // 2. ดึง Token จาก Cookie (req.cookies)
    // หมายเหตุ: หากใช้ใน Node.js/Vercel ปกติ อาจต้องติดตั้ง 'cookie' parser หรือดึงจาก req.headers.cookie
    const cookies = req.headers.cookie;
    const tokenFromCookie = cookies
      ?.split('; ')
      .find(row => row.startsWith('access_token='))
      ?.split('=')[1];

    if (!tokenFromCookie) {
      return res.status(401).json({ roles: ['guest'], isValid: false });
    }

    // 3. ตรวจสอบ Session กับ Database
    const { rows: userInDb } = await db.query(
      `SELECT admin_id, email 
       FROM admin_system 
       WHERE access_token = $1 AND is_deleted = false 
       LIMIT 1`,
      [tokenFromCookie]
    );

    if (userInDb.length === 0) {
      return res.status(401).json({ roles: ['guest'], isValid: false, message: 'Invalid session' });
    }

    const userData = userInDb[0];

    // 4. ดึง Roles จาก Permit.io (ใช้ SDK แทน Fetch API เพื่อความง่าย)
    let userRoles = ['guest'];
    try {
      const assignedRoles = await permit.api.users.getAssignedRoles({
        user: String(userData.admin_id),
        tenant: "default"
      });

      if (assignedRoles.length > 0) {
        // ดึงเฉพาะชื่อ role ออกมา
        userRoles = assignedRoles.map(r => r.role);
      }
    } catch (permitError) {
      console.error(`Permit Fetch Error for ${userData.admin_id}:`, permitError);
      // หากเกิด error กับ Permit ยังคงให้คืนค่า guest ไปก่อน
    }

    // 5. ส่งผลลัพธ์กลับ
    return res.status(200).json({
      roles: userRoles,
      isValid: true,
      email: userData.email,
    });

  } catch (error) {
    console.error("API Critical Error in GetUserRoles:", error);
    return res.status(500).json({
      roles: ['guest'],
      isValid: false,
      error: 'An internal server error occurred.'
    });
  }
}