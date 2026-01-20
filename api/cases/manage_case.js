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

  // 2. อนุญาตเฉพาะ PUT
  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ message: 'Method not allowed. Only PUT is supported.' }), { status: 405, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  // รับ Case ID จาก URL
  const { searchParams } = new URL(req.url);
  let case_id = searchParams.get('id'); 

// --- แก้ไขจุดที่ 1: เปลี่ยนวิธี Sanitize Case ID ให้เข้มงวดขึ้น ---
  // เดิม: case_id = case_id.replace(/['"]+/g, '');
  // ใหม่: เก็บเฉพาะ a-z, A-Z, 0-9 และ - เท่านั้น (กำจัด quotes, spaces, newline ทิ้งหมด)
  if (case_id) {
    case_id = case_id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (!case_id) {
    return new Response(JSON.stringify({ message: 'Case ID is required in URL parameter' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    const { current_admin_id, photo_id, file_url } = body;
    
    if (!current_admin_id) {
         return new Response(JSON.stringify({ message: 'Require current_admin_id' }), { status: 400, headers: corsHeaders });
    }

    if (!photo_id || !file_url) {
        return new Response(JSON.stringify({ message: 'Require photo_id and file_url to update.' }), { status: 400, headers: corsHeaders });
    }

    // --- แก้ไขจุดที่ 2 (สำคัญมาก): Sanitize photo_id ---
    // บรรทัดนี้จะลบเครื่องหมายฟันหนูส่วนเกินออก ป้องกัน Error 500
    const cleanPhotoId = photo_id.toString().replace(/[^a-zA-Z0-9-]/g, '');

    // ตรวจสอบ Admin ผู้ทำรายการ
    const actors = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        WHERE admin_id = ${current_admin_id}
    `;

    if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Current Admin not found' }), { status: 403, headers: corsHeaders });
    }
    const actorAdmin = actors[0];

    // ---------------------------------------------------------
    // Update Logic
    // ---------------------------------------------------------
    
    console.log("Sanitized IDs:", { case_id, cleanPhotoId });

    // สำคัญ: ตรงนี้ต้องใช้ตัวแปร cleanPhotoId ที่ทำความสะอาดแล้ว
    const updatedMedia = await sql`
        UPDATE voice_attachment
        SET 
            photo = ${file_url},
            updated_on = NOW()
        WHERE id = ${cleanPhotoId}  
        AND id IN (
            SELECT attachment_id 
            FROM voice_message_photos 
            WHERE message_id = ${case_id}
        )
        RETURNING id, photo, updated_on;
    `;

    if (updatedMedia.length === 0) {
        return new Response(JSON.stringify({ 
            message: 'Update failed. Photo ID not found or mismatch.' 
        }), { status: 404, headers: corsHeaders });
    }

    // บันทึก Log ความสำเร็จ
    await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'CASE_MEDIA_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'voice_attachment',
            case_id: case_id, 
            attachment_id: cleanPhotoId, // บันทึก ID ที่ถูกต้องลง Log
            new_url: file_url        
        }
    });

    return new Response(JSON.stringify({ 
        success: true, 
        data: updatedMedia[0]
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: error.message, details: error }), { status: 500, headers: corsHeaders });
  }
}