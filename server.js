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

// --- AUTHENTICATION ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username.toLowerCase() === 'superadmin') {
      const adminPass = await pool.query("SELECT value FROM platform_settings WHERE key = 'superadmin_password'");
      if (adminPass.rows.length > 0 && password === adminPass.rows[0].value) {
        return res.json({ success: true, role: 'superadmin', tenant_id: 'superadmin', name: 'Master Admin' });
      }
      return res.status(401).json({ error: "Invalid Super Admin credentials." });
    }

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE tenant_id = $1 AND admin_password = $2', [username.toLowerCase(), password]);
    
    if (tenantRes.rows.length > 0) {
      const t = tenantRes.rows[0];
      if (t.status !== 'active') return res.status(403).json({ error: `Account is ${t.status}. Contact SentinEx HQ.` });
      return res.json({ 
        success: true, role: 'admin', tenant_id: t.tenant_id, name: t.name, logo: t.logo_data, 
        start_time: t.start_time, late_time: t.late_time, closing_time: t.closing_time 
      });
    }

    return res.status(401).json({ error: "Invalid Organization ID or Password." });
  } catch (error) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/login-audit', async (req, res) => {
  const { admin_name, tenant_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO audit_logs (tenant_id, admin_name, action_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
      [tenant_id, admin_name, 'LOGIN', 'System', 'Admin logged in.']
    );
  } catch (err) {}
  res.status(200).json({ success: true });
});

// --- SETTINGS ---
app.put('/api/settings/password', async (req, res) => {
  try {
    const { tenant_id, old_password, new_password } = req.body;

    if (tenant_id === 'superadmin') {
      const current = await pool.query("SELECT value FROM platform_settings WHERE key = 'superadmin_password'");
      if (current.rows[0].value !== old_password) return res.status(400).json({ error: "Incorrect old password." });
      await pool.query("UPDATE platform_settings SET value = $1 WHERE key = 'superadmin_password'", [new_password]);
      return res.json({ success: true });
    } else {
      const current = await pool.query('SELECT admin_password FROM tenants WHERE tenant_id = $1', [tenant_id]);
      if (current.rows[0].admin_password !== old_password) return res.status(400).json({ error: "Incorrect old password." });
      await pool.query('UPDATE tenants SET admin_password = $1 WHERE tenant_id = $2', [new_password, tenant_id]);
      return res.json({ success: true });
    }
  } catch (error) { res.status(500).json({ error: "Server error" }); }
});

app.put('/api/settings/times', async (req, res) => {
  try {
    const { tenant_id, start_time, late_time, closing_time } = req.body;
    await pool.query(
      'UPDATE tenants SET start_time = $1, late_time = $2, closing_time = $3 WHERE tenant_id = $4', 
      [start_time, late_time, closing_time, tenant_id]
    );
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: "Server error" }); }
});

// --- TENANT MANAGEMENT ---
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT tenant_id, name, logo_data, status, created_at FROM tenants ORDER BY created_at DESC');
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/tenants', async (req, res) => {
  try {
    const { tenant_id, name, logo_data } = req.body;
    await pool.query(
      "INSERT INTO tenants (tenant_id, name, logo_data, status, admin_password, start_time, late_time, closing_time) VALUES ($1, $2, $3, 'pending', '1234', '07:00', '08:00', '18:00')",
      [tenant_id.toLowerCase(), name, logo_data]
    );
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: "Tenant ID exists" }); }
});

app.put('/api/tenants/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE tenants SET status = $1 WHERE tenant_id = $2', [status, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

// --- ANALYTICS ---
app.get('/api/analytics/trend', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const result = await pool.query(`
      SELECT DATE(scanned_at) as date, COUNT(*) as count 
      FROM attendance 
      WHERE tenant_id = $1 AND status != 'Pending' AND status != 'Denied' AND scanned_at >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY DATE(scanned_at) 
      ORDER BY DATE(scanned_at) ASC
    `, [tenant_id]);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

// --- ESP32 & ATTENDANCE ---
app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status, tenant_id } = req.body;
    const tid = tenant_id || 'sentinex';
    
    const tenantCheck = await pool.query('SELECT status, start_time, late_time, closing_time FROM tenants WHERE tenant_id = $1', [tid]);
    if (tenantCheck.rows.length > 0 && tenantCheck.rows[0].status !== 'active') return res.status(403).json({ success: false });

    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1 AND tenant_id = $2', [fingerprint_id, tid]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    // --- TIME LOGIC ---
    let finalStatus = status;
    if (status === 'Granted') {
      const now = new Date();
      const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
      
      const startTime = tenantCheck.rows[0].start_time || '07:00';
      const lateTime = tenantCheck.rows[0].late_time || '08:00';
      const closingTime = tenantCheck.rows[0].closing_time || '18:00';
      
      if (currentTime < startTime) {
          finalStatus = 'Denied'; // Too early
      } else if (currentTime >= startTime && currentTime <= lateTime) {
          finalStatus = 'Granted'; // On time
      } else if (currentTime > lateTime && currentTime <= closingTime) {
          finalStatus = 'Late'; // Late
      } else {
          finalStatus = 'Denied'; // Too late (after closing)
      }
    }

    await pool.query(
      'INSERT INTO attendance (tenant_id, fingerprint_id, student_name, status) VALUES ($1, $2, $3, $4)',
      [tid, fingerprint_id, studentName, finalStatus]
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
      WHERE a.tenant_id = $1 AND a.status != 'Denied'
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