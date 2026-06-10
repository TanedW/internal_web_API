// api/organization/search_org.js

import { query } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { q: searchQueryRaw } = req.query;

  try {
    if (req.method === 'GET') {
      if (!searchQueryRaw) {
        return res.status(400).json({ found: false, message: 'Search query (ID or Name) is required' });
      }

      const isNumeric = !isNaN(searchQueryRaw);
      const searchQuery = isNumeric ? parseInt(searchQueryRaw) : `%${searchQueryRaw}%`;

      const { rows: groups } = await query(`
        SELECT 
          g.id,
          g.name,
          g.photo,
          g.official_group,
          g.download_csv,
          CASE 
            WHEN g.deleted_at IS NULL THEN 'active'
            ELSE 'deleted' 
          END AS status,
          g.deleted_at,
          -- ดึง uuid_qr จากตาราง QR (ระบุชื่อตารางจริงของคุณแทน your_qr_table)
          q.uuid_qr,
          COALESCE(
            json_agg(DISTINCT
              jsonb_build_object(
                'id', c.id,
                'code', c.code,
                'code_staff', c.code_staff
              )
            ) FILTER (WHERE c.id IS NOT NULL), '[]'
          ) AS admin_codes,
          COALESCE(
            jsonb_agg(DISTINCT
              jsonb_build_object(
                'member', m.id,
                'picture_profile', u.document_url,
                'member_firstname', u.first_name,
                'member_lastname', u.last_name,
                'member_phone', u.phone,
                'email', u.email,
                'role', m.role,
                'user_id', m.user_id,
                'created_on', m.created_on 
              )
            ) FILTER (WHERE m.id IS NOT NULL), '[]'
          ) AS members
        FROM voice_fonduegroup g
        LEFT JOIN voice_codeclaimadmingroup c ON g.id = c.group_id
        -- JOIN กับตารางที่เก็บข้อมูลตามรูปภาพที่คุณแนบมา
        LEFT JOIN voice_qrcodefonduegroup q ON g.id = q.group_id AND q.type_qr = 'report-org'
        LEFT JOIN voice_fonduegroupmember m ON g.id = m.group_id
        LEFT JOIN traffy_user u ON m.user_id = u.id

        WHERE 
          ${isNumeric ? 'g.id = $1' : 'g.name ILIKE $1'}
        GROUP BY g.id, q.uuid_qr;
      `, [searchQuery]);

      if (groups.length === 0) {
        return res.status(404).json({ found: false, message: 'Group not found' });
      }

      const mappedGroups = groups.map(group => ({
        ...group,
        qr_report_url: group.uuid_qr 
          ? `https://storage.googleapis.com/traffy_public_bucket/traffy_fondue_qrcode/${group.uuid_qr}.jpg`
          : null
      }));

      return res.status(200).json({ 
        found: true, 
        data: mappedGroups 
      });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ message: 'Error', error: error.message });
  }
}

