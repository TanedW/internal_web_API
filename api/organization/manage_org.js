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
    group_id = group_id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  if (!group_id) {
    return new Response(JSON.stringify({ message: 'Group ID is required' }), { status: 400, headers: corsHeaders });
  }

  // ----------------------------------------------------------------------
  // CASE: DELETE (Soft Delete)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id, description } = await req.json();
      if (!description || description.trim() === "") {
        return new Response(JSON.stringify({ message: 'Description is required' }), { status: 400, headers: corsHeaders });
      }

      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      const deletedGroup = await sql`
        UPDATE voice_fonduegroup
        SET deleted_at = NOW(), updated_on = NOW()
        WHERE id = ${group_id}
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
        old_url,
        old_official, // เพิ่มการรับค่าเดิมจากหน้าบ้าน
        old_download  // เพิ่มการรับค่าเดิมจากหน้าบ้าน
      } = body;

      if (restore === true && (!description || description.trim() === "")) {
        return new Response(JSON.stringify({ message: 'Description is required for restoration' }), { status: 400, headers: corsHeaders });
      }

      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      let logDetails = { 
          target: 'voice_fonduegroup',
          group_id: group_id,
          description: description || "ปรับปรุงข้อมูล"
      };

      // 1. ตรวจสอบการเปลี่ยน Official Group
      if (typeof official_group !== 'undefined' && official_group !== old_official) {
          logDetails.action = `switch official from ${old_official} to ${official_group}`;
      }

      // 2. ตรวจสอบการเปลี่ยน Download CSV
      if (typeof download_csv !== 'undefined' && download_csv !== old_download) {
          // หากมีการสลับ official ไปก่อนหน้าแล้ว อาจจะใช้ concat หรือเก็บแยกตามความเหมาะสม
          // ในที่นี้ถ้าเปลี่ยนทั้งคู่ จะบันทึกอันล่าสุด หรือคุณสามารถปรับเป็น array ได้
          logDetails.action = `switch download_csv from ${old_download} to ${download_csv}`;
      }

      // 3. ตรวจสอบการ Restore (ให้ Priority สูงสุดในเรื่อง Action name)
      if (restore === true) {
          logDetails.action = "restore";
      }

      // เก็บประวัติชื่อและ URL หากมีการเปลี่ยน
      if (name && name !== old_name) {
          logDetails.new_name = name;
          logDetails.old_name = old_name;
      }
      if (file_url && file_url !== old_url) {
          logDetails.new_url = file_url;
          logDetails.old_url = old_url;
      }

      const updatedGroup = await sql`
        UPDATE voice_fonduegroup
        SET 
          name = COALESCE(${name}, name),
          photo = COALESCE(${file_url}, photo),
          official_group = ${typeof official_group !== 'undefined' ? official_group : sql`official_group`},
          download_csv = ${typeof download_csv !== 'undefined' ? download_csv : sql`download_csv`},
          deleted_at = CASE WHEN ${restore} = true THEN NULL ELSE deleted_at END,
          updated_on = NOW()
        WHERE id = ${group_id}
        RETURNING id, name, photo, official_group, download_csv, deleted_at, updated_on;
      `;

      if (updatedGroup.length === 0) return new Response(JSON.stringify({ message: 'Group not found' }), { status: 404, headers: corsHeaders });

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
        data: updatedGroup[0]
      }), { status: 200, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ message: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};