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
        ${adminId}::integer,       
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
    group_id = group_id.replace(/[^0-9]/g, ''); // กรองให้เหลือแต่ตัวเลขสำหรับ ID
  }

  if (!group_id) {
    return new Response(JSON.stringify({ message: 'Group ID is required' }), { status: 400, headers: corsHeaders });
  }

  // ----------------------------------------------------------------------
  // CASE: SOFT DELETE (DELETE Method)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id, description } = await req.json();

      if (!description || description.trim() === "") {
        return new Response(JSON.stringify({ message: 'Description is required for deletion' }), { status: 400, headers: corsHeaders });
      }

      // ใช้ ::integer เพื่อเปรียบเทียบ ID
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}::integer`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      const deletedGroup = await sql`
        UPDATE voice_fonduegroup
        SET deleted_at = NOW(), updated_on = NOW()
        WHERE id = ${group_id}::integer
        RETURNING id, name, deleted_at;
      `;

      if (deletedGroup.length === 0) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: corsHeaders });

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: 'GROUP_DELETE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: { target: 'voice_fonduegroup', group_id, action: 'soft_delete', description: description }
      });

      return new Response(JSON.stringify({ success: true, data: deletedGroup[0] }), { status: 200, headers: corsHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: UPDATE & RESTORE (PUT Method)
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    try {
      const body = await req.json();
      const { 
        current_admin_id, 
        name, 
        file_url, 
        description, 
        official_group, 
        download_csv,
        restore,
        old_name,
        old_url
      } = body;

      if (restore === true && (!description || description.trim() === "")) {
        return new Response(JSON.stringify({ message: 'Description is required for restoration' }), { status: 400, headers: corsHeaders });
      }

      // 1. ดึงข้อมูลผู้กระทำ (Cast ID เป็น integer)
      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}::integer`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      // 2. ดึงข้อมูลเดิม (Cast ID เป็น integer)
      const currentGroupData = await sql`SELECT official_group, download_csv FROM voice_fonduegroup WHERE id = ${group_id}::integer`;
      if (currentGroupData.length === 0) return new Response(JSON.stringify({ message: 'Group not found' }), { status: 404, headers: corsHeaders });
      const oldGroup = currentGroupData[0];

      let logDetails = { 
          target: 'voice_fonduegroup',
          group_id: group_id,
          description: description || ""
      };

      if (restore === true) {
          logDetails.action = "restore";
      } else {
          if (official_group !== undefined && official_group !== null && official_group !== oldGroup.official_group) {
              logDetails.action = `switch official from ${oldGroup.official_group} to ${official_group}`;
          } 
          else if (download_csv !== undefined && download_csv !== null && download_csv !== oldGroup.download_csv) {
              logDetails.action = `switch download_csv from ${oldGroup.download_csv} to ${download_csv}`;
          }
          else if (name && name !== old_name) {
              logDetails.action = "update_info";
              logDetails.new_name = name;
              logDetails.old_name = old_name;
          } else {
              logDetails.action = "update_info";
          }
      }

      // 3. ทำการอัปเดต (ตรวจสอบ Type Casting ทั้งหมด)
      const updatedGroup = await sql`
        UPDATE voice_fonduegroup
        SET 
          name = COALESCE(${name}::text, name),
          photo = COALESCE(${file_url}::text, photo),
          official_group = CASE 
            WHEN ${official_group}::boolean IS NOT NULL THEN ${official_group}::boolean 
            ELSE official_group 
          END,
          download_csv = CASE 
            WHEN ${download_csv}::boolean IS NOT NULL THEN ${download_csv}::boolean 
            ELSE download_csv 
          END,
          deleted_at = CASE 
            WHEN ${restore}::boolean = true THEN NULL 
            ELSE deleted_at 
          END,
          updated_on = NOW()
        WHERE id = ${group_id}::integer
        RETURNING id, name, photo, official_group, download_csv, deleted_at, updated_on;
      `;

      await saveAdminLog(sql, {
        adminId: actorAdmin.admin_id,
        email: actorAdmin.email,
        first_name: actorAdmin.first_name,
        last_name: actorAdmin.last_name,
        action_type: restore ? 'GROUP_RESTORE' : 'GROUP_UPDATE',
        status: 'SUCCESS',
        ipAddress, userAgent,
        details: logDetails
      });

      return new Response(JSON.stringify({ 
        success: true, 
        data: updatedGroup[0],
        status: updatedGroup[0].deleted_at === null ? 'active' : updatedGroup[0].deleted_at
      }), { status: 200, headers: corsHeaders });

    } catch (error) {
      console.error("Update Error:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}