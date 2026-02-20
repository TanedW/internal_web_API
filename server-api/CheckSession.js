// api/CheckSession.js
import * as db from '../api/lib/db.js';

export default async function handler(req, res) {
  // 1. ตั้งค่า CORS (อ้างอิงตาม AdminList.js)
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. ตอบกลับ OPTIONS Request (Preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. อนุญาตเฉพาะ POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { email, access_token } = req.body || {};

    if (!email || !access_token) {
      return res.status(400).json({ authenticated: false, message: 'Email and Access Token are required' });
    }

    // 4. ดึงข้อมูลมาเทียบ (ใช้ db.query จากไฟล์ lib/db.js)
    const { rows: users } = await db.query(
      `SELECT admin_id, access_token, is_deleted 
       FROM admin_system 
       WHERE email = $1 
       LIMIT 1`,
      [email]
    );

    if (users.length === 0) {
      return res.status(404).json({ authenticated: false, message: 'User not found' });
    }

    const user = users[0];

    // 5. เช็คว่า User ยังมีสิทธิ์ใช้งานอยู่ไหม (Soft Delete check)
    if (user.is_deleted) {
      return res.status(403).json({ authenticated: false, message: 'Account deactivated' });
    }

    // 6. เช็ค Session Mismatch
    if (user.access_token !== access_token) {
      return res.status(401).json({ authenticated: false, message: 'Session mismatch or expired' });
    }

    // 7. Session ถูกต้อง
    return res.status(200).json({ 
      authenticated: true,
      admin_id: user.admin_id 
    });

  } catch (error) {
    console.error("CheckSession Error:", error);
    return res.status(500).json({ 
      authenticated: false, 
      message: 'Server Error', 
      error: error.message 
    });
  }
}