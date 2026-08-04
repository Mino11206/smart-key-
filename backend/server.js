require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');


const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
//  CẤU HÌNH KẾT NỐI AWS RDS MYSQL
// ==========================================
const db = mysql.createPool({
    host: process.env.DB_HOST,       
    user: process.env.DB_USER,       
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,   
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10
});

// Kiểm tra kết nối SQL lúc khởi động
db.getConnection((err, connection) => {
    if (err) console.error('Lỗi kết nối AWS RDS MySQL:', err.message);
    else {
        console.log('Kết nối AWS RDS MySQL thành công');
        connection.release();
    }
});

// ==========================================
// CẤU HÌNH KẾT NỐI AWS IOT CORE (MQTTS)
// ==========================================
// Đọc file chứng chỉ SSL
const MQTT_BROKER = process.env.MQTT_BROKER;

if (!MQTT_BROKER) {
    console.error('LỖI: Biến MQTT_BROKER chưa được cấu hình trong file .env!');
} else {
    console.log(`Đang kết nối tới AWS IoT Endpoint: ${MQTT_BROKER}`);
}
const mqttOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs/private.pem.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs/certificate.pem.crt')),
    ca: [fs.readFileSync(path.join(__dirname, 'certs/AmazonRootCA1.pem'))],
    protocol: 'mqtts',
    port: 8883,
    rejectUnauthorized: true
};

const mqttClient = mqtt.connect(process.env.MQTT_BROKER, mqttOptions);

mqttClient.on('connect', () => {
    console.log('Đã kết nối thành công tới AWS IoT Core!');
    mqttClient.subscribe('MSSV/access_log'); 
});

mqttClient.on('error', (err) => {
    console.error('Lỗi kết nối AWS IoT Core:', err);
});

// ==========================================
//  XỬ LÝ LOGIC QUẸT THẺ TỪ ESP32
// ==========================================
mqttClient.on('message', (topic, message) => {
    if (topic === 'MSSV/access_log') {
        try {
            const payload = JSON.parse(message.toString());
            const cardUid = payload.uid;
            const accessTime = payload.access_time || new Date().toISOString().slice(0, 19).replace('T', ' ');

            console.log(`\n[MQTT] Phát hiện thẻ quẹt: ${cardUid} lúc ${accessTime}`);

            // Kiểm tra trạng thái cửa hiện tại
            db.query('SELECT status FROM DoorStatus ORDER BY id DESC LIMIT 1', (err, doorRows) => {
                if (err) return console.error('❌ Lỗi truy vấn DoorStatus:', err);

                const currentDoorStatus = doorRows.length > 0 ? doorRows[0].status : 'AUTO';

                // Case 1: Cửa đang UNLOCKED -> Không làm gì
                if (currentDoorStatus === 'UNLOCKED') {
                    console.log('🚪 Cửa đang UNLOCKED -> Giữ nguyên.');
                    saveAccessLog(cardUid, accessTime, 1, 'Cửa đang UNLOCKED sẵn');
                    return;
                }

                // Case 2: Cửa đang LOCKED -> Khóa cứng, từ chối
                if (currentDoorStatus === 'LOCKED') {
                    console.log('Cửa đang LOCKED -> Từ chối mở.');
                    saveAccessLog(cardUid, accessTime, 0, 'Cửa bị khóa cứng (LOCKED)');
                    return;
                }

                // BƯỚC B: Nếu Cửa AUTO -> Kiểm tra thông tin Thẻ trong CardInfo
                db.query('SELECT * FROM CardInfo WHERE uid = ?', [cardUid], (err, cardRows) => {
                    if (err) return console.error('Lỗi truy vấn CardInfo:', err);

                    if (cardRows.length === 0) {
                        console.log('⚠️ Thẻ lạ không tồn tại trong hệ thống! Tự động tạo thẻ với trạng thái DISABLED...');

                        // 1. Tự động thêm thẻ lạ này vào CardInfo trước để thỏa mãn Khóa ngoại
                        const insertCardSql = 'INSERT INTO CardInfo (uid, holder_name, role, status) VALUES (?, ?, ?, ?)';
                        db.query(insertCardSql, [cardUid, 'Thẻ chưa đăng ký', 'USER', 'DISABLED'], (cardErr) => {
                            if (cardErr) {
                                console.error('Lỗi tự động thêm thẻ lạ vào CardInfo:', cardErr.message);
                            } else {
                                console.log(`Đã tự động thêm thẻ lạ [${cardUid}] vào CardInfo.`);
                            }

                            // 2. Ghi nhật ký quẹt thẻ thất bại vào AccessInfo
                            saveAccessLog(cardUid, accessTime, 0, 'Thẻ không tồn tại trong hệ thống (Từ chối)');
                        });
                    } else if (cardRows[0].status === 'DISABLED') {
                        console.log('Thẻ đã bị vô hiệu hóa!');
                        saveAccessLog(cardUid, accessTime, 0, 'Thẻ đã bị vô hiệu hóa');
                    } else {
                        // THẺ HỢP LỆ & CỦA AUTO -> MỞ CỬA!
                        const userName = cardRows[0].holder_name;
                        console.log(`Thẻ hợp lệ! Đang gửi lệnh MỞ CỬA cho [${userName}]...`);

                        saveAccessLog(cardUid, accessTime, 1, 'Mở cửa thành công');

                        // Bắn MQTT lệnh OPEN về ESP32
                        mqttClient.publish('MSSV/door_control', 'HIGH');
                    }
                });
            });
        } catch (e) {
            console.error('Lỗi định dạng JSON nhận từ ESP32:', e.message);
        }
    }
});

