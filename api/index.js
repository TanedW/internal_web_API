import 'dotenv/config';   
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Force Vercel to bundle iconv-lite and pg-protocol internal files
try {
    require('iconv-lite/lib/extend-node');
    require('iconv-lite/lib/streams');
    require('pg-protocol');
} catch (e) {
    // Ignore error if files are missing during local dev
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(join(__dirname, '../package.json'), 'utf8'));

import adminLoginHandler from '../src/AdminLogin.js';
import adminListHandler from '../src/AdminList.js';
import manageCaseHandler from '../src/cases/manage_case.js'; 
import searchCaseHandler from '../src/cases/search_case.js';
import manageOrgHandler from '../src/organization/manage_org.js';
import searchOrgHandler from '../src/organization/search_org.js';
import manageFlexHandler from '../src/flex_message/manage_flex_message.js';
import getAuditLogsHandler from '../src/GetAuditLogs.js';
import richmenuHandler from '../src/richmmenu/richmenu_home.js'
import richmenuDashboardHandler from '../src/richmmenu/richmenu_dashboard.js'
import checkSessionHandler from '../src/CheckSession.js';
import getUserRolesHandler from '../src/GetUserRoles.js';
import validatePushHandler from '../src/flex_message/validate-push.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Multer for multipart/form-data (Rich Menu image uploads)
const upload = multer({ storage: multer.memoryStorage() });

// Skip JSON body parsing for multipart/form-data so multer can read the stream
app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) return next();
    express.json()(req, res, next);
});

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// Normalizing /internal_web_api/ for local testing if needed
app.use((req, res, next) => {
    if (req.url.startsWith('/internal_web_api/')) {
        req.url = req.url.replace('/internal_web_api/', '/src/');
    }
    next();
});

// ============================================================
// 🔧 ADAPTER FUNCTION
// ============================================================
async function vercelAdapter(req, res, handler) {
    try {
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        
        const webReq = {
            method: req.method,
            url: fullUrl,
            headers: {
                get: (key) => req.headers[key.toLowerCase()],
                ...req.headers
            },
            socket: req.socket,
            query: req.query,
            body: req.body,
            file: req.file,
            files: req.files,
            json: async () => req.body,
            text: async () => JSON.stringify(req.body)
        };

        const response = await handler(webReq, res);

        if (res.headersSent) return;

        if (response instanceof Response) {
            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            
            response.headers.forEach((value, key) => {
                if (!key.toLowerCase().startsWith('access-control-allow-')) {
                    res.setHeader(key, value);
                }
            });

            if (contentType.includes('application/json')) {
                const data = await response.json();
                res.json(data);
            } else {
                const text = await response.text();
                res.send(text);
            }
        }
    } catch (error) {
        console.error("Adapter Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || "Internal Server Error" });
        }
    }
}

// ============================================================
// 🛣️ ROUTES
// ============================================================

app.all('/src/AdminLogin', (req, res) => vercelAdapter(req, res, adminLoginHandler));
app.all('/src/AdminList', (req, res) => vercelAdapter(req, res, adminListHandler));
app.all('/src/cases/manage_case', (req, res) => vercelAdapter(req, res, manageCaseHandler));
app.all('/src/cases/search_case', (req, res) => vercelAdapter(req, res, searchCaseHandler));
app.all('/src/organization/manage_org', (req, res) => vercelAdapter(req, res, manageOrgHandler));
app.all('/src/organization/search_org', (req, res) => vercelAdapter(req, res, searchOrgHandler));
app.all('/src/flex_message/manage_flex_message', (req, res) => vercelAdapter(req, res, manageFlexHandler));
app.all('/src/GetAuditLogs', (req, res) => vercelAdapter(req, res, getAuditLogsHandler));
app.all('/src/richmmenu/richmenu_home', (req, res) => vercelAdapter(req, res, richmenuHandler));
app.all('/src/richmmenu/richmenu_dashboard', (req, res, next) => {
  const isUpload = req.method === 'POST' && req.query.action === 'upload';
  if (isUpload) {
    upload.single('menuImage')(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'File upload error', details: err.message });
      vercelAdapter(req, res, richmenuDashboardHandler);
    });
  } else {
    vercelAdapter(req, res, richmenuDashboardHandler);
  }
});
app.all('/src/CheckSession', (req, res) => vercelAdapter(req, res, checkSessionHandler));
app.all('/src/GetUserRoles', (req, res) => vercelAdapter(req, res, getUserRolesHandler));
app.all('/src/flex_message/validate-push', (req, res) => vercelAdapter(req, res, validatePushHandler));

app.get('/', (req, res) => {
  res.send(`${pkg.name} v${pkg.version}`);
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});


export default app;