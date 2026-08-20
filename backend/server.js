require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer'); 
const axios = require('axios');
const { GoogleGenAI } = require("@google/genai");


const app = express();

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

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

// Biến lưu trạng thái vật lý của cánh cửa (OPEN / CLOSED)
let currentPhysicalState = "CLOSED"; 

mqttClient.on('connect', () => {
    console.log('Đã kết nối thành công tới AWS IoT Core!');
    mqttClient.subscribe('MSSV/access_log');
    mqttClient.subscribe('MSSV/door_physical_state'); // <-- Thêm subscribe topic này
});


mqttClient.on('error', (err) => {
    console.error('Lỗi kết nối AWS IoT Core:', err);
});


// ==========================================
//  XỬ LÝ LOGIC QUẸT THẺ TỪ ESP32
// ==========================================
mqttClient.on('message', (topic, message) => {
    if (topic === 'MSSV/door_physical_state') {
        currentPhysicalState = message.toString().trim();
        console.log(`[Sensor] Trạng thái vật lý của cửa hiện tại: ${currentPhysicalState}`);
    }

    if (topic === 'MSSV/access_log') {
        try {
            const payload = JSON.parse(message.toString());
            const cardUid = payload.uid;
            const accessTime = payload.access_time || new Date().toISOString().slice(0, 19).replace('T', ' ');

            console.log(`\n[MQTT] Phát hiện thẻ quẹt: ${cardUid} lúc ${accessTime}`);

            // Kiểm tra trạng thái cửa hiện tại
            db.query('SELECT status FROM DoorStatus ORDER BY id DESC LIMIT 1', (err, doorRows) => {
                if (err) return console.error('Lỗi truy vấn DoorStatus:', err);

                const currentDoorStatus = doorRows.length > 0 ? doorRows[0].status : 'AUTO';

                // Case 1: Cửa đang UNLOCKED -> Không làm gì
                if (currentDoorStatus === 'UNLOCKED') {
                    console.log('Cửa đang UNLOCKED -> Giữ nguyên.');
                    saveAccessLog(cardUid, accessTime, 1, 'Cửa đang UNLOCKED');
                    return;
                }

                // Case 2: Cửa đang LOCKED -> Khóa cứng, từ chối
                if (currentDoorStatus === 'LOCKED') {

                    console.log('Cửa đang LOCKED -> Từ chối mở.');

                    const note = 'Cửa bị khóa cứng (LOCKED)';

                    saveAccessLog(
                        cardUid,
                        accessTime,
                        0,
                        note
                    );

                    sendAccessWarning(
                        cardUid,
                        accessTime,
                        'TỪ CHỐI',
                        note
                    );

                    sendTelegramNotification(
                        cardUid,
                        accessTime,
                        'TỪ CHỐI',
                        note
                    );

                    return;
                }

                // BƯỚC B: Nếu Cửa AUTO -> Kiểm tra thông tin Thẻ trong CardInfo
                db.query('SELECT * FROM CardInfo WHERE uid = ?', [cardUid], (err, cardRows) => {
                    if (err) return console.error('Lỗi truy vấn CardInfo:', err);

                    if (cardRows.length === 0) {

                        console.log(
                            'Thẻ lạ không tồn tại trong hệ thống!'
                        );

                        const note =
                            'Thẻ không tồn tại trong hệ thống';

                        sendTelegramNotification(
                            cardUid,
                            accessTime,
                            'TỪ CHỐI',
                            note
                        );

                        // Tự động thêm thẻ lạ vào CardInfo
                        const insertCardSql = `
                            INSERT INTO CardInfo
                            (uid, holder_name, role, status)
                            VALUES (?, ?, ?, ?)
                        `;

                        db.query(
                            insertCardSql,
                            [
                                cardUid,
                                'Thẻ chưa đăng ký',
                                'USER',
                                'DISABLED'
                            ],
                            (cardErr) => {

                                if (cardErr) {
                                    console.error(
                                        'Lỗi tự động thêm thẻ lạ:',
                                        cardErr.message
                                    );
                                } else {
                                    console.log(
                                        `Đã thêm thẻ lạ [${cardUid}] vào CardInfo.`
                                    );
                                }

                                // Lưu lịch sử
                                saveAccessLog(
                                    cardUid,
                                    accessTime,
                                    0,
                                    note
                                );

                                // ID 8 - Gửi email cảnh báo
                                sendAccessWarning(
                                    cardUid,
                                    accessTime,
                                    'TỪ CHỐI',
                                    note
                                );

                                // Báo về ESP32
                                mqttClient.publish(
                                    'MSSV/door_access',
                                    'Thẻ không tồn tại trong hệ thống'
                            );
                            }
                        );
                    } else if (cardRows[0].status === 'DISABLED') {

                        console.log('Thẻ đã bị vô hiệu hóa!');

                        const note = 'Thẻ đã bị vô hiệu hóa';

                        sendTelegramNotification(
                            cardUid,
                            accessTime,
                            'TỪ CHỐI',
                            note
                        );

                        // Lưu lịch sử
                        saveAccessLog(
                            cardUid,
                            accessTime,
                            0,
                            note
                        );

                        // ID 8 - Gửi email cảnh báo
                        sendAccessWarning(
                            cardUid,
                            accessTime,
                            'TỪ CHỐI',
                            note
                        );

                        // Báo về ESP32
                        mqttClient.publish(
                            'MSSS/access_denied',
                            'Thẻ đã bị vô hiệu hóa'
                        );
                    } else {
                        // THẺ HỢP LỆ & CỦA AUTO -> MỞ CỬA!
                        const userName = cardRows[0].holder_name;
                        console.log(`Thẻ hợp lệ! Đang gửi lệnh MỞ CỬA cho [${userName}]...`);

                        saveAccessLog(cardUid, accessTime, 1, 'Mở cửa thành công');

                        sendTelegramNotification(
                            cardUid,
                            accessTime,
                            'HỢP LỆ',
                            'Mở cửa thành công'
                        );

                        // Bắn MQTT lệnh OPEN về ESP32
                        mqttClient.publish('MSSV/door_access', 'HIGH');
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

/// API Đăng nhập Hệ thống (Bảng Account)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Kiểm tra dữ liệu đầu vào cơ bản
    if (!username || !password) {
        return res.status(400).json({ message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu!' });
    }

    db.query('SELECT * FROM Account WHERE username = ?', [username], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại!' });

        const user = results[0];

        // So sánh trực tiếp chuỗi mật khẩu thông thường (password hoặc password_hash tùy tên cột của bạn)
        if (user.password !== password && user.password_hash !== password) {
            return res.status(401).json({ message: 'Mật khẩu không chính xác!' });
        }

        res.json({
            success: true,
            message: 'Đăng nhập thành công!',
            user: { username: user.username }
        });
    });
});

// API Chỉnh sửa thông tin tài khoản 
app.post('/api/update-account', (req, res) => {
    const { username, currentPassword, newEmail, newPassword } = req.body;

    // Lấy thông tin tài khoản đang đăng nhập từ Database
    db.query('SELECT password, email FROM Account WHERE username = ?', [username], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        //Mật khẩu có khớp không? (Nếu không khớp hoặc lỗi mất session -> từ chối)
        if (results.length === 0 || results[0].password !== currentPassword) {
            return res.status(401).json({ success: false, message: 'Mật khẩu không chính xác' });
        }

        // Lấy dữ liệu mới, nếu để trống thì giữ nguyên dữ liệu cũ
        const updatedEmail = newEmail || results[0].email;
        const updatedPassword = newPassword || results[0].password;

        // Cập nhật xuống Database
        db.query('UPDATE Account SET email = ?, password = ? WHERE username = ?', 
            [updatedEmail, updatedPassword, username], 
            (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                res.json({ success: true, message: 'Cập nhật thông tin thành công!' });
        });
    });
});

// ==========================================
// ID 6 - CLOUD (AWS RDS) -> BACKEND -> WEB
// ==========================================
// API 1: Lấy lịch sử chi tiết từ AWS RDS MySQL
// Frontend dùng API này để hiển thị TEXT/TABLE.
app.get('/api/history', (req, res) => {
    const sql = `
        SELECT
            a.id,
            a.uid,
            c.holder_name,
            a.access_time,
            a.status,
            a.note
        FROM AccessInfo a
        LEFT JOIN CardInfo c ON a.uid = c.uid
        ORDER BY a.access_time DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error('Lỗi lấy lịch sử từ AWS RDS:', err.message);
            return res.status(500).json({
                success: false,
                error: 'Không thể lấy dữ liệu lịch sử từ AWS RDS'
            });
        }

        res.json(results);
    });
});

// API 2: Lấy dữ liệu thống kê theo ngày từ AWS RDS.
// Đây là dữ liệu nguồn cho Chart.js.
app.get('/api/history-summary', (req, res) => {
    let days = Number.parseInt(req.query.days, 10);

    // Chỉ cho phép khoảng thời gian hợp lý.
    if (!Number.isFinite(days)) days = 7;
    days = Math.min(Math.max(days, 1), 90);

    const sql = `
        SELECT
            DATE(a.access_time) AS access_date,
            SUM(CASE WHEN a.status = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN a.status = 0 THEN 1 ELSE 0 END) AS fail_count,
            COUNT(*) AS total_count
        FROM AccessInfo a
        WHERE a.access_time >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
        GROUP BY DATE(a.access_time)
        ORDER BY access_date ASC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error('Lỗi lấy thống kê từ AWS RDS:', err.message);
            return res.status(500).json({
                success: false,
                error: 'Không thể lấy dữ liệu thống kê từ AWS RDS'
            });
        }

        res.json({
            success: true,
            days,
            data: results
        });
    });
});

// // API Chuyển chế độ cửa (AUTO / LOCKED / UNLOCKED) từ Web
// app.post('/api/control-door', (req, res) => {
//     const { command } = req.body; // Cập nhật trạng thái "AUTO", "LOCKED", hoặc "UNLOCKED"
    
//     console.log(`[Web API] Cập nhật chế độ cửa thành: ${command}`);

//     // Ghi trạng thái mới vào bảng DoorStatus trên RDS
//     db.query('INSERT INTO DoorStatus (status) VALUES (?)', [command], (err) => {
//         if (err) return res.status(500).json({ message: 'Lỗi ghi trạng thái cửa vào RDS' });

//         // Bắn tín hiệu điều khiển xuống ESP32
//         mqttClient.publish('MSSV/door_control', JSON.stringify({ command: command }), (mqttErr) => {
//             if (mqttErr) return res.status(500).json({ message: 'Lỗi gửi lệnh MQTT' });
//             res.json({ success: true, status: `Đã cập nhật chế độ cửa thành [${command}]` });
//         });
//     });
// });
// API Chuyển chế độ cửa (AUTO / LOCKED / UNLOCKED) từ Web
app.post('/api/control-door', (req, res) => {
    const { command } = req.body; // Giá trị: "AUTO", "LOCKED", hoặc "UNLOCKED"
    
    if (!command || !['AUTO', 'LOCKED', 'UNLOCKED'].includes(command.toUpperCase())) {
        return res.status(400).json({ message: 'Lệnh không hợp lệ (Chỉ chấp nhận AUTO, LOCKED, UNLOCKED)' });
    }

    
    if (currentPhysicalState === 'OPEN') {
        console.log('[Từ chối] Cửa đang mở vật lý, không thể thay đổi chế độ!');
        return res.status(400).json({ 
            success: false, 
            isDoorOpen: true,
            message: 'Cửa đang mở! Vui lòng khép kín cửa trước khi đổi chế độ.' 
        });
    }
    const mode = command.toUpperCase();
    console.log(`[Web API] Cập nhật chế độ cửa thành: ${mode}`);

    // 1. Ghi trạng thái mới vào bảng DoorStatus trên RDS (nếu có cột created_at tự tăng)
    db.query('INSERT INTO DoorStatus (status) VALUES (?)', [mode], (err) => {
        if (err) {
            console.error('Lỗi truy vấn RDS:', err);
            return res.status(500).json({ message: 'Lỗi ghi trạng thái cửa vào RDS' });
        }

        // 2. Bắn chuỗi thuần trực tiếp xuống ESP32 qua MQTT để khớp với msg trên ESP32
        mqttClient.publish('MSSV/door_control', mode, (mqttErr) => {
            if (mqttErr) {
                console.error('Lỗi MQTT Publish:', mqttErr);
                return res.status(500).json({ message: 'Lỗi gửi lệnh MQTT xuống thiết bị' });
            }
            
            res.json({ 
                success: true, 
                status: `Đã cập nhật và gửi chế độ [${mode}] xuống ESP32` 
            });
        });
    });
});
// ==========================================
// CÁC API QUẢN LÝ THẺ (CARDINFO)
// ==========================================

// API Lấy danh sách thẻ
app.get('/api/cards', (req, res) => {
    db.query('SELECT uid, holder_name, role, status, created_at FROM CardInfo ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// API Cập nhật trạng thái thẻ (Khóa/Mở khóa thẻ)
app.put('/api/cards/:uid', (req, res) => {
    const { status, role, holder_name } = req.body;
    const sql = 'UPDATE CardInfo SET status = ?, role = ?, holder_name = ? WHERE uid = ?';
    db.query(sql, [status, role, holder_name, req.params.uid], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Cập nhật thẻ thành công!' });
    });
});

app.get('/api/account', (req, res) => {
    // 1. Nhận username từ Frontend truyền lên
    const username = req.query.username; 
    
    // 2. Kiểm tra nếu không có username
    if (!username) {
        return res.status(400).json({ error: 'Thiếu tên đăng nhập' });
    }

    // 3. Truy vấn đúng tài khoản đó
    db.query('SELECT username, email, created_at FROM Account WHERE username = ?', [username], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
        
        res.json(results[0]);
    });
});

app.get('/api/door-status', (req, res) => {
    db.query('SELECT status FROM DoorStatus ORDER BY id DESC LIMIT 1', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const currentMode = results.length > 0 ? results[0].status : 'AUTO';
        res.json({ 
            mode: currentMode,
            physicalState: currentPhysicalState // 'OPEN' hoặc 'CLOSED'
        });
    });
});

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`💻 Server Backend đang chạy tại cổng ${PORT}`));

// ==========================================
// ID 8 - GMAIL SMTP
// ==========================================

const mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

//gửi gmail
async function sendAccessWarning(uid, accessTime, status, note) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL,
            subject: '⚠️ CẢNH BÁO TRUY CẬP - HỆ THỐNG CỬA',

            text: `
            CẢNH BÁO TRUY CẬP HỆ THỐNG

            UID thẻ: ${uid}
            Thời gian: ${accessTime}
            Trạng thái: ${status}
            Lý do: ${note}

            Vui lòng kiểm tra hệ thống cửa thông minh.
            `
        };

        const info = await mailTransporter.sendMail(mailOptions);

        console.log(
            `[ID 8] Đã gửi email cảnh báo: ${info.messageId}`
        );

    } catch (error) {
        console.error(
            '[ID 8] Lỗi gửi email:',
            error.message
        );
    }
}