// Hàm hỗ trợ ghi Nhật ký ra vào bảng AccessInfo trên AWS RDS
function saveAccessLog(uid, accessTime, status, note) {
    const sql = 'INSERT INTO AccessInfo (uid, access_time, status, note) VALUES (?, ?, ?, ?)';
    db.query(sql, [uid, accessTime, status, note], (err) => {
        if (err) console.error('Lỗi lưu AccessInfo:', err.message);
        else console.log('Đã lưu lịch sử vào AWS RDS thành công.');
    });
}

// ==========================================
// 4. BỘ API HTTP DÀNH CHO FRONTEND
// ==========================================

// API Đăng nhập Hệ thống (Bảng Account)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.query('SELECT * FROM Account WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại!' });

        const user = results[0];
        
        // So sánh chuỗi Hash bcrypt (hoặc so sánh trực tiếp nếu để plain text test ban đầu)
        const isMatch = await bcrypt.compare(password, user.password_hash).catch(() => password === user.password_hash);

        if (!isMatch) return res.status(401).json({ message: 'Mật khẩu không chính xác!' });

        res.json({ success: true, message: 'Đăng nhập thành công!', user: { username: user.username } });
    });
});

// API Đổi Mật khẩu
app.post('/api/change-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;

    db.query('SELECT * FROM Account WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'Tài khoản không tồn tại!' });

        const user = results[0];
        const isMatch = await bcrypt.compare(oldPassword, user.password_hash).catch(() => oldPassword === user.password_hash);
        
        if (!isMatch) return res.status(401).json({ message: 'Mật khẩu cũ không chính xác!' });

        try {
            // Tạo chuỗi Hash mật khẩu mới
            const salt = await bcrypt.genSalt(10);
            const newHash = await bcrypt.hash(newPassword, salt);

            // Cập nhật chuỗi newHash vào CSDL
            db.query('UPDATE Account SET password_hash = ? WHERE username = ?', [newHash, username], (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                res.json({ success: true, message: 'Đổi mật khẩu mới thành công!' });
            });
        } catch (hashError) {
            res.status(500).json({ message: 'Lỗi mã hóa mật khẩu.' });
        }
    });
});

// API Lấy Lịch sử Quẹt thẻ (Bảng AccessInfo kết hợp CardInfo)
app.get('/api/history', (req, res) => {
    const sql = `
        SELECT a.id, a.uid, c.holder_name, a.access_time, a.status, a.note 
        FROM AccessInfo a
        LEFT JOIN CardInfo c ON a.uid = c.uid
        ORDER BY a.access_time DESC
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// API Chuyển chế độ cửa (AUTO / LOCKED / UNLOCKED) từ Web
app.post('/api/control-door', (req, res) => {
    const { command } = req.body; // Cập nhật trạng thái "AUTO", "LOCKED", hoặc "UNLOCKED"
    
    console.log(`[Web API] Cập nhật chế độ cửa thành: ${command}`);

    // Ghi trạng thái mới vào bảng DoorStatus trên RDS
    db.query('INSERT INTO DoorStatus (status) VALUES (?)', [command], (err) => {
        if (err) return res.status(500).json({ message: 'Lỗi ghi trạng thái cửa vào RDS' });

        // Bắn tín hiệu điều khiển xuống ESP32
        mqttClient.publish('MSSV/door_control', JSON.stringify({ command: command }), (mqttErr) => {
            if (mqttErr) return res.status(500).json({ message: 'Lỗi gửi lệnh MQTT' });
            res.json({ success: true, status: `Đã cập nhật chế độ cửa thành [${command}]` });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💻 Server Backend đang chạy tại cổng ${PORT}`));