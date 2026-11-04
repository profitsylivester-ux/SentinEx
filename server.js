const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

async function logAction(admin, action, target, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (admin_name, action_type, target_id, details) VALUES ($1, $2, $3, $4)',
      [admin, action, target, details]
    );
  } catch (err) { console.error("Audit Log Error:", err); }
}

app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status } = req.body;
    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [fingerprint_id]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    await pool.query(
      'INSERT INTO attendance (fingerprint_id, student_name, status) VALUES ($1, $2, $3)',
      [fingerprint_id, studentName, status]
    );
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

// NEW: Approve Pending Request
app.put('/api/approve-pending', async (req, res) => {
  try {
    const { fingerprint_id, admin_name } = req.body;
    
    // Find the latest Pending scan for this ID
    const result = await pool.query(
      `UPDATE attendance 
       SET status = 'Manual' 
       WHERE fingerprint_id = $1 AND status = 'Pending' AND DATE(scanned_at) = CURRENT_DATE
       RETURNING student_name`,
      [fingerprint_id]
    );

    if (result.rowCount > 0) {
      const name = result.rows[0].student_name;
      await logAction(admin_name, 'APPROVE_PENDING', fingerprint_id, `Approved manual request for ${name}.`);
      res.status(200).json({ success: true });
    } else {
      res.status(404).json({ success: false, message: "No pending request found today." });
    }
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/login-audit', async (req, res) => {
  await logAction(req.body.admin_name, 'LOGIN', 'System', 'Admin logged into the dashboard.');
  res.status(200).json({ success: true });
});

app.get('/api/audit-logs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100');
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/logs', async (req, res) => {
  try {
    const { date } = req.query; 
    let query = `
      SELECT a.*, s.reg_number,
      (SELECT COUNT(*) FROM attendance a2 WHERE a2.fingerprint_id = a.fingerprint_id AND DATE(a2.scanned_at) = DATE(a.scanned_at)) as scan_count
      FROM attendance a LEFT JOIN students s ON a.fingerprint_id = s.fingerprint_id
    `;
    let values = [];
    if (date) {
      query += ` WHERE DATE(a.scanned_at) = $1`;
      values.push(date);
    }
    query += ` ORDER BY a.scanned_at DESC LIMIT 100`;
    const result = await pool.query(query, values);
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students WHERE deleted_at IS NULL ORDER BY name ASC');
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/students', async (req, res) => {
  try {
    const { fingerprint_id, name, reg_number, admin_name } = req.body;
    await pool.query(
      'INSERT INTO students (fingerprint_id, name, reg_number, role) VALUES ($1, $2, $3, $4)',
      [fingerprint_id, name, reg_number, 'student']
    );
    await logAction(admin_name || 'Admin', 'ADD_STUDENT', reg_number, `Added student: ${name}`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: "ID or Reg No exists." }); }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, reg_number, admin_name } = req.body;
    await pool.query(
      'UPDATE students SET name = $1, reg_number = $2 WHERE fingerprint_id = $3',
      [name, reg_number, id]
    );
    await logAction(admin_name || 'Admin', 'EDIT_STUDENT', reg_number, `Updated details to Name: ${name}, Reg: ${reg_number}`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_name } = req.body;
    const student = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [id]);
    const name = student.rows.length > 0 ? student.rows[0].name : `Slot ${id}`;
    await pool.query('UPDATE students SET deleted_at = NOW() WHERE fingerprint_id = $1', [id]);
    await logAction(admin_name || 'Admin', 'DELETE_STUDENT', id, `Moved student ${name} to Trash.`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/trash/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_name } = req.body;
    const student = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [id]);
    const name = student.rows.length > 0 ? student.rows[0].name : `Slot ${id}`;
    await pool.query('UPDATE students SET deleted_at = NULL WHERE fingerprint_id = $1', [id]);
    await logAction(admin_name || 'Admin', 'RESTORE_STUDENT', id, `Restored student ${name}.`);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/trash', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    res.status(200).json(result.rows);
  } catch (error) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 SentinEx API running on port ${process.env.PORT}`);
});