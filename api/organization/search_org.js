// api/organization/search_org.js

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
  
  // รับค่า query parameter 'q' ซึ่งอาจจะเป็น ID หรือ Name ก็ได้
  const query = searchParams.get('q'); 

  try {
    if (req.method === 'GET') {
      if (!query) {
        return new Response(JSON.stringify({ found: false, message: 'Search query (ID or Name) is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ตรวจสอบว่าเป็นตัวเลขหรือไม่ เพื่อแยกแยะการค้นหาด้วย ID หรือ Name
      const isNumeric = !isNaN(query);

      // -----------------------------------------------------
      // ค้นหาข้อมูลจากตาราง voice_fonduegroup
      // -----------------------------------------------------
const groups = await sql`
SELECT 
    g.id,
    g.name,
    g.photo,
    g.official_group, -- ดึงค่า boolean ของ Official Account
    g.allow_csv,      -- ดึงค่า boolean ของสิทธิ์การดาวน์โหลด CSV
    -- ถ้า deleted_at เป็น null ให้บอกว่า 'active' ถ้ามีค่าให้ส่ง 'deleted'
    CASE 
      WHEN g.deleted_at IS NULL THEN 'active'
      ELSE 'deleted' 
    END AS status,
    g.deleted_at,
    COALESCE(
      json_agg(
        json_build_object(
          'id', c.id,
          'code', c.code,
          'code_staff', c.code_staff
        )
      ) FILTER (WHERE c.id IS NOT NULL), '[]'
    ) AS admin_codes
  FROM voice_fonduegroup g
  LEFT JOIN voice_codeclaimadmingroup c ON g.id = c.group_id
  WHERE 
    ${isNumeric ? sql`g.id = ${parseInt(query)}` : sql`g.name ILIKE ${'%' + query + '%'}`}
  GROUP BY g.id;
    `;

      if (groups.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Group not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ 
        found: true, 
        data: groups // ส่งกลับเป็น Array เพราะการค้นหาด้วยชื่ออาจเจอหลายรายการ
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