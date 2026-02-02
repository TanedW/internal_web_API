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
        ${JSON.stringify(details)}
      );
    `;
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL); // ตรวจสอบว่าตั้งค่าใน Vercel หรือ .env แล้ว
  const { searchParams } = new URL(req.url);
  
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  // ----------------------------------------------------------------------
  // CASE: GET - ดึงรายการ Flex Message ทั้งหมด
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
  // CASE: POST - สร้าง Flex Message ใหม่
  // ----------------------------------------------------------------------
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { current_admin_id, flex_name, flex_data, comment, quick_reply } = body;

      // ตรวจสอบ Admin ผู้กระทำการ
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      // บันทึกลงตาราง flex_message
      const newFlex = await sql`
        INSERT INTO public.flex_message (flex_name, flex_data, comment, quick_reply, created_on, updated_on)
        VALUES (
            ${flex_name}, 
            ${typeof flex_data === 'object' ? JSON.stringify(flex_data) : flex_data}, 
            ${comment || null}, 
            ${quick_reply || null}, 
            NOW(), 
            NOW()
        )
        RETURNING id, flex_name;
      `;

      // บันทึก Log การสร้าง
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_CREATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'flex_message', flex_id: newFlex[0].id, flex_name: newFlex[0].flex_name }
      });

      return new Response(JSON.stringify({ success: true, data: newFlex[0] }), { status: 201, headers: corsHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: PUT - แก้ไขข้อมูลเดิม
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    let flex_id = searchParams.get('id');
    if (!flex_id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });

    try {
      const body = await req.json();
      const { current_admin_id, flex_name, flex_data, comment, quick_reply, description, old_flex, new_flex } = body;

      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

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
        return new Response(JSON.stringify({ message: 'Data not found' }), { status: 404, headers: corsHeaders });
      }

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { 
          target: 'flex_message', flex_id: updatedFlex[0].id, flex_name: updatedFlex[0].flex_name,
          old_flex, new_flex, description: description || "Updated template info"
        }
      });

      return new Response(JSON.stringify({ success: true, data: updatedFlex[0] }), { status: 200, headers: corsHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}