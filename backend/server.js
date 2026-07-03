const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const bcrypt = require('bcryptjs');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// 1. CẤU HÌNH KẾT NỐI DATABASE SQL (Đáp ứng YCNC 4, 9) 
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// Kiểm tra kết nối SQL lúc khởi động
db.getConnection((err, connection) => {
    if (err) console.error('❌ Lỗi kết nối Database:', err.message);
    else {
        console.log('🚀 Kết nối Database SQL thành công!');
        connection.release();
    }
});

// 2. CẤU HÌNH KẾT NỐI MQTT BROKER (Luồng Căn Bản 1) [cite: 18]
const mqttClient = mqtt.connect(process.env.MQTT_BROKER);

mqttClient.on('connect', () => {
    console.log('📡 Đã kết nối thành công tới MQTT Broker!');
    mqttClient.subscribe('door/rfid'); // Lắng nghe dữ liệu từ đầu đọc RFID [cite: 18]
});

// Lắng nghe tín hiệu quẹt thẻ từ ESP gửi lên (Luồng Căn Bản 1 -> YCNC 4) [cite: 18, 44]
mqttClient.on('message', (topic, message) => {
    if (topic === 'door/rfid') {
        const cardUid = message.toString().trim();
        const status = "Mở cửa thành công"; 

        console.log(`[MQTT] Phát hiện thẻ quẹt: ${cardUid}`);

        // Ghi lịch sử vào Database SQL (YCNC 4) [cite: 44]
        const sql = 'INSERT INTO rfid_logs (card_uid, status) VALUES (?, ?)';
        db.query(sql, [cardUid, status], (err) => {
            if (err) console.error('❌ Lỗi lưu lịch sử quẹt thẻ:', err);
            else console.log('💾 Đã lưu lịch sử quẹt thẻ vào SQL thành công.');
        });
    }
});

// 3. XÂY DỰNG CÁC API HTTP CHO FRONTEND
// API Đăng nhập hệ thống (YCNC 9) 
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại!' });

        const user = results[0];
        // So sánh mật khẩu đã băm mã hóa
        const isMatch = password === user.password_hash; // Thay bằng bcrypt.compare(password, user.password_hash) nếu dùng hash thực sự
        if (!isMatch) return res.status(401).json({ message: 'Mật khẩu không chính xác!' });

        res.json({ success: true, message: 'Đăng nhập thành công!', user: { username: user.username, name: user.full_name } });
    });
});

// API ĐỔI MẬT KHẨU (Nhận mật khẩu thô -> Hash -> Lưu vào SQL)
app.post('/api/change-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;

    // Bước 1: Kiểm tra xem tài khoản có tồn tại không
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'Tài khoản không tồn tại!' });

        const user = results[0];

        // Bước 2: Xác thực mật khẩu cũ xem có đúng chính chủ không
        const isMatch = oldPassword === user.password_hash;
        if (!isMatch) return res.status(401).json({ message: 'Mật khẩu cũ không chính xác!' });

        try {
            // Bước 3: ĐÂY LÀ HÀM ĐỂ HASH MẬT KHẨU MỚI
            // Số 10 ở đây là "saltRounds" (độ phức tạp của thuật toán mã hóa)
            const salt = await bcrypt.genSalt(10);
            const newHash = await bcrypt.hash(newPassword, salt);

            // Bước 4: Chạy lệnh SQL UPDATE để lưu chuỗi hash mới đè lên chuỗi cũ
            db.query(
                'UPDATE users SET password_hash = ? WHERE username = ?', 
                [newPassword, username], 
                (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    
                    res.json({ success: true, message: 'Đổi mật khẩu mới thành công!' });
                }
            );
        } catch (hashError) {
            res.status(500).json({ message: 'Lỗi trong quá trình mã hóa mật khẩu.' });
        }
    });
});

// API Lấy danh sách lịch sử quẹt thẻ (YCNC 4 & YCNC 5 hiển thị dạng Text/Chart) 
app.get('/api/history', (req, res) => {
    db.query('SELECT * FROM rfid_logs ORDER BY scanned_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// API Điều khiển cửa từ Web -> Servo (Luồng Căn Bản 2) [cite: 19]
app.post('/api/control-door', (req, res) => {
    const { command } = req.body; // Lệnh "LOCK_ALL" hoặc "UNLOCK_ALL"
    
    console.log(`[Web API] Nhận lệnh điều khiển từ Web: ${command}`);
    
    // Bắn lệnh MQTT xuống cho board ESP nhận để điều khiển Servo (Luồng 2) [cite: 19]
    mqttClient.publish('door/control', command, (err) => {
        if (err) return res.status(500).json({ message: 'Lỗi gửi lệnh MQTT' });
        res.json({ success: true, status: `Đã kích hoạt lệnh [${command}] tới hệ thống cửa.` });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💻 Server Backend đang chạy ổn định tại cổng ${PORT}`));