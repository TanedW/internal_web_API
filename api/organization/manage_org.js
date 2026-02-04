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
  'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
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

  // ----------------------------------------------------------------------
  // CASE: SOFT DELETE (Method DELETE)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id } = await req.json();

      // ตรวจสอบ Admin
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      }
      const actorAdmin = actors[0];

      // ทำ Soft Delete
      const deletedGroup = await sql`
        UPDATE voice_fonduegroup
        SET deleted_at = NOW(), updated_on = NOW()
        WHERE id = ${group_id}
        RETURNING id, name, deleted_at;
      `;

      if (deletedGroup.length === 0) {
        return new Response(JSON.stringify({ message: 'Group not found' }), { status: 404, headers: corsHeaders });
      }

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'GROUP_DELETE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: { group_id, action: 'soft_delete', name: deletedGroup[0].name }
      });

      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Soft deleted successfully',
        status: deletedGroup[0].deleted_at 
      }), { status: 200, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: UPDATE & RESTORE (Method PUT)
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    try {
      const body = await req.json();
      const { current_admin_id, name, file_url, old_name, old_url, restore } = body;

      // ตรวจสอบ Admin
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      }
      const actorAdmin = actors[0];

      // Update Logic (แก้ไข Syntax: เปลี่ยน === เป็น = สำหรับ SQL)
      const updatedGroup = await sql`
        UPDATE voice_fonduegroup
        SET 
            name = COALESCE(${name}, name),
            photo = COALESCE(${file_url}, photo),
            deleted_at = CASE WHEN ${restore} = true THEN NULL ELSE deleted_at END,
            updated_on = NOW()
        WHERE id = ${group_id}
        RETURNING id, name, photo, deleted_at, updated_on;
      `;

      if (updatedGroup.length === 0) {
        return new Response(JSON.stringify({ message: 'Group not found' }), { status: 404, headers: corsHeaders });
      }

      // บันทึก Log
      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: restore ? 'GROUP_RESTORE' : 'GROUP_UPDATE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: { 
          group_id, 
          is_restore: !!restore,
          changes: { name: name !== old_name, photo: file_url !== old_url }
        }
      });

      return new Response(JSON.stringify({ 
        success: true, 
        data: updatedGroup[0],
        status: updatedGroup[0].deleted_at === null ? 'active' : updatedGroup[0].deleted_at
      }), { status: 200, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  // กรณี Method อื่นๆ
  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}