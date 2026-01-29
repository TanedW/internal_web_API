// api/flex_message/manage_flex_message.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log ลง Database
// ----------------------------------------------------------------------
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId},       
        ${email},         
        ${first_name},    
        ${last_name},     
        ${action_type}, 
        ${status}, 
        ${ipAddress || null}::inet, 
        ${userAgent || null}::text,
        ${details}
      );
    `;
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

// ----------------------------------------------------------------------
// Main Handler
// ----------------------------------------------------------------------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  const { searchParams } = new URL(req.url);
  let flex_id = searchParams.get('id'); // ID ของ Flex Message ที่ต้องการแก้ไข

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (!flex_id) {
    return new Response(JSON.stringify({ message: 'Flex Message ID is required' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    // รับค่าให้ตรงกับ Schema ของตาราง flex_message
    const { current_admin_id, flex_name, flex_data, comment, quick_reply } = body;
    
    if (!current_admin_id) {
         return new Response(JSON.stringify({ message: 'Admin ID is required' }), { status: 400, headers: corsHeaders });
    }

    // 1. ตรวจสอบสิทธิ์ Admin
    const actors = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        WHERE admin_id = ${current_admin_id}
    `;

    if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Unauthorized: Admin not found' }), { status: 403, headers: corsHeaders });
    }
    const actorAdmin = actors[0];

    // 2. Update Logic สำหรับตาราง flex_message
    const updatedFlex = await sql`
        UPDATE public.flex_message
        SET 
            flex_name = COALESCE(${flex_name}, flex_name),
            flex_data = COALESCE(${flex_data}, flex_data),
            comment = COALESCE(${comment}, comment),
            quick_reply = COALESCE(${quick_reply}, quick_reply),
            updated_on = NOW()
        WHERE id = ${flex_id}
        RETURNING id, flex_name, updated_on;
    `;

    if (updatedFlex.length === 0) {
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'FLEX_MESSAGE_UPDATE',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { reason: 'Flex ID not found', flex_id: flex_id }
        });

        return new Response(JSON.stringify({ 
            message: 'Update failed. Flex Message ID not found.' 
        }), { status: 404, headers: corsHeaders });
    }

    // 3. บันทึก Log เมื่อสำเร็จ
    await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'flex_message',
            flex_id: flex_id, 
            flex_name: flex_name,
            comment: comment
        }
    });

    return new Response(JSON.stringify({ 
        success: true, 
        data: updatedFlex[0]
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}