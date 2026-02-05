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
  // CASE: SOFT DELETE (DELETE Method)
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id, description } = await req.json();

      if (!description || description.trim() === "") {
        return new Response(JSON.stringify({ message: 'Description is required for deletion' }), { status: 400, headers: corsHeaders });
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
        details: { 
            target: 'voice_fonduegroup', 
            group_id, 
            action: 'soft_delete', 
            description: description 
        }
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
        old_official, // รับค่าเดิมจาก Frontend
        old_download  // รับค่าเดิมจาก Frontend
      } = body;

      if (restore === true && (!description || description.trim() === "")) {
        return new Response(JSON.stringify({ message: 'Description is required for restoration' }), { status: 400, headers: corsHeaders });
      }

      const actors = await sql`SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = ${current_admin_id}`;
      if (actors.length === 0) return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 403, headers: corsHeaders });
      const actorAdmin = actors[0];

      // เตรียมโครงสร้าง Log
      let logDetails = { 
          target: 'voice_fonduegroup',
          group_id: group_id,
          description: description || "ปรับปรุงข้อมูล"
      };

      let actions = [];

      // ตรวจสอบการเปลี่ยนแปลงทีละส่วนเพื่อสร้าง Action String
      if (restore === true) {
          actions.push("restore");
      } else {
          // เช็ค Official Group
          if (typeof official_group !== 'undefined' && official_group !== old_official) {
              actions.push(`switch official from ${old_official} to ${official_group}`);
          }
          // เช็ค Download CSV
          if (typeof download_csv !== 'undefined' && download_csv !== old_download) {
              actions.push(`switch download_csv from ${old_download} to ${download_csv}`);
          }
          // เช็คการเปลี่ยนชื่อ
          if (name && name !== old_name) {
              actions.push(`change name`);
              logDetails.old_name = old_name;
              logDetails.new_name = name;
          }
          // เช็คการเปลี่ยนรูป
          if (file_url && file_url !== old_url) {
              actions.push(`change photo`);
              logDetails.old_url = old_url; // เพิ่มการเก็บค่า URL เดิม
              logDetails.new_url = file_url; // เพิ่มการเก็บค่า URL ใหม่
          }
      }

      // รวม actions เป็น string เดียวกัน (เช่น "switch official from false to true, switch download_csv from true to false")
      logDetails.action = actions.length > 0 ? actions.join(", ") : "update_info";

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