// api/AdminList.js
import { Permit } from "permitio";
import * as db from './lib/db.js';
import { writeAuditLog } from './lib/logging.js';

const permit = new Permit({
  pdp: "https://cloudpdp.api.permit.io",
  token: process.env.PERMIT_API_KEY,
});

// ฟังก์ชันสำหรับส่ง Log ไปยัง External Logging API
async function sendExternalLog(logData) {
  try {
    const response = await fetch(process.env.LOGING_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LOGING_JWT_TOKEN}`
      },
      body: JSON.stringify(logData)
    });
    if (!response.ok) {
      console.error('Failed to send external log:', await response.text());
    }
  } catch (error) {
    console.error('External Logging API Error:', error);
  }
}

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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id, requester_id } = req.query;
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // GET: ดึงข้อมูล Admin พร้อม Roles ทั้งหมด
    if (req.method === 'GET') {
      const [canDelete, dbResult] = await Promise.all([
        requester_id
          ? permit.check(String(requester_id), "delete", { type: "Admin_user", tenant: "default" }).catch(() => false)
          : Promise.resolve(false),
        db.query(`SELECT admin_id, email, first_name, last_name, profile_url FROM admin_system WHERE is_deleted = false ORDER BY join_at DESC;`)
      ]);

      const { rows: admins } = dbResult;

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
          return { ...admin, roles: ['editor'] };
        }
      }));

      return res.status(200).json({ data: adminsWithRoles, meta: { can_delete: canDelete } });
    }

    const body = req.body || {};
    let actorAdmin = null;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const { current_admin_id } = body;
      if (current_admin_id) {
        const { rows: actors } = await db.query('SELECT * FROM admin_system WHERE admin_id = $1', [current_admin_id]);
        if (actors.length > 0) actorAdmin = actors[0];
      }
    }

    // POST: จัดการ Multi-role (Add / Reactivate / Update Roles)
    // if (req.method === 'POST') {
    //   const { email, roles } = body; // รับ roles เป็น Array จาก page.jsx
    //   if (!email || !Array.isArray(roles)) {
    //       return res.status(400).json({ message: 'Email and roles array are required' });
    //   }

    //   // กรองเฉพาะ Role ที่อนุญาต
    //   const validRolesList = [
    //     'admin', 
    //     'editor', 
    //     'editor_manage_case', 
    //     'editor_manage_menu', 
    //     'editor_manage_flex', 
    //     'editor_manage_org', 
    //     'editor_file_search', 
    //     'editor_search_duplicate_org', 
    //     'editor_manage_user'
    //   ];
    //   const assignedRoles = roles.filter(r => validRolesList.includes(r.toLowerCase()));
    //   if (assignedRoles.length === 0) assignedRoles.push('editor');

    //   const { rows: existing } = await db.query('SELECT * FROM admin_system WHERE email = $1 LIMIT 1', [email]);

    //   let targetUser;
    //   let actionStatus = 'ADMIN_ADD';

    //   if (existing.length > 0) {
    //     targetUser = existing[0];
    //     if (targetUser.is_deleted) {
    //       const { rows: updated } = await db.query(`UPDATE admin_system SET is_deleted = false WHERE email = $1 RETURNING *;`, [email]);
    //       targetUser = updated[0];
    //       actionStatus = 'ADMIN_REACTIVATE';
    //     } else {
    //       actionStatus = 'ADMIN_UPDATE_ROLE';
    //     }
    //   } else {
    //     const { rows: inserted } = await db.query(`INSERT INTO admin_system (email) VALUES ($1) RETURNING *;`, [email]);
    //     targetUser = inserted[0];
    //     actionStatus = 'ADMIN_CREATE_NEW';
    //   }

    //   // --- Sync กับ Permit.io สำหรับ Multi-role ---
    //   try {
    //     await permit.api.users.sync({
    //       key: String(targetUser.admin_id),
    //       email: targetUser.email,
    //       first_name: targetUser.first_name || "",
    //       last_name: targetUser.last_name || ""
    //     });

    //     // 1. ดึงบทบาทปัจจุบันใน Permit ออกมา
    //     const currentAssigned = await permit.api.users.getAssignedRoles({ 
    //         user: String(targetUser.admin_id), 
    //         tenant: "default" 
    //     });
    //     const currentRoleKeys = currentAssigned.map(r => r.role);

    //     // 2. ลบบทบาทที่ไม่ได้อยู่ใน List ใหม่ (กรณี Update)
    //     for (const oldRole of currentRoleKeys) {
    //         if (!assignedRoles.includes(oldRole)) {
    //             await permit.api.users.unassignRole({
    //                 user: String(targetUser.admin_id),
    //                 role: oldRole,
    //                 tenant: "default"
    //             });
    //         }
    //     }

    //     // 3. เพิ่มบทบาทใหม่ที่ยังไม่มี
    //     for (const newRole of assignedRoles) {
    //         if (!currentRoleKeys.includes(newRole)) {
    //             await permit.api.users.assignRole({
    //                 user: String(targetUser.admin_id),
    //                 role: newRole,
    //                 tenant: "default"
    //             });
    //         }
    //     }
    //   } catch (e) {
    //     console.error("Permit Multi-role Sync Error:", e);
    //   }

    //   if (actorAdmin) {
    //       await saveAdminLog({
    //         adminId: actorAdmin.admin_id, email: actorAdmin.email, first_name: actorAdmin.first_name, last_name: actorAdmin.last_name,
    //         action_type: actionStatus, status: 'SUCCESS', ipAddress, userAgent,
    //         details: { target_id: targetUser.admin_id, assigned_roles: assignedRoles }
    //       });
    //   }

    //   return res.status(200).json({ ...targetUser, roles: assignedRoles });
    // }

    // POST: จัดการ Multi-role (Add / Reactivate / Update Roles)
    // POST: จัดการ Multi-role (Add / Reactivate / Update Roles)
    if (req.method === 'POST') {
      const { email, roles } = body;
      if (!email || !Array.isArray(roles)) {
        return res.status(400).json({ message: 'Email and roles array are required' });
      }

      // กรองเฉพาะ Role ที่อนุญาต
      const validRolesList = [
        'admin', 'editor', 'editor_manage_case', 'editor_manage_menu',
        'editor_manage_flex', 'editor_manage_org', 'editor_file_search',
        'editor_search_duplicate_org', 'editor_manage_user'
      ];
      const assignedRoles = roles.filter(r => validRolesList.includes(r.toLowerCase()));
      if (assignedRoles.length === 0) assignedRoles.push('editor');

      const { rows: existing } = await db.query('SELECT * FROM admin_system WHERE email = $1 LIMIT 1', [email]);

      let targetUser;
      let logAction = "ADMIN_ADD_USER"; // Default action สำหรับ Log

      if (existing.length > 0) {
        targetUser = existing[0];
        if (!targetUser.is_deleted) {
          return res.status(400).json({ message: 'มี email อยู่ในระบบแล้ว' });
        }

        // กรณีเคยถูกลบ (is_deleted = true) ให้ดึงกลับมาใช้งานใหม่
        const { rows: updated } = await db.query(
          `UPDATE admin_system SET is_deleted = false WHERE email = $1 RETURNING *;`,
          [email]
        );
        targetUser = updated[0];
        logAction = "ADMIN_REACTIVATE_USER"; // ปรับ Action เมื่อเป็นการดึงผู้ใช้เก่ากลับมา
      } else {
        // กรณีไม่มีอีเมลนี้เลย ให้สร้างใหม่
        const { rows: inserted } = await db.query(`INSERT INTO admin_system (email) VALUES ($1) RETURNING *;`, [email]);
        targetUser = inserted[0];
        logAction = "ADMIN_ADD_USER";
      }

      // --- Sync กับ Permit.io สำหรับ Multi-role ---
      try {
        await permit.api.users.sync({
          key: String(targetUser.admin_id),
          email: targetUser.email,
          first_name: targetUser.first_name || "",
          last_name: targetUser.last_name || ""
        });

        const currentAssigned = await permit.api.users.getAssignedRoles({
          user: String(targetUser.admin_id),
          tenant: "default"
        });
        const currentRoleKeys = currentAssigned.map(r => r.role);

        for (const oldRole of currentRoleKeys) {
          if (!assignedRoles.includes(oldRole)) {
            await permit.api.users.unassignRole({
              user: String(targetUser.admin_id),
              role: oldRole,
              tenant: "default"
            });
          }
        }

        for (const newRole of assignedRoles) {
          if (!currentRoleKeys.includes(newRole)) {
            await permit.api.users.assignRole({
              user: String(targetUser.admin_id),
              role: newRole,
              tenant: "default"
            });
          }
        }
      } catch (e) {
        console.error("Permit Multi-role Sync Error:", e);
      }

      // --- ส่ง Log ไปยัง LOGING_API ---
      const externalLogPayload = {
        actor_id: actorAdmin ? String(actorAdmin.admin_id) : "",
        actor_type: "ADMIN",
        actor_name: actorAdmin ? `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim() : "System",
        source_channel: "Internal Portal",
        target_id: String(targetUser.admin_id),
        action: logAction, // ใช้ logAction ที่ระบุว่าเป็น ADD หรือ REACTIVATE
        reason: null,
        payload: {
          created_data: {
            email: targetUser.email,
            roles: assignedRoles,
            admin_id: String(targetUser.admin_id)
          }
        },
        client_ip: ipAddress,
        user_agent: userAgent
      };

      await sendExternalLog(externalLogPayload);

      // บันทึก Log ภายในระบบ (เรียกใช้ฟังก์ชันเดิมเพื่อรักษา Audit Trail ภายใน)
      if (actorAdmin) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: logAction,
          status: 'SUCCESS',
          ipAddress,
          userAgent,
          details: { target_id: targetUser.admin_id, assigned_roles: assignedRoles }
        });
      }

      return res.status(200).json({ ...targetUser, roles: assignedRoles });
    }

    // PUT: อัปเดตบทบาทสมาชิกที่มีอยู่แล้ว
    if (req.method === 'PUT') {
      const { admin_id, roles, current_admin_id } = body;

      if (!admin_id || !Array.isArray(roles)) {
        return res.status(400).json({ message: 'Admin ID and roles array are required' });
      }

      // 1. ตรวจสอบสิทธิ์การแก้ไข (ใช้โครงสร้าง Object ตามที่ PDP ต้องการ)
      const isPermitted = await permit.check(
        String(current_admin_id),
        "update",
        {
          type: "Admin_user",
          tenant: "default"
        }
      );

      if (!isPermitted) {
        return res.status(403).json({ message: 'คุณไม่มีสิทธิ์ในการแก้ไขข้อมูลสมาชิก' });
      }

      // 2. ตรวจสอบว่ามี User ใน DB หรือไม่
      const { rows: existing } = await db.query(
        'SELECT * FROM admin_system WHERE admin_id = $1 AND is_deleted = false',
        [admin_id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ message: 'ไม่พบรายชื่อสมาชิกนี้ในระบบ' });
      }
      const targetUser = existing[0];

      // 3. กรอง Role ที่อนุญาต
      const validRolesList = [
        'admin', 'editor', 'editor_manage_case', 'editor_manage_menu',
        'editor_manage_flex', 'editor_manage_org', 'editor_file_search',
        'editor_search_duplicate_org', 'editor_manage_user'
      ];
      const newAssignedRoles = roles.filter(r => validRolesList.includes(r));
      if (newAssignedRoles.length === 0) newAssignedRoles.push('editor');

      try {
        // 4. SYNC USER ก่อนเสมอ เพื่อป้องกัน Error 404 เมื่อสั่ง Assign Role
        await permit.api.users.sync({
          key: String(targetUser.admin_id),
          email: targetUser.email,
          first_name: targetUser.first_name || "",
          last_name: targetUser.last_name || ""
        });

        // 5. ดึงบทบาทปัจจุบันมาเปรียบเทียบ
        const currentAssigned = await permit.api.users.getAssignedRoles({
          user: String(targetUser.admin_id),
          tenant: "default"
        });
        const currentRoleKeys = currentAssigned.map(r => r.role);

        // 6. ลบบทบาทเก่าที่ไม่ได้อยู่ใน List ใหม่
        for (const oldRole of currentRoleKeys) {
          if (!newAssignedRoles.includes(oldRole)) {
            await permit.api.users.unassignRole({
              user: String(targetUser.admin_id),
              role: oldRole,
              tenant: "default"
            });
          }
        }

        // 7. เพิ่มบทบาทใหม่ที่ยังไม่มี
        for (const newRole of newAssignedRoles) {
          if (!currentRoleKeys.includes(newRole)) {
            await permit.api.users.assignRole({
              user: String(targetUser.admin_id),
              role: newRole,
              tenant: "default"
            });
          }
        }
      } catch (permitError) {
        console.error("Permit Update Role Error:", permitError);
        // คุณอาจจะเลือก return error ตรงนี้ถ้าต้องการให้หยุดทำงานเมื่อ Permit พัง
      }

      // 8. ส่ง Log ไปยัง External Logging API
      const externalLogPayload = {
        actor_id: actorAdmin ? String(actorAdmin.admin_id) : String(current_admin_id),
        actor_type: "ADMIN",
        actor_name: actorAdmin ? `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim() : "System",
        source_channel: "Internal Portal",
        target_id: String(targetUser.admin_id),
        action: "ADMIN_UPDATE_ROLE_USER",
        reason: null,
        payload: {
          updated_data: {
            email: targetUser.email,
            new_roles: newAssignedRoles,
            admin_id: String(targetUser.admin_id)
          }
        },
        client_ip: ipAddress,
        user_agent: userAgent
      };

      await sendExternalLog(externalLogPayload);

      // 9. บันทึก Audit Log ภายใน
      if (actorAdmin) {
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'ADMIN_UPDATE_ROLE',
          status: 'SUCCESS',
          ipAddress,
          userAgent,
          details: {
            target_id: admin_id,
            new_roles: newAssignedRoles
          }
        });
      }

      return res.status(200).json({
        message: 'อัปเดตบทบาทสำเร็จ',
        admin_id: targetUser.admin_id,
        roles: newAssignedRoles
      });
    }

    // DELETE (Soft Delete)
    if (req.method === 'DELETE') {
      // 1. ตรวจสอบพารามิเตอร์เบื้องต้น
      if (!id || !actorAdmin) {
        return res.status(400).json({ message: 'Invalid Request' });
      }

      // 2. ตรวจสอบสิทธิ์การลบ (แก้ไขจาก String เป็น Object เพื่อรองรับ Cloud PDP)
      const isPermitted = await permit.check(
        String(actorAdmin.admin_id),
        "delete",
        {
          type: "Admin_user",
          tenant: "default"
        }
      );

      if (!isPermitted) {
        return res.status(403).json({ message: 'คุณไม่มีสิทธิ์ในการลบสมาชิก' });
      }

      try {
        // 3. ทำการ Soft Delete ใน Database ก่อน
        const { rows: deletedUser } = await db.query(
          `UPDATE admin_system SET is_deleted = true WHERE admin_id = $1 RETURNING *;`,
          [id]
        );

        if (deletedUser.length === 0) {
          return res.status(404).json({ message: 'ไม่พบรายชื่อที่ต้องการลบ' });
        }

        const targetUser = deletedUser[0];

        // 4. ลบ User ออกจากระบบ Permit.io
        // การลบ user ใน permit จะช่วยลบ role assignments ทั้งหมดของ user นั้นไปด้วยอัตโนมัติ
        try {
          await permit.api.users.delete(String(id));
        } catch (permitError) {
          console.error("Permit Delete User Error:", permitError.message);
          // เรามักไม่หยุดกระบวนการลบใน DB แม้ Permit จะลบไม่สำเร็จ (เช่น ไม่มี user นั้นใน permit อยู่แล้ว)
        }

        // 5. ส่ง Log ไปยัง External Logging API
        const externalLogPayload = {
          actor_id: String(actorAdmin.admin_id),
          actor_type: "ADMIN",
          actor_name: `${actorAdmin.first_name || ''} ${actorAdmin.last_name || ''}`.trim(),
          source_channel: "Internal Portal",
          target_id: String(id),
          action: "ADMIN_DELETE_USER",
          reason: null,
          payload: {
            deleted_user: {
              email: targetUser.email,
              admin_id: String(id)
            }
          },
          client_ip: ipAddress,
          user_agent: userAgent
        };
        await sendExternalLog(externalLogPayload);

        // 6. บันทึก Audit Log ภายในระบบ
        await saveAdminLog({
          adminId: actorAdmin.admin_id,
          email: actorAdmin.email,
          first_name: actorAdmin.first_name,
          last_name: actorAdmin.last_name,
          action_type: 'ADMIN_DELETE_SOFT',
          status: 'SUCCESS',
          ipAddress,
          userAgent,
          details: { deleted_id: id }
        });

        return res.status(200).json({ message: 'Deactivated and removed from access control' });

      } catch (dbError) {
        console.error("Database Delete Error:", dbError);
        return res.status(500).json({ message: 'Server Error', error: dbError.message });
      }
    }

    return res.status(405).json({ message: 'Method Not Allowed' });

  } catch (error) {
    return res.status(500).json({ message: 'Server Error', error: error.message });
  }
}