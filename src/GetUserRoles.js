// api/GetUserRoles.js
import { Permit } from "permitio";
import * as db from './lib/db.js';
import { parse } from 'cookie'; // ใช้ library ในการ parse เพื่อความแม่นยำ

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log("--- New Request Received ---");

  try {
    // --- 2. Extract Token from Cookie ---
    const rawCookies = req.headers.cookie || '';
    console.log("Debug [1] Raw Cookie Header:", rawCookies);

    const cookies = parse(rawCookies);
    const tokenFromCookie = cookies.access_token; // เปลี่ยนชื่อตามที่เก็บใน Browser จริง

    if (!tokenFromCookie) {
      console.warn("Debug [2] No 'access_token' found in cookies.");
      return res.status(401).json({ roles: ['guest'], isValid: false, message: 'No token provided' });
    }
    console.log("Debug [2] Extracted Token:", tokenFromCookie.substring(0, 10) + "...");

    // --- 3. ตรวจสอบ Session กับ Database ---
    const { rows: userInDb } = await db.query(
      `SELECT admin_id, email 
       FROM admin_system 
       WHERE access_token = $1 AND is_deleted = false 
       LIMIT 1`,
      [tokenFromCookie]
    );

    if (!userInDb || userInDb.length === 0) {
      console.warn("Debug [3] Token not found in DB or User is deleted.");
      return res.status(401).json({ roles: ['guest'], isValid: false, message: 'Invalid session' });
    }

    const userData = userInDb[0];
    console.log("Debug [3] User Found in DB:", userData.email);

    // --- 4. ดึง Roles จาก Permit.io ---
    let userRoles = ['guest'];
    try {
      console.log(`Debug [4] Fetching roles for User ID: ${userData.admin_id}`);
      
      const assignedRoles = await permit.api.users.getAssignedRoles({
        user: String(userData.admin_id),
        tenant: "default"
      });

      if (assignedRoles && assignedRoles.length > 0) {
        userRoles = assignedRoles.map(r => r.role);
        console.log("Debug [4] Roles Found in Permit:", userRoles);
      } else {
        console.log("Debug [4] No roles assigned in Permit, defaulting to guest.");
      }
    } catch (permitError) {
      console.error("Debug [4] Permit API Error:", permitError.message);
      // หาก Permit มีปัญหา ยังให้ isValid: true ตาม DB แต่ Role เป็น guest
    }

    // --- 5. Return Success ---
    console.log("Debug [5] Final Response Sent: Success");
    return res.status(200).json({
      roles: userRoles,
      isValid: true,
      email: userData.email,
    });

  } catch (error) {
    console.error("Debug [CRITICAL ERROR]:", error);
    return res.status(500).json({
      roles: ['guest'],
      isValid: false,
      error: 'Internal server error'
    });
  }
}