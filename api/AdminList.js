// api/AdminList.js
import 'dotenv/config'; // แทนที่ require('dotenv').config();import { query } from '../lib/db.js';
import { Permit } from "permitio";
import * as db from './lib/db.js'; // นำเข้าทั้งหมดเป็น db object
import { writeAuditLog } from './lib/logging.js';

// Initialize Permit
const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY, });
// Helper: บันทึก Log
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

console.log("Using Token Prefix:", permit.config.token.substring(0, 15) + "...");

export default async function handler(req, res) {
  // 1. ดึงค่าจาก Header 'origin'
  const origin = req.headers.origin;

  // 2. ตั้งค่า CORS ให้รองรับ Credentials
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin); // ห้ามใช้ '*' เด็ดขาด
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true'); // อนุญาตให้ส่ง Cookie
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 3. สำคัญมาก: ต้องตอบกลับ OPTIONS Request ทันที!
  if (req.method === 'OPTIONS') {
    return res.status(200).end(); 
  }

  const { id, requester_id } = req.query; 

  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // =================================================================
    // GET: ดึงข้อมูล + ดึง Roles (Array) สดๆ จาก Permit
    // =================================================================
    if (req.method === 'GET') {
      // 1. รันงานขนานกัน: เช็คสิทธิ์การลบ + ดึงข้อมูลรายชื่อจาก DB
      const [canDelete, dbResult] = await Promise.all([
    requester_id 
      ? permit.check(String(requester_id), "delete", { type: "Admin_Users", tenant: "default" }).catch(() => false)
      : Promise.resolve(false),
    
    db.query(`
      SELECT admin_id, email, first_name, last_name, profile_url
      FROM admin_system 
      WHERE is_deleted = false
      ORDER BY join_at DESC;
    `)
]);

      const { rows: admins } = dbResult;

      // 2. ดึง Roles ของทุกคนขนานกัน
      const adminsWithRoles = await Promise.all(admins.map(async (admin) => {
        try {
            const assignedRoles = await permit.api.users.getAssignedRoles({ 
                user: String(admin.admin_id), 
                tenant: "default" 
            });
            return {
                ...admin,
                roles: assignedRoles.length > 0 ? assignedRoles.map(r => r.role) : ['editor'] 
            };
        } catch (error) {
            console.error(`Failed to fetch role for ${admin.email}:`, error);
            return { ...admin, roles: ['editor'] }; 
        }
      }));

      return res.status(200).json({
        data: adminsWithRoles, 
        meta: { can_delete: canDelete }
      });
    }

    // ส่วนอื่นๆ (POST, PUT, DELETE)
    const body = req.body || {};
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const { current_admin_id } = body;
        if (current_admin_id) {
            const { rows: actors } = await db.query('SELECT * FROM admin_system WHERE admin_id = $1', [current_admin_id]);
            if (actors.length > 0) actorAdmin = actors[0];
        }
    }

