// import { Logging } from '@google-cloud/logging';

// const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'traffy-cloud';
// const logName = 'audit-log';
// const logging = new Logging({ projectId });

/**
 * Writes an audit log entry to Google Cloud Logging.
 * 
 * @param {Object} logData - The data to log.
 * @param {string} logData.adminId - ID of the admin performing the action.
 * @param {string} logData.email - Email of the admin.
 * @param {string} logData.actionType - Type of action performed (e.g., 'ADMIN_LOGIN').
 * @param {string} logData.status - Status of the action (e.g., 'SUCCESS', 'FAILED').
 * @param {string} [logData.firstName] - First name of the admin.
 * @param {string} [logData.lastName] - Last name of the admin.
 * @param {string} [logData.ipAddress] - IP address of the request.
 * @param {string} [logData.userAgent] - User agent of the request.
 * @param {Object} [logData.details] - Additional structured details.
 * @param {string} [severity='INFO'] - Log severity level. INFO (ทั่วไป), NOTICE (เหตุการณ์สำคัญ), WARNING (ผิดพลาดไม่ร้ายแรง), ERROR (พัง)
 */
export async function writeAuditLog(logData, severity = 'INFO') {
//   try {
//     const log = logging.log(logName);

//     const message = `${logData.actionType} - ${logData.email} (${logData.status})`;

//     const payload = {
//       event_timestamp: new Date().toISOString(),
//       actor: {
//         id: logData.adminId,
//         email: logData.email,
//         first_name: logData.firstName,
//         last_name: logData.lastName,
//       },
//       activity: {
//         type: logData.actionType,
//         status: logData.status,
//         description: message,
//         details: logData.details || {},
//       },
//       network: {
//         ip_address: logData.ipAddress,
//         user_agent: logData.userAgent,
//       },
//       trace: {
//         generator: "fondue-internal-service"
//       }
//     };

//     const entry = log.entry({
//       resource: { type: 'global' },
//       severity: severity,
//       textPayload: message,
//     }, payload);

//     await log.write(entry);
//   } catch (error) {
//     console.error('Error sending log to Google Cloud Logging:', error);
//   }
}
