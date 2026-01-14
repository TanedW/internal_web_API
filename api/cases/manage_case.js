// api/cases/manage_case.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// Helper: Header สำหรับ CORS (ถ้าเรียกจาก domain อื่น หรือ localhost ต่าง port)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // 1. Handle Preflight Request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  // รับ ID จาก URL (สำหรับ GET One, PUT, DELETE)
  // เช่น /api/cases/manage?id=uuid-ของ-case
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id'); 

  try {
    // อ่าน Body (สำหรับ POST, PUT)
    let body = {};
    if (['POST', 'PUT'].includes(req.method)) {
      try {
        body = await req.json();
      } catch (e) { /* body empty */ }
    }

    // =========================================================
    // 🛡️ Security Check: ตรวจสอบคนทำรายการ (Admin)
    // =========================================================
    // สำหรับ POST, PUT, DELETE ต้องส่ง current_admin_id มาด้วยเสมอ
    if (req.method !== 'GET') {
        const { current_admin_id } = body; // หรือรับจาก params สำหรับ DELETE
        if (!current_admin_id && req.method !== 'DELETE') {
             // หมายเหตุ: DELETE ปกติไม่ส่ง body ถ้าจะส่ง admin_id อาจต้องส่งผ่าน query params หรือ header
             // ในตัวอย่างนี้ขอละไว้เน้น Logic หลักครับ
             return new Response(JSON.stringify({ message: 'Require current_admin_id' }), { status: 400, headers: corsHeaders });
        }
        // (ตรงนี้คุณสามารถใส่ Logic บันทึก Log แบบไฟล์ AdminList.js ได้เลย)
    }

    // =========================================================
    // 1. READ (GET) - ดึงข้อมูล
    // =========================================================
    if (req.method === 'GET') {
      if (id) {
        // 1.1 ดึงรายตัว
        const cases = await sql`SELECT * FROM issue_cases WHERE issue_cases_id = ${id}`;
        return new Response(JSON.stringify(cases[0] || {}), { status: 200, headers: corsHeaders });
      } else {
        // 1.2 ดึงทั้งหมด (ควรมี LIMIT)
        const cases = await sql`
            SELECT issue_cases_id, case_code, department, status, cover_image_url, created_at 
            FROM issue_cases 
            ORDER BY created_at DESC 
            LIMIT 50
        `;
        return new Response(JSON.stringify(cases), { status: 200, headers: corsHeaders });
      }
    }

    // =========================================================
    // 2. CREATE (POST) - สร้าง Case ใหม่
    // =========================================================
    if (req.method === 'POST') {
      const { case_code, department, status, cover_image_url, description } = body;

      // Validation เบื้องต้น
      if (!case_code || !department) {
        return new Response(JSON.stringify({ message: 'Missing required fields' }), { status: 400, headers: corsHeaders });
      }

      const newCase = await sql`
        INSERT INTO issue_cases (case_code, department, status, cover_image_url, description)
        VALUES (${case_code}, ${department}, ${status || 'Open'}, ${cover_image_url}, ${description})
        RETURNING *;
      `;

      return new Response(JSON.stringify({ success: true, data: newCase[0] }), { status: 201, headers: corsHeaders });
    }

    // =========================================================
    // 3. UPDATE (PUT) - แก้ไขข้อมูล
    // =========================================================
    if (req.method === 'PUT') {
      if (!id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });
      
      const { status, cover_image_url, department } = body;

      const updatedCase = await sql`
        UPDATE issue_cases 
        SET 
          status = ${status},
          department = ${department},
          cover_image_url = ${cover_image_url},
          updated_at = NOW() -- อย่าลืม update เวลา
        WHERE issue_cases_id = ${id}
        RETURNING *;
      `;

      if (updatedCase.length === 0) return new Response(JSON.stringify({ message: 'Case not found' }), { status: 404, headers: corsHeaders });

      return new Response(JSON.stringify({ success: true, data: updatedCase[0] }), { status: 200, headers: corsHeaders });
    }

    // =========================================================
    // 4. DELETE (DELETE) - ลบข้อมูล
    // =========================================================
    if (req.method === 'DELETE') {
      if (!id) return new Response(JSON.stringify({ message: 'ID required' }), { status: 400, headers: corsHeaders });

      // ลบจริง (Hard Delete)
      const deletedCase = await sql`
        DELETE FROM issue_cases WHERE issue_cases_id = ${id} RETURNING issue_cases_id;
      `;
      
      // หรือถ้าจะทำ Soft Delete (แค่เปลี่ยน status เป็น Cancelled) ให้ใช้ UPDATE แทน

      if (deletedCase.length === 0) return new Response(JSON.stringify({ message: 'Case not found' }), { status: 404, headers: corsHeaders });

      return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200, headers: corsHeaders });
    }

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}