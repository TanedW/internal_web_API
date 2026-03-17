// api/cases/search_case.js

import { query } from '../lib/db.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id } = req.query;

  try {
    if (req.method === 'GET') {
      if (!id) {
        return res.status(400).json({ found: false, message: 'Ticket ID is required' });
      }

      // -----------------------------------------------------
      // STEP 1: ค้นหาข้อมูลหลักจากตาราง voice_message
      // -----------------------------------------------------
      const { rows: cases } = await query(`
        SELECT 
          id,
          ticket_id,
          problem_type,
          address,
          status,
          comment,
          timestamp
        FROM voice_message
        WHERE ticket_id = $1
      `, [id]);

      if (cases.length === 0) {
        return res.status(404).json({ found: false, message: 'Case not found' });
      }

      const foundCase = cases[0]; 

      // -----------------------------------------------------
      // STEP 2: ค้นหา Timeline/รูปภาพ (ดึงเฉพาะที่ is_hidden = false)
      // -----------------------------------------------------
      const { rows: timeline } = await query(`
        SELECT 
          a.id, 
          a.note, 
          a.viewed, 
          a.photo, 
          a.updated_on, 
          a.status,
          a.is_hidden,
          a.is_cover
        FROM voice_attachment a
        JOIN voice_message_photos mp ON a.id = mp.attachment_id
        WHERE mp.message_id = $1 
        
        ORDER BY a.is_cover DESC, a.updated_on ASC;
      `, [foundCase.id]);

      // ----------------------------------------------------- AND a.is_hidden = false  -- เพิ่มเงื่อนไขกรองข้อมูลที่ซ่อนอยู่ออก 
      // STEP 3: รวมข้อมูลส่งกลับ
      // -----------------------------------------------------
      const resultData = {
        ...foundCase,
        timeline: timeline 
      };

      return res.status(200).json({ 
        found: true, 
        data: resultData 
      });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ message: 'Error', error: error.message });
  }
}
