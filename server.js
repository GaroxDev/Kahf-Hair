require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const http = require('http');
const https = require('https');
var cors = require('cors')
const agent = new https.Agent({
  rejectUnauthorized: false
});
const fetch = require('node-fetch'); // add this
const path = require('path');
const { Pool } = require('pg');
const {S3Client, PutObjectCommand} = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());

// ------------------- Config / Ports -------------------
const PORT = process.env.PORT || 4011;
const PORTSSL = process.env.PORTSSL || 4012;
const FASTAPI_HOST = process.env.FASTAPI_HOST || 'http://192.168.31.63:8001';
const DB_SCHEMA = process.env.DB_SCHEMA || 'public';
const DB_SCHEMA_PREFIX = DB_SCHEMA ? `${DB_SCHEMA}.` : '';

// ------------------- Postgres Pool -------------------
const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432
});

app.use((req, res, next) => {
  // Change password if path is NOT 'hair'
  let dbPassword = process.env.DB_PASS_SKIN;

  if (req.path.startsWith('/hair')) {
    dbPassword = process.env.DB_PASS;
  }

  // Create new pool for this request
  req.db = new Pool({
    password: dbPassword,
  });

  next();
});

// ------------------- S3 Client -------------------
const s3_client = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  }
});

async function uploadToS3(filepath, filename) {
  try {
    let key = `${process.env.S3_PATH || ''}${filename}`; // filename may already include folder prefix (e.g. 'users/...')
    let s3_url = `https://${process.env.S3_BUCKET}.${s3_client.config.defaultSigningName}.${process.env.S3_REGION}.amazonaws.com/${key}`;

    // Read file
    const file = await fsPromises.readFile(filepath);

    // Upload to S3
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: file,
      ACL: 'public-read',
    });

    const response = await s3_client.send(command);

    if (response['$metadata'] && response['$metadata'].httpStatusCode === 200) {
      return {
        s3_url,
        filepath,
        filename,
      };
    } else {
      return false;
    }
  } catch (err) {
    console.error('❌ uploadToS3 error:', err);
    return false;
  }
}

async function queryDB(query, params = []) {
  try {
    const res = await db.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('POSTGRES ERROR:', err);
    return { error: err };
  }
}

// Ensure uploads folder exists (root)
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Separate subfolders for users and hair
const UPLOADS_USER_DIR = path.join(UPLOADS_DIR, 'users');
const UPLOADS_HAIR_DIR = path.join(UPLOADS_DIR, 'hair');

[UPLOADS_DIR, UPLOADS_USER_DIR, UPLOADS_HAIR_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created ${path.relative(__dirname, dir)}/ folder`);
  }
});

// Ensure users table exists
async function ensureTables() {
  try {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${DB_SCHEMA_PREFIX}users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        phone VARCHAR(15),
        age INT,
        hair_selection VARCHAR(100),
        photo_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await db.query(createTableSQL);
    console.log(`✅ Ensured table ${DB_SCHEMA_PREFIX}users exists`);
  } catch (err) {
    console.error('❌ Error ensuring tables:', err);
  }
}

// Ensure hair_selections table exists (NEW)
async function ensureHairTable() {
  try {
    const createSQL = `
      CREATE TABLE IF NOT EXISTS ${DB_SCHEMA_PREFIX}hair_selections (
        id SERIAL PRIMARY KEY,
        hair_name VARCHAR(255) NOT NULL,
        hair_product TEXT,
        product_brand TEXT,
        photo_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await db.query(createSQL);
    console.log('✅ Ensured table ' + DB_SCHEMA_PREFIX + 'hair_selections exists');
  } catch (err) {
    console.error('❌ Error ensuring hair_selections table:', err);
  }
}

ensureTables().catch(() => {});
ensureHairTable().catch(() => {});

