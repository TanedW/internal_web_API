// /api/AdminList.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

// ฟังก์ชันบันทึก Log สำหรับ AdminList
async function saveAdminLog(sql, { adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  try {
    await sql`
      INSERT INTO admin_system_logs 
      (admin_id, email, first_name, last_name, action_type, status, ip_address, user_agent, details)
      VALUES (
        ${adminId || null}, 
        ${email || null}, 
        ${first_name || null}, 
        ${last_name || null}, 
        ${action_type}, 
        ${status}, 
        ${ipAddress || null}, 
        ${userAgent || null},
        ${details || null}
      );
    `;
  } catch (e) {
    console.error("Error saving admin log:", e);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // Handle CORS Preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const sql = neon(process.env.DATA_BASE_URL);
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : null;
  const userAgent = req.headers.get('user-agent') || null;

  try {
    // Handle GET request (Read)
    if (req.method === 'GET') {
      const admins = await sql`
        SELECT admin_id, email, first_name, last_name 
        FROM admin_system 
        ORDER BY admin_id;
      `;
      return new Response(JSON.stringify(admins), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle POST request (Create)
    if (req.method === 'POST') {
      const { email, first_name, last_name } = await req.json();
      if (!email || !first_name || !last_name) {
        return new Response(JSON.stringify({ message: 'Email, first_name, and last_name are required' }), { status: 400, headers: corsHeaders });
      }
      const newUser = await sql`
        INSERT INTO admin_system (email, first_name, last_name) 
        VALUES (${email}, ${first_name}, ${last_name}) 
        RETURNING *;
      `;
      await saveAdminLog(sql, {
        adminId: newUser[0].admin_id,
        email: newUser[0].email,
        first_name: newUser[0].first_name,
        last_name: newUser[0].last_name,
        action_type: 'ADMIN_ADD',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { new_admin_id: newUser[0].admin_id, email: newUser[0].email }
      });
      return new Response(JSON.stringify(newUser[0]), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle PUT request (Update)
    if (req.method === 'PUT') {
      if (!id) {
        return new Response(JSON.stringify({ message: 'Admin ID is required for update' }), { status: 400, headers: corsHeaders });
      }
      const { first_name, last_name, email } = await req.json();
      const updatedUser = await sql`
        UPDATE admin_system 
        SET 
          first_name = ${first_name}, 
          last_name = ${last_name},
          email = ${email}
        WHERE admin_id = ${id}
        RETURNING *;
      `;
      if (updatedUser.length === 0) {
        return new Response(JSON.stringify({ message: 'Admin not found' }), { status: 404, headers: corsHeaders });
      }
      return new Response(JSON.stringify(updatedUser[0]), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle DELETE request (Delete)
    if (req.method === 'DELETE') {
      if (!id) {
        return new Response(JSON.stringify({ message: 'Admin ID is required for deletion' }), { status: 400, headers: corsHeaders });
      }
      const deletedUser = await sql`
        DELETE FROM admin_system 
        WHERE admin_id = ${id}
        RETURNING *;
      `;
      if (deletedUser.length === 0) {
        await saveAdminLog(sql, {
          adminId: id,
          action_type: 'ADMIN_DELETE',
          status: 'FAILED',
          ipAddress,
          userAgent,
          details: { message: 'Admin not found for deletion' }
        });
        return new Response(JSON.stringify({ message: 'Admin not found' }), { status: 404, headers: corsHeaders });
      }
      await saveAdminLog(sql, {
        adminId: id,
        email: deletedUser[0].email,
        first_name: deletedUser[0].first_name,
        last_name: deletedUser[0].last_name,
        action_type: 'ADMIN_DELETE',
        status: 'SUCCESS',
        ipAddress,
        userAgent,
        details: { deleted_admin_id: id, email: deletedUser[0].email }
      });
      return new Response(JSON.stringify({ message: 'Admin deleted successfully' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If method is not handled
    return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ message: 'An error occurred', error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}