require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mysql = require('mysql2');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const resourceType = file.mimetype.startsWith('image') ? 'image' : 'video';
    return {
      folder: 'obtc-uploads',
      resource_type: resourceType,
      public_id: uuidv4()
    };
  }
});
const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'hi-form-secret',
  resave: false,
  saveUninitialized: false
}));

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});
db.connect((err) => {
  if (err) {
    console.error('❌ ไม่สามารถเชื่อมต่อ MySQL:', err);
  } else {
    console.log('✅ เชื่อมต่อ MySQL สำเร็จ');
  }
});
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendEmail = (subject, body) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_RECEIVER,
    subject: subject,
    text: body
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('❌ ส่งอีเมลไม่สำเร็จ:', error.message);
    } else {
      console.log('✅ ส่งอีเมลสำเร็จ:', info.response);
    }
  });
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin-login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin-login'));
});

app.get('/admin', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.post('/submit', upload.array('mediaFiles'), async (req, res) => {
  try {
    console.log('📨 รับข้อมูลใหม่:', JSON.stringify(req.body, null, 2));
    console.log('🖼️ req.files:', req.files);

    const files = req.files || [];
    const { name, phone, address, message, latitude, longitude } = req.body;
    const category = '';

    if (!name || !phone || !address || !message) {
      return res.status(400).send('❌ ข้อมูลไม่ครบ');
    }

    const photoUrls = files.map(f => {
      let type = 'other';
      if (f.mimetype.startsWith('image')) {
        type = 'image';
      } else if (f.mimetype.startsWith('video')) {
        type = 'video';
      }
      return {
        url: f.path,
        type
      };
    });

    const photoUrl = JSON.stringify(photoUrls);

    const sql = `
      INSERT INTO requests 
      (name, phone, address, category, message, latitude, longitude, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [name, phone, address, category, message, latitude, longitude, photoUrl];

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error('❌ บันทึกข้อมูลล้มเหลว:', err);
        return res.status(500).send('❌ บันทึกไม่สำเร็จ');
      }

      // ✅ เพิ่มตรงนี้: ส่งอีเมลแจ้งเตือน
      sendEmail(
        '📬 แจ้งเตือนคำร้องใหม่',
        `ชื่อ: ${name}\nเบอร์โทร: ${phone}\nที่อยู่: ${address}\nข้อความ: ${message}`
      );

      console.log('✅ บันทึกคำร้อง:', JSON.stringify(result, null, 2));
      return res.send(`
        <h2>✅ ส่งคำร้องสำเร็จ</h2>
        <p>ขอบคุณ ${name}</p>
        <p><a href="/">🔙 กลับหน้าหลัก</a></p>
      `);
    });


  } catch (error) {
    console.error('💥 เกิดข้อผิดพลาดไม่คาดคิด:', error);
    res.status(500).send('💥 เกิดข้อผิดพลาดไม่คาดคิด');
  }
});

app.get('/data', (req, res) => {
  const department = req.query.department;
  let sql = 'SELECT * FROM requests WHERE processed = false';
  const params = [];

  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }

  sql += ' ORDER BY id DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.get('/data-approved', (req, res) => {
  const department = req.query.department;
  if (!department) return res.status(400).json({ error: 'กรุณาระบุแผนก' });

  const sql = `
    SELECT * FROM requests 
    WHERE department = ? AND approved = 1 AND processed = true
    ORDER BY id DESC
  `;

  db.query(sql, [department], (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.get('/processed', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'processed.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-sp', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-sp.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-health', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-health.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-engineer', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-engineer.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-electric', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-electric.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/admin-other', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin-other.html'));
  } else {
    res.redirect('/admin-login');
  }
});

app.get('/data-processed', (req, res) => {
  const department = req.query.department;
  let sql = 'SELECT * FROM requests WHERE processed = true';
  const params = [];

  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }

  sql += ' ORDER BY id DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
    res.json(results);
  });
});

app.post('/approve/:id', (req, res) => {
  const id = req.params.id;
  db.query('UPDATE requests SET approved = 1, processed = true WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('❌ อนุมัติไม่สำเร็จ');
    res.send('✅ อนุมัติสำเร็จ');
  });
});

app.post('/reject/:id', (req, res) => {
  const id = req.params.id;
  db.query('UPDATE requests SET approved = 0, processed = true WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('❌ ปฏิเสธไม่สำเร็จ');
    res.send('✅ ปฏิเสธคำร้องแล้ว');
  });
});

app.post('/set-department/:id', (req, res) => {
  const { department } = req.body;
  const id = req.params.id;

  console.log(`📌 รับข้อมูลเปลี่ยนแผนก id=${id}, department=${department}`);

  if (!department) {
    return res.status(400).json({ message: '❌ ต้องระบุแผนก' });
  }

  db.query('UPDATE requests SET department = ? WHERE id = ?', [department, id], (err, result) => {
    if (err) {
      console.error('❌ SQL error:', err);
      return res.status(500).json({ message: '❌ เปลี่ยนแผนกไม่สำเร็จ' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '❌ ไม่พบคำร้องนี้' });
    }

    console.log(`✅ อัปเดตแผนก id=${id} -> ${department}`);
    res.json({ message: '✅ เปลี่ยนแผนกแล้ว' });
  });
});

app.post('/disapprove/:id', (req, res) => {
  const id = req.params.id;
  db.query('UPDATE requests SET approved = 0, processed = true WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('เกิดข้อผิดพลาด');
    res.sendStatus(200);
  });
});
app.get('/data-engineer-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['กองช่าง'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

app.get('/data-health-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['สาธารณสุข'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

app.get('/data-electric-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['ไฟฟ้า'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

app.get('/data-other-all', (req, res) => {
  db.query('SELECT * FROM requests WHERE department = ? ORDER BY id DESC', ['อื่นๆ'], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});
app.get('/data-approved-all', (req, res) => {
  const sql = 'SELECT * FROM requests WHERE approved = 1 ORDER BY id DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});
app.get('/approved-all', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'approved-all.html'));
  } else {
    res.redirect('/admin-login');
  }
});


app.get('/data-sp-all', (req, res) => {
  db.query(
    'SELECT * FROM requests WHERE department = ? ORDER BY id DESC',
    ['สำนักงานปลัด'],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
      res.json(results);
    }
  );
});


app.use((req, res) => {
  res.status(404).send('ไม่พบหน้าเว็บที่คุณเรียก');
});

app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err);
  res.status(500).send('เกิดข้อผิดพลาดในเซิร์ฟเวอร์');
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