// ==========================================
// TEST ID 8
// ==========================================

async function testEmail() {
    try {
        const info = await mailTransporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL,
            subject: 'TEST ID 8 - Smart Door',
            text: `
Đây là email test cho chức năng ID 8.

Hệ thống Gmail SMTP đang hoạt động bình thường.
            `
        });

        console.log('[TEST ID 8] Email đã gửi:', info.messageId);

    } catch (error) {
        console.error('[TEST ID 8] Gửi email thất bại:', error.message);
    }
}

// testEmail();

// ==========================================
// ID 9 - CHATBOT AI - GEMINI
// ==========================================

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;

        // 1. Kiểm tra dữ liệu đầu vào
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng nhập câu hỏi!'
            });
        }

        // 2. Giới hạn độ dài câu hỏi
        const userMessage = message.trim();

        if (userMessage.length > 1000) {
            return res.status(400).json({
                success: false,
                message: 'Câu hỏi không được vượt quá 1000 ký tự!'
            });
        }

        console.log(`[ID 9] Câu hỏi: ${userMessage}`);

        // 3. Gọi Gemini API
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',

            contents: userMessage,

            config: {
                systemInstruction:
                    'Bạn là trợ lý AI của hệ thống quản lý cửa thông minh Smart Key. ' +
                    'Hãy trả lời bằng tiếng Việt, ngắn gọn, dễ hiểu. ' +
                    'Chỉ trả lời những gì liên quan đến hệ thống cửa thông minh, ' +
                    'RFID, thẻ ra vào, trạng thái cửa, lịch sử truy cập và cách sử dụng hệ thống. ' +
                    'Nếu câu hỏi không liên quan, hãy lịch sự thông báo rằng bạn chỉ hỗ trợ hệ thống Smart Key.',

                maxOutputTokens: 10000 
            }
        });

        // 4. Lấy câu trả lời từ Gemini
        const answer = response.text?.trim();

        if (!answer) {
            console.error('[ID 9] Gemini không trả về nội dung');

            return res.status(502).json({
                success: false,
                message: 'AI không trả về câu trả lời.'
            });
        }

        console.log(`[ID 9] AI trả lời: ${answer}`);

        // 5. Trả kết quả về Frontend
        return res.json({
            success: true,
            answer: answer
        });

    } catch (error) {

        console.error('[ID 9] Lỗi Chatbot:', error);

        // ==========================================
        // XỬ LÝ LỖI GEMINI
        // ==========================================

        // API Key sai / không hợp lệ
        if (
            error?.status === 401 ||
            error?.status === 403
        ) {
            return res.status(500).json({
                success: false,
                errorType: 'INVALID_API_KEY',
                message: 'Gemini API Key không hợp lệ hoặc chưa được cấu hình.'
            });
        }

        // Hết quota / vượt giới hạn request
        if (error?.status === 429) {
            return res.status(429).json({
                success: false,
                errorType: 'QUOTA_EXCEEDED',
                message: 'Gemini API hiện đã vượt giới hạn miễn phí. Vui lòng thử lại sau.'
            });
        }

        // Các lỗi khác
        return res.status(500).json({
            success: false,
            errorType: 'AI_ERROR',
            message: 'Không thể xử lý yêu cầu bằng Gemini AI.'
        });
    }
});


