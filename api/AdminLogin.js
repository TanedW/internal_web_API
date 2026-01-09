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


async function saveLoginLog(sql, { userId, ipAddress, userAgent, status, email, first_name , last_name}) {
  try {
    // หมายเหตุ: ผมเพิ่ม email ลงไปใน log ด้วยเพื่อให้ตรวจสอบง่ายขึ้นกรณี userId เป็น null
    await sql`
      INSERT INTO admin_system_logs (admin_id, email, ip_address, user_agent, status, action_type)
      VALUES (${userId}, ${email}, ${first_name}, ${last_name}, ${ipAddress}, ${userAgent}, ${status}, 'ADMIN_LOGIN');
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
    
    let email, provider; 
    
    try {
      const body = await req.json();
      email = body.email;
      provider = body.provider; 
      const { first_name, last_name, access_token } = body;
      
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
              "first_name" = ${first_name}  -- แก้ไขคำผิดจาก first_n ame เป็น first_name
            WHERE "email" = ${email} 
            RETURNING *;
          `;
        
        // บันทึก Log: Success (Existing User)
        await saveLoginLog(sql, {
          userId: updatedUser[0].admin_id, // หรือ updatedUser[0].id ขึ้นอยู่กับชื่อ column ในตาราง admin_system
          email: email,
          provider, ipAddress, userAgent, status: 'SUCCESS'
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
          userId: newUser[0].admin_id,
          email: email,
          first_name, last_name, ipAddress, userAgent, status: 'SUCCESS'
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
            userId: null, // ไม่มี User ID เพราะ Login พลาด
            email: email || 'unknown', // พยายามเก็บ email ที่ user กรอกมา
            provider, ipAddress, userAgent, status: 'FAILED'
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