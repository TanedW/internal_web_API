// api/flex_message/manage_flex_message.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

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
        headers: corsHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: PUT - แก้ไขข้อมูล (โค้ดเดิมที่คุณมี)
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    const { searchParams } = new URL(req.url);
    let flex_id = searchParams.get('id');

    if (!flex_id) {
      return new Response(JSON.stringify({ message: 'Flex Message ID is required' }), { status: 400, headers: corsHeaders });
    }

    try {
      const body = await req.json();
      const { current_admin_id, flex_name, flex_data, comment, quick_reply } = body;

      // อัปเดตข้อมูล
      const updatedFlex = await sql`
        UPDATE public.flex_message
        SET 
            flex_name = COALESCE(${flex_name}, flex_name),
            flex_data = COALESCE(${flex_data}, flex_data),
            comment = COALESCE(${comment}, comment),
            quick_reply = COALESCE(${quick_reply}, quick_reply),
            updated_on = NOW()
        WHERE id = ${flex_id}
        RETURNING *;
      `;

      if (updatedFlex.length === 0) {
        return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, data: updatedFlex[0] }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}