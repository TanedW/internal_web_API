import express from 'express';
import cors from 'cors';

// 1. นำเข้าไฟล์ API ของคุณ
// *** ตรวจสอบ path ให้ถูกต้องก่อนรันนะครับ ***
import adminLoginHandler from './api/AdminLogin.js';
import adminListHandler from './api/AdminList.js';
import manageCaseHandler from './api/cases/manage_case.js'; 

// --- ส่วนจัดการ Environment Variable ---
// ถ้ามีตัวแปร DATA_BASE_URL (ของคุณ) ให้ก๊อปปี้ไปใส่ DATABASE_URL (มาตรฐาน)
if (process.env.DATA_BASE_URL) {
    process.env.DATABASE_URL = process.env.DATA_BASE_URL;
}

console.log("DEBUG: DATA_BASE_URL ->", process.env.DATA_BASE_URL ? "Set" : "Not Set");
console.log("DEBUG: DATABASE_URL  ->", process.env.DATABASE_URL ? "Set" : "Not Set");
// -------------------------------------

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

// ============================================================
// 🔧 ADAPTER FUNCTION (ตัวช่วยแปลงร่าง)
// หน้าที่: แปลง Request ของ Express ให้หน้าตาเหมือน Vercel Edge
// ============================================================
async function vercelAdapter(req, res, handler) {
    try {
        // 1. สร้าง Full URL (แก้ปัญหา Invalid URL)
        const fullUrl = `http://localhost:${PORT}${req.originalUrl}`;
        
        // 2. จำลอง Request Object แบบ Web Standard
        const webReq = {
            url: fullUrl,
            method: req.method,
            headers: { 
                get: (key) => req.headers[key.toLowerCase()] // จำลองฟังก์ชัน .get()
            },
            // จำลองฟังก์ชัน .json() โดยส่ง body ที่ express แกะมาให้แล้วกลับไป
            json: async () => req.body 
        };

        // 3. เรียกใช้ Handler เดิมของคุณ
        const response = await handler(webReq);

        // 4. แปลง Response กลับเป็น Express เพื่อส่งคืน Client
        // (เช็คก่อนว่ามี content type เป็น json ไหม)
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('application/json')) {
            const data = await response.json();
            res.status(response.status).json(data);
        } else {
            // กรณี return เป็น text หรืออย่างอื่น
            const text = await response.text();
            res.status(response.status).send(text);
        }

    } catch (error) {
        console.error("Adapter Error:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
}

// ============================================================
// 🛣️ ROUTES (เชื่อมต่อ API ผ่าน Adapter)
// ============================================================

// 1. Login
app.all('/api/admin-login', (req, res) => {
    vercelAdapter(req, res, adminLoginHandler);
});

// 2. Admin List (ตัวที่มีปัญหา)
app.all('/api/admin-list', (req, res) => {
    vercelAdapter(req, res, adminListHandler);
});

// 3. Manage Case
app.all('/api/manage-case', (req, res) => {
    vercelAdapter(req, res, manageCaseHandler);
});

// Route พื้นฐานเอาไว้เช็ค Server
app.get('/', (req, res) => {
  res.send('API Gateway is running (with Vercel Adapter)...');
});

// เริ่มต้น Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});