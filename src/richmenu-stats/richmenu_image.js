// src/richmmenu/richmenu_image.js
// แปลงจาก main.go — GetRichMenuImageHandler

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * GetRichMenuImageHandler
 * เทียบกับ func GetRichMenuImageHandler(w http.ResponseWriter, r *http.Request)
 * Proxy รูปภาพจาก LINE API ส่งตรงให้ client
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // ดึง richMenuId จาก query param แทน path parsing แบบ Go
  // route: GET /api/richmenu/image/:richMenuId
  const { richMenuId } = req.query;

  if (!richMenuId || richMenuId === 'default' || richMenuId === 'error') {
    return res.status(404).json({ message: 'No image for default/error menu' });
  }

  try {
    const lineRes = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` } }
    );

    if (lineRes.status !== 200) {
      return res.status(404).json({ message: 'Image not found on LINE' });
    }

    // pipe content-type + body ตรงไปให้ client
    // เทียบกับ io.Copy(w, resp.Body) ใน Go
    const contentType = lineRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);

    const arrayBuffer = await lineRes.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error(`Image proxy error for ${richMenuId}:`, err);
    return res.status(500).json({ message: 'Internal error' });
  }
}
