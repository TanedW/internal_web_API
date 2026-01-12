// /api/AdminList.js

export const config = {
  runtime: 'edge',
};

import { neon } from '@neondatabase/serverless';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  // Handle CORS Preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Handle GET request to fetch admin list
  if (req.method === 'GET') {
    try {
      // Connect to the database
      const sql = neon(process.env.DATA_BASE_URL);

      // Fetch first_name and last_name from the admin_system table
      const admins = await sql`
        SELECT first_name, last_name 
        FROM admin_system;
      `;

      // Return the list of admins
      return new Response(JSON.stringify(admins), {
        status: 200,
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

  // Handle other methods
  return new Response(JSON.stringify({ message: `Method ${req.method} Not Allowed` }), {
    status: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
