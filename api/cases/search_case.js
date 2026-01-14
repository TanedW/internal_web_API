export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// ----------------------------------------------------------------------
// Main Handler
// ----------------------------------------------------------------------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS', // เน้น GET สำหรับการค้นหา
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // Handle CORS Preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
  
  // รับค่า id ที่ส่งมาจากหน้าบ้าน (เช่น ?id=CASE-001)
  const id = searchParams.get('id'); 

  try {
    // =================================================================
    // GET: ค้นหา Case ตาม case_code
    // =================================================================
    if (req.method === 'GET') {
      
      // Validation: ตรวจสอบว่ามีการส่ง ID มาหรือไม่
      if (!id) {
        return new Response(JSON.stringify({ found: false, message: 'Case ID is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Query ค้นหาในตาราง issue_cases ที่ column case_code
      const cases = await sql`
        SELECT * FROM issue_cases 
        WHERE case_code = ${id}
        LIMIT 1; -- เอาแค่รายการเดียวที่เจอ
      `;

      // กรณีไม่เจอข้อมูล
      if (cases.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Case not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // กรณีเจอข้อมูล ส่งข้อมูลกลับไป
      // ปรับโครงสร้างข้อมูลให้ตรงกับที่หน้าบ้านต้องการ (data: ...)
      return new Response(JSON.stringify({ 
        found: true, 
        data: cases[0] 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // กรณี Method อื่นที่ไม่ใช่ GET
    return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ message: 'An error occurred', error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}