// =================================================================
    // POST: เพิ่ม User ใหม่, Reactivate หรือ อัปเดต Role ให้ User เดิม
    // =================================================================
    if (req.method === 'POST') {
      const { email, role } = body; 
      if (!email) return res.status(400).json({ message: 'Email required' });

      const validRoles = ['admin',
                          'editor',
                          'editor_manage_case',
                          'editor_manage_menu',
                          'editor_manage_flex',
                          'editor_search_org',
                          'editor_file_search',
                          'editor_search_duplicate_org',
                          'editor_mange_user',                                 
                        ];
      const assignedRole = validRoles.includes(role) ? role : 'editor';

      try {
        // 1. เช็คว่ามีอีเมลนี้อยู่ในระบบหรือไม่
        const { rows: existing } = await db.query('SELECT * FROM admin_system WHERE email = $1 LIMIT 1', [email]);
        
        let targetUser;
        let actionStatus = 'ADMIN_ADD';

        if (existing.length > 0) {
          targetUser = existing[0];
          
          if (targetUser.is_deleted === true) {
            // กรณีเคยถูกลบ: ให้คืนชีพ (Reactivate)
            const { rows: updated } = await db.query(`
              UPDATE admin_system 
              SET is_deleted = false 
              WHERE email = $1 
              RETURNING *;
            `, [email]);
            targetUser = updated[0];
            actionStatus = 'ADMIN_REACTIVATE';
          } else {
            // กรณีมีอยู่ในระบบและใช้งานอยู่: เตรียมอัปเดต Role ใน Permit
            actionStatus = 'ADMIN_UPDATE_ROLE';
          }
        } else {
          // กรณีไม่เคยมีข้อมูลเลย: INSERT ใหม่
          const { rows: inserted } = await db.query(`
            INSERT INTO admin_system (email) VALUES ($1) RETURNING *;
          `, [email]);
          targetUser = inserted[0];
          actionStatus = 'ADMIN_CREATE_NEW';
        }

        // 2. Sync Permit + Assign Role (Permit จะจัดการ Overwrite หรือ Add Role ให้เอง)
        try {
          const syncUser = await permit.api.users.sync({ // เพิ่ม const syncUser = เข้าไป
  key: String(targetUser.admin_id),
  email: targetUser.email,
  first_name: targetUser.first_name || "",
  last_name: targetUser.last_name || ""
});

          console.log("--- Permit Sync Result ---");
  console.log(JSON.stringify(syncUser, null, 2)); // พ่นออกมาดูแบบสวยๆ ใน Terminal
  console.log("--------------------------");

          // --- ทางเลือก A: ดึงมาเช็กก่อน Assign เพื่อป้องกัน Role ซ้ำซ้อน ---
          const currentAssignedRoles = await permit.api.users.getAssignedRoles({ 
              user: String(targetUser.admin_id), 
              tenant: "default" 
          });

          // ตรวจสอบว่ามี Role นี้อยู่แล้วหรือยัง
          const hasRole = currentAssignedRoles.some(r => r.role === assignedRole);

          if (!hasRole) {
              await permit.api.users.assignRole({
                  user: String(targetUser.admin_id),
                  role: assignedRole, 
                  tenant: "default"
              });
              console.log(`Assigned new role: ${assignedRole} to ${targetUser.email}`);
          } else {
              console.log(`User ${targetUser.email} already has role: ${assignedRole}`);
          }
          // -----------------------------------------------------------

        } catch (e) {
          console.error("Permit Sync/Assign Error:", e);
        }

        // 3. บันทึก Log ตาม Action ที่เกิดขึ้น
        if (actorAdmin) {
            await saveAdminLog({
              adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
              action_type: actionStatus, status: 'SUCCESS', ipAddress, userAgent,
              details: { 
                target: 'admin_role_assigned', 
                target_id: targetUser.admin_id, 
                target_email: targetUser.email, 
                assigned_role: assignedRole,
                previous_status: existing.length > 0 ? (existing[0].is_deleted ? 'deleted' : 'active') : 'new'
              }
            });
        }

        return res.status(200).json({ 
          ...targetUser, 
          message: actionStatus === 'ADMIN_UPDATE_ROLE' ? 'อัปเดตบทบาทเรียบร้อยแล้ว' : 'เพิ่มผู้ใช้งานเรียบร้อยแล้ว',
          roles: [assignedRole] 
        });

      } catch (dbError) {
        console.error("Database Error:", dbError);
        return res.status(500).json({ message: 'Database Error', error: dbError.message });
      }
    }

    // =================================================================
    // PUT
    // =================================================================
    if (req.method === 'PUT') {
        if (!id) return res.status(400).json({ message: 'ID required' });
        const { first_name, last_name, email } = body;
        
        if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });
  
        const { rows: updatedUser } = await db.query(`
          UPDATE admin_system SET first_name=$1, last_name=$2, email=$3
          WHERE admin_id = $4 RETURNING *;
        `, [first_name, last_name, email, id]);
  
        if (updatedUser.length === 0) return res.status(404).json({ message: 'Not found' });
  
        await saveAdminLog({
          adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
          action_type: 'ADMIN_UPDATE', status: 'SUCCESS', ipAddress, userAgent,
          details: { target: 'admin_updated', target_id: id, updated_data: { email, first_name, last_name } }
        });
  
        return res.status(200).json(updatedUser[0]);
    }

        // =================================================================
        // DELETE (เปลี่ยนเป็น Soft Delete)
        // =================================================================
        if (req.method === 'DELETE') {
            if (!id) return res.status(400).json({ message: 'ID required' });
            if (!actorAdmin) return res.status(403).json({ message: 'Unauthorized action' });

            // 1. Check Permission จาก Permit.io เหมือนเดิม
            const isPermitted = await permit.check(String(actorAdmin.admin_id), "delete", "Admin_Users");

            if (!isPermitted) {
              await saveAdminLog({
                  adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
                  action_type: 'ADMIN_DELETE_SOFT', status: 'FORBIDDEN', ipAddress, userAgent,
                  details: { message: 'Permission denied', target_id: id }
              });
              return res.status(403).json({ message: 'Forbidden: No permission to delete.' });
            }

            // 2. เปลี่ยนจาก DELETE เป็น UPDATE is_deleted = true
            const { rows: deletedUser } = await db.query(`
              UPDATE admin_system 
              SET is_deleted = true 
              WHERE admin_id = $1 
              RETURNING *;
            `, [id]);

            if (deletedUser.length === 0) return res.status(404).json({ message: 'Not found' });

            // 3. จัดการกับ Permit (แนะนำให้ลบ User ออกจาก Permit เพื่อตัดสิทธิ์การเข้าถึงทันที)
            try {
              await permit.api.users.delete(String(id));
            } catch(e) {
              console.error("Failed to delete user in Permit:", e);
            }

            // 4. บันทึก Log
            await saveAdminLog({
              adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
              action_type: 'ADMIN_DELETE_SOFT', status: 'SUCCESS', ipAddress, userAgent,
              details: { target: 'admin_soft_deleted', deleted_id: id, deleted_email: deletedUser[0].email }
            });

            return res.status(200).json({ message: 'User deactivated successfully' });
        }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}
