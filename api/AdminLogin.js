// api/AdminLogin.js

// 1. ลบบรรทัด runtime: 'edge' ออกถาวร
import { neon } from '@neondatabase/serverless';
import { Permit } from "permitio";

const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

export default async function handler(req, res) { // ใช้ (req, res) แบบ Node.js
  
  // จัดการ CORS แบบ Node.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      // 2. ดึง Headers แบบ Node.js Object
      const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      
      // 3. ดึง Body ตรงๆ (Vercel Node.js parse มาให้แล้ว)
      const { email, first_name, last_name, profile_url, access_token } = req.body;
      
      const sql = neon(process.env.DATA_BASE_URL);
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email} LIMIT 1`;

      if (existingUser.length > 0) {
        const user = existingUser[0];
        
        // --- 🟢 ใช้ SDK ได้ตามปกติใน Node.js Runtime ---
        let userRoles = ['guest'];
        try {
          const permitUser = await permit.api.getUser(user.admin_id.toString());
          if (permitUser?.roles) {
            userRoles = permitUser.roles.map(r => typeof r === 'object' ? r.role : r);
          }
        } catch (e) { console.error("Permit Error:", e.message); }
        // ------------------------------------------

        await sql`UPDATE admin_system SET "access_token" = ${access_token} WHERE "email" = ${email}`;

        // 4. ส่ง Response กลับแบบ .json()
        return res.status(200).json({
          admin_id: user.admin_id,
          roles: userRoles
        });
      }
      return res.status(403).json({ message: "Unauthorized" });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
}