// ------------------- Middleware -------------------
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------- HTML Routes -------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index_skin.html')));
app.get('/hair', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index_hair.html')));

// ------------------- API Routes -------------------

// Forward face upload to FastAPI
app.post('/api/upload-face', async (req, res) => {
  console.log("📥 Received /api/upload-face request");
  try {
    const bodyData = req.body; // { center, left, right }
    const fastApiUrl = `${FASTAPI_HOST}/api/upload-face`;

    const response = await axios.post(fastApiUrl, bodyData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 300000 // 5 minutes
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error calling FastAPI (/api/upload-face):", error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ success: false, error: 'Failed to process face upload' });
  }
});

// Proxy analyze_v3
app.post('/api/analyze_v3', async (req, res) => {
  try {
    const response = await fetch('https://192.168.31.125:3091/analyze_v3', {
      agent: agent,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error proxying analyze_v3:', err);
    res.status(500).json({ error: 'Failed to analyze' });
  }
});

// process remaining gallery
app.post('/api/process-remaining-gallery', async (req, res) => {
  try {
    const bodyData = req.body;
    const fastApiUrl = `${FASTAPI_HOST}/api/process-remaining-gallery`;

    const response = await axios.post(fastApiUrl, bodyData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error calling FastAPI for remaining gallery:", error.message);
    if (error.response && error.response.data) {
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ success: false, error: 'Failed to process remaining gallery' });
  }
});

// process gallery batch
app.post('/api/process-gallery-batch', async (req, res) => {
  console.log("📥 Received /api/process-gallery-batch request");
  try {
    const bodyData = req.body; // { images: [...] }
    const fastApiUrl = `${FASTAPI_HOST}/api/process-gallery-batch`;

    const response = await axios.post(fastApiUrl, bodyData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error calling FastAPI for gallery batch:", error.message);
    if (error.response && error.response.data) {
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ success: false, error: 'Failed to process gallery batch' });
  }
});

// -------------- NEW: Save user direct endpoint (optional) --------------
app.post('/api/save-user', async (req, res) => {
  try {
    const { name, phone, age } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    // insert to DB
    const insertRes = await queryDB(
      `INSERT INTO ${DB_SCHEMA_PREFIX}users (name, phone, age) VALUES ($1,$2,$3) RETURNING *`,
      [name, phone || null, age || null]
    );

    if (insertRes && insertRes.error) {
      throw insertRes.error;
    }

    res.json({ success: true, data: insertRes[0] });
  } catch (err) {
    console.error('❌ Error /api/save-user:', err);
    res.status(500).json({ success: false, error: 'Failed to save user' });
  }
});

// server.js - Tambahkan endpoint ini setelah endpoint /api/save-user
app.post('/api/save-complete-user', async (req, res) => {
  try {
    const { name, phone, age, hair_type, face_base64 } = req.body;
    
    if (!name || !face_base64 || !hair_type) {
      return res.status(400).json({ 
        success: false, 
        error: 'name, face_base64, and hair_type are required' 
      });
    }

    // Simpan foto ke file (USER folder)
    let filename = null;
    let s3Url = null;
    
    if (face_base64) {
      const base64Data = face_base64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      filename = `user_${Date.now()}.png`;
      const filePath = path.join(UPLOADS_USER_DIR, filename); // <-- user folder
      fs.writeFileSync(filePath, buffer);
      
      // Upload to S3 with users/ prefix
      const s3KeyName = `users/${filename}`;
      const s3Result = await uploadToS3(filePath, s3KeyName);
      if (s3Result) {
        s3Url = s3Result.s3_url;
        console.log('✅ File uploaded to S3:', s3Url);
        
        // Optional: Delete local file after S3 upload to save space
        try {
          await fsPromises.unlink(filePath);
          console.log('🗑️ Local file deleted after S3 upload');
        } catch (deleteErr) {
          console.warn('⚠️ Could not delete local file:', deleteErr.message);
        }
      } else {
        console.warn('⚠️ S3 upload failed, keeping local file');
      }
    }

    // Insert ke database - store S3 URL if available, otherwise local path
    const photoPath = s3Url || path.join('uploads', 'users', filename);
    
    const insertRes = await queryDB(
      `INSERT INTO ${DB_SCHEMA_PREFIX}users (name, phone, age, hair_selection, photo_path) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, phone || null, age || null, hair_type, photoPath]
    );

    if (insertRes && insertRes.error) {
      throw insertRes.error;
    }

    res.json({ 
      success: true, 
      data: insertRes[0],
      message: 'User data saved successfully with face and hair selection',
      s3_url: s3Url // Include S3 URL in response
    });
  } catch (err) {
    console.error('❌ Error /api/save-complete-user:', err);
    res.status(500).json({ success: false, error: 'Failed to save complete user data' });
  }
});

// ------------------- MODIFIED /api/fuse-hair : forward -> save -> respond -------------------
app.post('/api/fuse-hair', async (req, res) => {
  try {
    const { face_base64, hair_type } = req.body;

    if (!face_base64 || !hair_type) {
      return res.status(400).json({ success: false, error: 'face_base64 and hair_type are required' });
    }

    // ✅ Forward directly to FastAPI
    const fastApiUrl = 'http://192.168.31.63:8001/api/fuse-hair';
    const response = await axios.post(fastApiUrl, {
      face_base64,
      hair_type
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 300000 // 5 minutes
    });

    console.log("✅ FastAPI fuse-hair responded");
    res.json(response.data);

  } catch (error) {
    console.error("❌ Error calling FastAPI fuse-hair:", error.message);
    if (error.response) {
      console.error("📄 FastAPI response data:", error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ success: false, error: 'Failed to fuse hair' });
  }
});

// POST: insert scan result (robust, safe)
app.post("/api/skin_result", async (req, res) => {
  try {
    const data = req.body;
    // console.log("📥 Raw req.body:", JSON.stringify(data, null, 2));

    // Normalizers
    const num = (v) => {
      if (v === undefined || v === null || v === "") return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };
    const str = (v) => (v === undefined || v === null ? "" : String(v));

    // build values explicitly and log them
    const values = [
      str(data.full_name),                    // $1
      str(data.phone),                        // $2
      str(data.age),                          // $3
      num(data.acne),                         // $4
      num(data.acne_scar),                    // $5
      num(data.dark_spot),                    // $6
      num(data.wrinkle),                      // $7
      num(data.enlarge_pores),                // $8
      num(data.fineline),                     // $9
      num(data.dullness),                     // $10
      num(data.eyebag),                       // $11
      num(data.hyperpigment),                 // $12
      num(data.loss_firmness),                // $13
      num(data.unseen_dark_spot),             // $14
      num(data.potential_acne),               // $15
      num(data.sensitivity),                  // $16
      str(data.skin_type),                    // $17
      str(data.skin_concern),                 // $18
      num(data.skin_age),                     // $19
      str(data.skin_color),                   // $20
      num(data.sebum_u),                      // $21
      num(data.sebum_t),                      // $22
      num(data.blackhead),                    // $23
      str(data.photo_path)                    // $24
    ];

    // final safety check (ensure index 13 -> unseen_dark_spot not null/undefined)
    if (values[13] === null || values[13] === undefined) {
      values[13] = 0;
    }

    const query = `
      INSERT INTO users_skin_result (
        full_name, phone, age,
        acne, acne_scar, dark_spot, wrinkle, enlarge_pores,
        fineline, dullness, eyebag, hyperpigment, loss_firmness,
        unseen_dark_spot, potential_acne, sensitivity,
        skin_type, skin_concern, skin_age, skin_color,
        sebum_u, sebum_t, blackhead, photo_path
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24
      )
      RETURNING id;
    `;

    const result = await db.query(query, values);
    console.log("DB insert result:", result.rows[0]);

    // Simpan foto ke file (USER folder)
    let filename = null;
    let s3Url = null;
    
    if (data.photo_path && data.photo_path !== "") {
      const base64Data = data.photo_path.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      filename = `user_${Date.now()}.png`;
      const filePath = path.join(UPLOADS_USER_DIR, filename); // <-- user folder
      fs.writeFileSync(filePath, buffer);
      
      // Upload to S3 with users/ prefix
      const s3KeyName = `users/${filename}`;
      const s3Result = await uploadToS3(filePath, s3KeyName);
      if (s3Result) {
        s3Url = s3Result.s3_url;
        console.log('✅ File uploaded to S3:', s3Url);
        
        // Optional: Delete local file after S3 upload to save space
        try {
          await fsPromises.unlink(filePath);
          console.log('🗑️ Local file deleted after S3 upload');
        } catch (deleteErr) {
          console.warn('⚠️ Could not delete local file:', deleteErr.message);
        }
      } else {
        console.warn('⚠️ S3 upload failed, keeping local file');
      }
    }

    return res.json({
      success: true,
      id: result.rows[0].id,
      message: "✅ Skin result inserted successfully!"
    });
  } catch (err) {
    console.error("❌ Error inserting skin result:", err);
    return res.status(500).json({ success: false, error: err.message || err });
  };
})

// Proxy predict-face-shape (base64)
app.post('/api/predict-face-shape', async (req, res) => {
  console.log("📥 Received /api/predict-face-shape request");

  try {
    const bodyData = req.body; // { image_base64 }

    const fastApiUrl = `${FASTAPI_HOST}/api/predict-face-shape`;

    // 🔍 Debug: check what Node is sending to FastAPI
    console.log("➡️ Forwarding request to:", fastApiUrl);
    console.log("📦 Body data keys:", Object.keys(bodyData));
    if (bodyData.image_base64) {
      console.log("🖼️ Base64 length:", bodyData.image_base64.length);
      console.log("🖼️ Base64 preview:", bodyData.image_base64.substring(0, 80) + "...");
    }

    const response = await axios.post(fastApiUrl, bodyData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ Error calling FastAPI (/api/predict-face-shape):", error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ success: false, error: 'Failed to predict face shape' });
  }
});

// ------------------- NEW: Save hairstyle selection endpoint -------------------
app.post('/api/save-hairstyle', async (req, res) => {
  try {
    const { hair_name, hair_product, product_brand, image_base64, hairstyle_filename } = req.body;
    if (!hair_name) {
      return res.status(400).json({ success: false, error: 'hair_name is required' });
    }
    let filename = null;
    let s3Url = null;
    // === Jika ada image ===
    if (image_base64 && image_base64.startsWith('data:image/')) {
      try {
        const base64Data = image_base64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        // Ambil nama file dari frontend untuk S3
        const ext = path.extname(hairstyle_filename || '') || '.png';
        const baseName = path.basename(hairstyle_filename || 'hair', ext).replace(/\s+/g, '_').replace(/[^\w\-_.]/g, '');
        filename = `${baseName}_${Date.now()}${ext}`;
        // Simpan ke folder lokal sementara (HAIR folder)
        const filePath = path.join(UPLOADS_HAIR_DIR, filename);
        await fsPromises.writeFile(filePath, buffer);
        // Upload ke S3 with hair/ prefix
        const s3KeyName = `hair/${filename}`;
        const s3Result = await uploadToS3(filePath, s3KeyName);
        if (s3Result?.s3_url) {
          s3Url = s3Result.s3_url;
          // Hapus file lokal
          try {
            await fsPromises.unlink(filePath);
            console.log('🗑️ Local file deleted after S3 upload');
          } catch (deleteErr) {
            console.warn('⚠️ Could not delete local file:', deleteErr.message);
          }
        } else {
          console.warn('⚠️ S3 upload failed for hair file, keeping local copy at', filePath);
        }
        console.log('🖼️ Uploaded hairstyle image to S3:', s3Url || filePath);
      } catch (imgErr) {
        console.warn('⚠️ Failed to process image_base64:', imgErr.message);
      }
    }
    const photoPath = s3Url || (filename ? path.join('uploads', 'hair', filename) : null);
    // === Simpan ke DB tanpa menyertakan hairstyle_filename ===
    const insertQuery = `
      INSERT INTO ${DB_SCHEMA_PREFIX}hair_selections
        (hair_name, hair_product, product_brand, photo_path)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const params = [hair_name, hair_product || null, product_brand || null, photoPath || null];
    const result = await db.query(insertQuery, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('❌ Error /api/save-hairstyle:', err);
    res.status(500).json({ success: false, error: 'Failed to save hairstyle selection' });
  }
});

// ------------------- Start HTTP Server -------------------
app.listen(PORT, () => console.log(`🚀 HTTP Server running at http://localhost:${PORT}`));

// ------------------- Start HTTPS Server (if certs exist) -------------------
try {
  const keyPath = path.join(__dirname, 'server.key');
  const certPath = path.join(__dirname, 'server.cert');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.warn('⚠️ HTTPS certificates not found, skipping HTTPS server');
  } else {
    const serverSSL = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      app
    );

    serverSSL.listen(PORTSSL, () =>
      console.log(`🔒 HTTPS Server running at https://localhost:${PORTSSL}`)
    );
  }
} catch (err) {
  console.error("❌ Failed to start HTTPS server:", err);
}
