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

// 1. ESP32 Endpoint (Save Attendance)
app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status } = req.body;
    
    // Find student to get name
    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [fingerprint_id]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    await pool.query(
      'INSERT INTO attendance (fingerprint_id, student_name, status) VALUES ($1, $2, $3)',
      [fingerprint_id, studentName, status]
    );

    console.log(`✅ Logged: ${studentName} (ID: ${fingerprint_id}) - ${status}`);
    res.status(200).json({ success: true });

  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ success: false });
  }
});

// 2. Get Attendance Logs (with Reg Number mapping)
app.get('/api/logs', async (req, res) => {
  try {
    const { date } = req.query; 
    let query = `
      SELECT a.*, s.reg_number,
      (SELECT COUNT(*) FROM attendance a2 
       WHERE a2.fingerprint_id = a.fingerprint_id 
       AND DATE(a2.scanned_at) = DATE(a.scanned_at)) as scan_count
      FROM attendance a 
      LEFT JOIN students s ON a.fingerprint_id = s.fingerprint_id
    `;
    let values = [];

    if (date) {
      query += ` WHERE DATE(a.scanned_at) = $1`;
      values.push(date);
    }

    query += ` ORDER BY a.scanned_at DESC LIMIT 100`;
    
    const result = await pool.query(query, values);
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 3. Get All Active Students
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students WHERE deleted_at IS NULL ORDER BY name ASC');
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 4. Soft Delete a Student (Move to Trash)
app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE students SET deleted_at = NOW() WHERE fingerprint_id = $1', [id]);
    res.status(200).json({ success: true, message: "Student moved to trash." });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 5. Get Trash Bin
app.get('/api/trash', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 6. Restore Student from Trash
app.put('/api/trash/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE students SET deleted_at = NULL WHERE fingerprint_id = $1', [id]);
    res.status(200).json({ success: true, message: "Student restored." });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 SentinEx API running on port ${process.env.PORT}`);
});