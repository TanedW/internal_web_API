import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog({
    adminId, email, firstName: first_name, lastName: last_name,
    actionType: action_type, status, ipAddress, userAgent, details
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  // รองรับ OPTIONS สำหรับ CORS
  if (req.method === 'OPTIONS') return res.status(200).set(corsHeaders).end();
  
  // ตั้งค่า CORS สำหรับทุก Response
  res.set(corsHeaders);

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    const { key, current_admin_id } = req.body;

    // 1. Validation: ตรวจสอบข้อมูลที่จำเป็น
    if (!key) return res.status(400).json({ message: 'Key (Phone number) is required' });
    if (!current_admin_id) return res.status(400).json({ message: 'Admin ID is required' });

    // 2. Authorization: ตรวจสอบสิทธิ์ Admin
    const { rows: actors } = await query(`
        SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1
    `, [current_admin_id]);

    if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
    const actorAdmin = actors[0];

    // 3. METHOD: PUT (สำหรับการ Update/Reset)
    if (req.method === 'PUT') {
      const { rows: updatedOtp } = await query(`
          UPDATE otp_verification
          SET 
            counter_consecutive_fail = 0,
            counter_sent = 0
          WHERE key = $1
          RETURNING key, counter_consecutive_fail, counter_sent;
      `, [key]);

      // กรณีไม่พบ Key ในระบบ
      if (updatedOtp.length === 0) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id, 
          email: actorAdmin.email, 
          first_name: actorAdmin.first_name, 
          last_name: actorAdmin.last_name,
          action_type: 'RESET_OTP_LIMIT', 
          status: 'FAILED', ipAddress, 
          userAgent,
          details: { reason: 'Key not found', phone_key: key }
        });
        return res.status(404).json({ message: 'OTP record not found' });
      }

      // บันทึก Log เมื่อสำเร็จ
      await saveAdminLog({
        adminId: actorAdmin.admin_id, 
        email: actorAdmin.email, 
        first_name: actorAdmin.first_name, 
        last_name: actorAdmin.last_name,
        action_type: 'RESET_OTP_LIMIT', 
        status: 'SUCCESS', 
        ipAddress, 
        userAgent,
        details: { phone_key: key, reset_values: { fail: 0, sent: 0 } }
      });

      return res.status(200).json({ success: true, data: updatedOtp[0] });
    }

    return res.status(405).json({ message: 'Method Not Allowed' });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}