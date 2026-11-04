const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors({ limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function logAction(tenant_id, admin, action, target, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (tenant_id, admin_name, action_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
      [tenant_id, admin, action, target, details]
    );
  } catch (err) { console.error("Audit Error:", err); }
}

// ... (Keep all existing Auth, Settings, Tenants, Analytics, Scan, Approve, Audit, Logs, Students, Trash endpoints exactly as they are) ...

// --- NEW: OFFLINE SYNC ENDPOINT ---
app.post('/api/sync-offline', async (req, res) => {
  try {
    const { tenant_id, records } = req.body;
    
    if (!records || records.length === 0) return res.status(400).json({ error: "No records provided." });

    let insertedCount = 0;
    
    for (let record of records) {
      const { fingerprint_id, status, timestamp } = record;
      
      // Get student name
      const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1 AND tenant_id = $2', [fingerprint_id, tenant_id]);
      const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

      // Check for duplicates (same ID, same timestamp)
      const checkDup = await pool.query(
        'SELECT id FROM attendance WHERE tenant_id = $1 AND fingerprint_id = $2 AND scanned_at = $3',
        [tenant_id, fingerprint_id, timestamp]
      );

      if (checkDup.rows.length === 0) {
        await pool.query(
          'INSERT INTO attendance (tenant_id, fingerprint_id, student_name, status, scanned_at) VALUES ($1, $2, $3, $4, $5)',
          [tenant_id, fingerprint_id, studentName, status, timestamp]
        );
        insertedCount++;
      }
    }

    await logAction(tenant_id, 'Admin', 'SYNC_OFFLINE', 'System', `Synced ${insertedCount} offline records.`);
    res.status(200).json({ success: true, inserted: insertedCount });
  } catch (error) {
    console.error("Sync Error:", error);
    res.status(500).json({ success: false });
  }
});