// /api/AdminLogin.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // 2. Handle POST
  if (req.method === 'POST') {
    const forwarded = req.headers.get('x-forwarded-for');
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
    const userAgent = req.headers.get('user-agent') || null;
    
    let email, provider; // ยังเก็บ provider ไว้ใช้สำหรับ Log (ถ้าต้องการ)
    
    try {
      const body = await req.json();
      email = body.email;
      provider = body.provider; // รับค่ามาเพื่อบันทึกลง Log ว่า login ด้วยอะไร
      const { first_name, last_name, access_token } = body;
      
      const sql = neon(process.env.DATA_BASE_URL);

      // 3. Check existing user
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email}`;

      if (existingUser.length > 0) {
        // --- Case 1: User exists -> Update Name & Token ONLY ---
        // ตัด logic เรื่อง providers array ทิ้งไป
        const updatedUser = await sql`
            UPDATE admin_system SET 
              "access_token" = ${access_token}, 
              "last_name" = ${last_name}, 
              "first_name" = ${first_name}
            WHERE "email" = ${email} 
            RETURNING *;
          `;
        
        // บันทึก Log การเข้าใช้งาน
        // await saveLoginLog(sql, {
        //   userId: updatedUser[0].user_id,
        //   provider, ipAddress, userAgent, status: 'SUCCESS'
        // });

        return new Response(JSON.stringify(updatedUser[0]), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        // --- Case 2: Create New User ---
        // ตัด field providers ออกจากคำสั่ง INSERT
        const newUser = await sql`
          INSERT INTO admin_system ("email", "first_name", "last_name", "access_token") 
          VALUES (${email}, ${first_name}, ${last_name}, ${access_token}) 
          RETURNING *;
        `;
        
        await (sql, {
          userId: newUser[0].user_id,
          provider, ipAddress, userAgent, status: 'SUCCESS'
        });

        return new Response(JSON.stringify(newUser[0]), { 
            status: 201, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error("API Error:", error);

      // Log Failed Attempt
      try {
          const sql = neon(process.env.DATA_BASE_URL);
          // await saveLoginLog(sql, {
          //   userId: null,
          //   provider, ipAddress, userAgent, status: 'FAILED'
          // });
      } catch (logError) { console.error("Log Error:", logError); }

      return new Response(JSON.stringify({ message: 'An error occurred', error: error.message }), { 
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

// // Helper Function: บันทึกประวัติการ Login (ควรสร้างตาราง login_logs ไว้ด้วย)
// async function saveLoginLog(sql, { userId, provider, ipAddress, userAgent, status }) {
//     try {
//         await sql`
//             INSERT INTO login_logs (user_id, provider, ip_address, user_agent, status)
//             VALUES (${userId}, ${provider}, ${ipAddress}, ${userAgent}, ${status})
//         `;
//     } catch (e) {
//         console.error("Error saving log:", e);
//     }
// }