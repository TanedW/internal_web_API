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
        ${ipAddress || null}::inet, 
        ${userAgent || null}::text,
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  
  const { searchParams } = new URL(req.url);
  let case_id = searchParams.get('id'); 

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (case_id) {
    case_id = case_id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  if (!case_id) {
    return new Response(JSON.stringify({ message: 'Case ID is required' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    const { current_admin_id, photo_id, file_url, description, viewed } = body;
    
    if (!current_admin_id || !photo_id || !file_url) {
         return new Response(JSON.stringify({ message: 'Missing required fields' }), { status: 400, headers: corsHeaders });
    }

    const cleanPhotoId = photo_id.toString().replace(/[^a-zA-Z0-9-]/g, '');

    // 1. ตรวจสอบ Admin
    const actors = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        WHERE admin_id = ${current_admin_id}
    `;

    if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Unauthorized: Admin not found' }), { status: 403, headers: corsHeaders });
    }
    const actorAdmin = actors[0];

    // 2. Update Logic (เอา description ออกจากตรงนี้ เพื่อไม่ให้ Error)
    const updatedMedia = await sql`
        UPDATE voice_attachment
        SET 
            photo = ${file_url},
            viewed = ${viewed}, 
            updated_on = NOW()
            -- ลบบรรทัด description = ... ทิ้งไปเลย เพราะตารางนี้ไม่มี column นี้
        WHERE id = ${cleanPhotoId}  
        AND id IN (
            SELECT attachment_id 
            FROM voice_message_photos 
            WHERE message_id = ${case_id}
        )
        RETURNING id, photo, updated_on;
    `;

    if (updatedMedia.length === 0) {
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'CASE_MEDIA_UPDATE',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { 
                reason: 'Photo ID not found or mismatch case',
                case_id: case_id, 
                attachment_id: cleanPhotoId
            }
        });

        return new Response(JSON.stringify({ 
            message: 'Update failed. Photo ID not found or mismatch.' 
        }), { status: 404, headers: corsHeaders });
    }

    // 3. Save Success Log (บันทึก description ลงใน JSON details ของตาราง Log แทน)
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
            attachment_id: cleanPhotoId,
            new_url: file_url,
            new_type_code: viewed,
            old_url: old_url || null, // <--- เพิ่มบรรทัดนี้เพื่อเก็บ URL เก่า
            description: description || "No reason provided" // <--- อยู่ตรงนี้ครับ ถูกต้องตาม requirement
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