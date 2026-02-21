// import { Logging } from '@google-cloud/logging';

// const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'traffy-cloud';
// const logName = 'audit-log';
// const logging = new Logging({ projectId });

export default async function handler(req) {
  // const { searchParams } = new URL(req.url);
  // const limit = parseInt(searchParams.get('limit') || '50');
  // const actionType = searchParams.get('actionType');
  // const groupId = searchParams.get('groupId');
  // const caseId = searchParams.get('caseId');
  // const email = searchParams.get('email');
  // const status = searchParams.get('status');

  // try {
  //   let filter = `logName="projects/${projectId}/logs/${logName}"`;
    
  //   if (actionType) {
  //     filter += ` AND (jsonPayload.activity.type="${actionType}" OR jsonPayload.jsonPayload.activity.type="${actionType}")`;
  //   }
  //   if (email) {
  //     filter += ` AND (jsonPayload.actor.email="${email}" OR jsonPayload.jsonPayload.actor.email="${email}")`;
  //   }
  //   if (status) {
  //     filter += ` AND (jsonPayload.activity.status="${status}" OR jsonPayload.jsonPayload.activity.status="${status}")`;
  //   }
  //   if (groupId) {
  //     filter += ` AND (jsonPayload.activity.details.group_id="${groupId}" OR jsonPayload.jsonPayload.activity.details.group_id="${groupId}")`;
  //   }
  //   if (caseId) {
  //     filter += ` AND (jsonPayload.activity.details.case_id="${caseId}" OR jsonPayload.jsonPayload.activity.details.case_id="${caseId}")`;
  //   }

  //   const [entries] = await logging.getEntries({
  //     filter: filter,
  //     pageSize: limit,
  //     orderBy: 'timestamp desc'
  //   });

  //   const logs = entries.map(entry => {
  //     const data = entry.data || {};
  //     const metadata = entry.metadata || {};
      
  //     const result = {
  //       timestamp: metadata.timestamp,
  //       severity: metadata.severity || 'DEFAULT',
  //       ...data
  //     };

  //     if (data.jsonPayload && data.jsonPayload.jsonPayload) {
  //       result.jsonPayload = data.jsonPayload.jsonPayload;
  //     } 
  //     else if (data.activity && !data.jsonPayload) {
  //       result.jsonPayload = data;
  //     }

  //     if (!result.textPayload && metadata.textPayload) {
  //       result.textPayload = metadata.textPayload;
  //     }

  //     return result;
  //   });

  //   return new Response(JSON.stringify({ success: true, data: logs }), {
  //     status: 200,
  //     headers: { 'Content-Type': 'application/json' }
  //   });
  // } catch (error) {
  //   console.error("Fetch Logs Error:", error);
  //   return new Response(JSON.stringify({ success: false, error: error.message }), {
  //     status: 500,
  //     headers: { 'Content-Type': 'application/json' }
  //   });
  // }
}
