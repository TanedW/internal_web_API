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

export default async function handler(req) {
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === 'POST') {
    const forwarded = req.headers.get('x-forwarded-for');
    const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
    const userAgent = req.headers.get('user-agent') || null;
    
    let email = null; 
    let first_name = null;
    let last_name = null;
    
    try {
      const body = await req.json();
      email = body.email;
      first_name = body.first_name;
      last_name = body.last_name;
      profile_url = body.photoURL;
      const { access_token } = body;
      
      const sql = neon(process.env.DATA_BASE_URL);

      // Check existing user
      const existingUser = await sql`SELECT * FROM admin_system WHERE "email" = ${email}`;

      if (existingUser.length > 0) {
        // --- Case 1: พบผู้ใช้ในระบบ -> อนุญาตให้ Login ---
        const updatedUser = await sql`
            UPDATE admin_system SET 
              "access_token" = ${access_token}, 
              "last_name" = ${last_name}, 
              "first_name" = ${first_name},
              "profile_url" = ${profile_url},
            WHERE "email" = ${email} 
            RETURNING *;
          `;
        
        await saveLoginLog(sql, {
          adminId: updatedUser[0].admin_id, 
          email: email,
          first_name, 
          last_name, 
          ipAddress, 
          userAgent,
          status: 'SUCCESS'
        });

        return new Response(JSON.stringify(updatedUser[0]), { 
            status: 200, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } else {
        // --- Case 2: ไม่พบผู้ใช้ (New User) -> ปฏิเสธการเข้าใช้งาน (REJECT) ---
        
        // บันทึก Log: Failed Attempt (Unauthorized)
        await saveLoginLog(sql, {
          adminId: null,
          email: email,
          first_name, 
          last_name, 
          ipAddress, 
          userAgent, 
          status: 'FAILED_UNAUTHORIZED' // ระบุสถานะว่าไม่มีสิทธิ์
        });

        // ส่ง error กลับไปให้ Frontend (403 Forbidden)
        return new Response(JSON.stringify({ 
            message: 'Access Denied: Your email is not authorized.' 
        }), { 
            status: 403, // หรือ 401
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error("API Error:", error);

      try {
          const sql = neon(process.env.DATA_BASE_URL);
          await saveLoginLog(sql, {
            adminId: null,
            email: email || 'unknown',
            first_name,
            last_name,
            ipAddress, 
            userAgent, 
            status: 'FAILED_ERROR'
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