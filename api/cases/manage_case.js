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
  
  // รับ Case ID จาก URL (message_id ของตาราง voice_message)
  const { searchParams } = new URL(req.url);
  const case_id = searchParams.get('id'); 

  // ดึง IP และ User Agent สำหรับ Log
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (!case_id) {
    return new Response(JSON.stringify({ message: 'Case ID (message_id) is required in URL parameter' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // รับ Parameters ใหม่: photo_id และ file_url
    // ---------------------------------------------------------
    const { current_admin_id, photo_id, file_url } = body;
    
    // Security Check
    if (!current_admin_id) {
         return new Response(JSON.stringify({ message: 'Require current_admin_id' }), { status: 400, headers: corsHeaders });
    }

    // Validate เปลี่ยนชื่อตัวแปรที่เช็ค
    if (!photo_id || !file_url) {
        return new Response(JSON.stringify({ message: 'Require photo_id (attachment_id) and file_url to update.' }), { status: 400, headers: corsHeaders });
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

    // ---------------------------------------------------------
    // Update Logic: อัปเดต voice_attachment
    // ---------------------------------------------------------
    
    const updatedMedia = await sql`
        UPDATE voice_attachment
        SET 
            photo = ${file_url},  -- ใช้ค่า file_url
            updated_on = NOW()
        WHERE id = ${photo_id}    -- ใช้ค่า photo_id
        AND id IN (
            SELECT attachment_id 
            FROM voice_message_photos 
            WHERE message_id = ${case_id}
        )
        RETURNING id, photo, updated_on;
    `;

    if (updatedMedia.length === 0) {
        return new Response(JSON.stringify({ 
            message: 'Update failed. Photo ID not found or does not belong to this Case ID.' 
        }), { status: 404, headers: corsHeaders });
    }

    // ---------------------------------------------------------
    // บันทึก Log Success
    // ---------------------------------------------------------
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
            attachment_id: photo_id, // บันทึกเป็นชื่อ field ใหม่ใน log
            new_url: file_url        // บันทึกเป็นชื่อ field ใหม่ใน log
        }
    });

    return new Response(JSON.stringify({ 
        success: true, 
        data: updatedMedia[0]
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}