// ==========================================
// ID 9 - TEST ROUTE
// ==========================================

app.get('/api/chat-health', (req, res) => {
    res.json({
        success: true,
        service: 'Smart Key AI Chatbot',
        status: 'Backend chatbot đang hoạt động'
    });
});

// ==========================================
// ID 7 - TELEGRAM
// ==========================================

async function sendTelegramNotification(uid, accessTime, status, note) {
    try {
        const message =
`🔐 SMART DOOR - THÔNG BÁO TRUY CẬP

UID: ${uid}
Thời gian: ${accessTime}
Trạng thái: ${status}
Lý do: ${note}`;

        const response = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: message
            }
        );

        console.log('[ID 7] Đã gửi Telegram thành công');
        console.log(response.data);

    } catch (error) {
        console.error(
            '[ID 7] Lỗi gửi Telegram:',
            error.response?.data || error.message
        );
    }
}

async function testTelegram() {
    try {
        await sendTelegramNotification(
            'TEST-UID',
            new Date().toLocaleString('vi-VN'),
            'TEST',
            'Kiểm tra chức năng ID 7'
        );

        console.log('[TEST ID 7] Hoàn tất test Telegram');

    } catch (error) {
        console.error('[TEST ID 7] Lỗi:', error.message);
    }
}

// testTelegram();


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💻 Server Backend đang chạy tại cổng ${PORT}`));