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

// ฟังก์ชันบันทึก Log
async function saveLoginLog(sql, { adminId, ipAddress, status, email, first_name, last_name, userAgent }) {
  try {
    // ใช้ || null เพื่อกันค่า undefined กรณีเกิด Error ก่อนได้ค่า name
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
    // ถ้าบันทึก Log ไม่สำเร็จ ให้แค่แสดง Error แต่ห้ามทำให้ระบบ Login หลักพัง
    console.error("Error saving log:", e);
  }
}

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
    
    // ประกาศตัวแปรไว้นอก Try เพื่อให้ Catch block มองเห็น
    let email = null; 
    let first_name = null;
    let last_name = null;
    
    try {
      const body = await req.json();
      email = body.email;
      first_name = body.first_name;
      last_name = body.last_name;
      const { access_token } = body;
      
      // เชื่อมต่อ Database
      const sql = neon(process.env.DATA_BASE_URL);

      // 3. Check existing user in admin_system
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email}`;

      if (existingUser.length > 0) {
        // --- Case 1: User exists -> Update Name & Token ---
        const updatedUser = await sql`
            UPDATE admin_system SET 
              "access_token" = ${access_token}, 
              "last_name" = ${last_name}, 
              "first_name" = ${first_name}
            WHERE "email" = ${email} 
            RETURNING *;
          `;
        
        // บันทึก Log: Success (Existing User)
        await saveLoginLog(sql, {
          adminId: updatedUser[0].admin_id, 
          email: email,
          first_name, 
          last_name, 
          ipAddress, 
          userAgent, // เพิ่ม userAgent ที่เคยขาดไป
          status: 'SUCCESS'
        });

        return new Response(JSON.stringify(updatedUser[0]), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        // --- Case 2: Create New User ---
        const newUser = await sql`
          INSERT INTO admin_system ("email", "first_name", "last_name", "access_token") 
          VALUES (${email}, ${first_name}, ${last_name}, ${access_token}) 
          RETURNING *;
        `;
        
        // บันทึก Log: Success (New User)
        await saveLoginLog(sql, {
          adminId: newUser[0].admin_id, // แก้ไข: เปลี่ยนจาก userId เป็น adminId ให้ตรงกับฟังก์ชัน
          email: email,
          first_name, 
          last_name, 
          ipAddress, 
          userAgent, 
          status: 'SUCCESS'
        });

        return new Response(JSON.stringify(newUser[0]), { 
            status: 201, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error("API Error:", error);

      // บันทึก Log: Failed Attempt
      try {
          const sql = neon(process.env.DATA_BASE_URL);
          await saveLoginLog(sql, {
            adminId: null, // Login พลาด ไม่มี Admin ID
            email: email || 'unknown',
            first_name: first_name, // ส่งค่าเท่าที่มี (อาจเป็น null)
            last_name: last_name,   // ส่งค่าเท่าที่มี (อาจเป็น null)
            ipAddress, 
            userAgent, 
            status: 'FAILED'
          });
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