// api/flex_message/manage_flex_message.js

import { query } from '../lib/db.js';
import { writeAuditLog } from '../lib/logging.js';

// ----------------------------------------------------------------------
// Helper Function: บันทึก Log
// ----------------------------------------------------------------------
async function saveAdminLog({ adminId, email, first_name, last_name, action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog({
    adminId,
    email,
    firstName: first_name,
    lastName: last_name,
    actionType: action_type,
    status,
    ipAddress,
    userAgent,
    details
  }, status === 'SUCCESS' ? 'INFO' : 'WARNING');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id: flex_id } = req.query;
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  // ----------------------------------------------------------------------
  // CASE: GET - ดึงจาก DB
  // ----------------------------------------------------------------------
  if (req.method === 'GET') {
    try {
      const { rows: messages } = await query(`
        SELECT id, flex_name, flex_data, comment, quick_reply, created_on, updated_on 
        FROM public.flex_message
        WHERE is_deleted = false 
        ORDER BY updated_on DESC;
      `);
      
      return res.status(200).json({ success: true, data: messages });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: POST - สร้าง Flex Message ใหม่
  // ----------------------------------------------------------------------
  if (req.method === 'POST') {
    try {
      const { current_admin_id, flex_name, flex_data, comment, quick_reply } = req.body;

      // [UNIFIED] 1. ตรวจสอบ Admin
      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      // [UNIFIED] 2. บันทึกลง DB
      const { rows: newFlexData } = await query(`
        INSERT INTO public.flex_message (flex_name, flex_data, comment, quick_reply, created_on, updated_on)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING id, flex_name;
      `, [
        flex_name, 
        typeof flex_data === 'object' ? JSON.stringify(flex_data) : flex_data, 
        comment || null, 
        quick_reply ? (typeof quick_reply === 'object' ? JSON.stringify(quick_reply) : quick_reply) : null
      ]);

      const newFlex = newFlexData[0];

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_CREATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'flex_message', flex_id: newFlex.id, flex_name: newFlex.flex_name }
      });

      return res.status(201).json({ success: true, data: newFlex });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: PUT - แก้ไขใน DB
  // ----------------------------------------------------------------------
  if (req.method === 'PUT') {
    if (!flex_id) return res.status(400).json({ message: 'ID required' });

    try {
      const { current_admin_id, flex_name, flex_data, comment, quick_reply, description, old_flex, new_flex } = req.body;

      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      const { rows: updatedFlexData } = await query(`
        UPDATE public.flex_message
        SET 
            flex_name = COALESCE($1, flex_name),
            flex_data = COALESCE($2, flex_data),
            comment = COALESCE($3, comment),
            quick_reply = COALESCE($4, quick_reply),
            updated_on = NOW()
        WHERE id = $5
        RETURNING id, flex_name;
      `, [
        flex_name || null, 
        flex_data ? (typeof flex_data === 'object' ? JSON.stringify(flex_data) : flex_data) : null,
        comment || null,
        quick_reply ? (typeof quick_reply === 'object' ? JSON.stringify(quick_reply) : quick_reply) : null,
        flex_id
      ]);

      if (updatedFlexData.length === 0) {
        return res.status(404).json({ message: 'Data not found' });
      }

      const updatedFlex = updatedFlexData[0];

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
        details: { 
          target: 'flex_message', flex_id: updatedFlex.id, flex_name: updatedFlex.flex_name,
          old_flex, new_flex, description: description || "Updated template info"
        }
      });

      return res.status(200).json({ success: true, data: updatedFlex });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ----------------------------------------------------------------------
  // CASE: DELETE - Soft Delete ใน DB
  // ----------------------------------------------------------------------
  if (req.method === 'DELETE') {
    try {
      const { current_admin_id } = req.body;

      const { rows: actors } = await query('SELECT admin_id, email, first_name, last_name FROM admin_system WHERE admin_id = $1', [current_admin_id]);
      if (actors.length === 0) return res.status(403).json({ message: 'Unauthorized' });
      const actorAdmin = actors[0];

      const { rows: deletedFlexData } = await query(`
        UPDATE public.flex_message
        SET 
            is_deleted = true,
            updated_on = NOW()
        WHERE id = $1
        RETURNING id, flex_name;
      `, [flex_id]);

      if (deletedFlexData.length === 0) {
        return res.status(404).json({ message: 'Data not found' });
      }

      const deletedFlex = deletedFlexData[0];

      await saveAdminLog({
        adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
        action_type: 'FLEX_MESSAGE_DELETE', status: 'SUCCESS', ipAddress, userAgent,
        details: { target: 'flex_message', flex_id: deletedFlex.id, flex_name: deletedFlex.flex_name, note: "Soft deleted" }
      });

      return res.status(200).json({ success: true, message: "Deleted successfully" });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ message: 'Method not allowed' });
}
