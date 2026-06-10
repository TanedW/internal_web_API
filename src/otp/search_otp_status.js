import { query } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { key } = req.query;

    if (!key) {
      return res.status(400).json({ message: 'Phone number (key) is required' });
    }

    const { rows: otpData } = await query(`
        SELECT 
          o.key AS phone, 
          o.counter_consecutive_fail, 
          o.counter_sent,
          u.first_name,
          u.last_name,
          u.document_url
        FROM otp_verification o
        INNER JOIN traffy_user u ON o.key = u.phone
        WHERE o.key = $1
    `, [key]);

    if (otpData.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No OTP record or matching user found' 
      });
    }

    // --- เพิ่ม Logic สำหรับกำหนดสถานะ ---
    const result = otpData[0];
    const status = result.counter_consecutive_fail >= 3 ? 'locked' : 'active';

    return res.status(200).json({ 
      success: true, 
      data: {
        ...result,
        status: status // ส่งสถานะเพิ่มเข้าไป
      }
    });

  } catch (error) {
    console.error("Search OTP Error:", error);
    return res.status(500).json({ error: error.message });
  }
}