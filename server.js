const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// FIX: Force the server to read HTML files in UTF-8 so emojis work
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// Connect to Neon Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Endpoint for ESP32 to send scans
app.post('/api/scan', async (req, res) => {
  try {
    const { fingerprint_id, status } = req.body;
    
    // 1. Find the student in the database
    const studentResult = await pool.query('SELECT name FROM students WHERE fingerprint_id = $1', [fingerprint_id]);
    const studentName = studentResult.rows.length > 0 ? studentResult.rows[0].name : 'Unknown';

    // 2. Save to attendance logs
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

// Endpoint for the Frontend to fetch logs
app.get('/api/logs', async (req, res) => {
  try {
    // This query counts how many times a student scanned TODAY for the warning icon
    const query = `
      SELECT a.*, 
      (SELECT COUNT(*) FROM attendance a2 
       WHERE a2.fingerprint_id = a.fingerprint_id 
       AND DATE(a2.scanned_at) = DATE(a.scanned_at)) as scan_count
      FROM attendance a 
      ORDER BY a.scanned_at DESC 
      LIMIT 50
    `;
    const result = await pool.query(query);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Failed to fetch logs" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 SentinEx API running on port ${process.env.PORT}`);
});