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
  const id = searchParams.get('id');

  try {
    if (req.method === 'GET') {
      if (!id) {
        return new Response(JSON.stringify({ found: false, message: 'Ticket ID is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------
      // STEP 1: ค้นหาข้อมูลหลัก + ข้อมูล QR Code (type_qr = 'report-org')
      // -----------------------------------------------------
      // ทำการ Left Join กับตาราง QR โดยใช้ group_id เป็นตัวเชื่อม
      const cases = await sql`
        SELECT 
          v.id,
          v.ticket_id,
          v.problem_type,
          v.address,
          v.status,
          v.comment,
          v.timestamp,
          v.group_id,
          ST_AsText(v.point) as location,
          q.uuid_qr
        FROM voice_message v
        LEFT JOIN voice_qrcodefonduegroup q ON v.group_id = q.group_id AND q.type_qr = 'report-org'
        WHERE v.ticket_id = ${id}
        LIMIT 1
      `;

      if (cases.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Case not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const foundCase = cases[0];

      // สร้าง URL สำหรับ QR Code ถ้ามี uuid_qr
      const qrImageUrl = foundCase.uuid_qr 
        ? `https://storage.googleapis.com/traffy_public_bucket/traffy_fondue_qrcode/${foundCase.uuid_qr}.jpg`
        : null;

      // -----------------------------------------------------
      // STEP 2: ค้นหา Timeline/รูปภาพ (เหมือนเดิม)
      // -----------------------------------------------------
      const timeline = await sql`
        SELECT 
          a.id, a.note, a.viewed, a.photo, a.updated_on, a.status
        FROM voice_attachment a
        JOIN voice_message_photos mp ON a.id = mp.attachment_id
        WHERE mp.message_id = ${foundCase.id}
        ORDER BY a.updated_on ASC;
      `;

      // -----------------------------------------------------
      // STEP 3: รวมข้อมูลส่งกลับ
      // -----------------------------------------------------
      const resultData = {
        ...foundCase,
        qr_report_url: qrImageUrl, // เพิ่ม Field URL รูปภาพ QR เข้าไป
        timeline: timeline 
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