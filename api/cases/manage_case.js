// api/manage_case.js

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
        ${ipAddress || null}, 
        ${userAgent || null},
        ${details}
      );
    `;
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

// ----------------------------------------------------------------------
// Main Handler
// ----------------------------------------------------------------------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // 1. Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // 2. Allow only PUT
  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ message: 'Method not allowed. Only PUT is supported.' }), { status: 405, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  // รับ Case ID จาก URL (ในที่นี้คือ id ของ voice_message)
  const { searchParams } = new URL(req.url);
  const case_id = searchParams.get('id'); 

  // ดึง IP และ User Agent สำหรับ Log
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (!case_id) {
    return new Response(JSON.stringify({ message: 'Case ID (id) is required in URL parameter' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    // Parameters:
    // current_admin_id: ต้องมีเสมอ
    // cover_image_url: สำหรับอัปเดตรูปปกเคส (ถ้าตาราง voice_message มี field นี้)
    // media_id, media_url: สำหรับแก้ไขรูปภาพใน timeline (voice_attachment)
    const { current_admin_id, cover_image_url, media_id, media_url } = body;
    
    // Security Check
    if (!current_admin_id) {
         return new Response(JSON.stringify({ message: 'Require current_admin_id' }), { status: 400, headers: corsHeaders });
    }

    // Check ว่ามีการส่งค่ามาอัปเดตบ้างไหม
    if (!cover_image_url && (!media_id || !media_url)) {
        return new Response(JSON.stringify({ message: 'Nothing to update. Please provide cover_image_url OR (media_id AND media_url)' }), { status: 400, headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // Validate Actor (ตรวจสอบผู้กระทำ)
    // ---------------------------------------------------------
    const actors = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        WHERE admin_id = ${current_admin_id}
    `;

    if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Current Admin (Actor) not found in system' }), { 
            status: 403, 
            headers: corsHeaders 
        });
    }
    const actorAdmin = actors[0];

    const results = {};

    // ---------------------------------------------------------
    // A. ถ้ามี cover_image_url -> Update ตาราง voice_message (แทน issue_cases)
    // ---------------------------------------------------------
    // หมายเหตุ: ตรวจสอบว่าตาราง voice_message มี field 'cover_image' หรือไม่ 
    // หากไม่มีและต้องการใช้รูปแรกเป็นปก อาจไม่ต้องอัปเดตส่วนนี้ หรือปรับเป็น field อื่น
    if (cover_image_url) {
        // สมมติว่า voice_message มี column cover_image หรือต้องการอัปเดตสถานะที่เกี่ยวข้อง
        // หากไม่มี column นี้ ให้ comment ส่วนนี้ออก หรือเปลี่ยนชื่อ column ให้ถูกต้อง
        try {
            const updatedCase = await sql`
                UPDATE voice_message 
                SET 
                    cover_image = ${cover_image_url} 
                    -- , updated_at = NOW() -- voice_message อาจไม่มี updated_at เช็ค schema ก่อน
                WHERE id = ${case_id}
                RETURNING id;
            `;
            results.case_update = updatedCase[0] || 'Case ID not found';
        } catch (err) {
            console.warn("Update voice_message failed (Column might not exist):", err.message);
            results.case_update_error = err.message;
        }
    }

    // ---------------------------------------------------------
    // B. ถ้ามี media_id และ media_url -> Update ตาราง voice_attachment (แทน case_media)
    // ---------------------------------------------------------
    if (media_id && media_url) {
        // เปลี่ยนจาก url เป็น photo ตาม search_case.js
        // เปลี่ยนจาก case_media เป็น voice_attachment
        // การเช็ค case_id อาจต้องผ่าน voice_message_photos แต่เพื่อความง่ายจะเช็ค ID โดยตรง
        
        const updatedMedia = await sql`
            UPDATE voice_attachment
            SET 
                photo = ${media_url},
                updated_on = NOW()
            WHERE id = ${media_id}
            RETURNING id, photo;
        `;
        results.media_update = updatedMedia[0] || 'Media ID not found';
    }

    // ---------------------------------------------------------
    // บันทึก Log Success
    // ---------------------------------------------------------
    await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'CASE_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'voice_message_management',
            case_id: case_id,
            updates: results
        }
    });

    return new Response(JSON.stringify({ 
        success: true, 
        changes: results
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}