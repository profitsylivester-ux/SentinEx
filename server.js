const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors({ limit: '10mb' })); // Increase limit for base64 images
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

// --- TENANT MANAGEMENT (Super Admin) ---
app.get('/api/tenants/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants WHERE tenant_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "School not found" });
    res.status(200).json(result.rows[0]);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/tenants', async (req, res) => {
  try {
    const { tenant_id, name, logo_data } = req.body;
    // New schools default to 'pending'
    await pool.query(
      "INSERT INTO tenants (tenant_id, name, logo_data, status) VALUES ($1, $2, $3, 'pending')",
      [tenant_id, name, logo_data]
    );
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: "Tenant ID exists" }); }
});

app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/tenants/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE tenants SET status = $1 WHERE tenant_id = $2', [status, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

// --- ESP32 & ATTENDANCE ---
app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status, tenant_id } = req.body;
    const tid = tenant_id || 'sentinex';
    
    // Check if tenant is active
    const tenantCheck = await pool.query('SELECT status FROM tenants WHERE tenant_id = $1', [tid]);
    if (tenantCheck.rows.length > 0 && tenantCheck.rows[0].status !== 'active') {
      return res.status(403).json({ success: false, error: "Tenant suspended" });
    }

    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1 AND tenant_id = $2', [fingerprint_id, tid]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    await pool.query(
      'INSERT INTO attendance (tenant_id, fingerprint_id, student_name, status) VALUES ($1, $2, $3, $4)',
      [tid, fingerprint_id, studentName, status]
    );
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/approve-pending', async (req, res) => {
  try {
    const { fingerprint_id, admin_name, tenant_id } = req.body;
    const result = await pool.query(
      `UPDATE attendance SET status = 'Manual' WHERE fingerprint_id = $1 AND tenant_id = $2 AND status = 'Pending' AND DATE(scanned_at) = CURRENT_DATE RETURNING student_name`,
      [fingerprint_id, tenant_id]
    );
    if (result.rowCount > 0) {
      await logAction(tenant_id, admin_name, 'APPROVE_PENDING', fingerprint_id, `Approved manual request.`);
      res.status(200).json({ success: true });
    } else { res.status(404).json({ success: false }); }
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/login-audit', async (req, res) => {
  const { admin_name, tenant_id } = req.body;
  await logAction(tenant_id || 'sentinex', admin_name, 'LOGIN', 'System', 'Admin logged in.');
  res.status(200).json({ success: true });
});

app.get('/api/audit-logs', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const result = await pool.query('SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT 100', [tenant_id]);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/logs', async (req, res) => {
  try {
    const { date, tenant_id } = req.query; 
    let query = `
      SELECT a.*, s.reg_number,
      (SELECT COUNT(*) FROM attendance a2 WHERE a2.fingerprint_id = a.fingerprint_id AND a2.tenant_id = a.tenant_id AND DATE(a2.scanned_at) = DATE(a.scanned_at)) as scan_count
      FROM attendance a LEFT JOIN students s ON a.fingerprint_id = s.fingerprint_id AND a.tenant_id = s.tenant_id
      WHERE a.tenant_id = $1
    `;
    let values = [tenant_id];
    if (date) { query += ` AND DATE(a.scanned_at) = $2`; values.push(date); }
    query += ` ORDER BY a.scanned_at DESC LIMIT 100`;
    const result = await pool.query(query, values);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/students', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const result = await pool.query('SELECT * FROM students WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name ASC', [tenant_id]);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/students', async (req, res) => {
  try {
    const { fingerprint_id, name, reg_number, admin_name, tenant_id } = req.body;
    await pool.query(
      'INSERT INTO students (tenant_id, fingerprint_id, name, reg_number, role) VALUES ($1, $2, $3, $4, $5)',
      [tenant_id, fingerprint_id, name, reg_number, 'student']
    );
    await logAction(tenant_id, admin_name, 'ADD_STUDENT', reg_number, `Added student: ${name}`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, reg_number, admin_name, tenant_id } = req.body;
    await pool.query('UPDATE students SET name = $1, reg_number = $2 WHERE fingerprint_id = $3 AND tenant_id = $4', [name, reg_number, id, tenant_id]);
    await logAction(tenant_id, admin_name, 'EDIT_STUDENT', reg_number, `Updated details.`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_name, tenant_id } = req.body;
    await pool.query('UPDATE students SET deleted_at = NOW() WHERE fingerprint_id = $1 AND tenant_id = $2', [id, tenant_id]);
    await logAction(tenant_id, admin_name, 'DELETE_STUDENT', id, `Moved to Trash.`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/trash/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_name, tenant_id } = req.body;
    await pool.query('UPDATE students SET deleted_at = NULL WHERE fingerprint_id = $1 AND tenant_id = $2', [id, tenant_id]);
    await logAction(tenant_id, admin_name, 'RESTORE_STUDENT', id, `Restored student.`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/trash', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const result = await pool.query('SELECT * FROM students WHERE tenant_id = $1 AND deleted_at IS NOT NULL', [tenant_id]);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 SentinEx API running on port ${process.env.PORT}`);
});