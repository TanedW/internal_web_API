// src/proxy-search-org/search-org.js

import { writeAuditLog } from '../lib/logging.js';

// ----------------------------------------------------------------------
// Helper: บันทึก Log
// ----------------------------------------------------------------------
async function saveLog({ action_type, status, ipAddress, userAgent, details }) {
  await writeAuditLog(
    {
      adminId: null,
      email: 'system',
      firstName: null,
      lastName: null,
      actionType: action_type,
      status,
      ipAddress,
      userAgent,
      details,
    },
    status === 'SUCCESS' ? 'INFO' : 'WARNING'
  );
}

// ----------------------------------------------------------------------
// Helper: ดึง IP / User-Agent จาก request headers
// ----------------------------------------------------------------------
function getClientInfo(req) {
  const forwarded = req.headers['x-forwarded-for'] ?? req.headers.get?.('x-forwarded-for');
  const ipAddress = forwarded
    ? (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0])
    : (req.socket?.remoteAddress ?? null);
  const userAgent = req.headers['user-agent'] ?? req.headers.get?.('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// ----------------------------------------------------------------------
// GET — Proxy ค้นหาองค์กรจาก PHP backend
// ----------------------------------------------------------------------
export async function GET(req, res) {
  const { ipAddress, userAgent } = getClientInfo(req);

  try {
    const searchParams = req.query ?? Object.fromEntries(new URL(req.url).searchParams);
    const search     = searchParams['search']    ?? null;
    const limit      = searchParams['limit']     ?? 20;
    const threshold  = searchParams['threshold'] ?? 0.1;

    if (!search) {
      return res
        .status(400)
        .json({ message: 'กรุณาระบุคำค้นหา' });
    }

    const targetUrl = `https://kong.traffy.in.th/org-name-validator/organizations/search.php` +
      `?search=${encodeURIComponent(search)}&limit=${limit}&threshold=${threshold}`;

    console.log('Fetching from PHP:', targetUrl);

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Next.js Server)',
      },
      cache: 'no-store',
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('PHP returned non-JSON:', text);

      await saveLog({
        action_type: 'ORG_SEARCH_PROXY',
        status: 'FAILED',
        ipAddress,
        userAgent,
        details: { reason: 'PHP returned non-JSON', search, debug: text.slice(0, 300) },
      });

      return res
        .status(500)
        .json({ message: 'PHP ส่งข้อมูลกลับมาไม่ใช่ JSON', debug: text });
    }

    await saveLog({
      action_type: 'ORG_SEARCH_PROXY',
      status: 'SUCCESS',
      ipAddress,
      userAgent,
      details: { search, limit, threshold },
    });

    return res.status(200).json(data);

  } catch (error) {
    console.error('Proxy Error:', error);

    await saveLog({
      action_type: 'ORG_SEARCH_PROXY',
      status: 'FAILED',
      ipAddress,
      userAgent,
      details: { reason: error.message },
    });

    return res.status(500).json({ message: error.message });
  }
}
// ----------------------------------------------------------------------
// Default export สำหรับ Express adapter ใน index.js
// ----------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')    return GET(req, res);
  return res.status(405).json({ message: 'Method Not Allowed' });
}