// --- SUPER ADMIN GLOBAL STATS ---
app.get('/api/superadmin/stats', async (req, res) => {
  try {
    // ADDED: t.last_heartbeat and t.device_status_msg to the query
    const tenantsQuery = `
      SELECT t.tenant_id, t.name, t.logo_data, t.status, t.created_at, t.last_heartbeat, t.device_status_msg, t.last_heartbeat, t.device_status_msg,
      (SELECT COUNT(*) FROM students s WHERE s.tenant_id = t.tenant_id AND deleted_at IS NULL) as student_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.tenant_id = t.tenant_id AND status != 'Denied') as scan_count
      FROM tenants t 
      ORDER BY t.created_at DESC
    `;
    const tenantsResult = await pool.query(tenantsQuery);

    let globalStudents = 0;
    let globalScans = 0;
    tenantsResult.rows.forEach(t => {
      globalStudents += parseInt(t.student_count);
      globalScans += parseInt(t.scan_count);
    });

    res.status(200).json({
      tenants: tenantsResult.rows,
      globalStudents,
      globalScans
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// --- NEW: DEVICE HEARTBEAT ENDPOINT ---
// The ESP32 will call this every 60 seconds
app.post('/api/device/heartbeat', async (req, res) => {
  try {
    const { tenant_id, status_msg } = req.body;
    // Update the last_heartbeat to right now, and set the status message (defaults to 'OK')
    await pool.query(
      'UPDATE tenants SET last_heartbeat = NOW(), device_status_msg = $1 WHERE tenant_id = $2', 
      [status_msg || 'OK', tenant_id]
    );
    res.status(200).json({ success: true });
  } catch (error) { 
    res.status(500).json({ success: false }); 
  }
});
