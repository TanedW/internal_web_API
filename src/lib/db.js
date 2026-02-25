import pg from 'pg';

const { Pool } = pg;

// ============================================================
// 🗄️ PRIMARY DB — neondb (line_bots, bot_rich_menus, audit_logs ฯลฯ)
// ============================================================
const isCloudDb = process.env.API_PY_HOST && 
                 (process.env.API_PY_HOST.includes('neon') || process.env.PGSSLMODE === 'require');

const baseConfig = {
  max: 10,
  idleTimeoutMillis: 60000,
  user: process.env.API_PY_USER,
  database: process.env.API_PY_DBNAME,
  password: process.env.API_PY_PASS,
  port: process.env.API_PY_PORT
};

if (isCloudDb) {
  baseConfig.ssl = {
    rejectUnauthorized: false
  };
}

const primaryConfig = {
  ...baseConfig,
  host: process.env.API_PY_HOST,
};

if (primaryConfig.host && primaryConfig.host.startsWith('/')) {
  delete primaryConfig.port;
}

const replicaConfig = {
  ...baseConfig,
  host: process.env.REPLICA_API_PY_HOST || process.env.API_PY_HOST,
};

if (replicaConfig.host && replicaConfig.host.startsWith('/')) {
  delete replicaConfig.port;
}

export const primaryPool = new Pool(primaryConfig);
export const replicaPool = new Pool(replicaConfig);

export const query = (text, params) => primaryPool.query(text, params);
export const pool = primaryPool;

primaryPool.on('error', (err) => {
    console.error('Unexpected error on primary idle client', err);
});

replicaPool.on('error', (err) => {
    console.error('Unexpected error on replica idle client', err);
});


// ============================================================
// 🗄️ CUSTOMIZE CONVERSATION DB — fondue-customize-conversation
//    ใช้สำหรับตาราง bot_config, action-list, state
// ============================================================
const isFdCloudDb = process.env.FD_CUSTOMIZE_CONVERSATION_HOST &&
                   (process.env.FD_CUSTOMIZE_CONVERSATION_HOST.includes('neon') ||
                    process.env.FD_CUSTOMIZE_CONVERSATION_HOST.includes('aws') ||
                    process.env.FD_CUSTOMIZE_CONVERSATION_SSLMODE === 'require');

const fdBaseConfig = {
  max: 10,
  idleTimeoutMillis: 60000,
  host: process.env.REPLICA_FD_CUSTOMIZE_CONVERSATION_HOST || process.env.FD_CUSTOMIZE_CONVERSATION_HOST,
  port: process.env.FD_CUSTOMIZE_CONVERSATION_PORT || 5432,
  database: process.env.FD_CUSTOMIZE_CONVERSATION_DBNAME,
  user: process.env.FD_CUSTOMIZE_CONVERSATION_USER,
  password: process.env.FD_CUSTOMIZE_CONVERSATION_PASS,
};

if (isFdCloudDb) {
  fdBaseConfig.ssl = { rejectUnauthorized: false };
}

// Unix Socket support (Cloud SQL / Cloud Run)
if (fdBaseConfig.host && fdBaseConfig.host.startsWith('/')) {
  delete fdBaseConfig.port;
}

export const fdPool = new Pool(fdBaseConfig);

export const fdQuery = (text, params) => fdPool.query(text, params);

fdPool.on('error', (err) => {
    console.error('Unexpected error on fondue-customize-conversation idle client', err);
});