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
  
  const query = searchParams.get('q'); 

  try {
    if (req.method === 'GET') {
      if (!query) {
        return new Response(JSON.stringify({ found: false, message: 'Search query (ID or Name) is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const isNumeric = !isNaN(query);

      // -----------------------------------------------------
      // ค้นหาข้อมูลกลุ่ม พร้อม Join ข้อมูล QR Code (type_qr = 'report-org')
      // -----------------------------------------------------
      const groups = await sql`
        SELECT 
          g.id,
          g.name,
          g.photo,
          g.official_group,
          g.download_csv,
          CASE 
            WHEN g.deleted_at IS NULL THEN 'active'
            ELSE 'deleted' 
          END AS status,
          g.deleted_at,
          -- ดึง uuid_qr จากตาราง QR (ระบุชื่อตารางจริงของคุณแทน your_qr_table)
          q.uuid_qr,
          COALESCE(
            json_agg(DISTINCT
              json_build_object(
                'id', c.id,
                'code', c.code,
                'code_staff', c.code_staff
              )
            ) FILTER (WHERE c.id IS NOT NULL), '[]'
          ) AS admin_codes,
          COALESCE(
            json_agg(DISTINCT
              json_build_object(
                'member', m.id,
                'member_name', m.name,
                'member_phone', m.phone,
                'role', m.role,
                'user_id', m.userid,
                'created_on', m.created_on 
              )
            ) FILTER (WHERE c.id IS NOT NULL), '[]'
          ) AS members
        FROM voice_fonduegroup g
        LEFT JOIN voice_codeclaimadmingroup c ON g.id = c.group_id
        -- JOIN กับตารางที่เก็บข้อมูลตามรูปภาพที่คุณแนบมา
        LEFT JOIN voice_qrcodefonduegroup q ON g.id = q.group_id AND q.type_qr = 'report-org'
        LEFT JOIN voice_fonduegroupmember m ON g.id = m.group_id

        WHERE 
        
          ${isNumeric ? sql`g.id = ${parseInt(query)}` : sql`g.name ILIKE ${'%' + query + '%'}`}
        GROUP BY g.id, q.uuid_qr; -- เพิ่ม q.uuid_qr ใน Group By
      `;

      if (groups.length === 0) {
        return new Response(JSON.stringify({ found: false, message: 'Group not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------
      // สร้าง Full URL สำหรับ QR Code ให้แต่ละรายการ
      // -----------------------------------------------------
      const mappedGroups = groups.map(group => ({
        ...group,
        qr_report_url: group.uuid_qr 
          ? `https://storage.googleapis.com/traffy_public_bucket/traffy_fondue_qrcode/${group.uuid_qr}.jpg`
          : null
      }));

      return new Response(JSON.stringify({ 
        found: true, 
        data: mappedGroups 
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