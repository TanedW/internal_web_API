// api/manage_org.js

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
  // เปลี่ยนจาก id (case) เป็น group_id เพื่อความชัดเจน
  let group_id = searchParams.get('id'); 

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  if (group_id) {
    group_id = group_id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  if (!group_id) {
    return new Response(JSON.stringify({ message: 'Group ID is required' }), { status: 400, headers: corsHeaders });
  }

  try {
    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
    }

    // รับค่า name และ file_url (photo) จาก body
    const { current_admin_id, name, file_url, description, old_name, old_url } = body;
    
    if (!current_admin_id || (!name && !file_url)) {
         return new Response(JSON.stringify({ message: 'Missing required fields (Admin ID and Name or Photo)' }), { status: 400, headers: corsHeaders });
    }

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

    // 2. Update Logic สำหรับตาราง voice_fonduegroup
    const updatedGroup = await sql`
        UPDATE voice_fonduegroup
        SET 
            name = COALESCE(${name}, name),
            photo = COALESCE(${file_url}, photo),
            updated_on = NOW()
        WHERE id = ${group_id}
        RETURNING id, name, photo, updated_on;
    `;

    if (updatedGroup.length === 0) {
        await saveAdminLog(sql, {
            adminId: actorAdmin.admin_id,
            email: actorAdmin.email,
            first_name: actorAdmin.first_name,
            last_name: actorAdmin.last_name,
            action_type: 'ORGANIZATION_UPDATE',
            status: 'FAILED',
            ipAddress,
            userAgent,
            details: { 
                reason: 'Group ID not found',
                group_id: group_id
            }
        });

        return new Response(JSON.stringify({ 
            message: 'Update failed. Group ID not found.' 
        }), { status: 404, headers: corsHeaders });
    }

    // 3. Save Success Log
    await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'GROUP_UPDATE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { 
            target: 'voice_fonduegroup',
            group_id: group_id, 
            new_name: name,
            new_url: file_url,
            old_name: old_name || null,
            old_url: old_url || null,
            description: description || "Updated group info"
        }
    });

    return new Response(JSON.stringify({ 
        success: true, 
        data: updatedGroup[0]
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}