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
  const id = searchParams.get('id'); // รับ case_code (เช่น CASE-001)

  try {
    if (req.method === 'GET') {
      if (!id) {
        return new Response(JSON.stringify({ found: false, message: 'Case ID is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------
      // STEP 1: ค้นหาข้อมูล Case หลักจากตาราง issue_cases
      // -----------------------------------------------------
      // สมมติว่า PK ของ issue_cases ชื่อ 'issue_cases_id' (ตามที่ Foreign Key อ้างถึง)
      const cases = await sql`
        SELECT cover_image_url
        FROM issue_cases 
        WHERE case_code = ${id}
        LIMIT 1;
      `;

      if (cases.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Case not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const foundCase = cases[0]; // เก็บข้อมูล Case ไว้ก่อน

      // -----------------------------------------------------
      // STEP 2: ค้นหารูปภาพทั้งหมดจากตาราง case_media
      // -----------------------------------------------------
      // ใช้ ID จริง (UUID) จาก step 1 ไปค้นหาในตารางรูป
      const images = await sql`
        SELECT id, url, media_type, created_at 
        FROM case_media 
        WHERE case_id = ${foundCase.issue_cases_id} -- ต้องใช้ UUID ของเคสนั้นๆ
        ORDER BY created_at DESC;
      `;

      // -----------------------------------------------------
      // STEP 3: รวมข้อมูลแล้วส่งกลับ
      // -----------------------------------------------------
      // ยัดรูปที่เจอ ใส่เข้าไปใน field ชื่อ 'images' (เป็น Array)
      const resultData = {
        ...foundCase,
        images: images // ส่งไปเป็น Array [] แม้จะมีรูปเดียวหรือไม่มีเลย
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