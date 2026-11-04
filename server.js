const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Force UTF-8 for Emojis
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

// Endpoint for ESP32 to send scans
app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status } = req.body;
    
    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [fingerprint_id]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    await pool.query(
      'INSERT INTO attendance (fingerprint_id, student_name, status) VALUES ($1, $2, $3)',
      [fingerprint_id, studentName, status]
    );

    console.log(`✅ [SENTINEX CLOUD] Logged: ${studentName} (ID: ${fingerprint_id}) - ${status}`);
    res.status(200).json({ success: true, message: "Scan saved to Neon!" });

  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// UPDATED: Endpoint for Frontend to fetch logs (with Date Filtering)
app.get('/api/logs', async (req, res) => {
  try {
    const { date } = req.query; 
    let query = `
      SELECT a.*, 
      (SELECT COUNT(*) FROM attendance a2 
       WHERE a2.fingerprint_id = a.fingerprint_id 
       AND DATE(a2.scanned_at) = DATE(a.scanned_at)) as scan_count
      FROM attendance a 
    `;
    let values = [];

    // If a date was provided (e.g., ?date=2026-11-04), filter by it
    if (date) {
      query += ` WHERE DATE(a.scanned_at) = $1`;
      values.push(date);
    }

    query += ` ORDER BY a.scanned_at DESC LIMIT 100`;
    
    const result = await pool.query(query, values);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Failed to fetch logs" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 SentinEx API running on port ${process.env.PORT}`);
});