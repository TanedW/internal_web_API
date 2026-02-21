import pg from 'pg';

const { Pool } = pg;

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

// จัดการ Unix Socket สำหรับ Cloud SQL ใน Cloud Run
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

primaryPool.on('error', (err) => {
    console.error('Unexpected error on primary idle client', err);
    ;
});

replicaPool.on('error', (err) => {
    console.error('Unexpected error on replica idle client', err);
});
