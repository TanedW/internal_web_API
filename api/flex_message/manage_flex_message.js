// api/flex_message/manage_flex_message.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log ลง Database (ใช้เฉพาะตอนมี Action เปลี่ยนแปลงข้อมูล)
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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
  
  // เตรียมข้อมูล IP และ User-Agent สำหรับใช้ใน Log (ถ้ามี Action)
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  // ----------------------------------------------------------------------
  // CASE: GET - ดึงรายการ Flex Message (ไม่มีการลง Log)
  // ----------------------------------------------------------------------
  if (req.method === 'GET') {
    try {
      const messages = await sql`
        SELECT id, flex_name, flex_data, comment, quick_reply, created_on, updated_on 
        FROM public.flex_message 
        ORDER BY updated_on DESC;
      `;
      
      return new Response(JSON.stringify({ success: true, data: messages }), { 
        status: 200, 
        headers: corsHeaders 
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: PUT - แก้ไขข้อมูล และบันทึก Log
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    let flex_id = searchParams.get('id');
    if (!flex_id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });

    try {
      const body = await req.json();
      const { current_admin_id, flex_name, flex_data, comment, quick_reply, description } = body;

      // 1. ตรวจสอบ Admin ผู้กระทำการ
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      // 2. อัปเดตข้อมูลลงตาราง flex_message
      const updatedFlex = await sql`
        UPDATE public.flex_message
        SET 
            flex_name = COALESCE(${flex_name}, flex_name),
            flex_data = COALESCE(${flex_data}, flex_data),
            comment = COALESCE(${comment}, comment),
            quick_reply = COALESCE(${quick_reply}, quick_reply),
            updated_on = NOW()
        WHERE id = ${flex_id}
        RETURNING id, flex_name;
      `;

      if (updatedFlex.length === 0) {
        // บันทึก Log กรณีหา ID ไม่พบ (FAILED)
        await saveAdminLog(sql, { 
          adminId: actorAdmin.admin_id, 
          email: actorAdmin.email, 
          first_name: actorAdmin.first_name, 
          last_name: actorAdmin.last_name, 
          action_type: 'FLEX_MESSAGE_UPDATE', 
          status: 'FAILED', 
          ipAddress, 
          userAgent, 
          details: { flex_id, reason: 'ID not found' } 
        });
        return new Response(JSON.stringify({ message: 'Data not found' }), { status: 404, headers: corsHeaders });
      }

      // 3. บันทึก Log เมื่อแก้ไขสำเร็จ (SUCCESS)
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
          flex_id: updatedFlex[0].id, 
          flex_name: updatedFlex[0].flex_name ,
          description: description || "Updated group info"

          
        }
      });

      return new Response(JSON.stringify({ success: true, data: updatedFlex[0] }), { status: 200, headers: corsHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}