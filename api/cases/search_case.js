// api/cases/search_case.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id'); // รับ ticket_id (เช่น TKT-20260115-0001)

  try {
    if (req.method === 'GET') {
      if (!id) {
        return new Response(JSON.stringify({ found: false, message: 'Ticket ID is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------
      // STEP 1: ค้นหาข้อมูลหลักจากตาราง voice_message
      // -----------------------------------------------------
      const cases = await sql`
        SELECT 
          id,
          ticket_id,
          problem_type,
          address,
          status,
          comment,
          timestamp,
          ST_AsText(point) as location -- แปลงพิกัดเป็น Text (เช่น "POINT(100.5 13.7)") เพื่อให้อ่านง่าย
        FROM voice_message
        WHERE ticket_id = ${id}
      `;

      if (cases.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Case not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const foundCase = cases[0]; // เก็บข้อมูล Case หลักไว้

      // -----------------------------------------------------
      // STEP 2: ค้นหา Timeline/รูปภาพ จาก voice_attachment ผ่านตารางกลาง
      // -----------------------------------------------------
      // ใช้ ID (Integer) จาก Step 1 มาค้นหาความสัมพันธ์
      const timeline = await sql`
        SELECT 
          a.id, 
          a.note, 
          a.viewed, -- (0=img/text, 1=video, 2=file, 3=audio)
          a.photo, 
          a.updated_on, 
          a.status
        FROM voice_attachment a
        JOIN voice_message_photos mp ON a.id = mp.attachment_id
        WHERE mp.message_id = ${foundCase.id}
        ORDER BY a.updated_on ASC; -- เรียงตามลำดับเวลาที่เกิดขึ้น
      `;

      // -----------------------------------------------------
      // STEP 3: รวมข้อมูลส่งกลับ
      // -----------------------------------------------------
      const resultData = {
        ...foundCase,
        timeline: timeline // ส่งกลับเป็น Array ของเหตุการณ์ทั้งหมด
      };

      return new Response(JSON.stringify({ 
        found: true, 
        data: resultData 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ message: 'Error', error: error.message }), { status: 500, headers: corsHeaders });
  }
}
