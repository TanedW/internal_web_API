// api/AdminLogin.js
import { neon } from '@neondatabase/serverless';

export const config = {
  runtime: 'edge',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === 'POST') {
    try {
      const { email, first_name, last_name } = await req.json();
      const sql = neon(process.env.DATABASE_URL);

      // 1. ตรวจสอบ User ใน Database
      const existingUser = await sql`SELECT * FROM admin_system WHERE email = ${email} LIMIT 1`;

      if (existingUser.length > 0) {
        // 2. ดึงสิทธิ์จาก Permit.io (ใช้ API ของ Permit โดยตรง)
        const PERMIT_API_KEY = process.env.PERMIT_API_KEY; // ใส่ใน Environment Variable
        
        const permitResponse = await fetch(
          `https://api.permit.io/v2/facts/${process.env.PERMIT_PROJECT_ID}/${process.env.PERMIT_ENV_ID}/users/${email}/roles`,
          {
            headers: {
              'Authorization': `Bearer ${PERMIT_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        let roles = [];
        if (permitResponse.ok) {
          const permitData = await permitResponse.json();
          // permitData มักจะเป็น Array ของ Object เช่น [{ role: 'admin', ... }]
          roles = permitData.map(r => r.role);
        }

        // 3. Update ข้อมูลการ Login ล่าสุด
        const updatedUser = await sql`
          UPDATE admin_system 
          SET first_name = ${first_name}, last_name = ${last_name}, last_login = NOW()
          WHERE email = ${email}
          RETURNING *;
        `;

        // 4. ส่งข้อมูล User พร้อม Roles กลับไป
        const userData = {
          ...updatedUser[0],
          roles: roles.length > 0 ? roles : ['guest'] // ถ้าไม่มีสิทธิ์เลยให้เป็น guest
        };

        return new Response(JSON.stringify(userData), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        return new Response(JSON.stringify({ message: 'Access Denied' }), { 
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ message: 'Error', error: error.message }), { 
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
}