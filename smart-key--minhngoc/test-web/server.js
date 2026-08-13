const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

// Tạo dữ liệu giả lập lịch sử rfid để test hiển thị
let testLogs = [
    { card_uid: "A3 B2 C5 D9", status: "Mở cửa thành công", scanned_at: new Date() },
    { card_uid: "99 88 77 66", status: "Thẻ không hợp lệ", scanned_at: new Date() }
];

// API lấy lịch sử
app.get('/api/history', (req, res) => {
    res.json(testLogs);
});

// API nhận lệnh điều khiển từ nút bấm trên Web
app.post('/api/control-door', (express.json()), (req, res) => {
    console.log("-> Backend nhận lệnh điều khiển từ Web:", req.body.command);
    res.json({ status: `Thành công! Đã chuyển lệnh [${req.body.command}] tới Backend.` });
});

app.listen(3000, () => console.log('🚀 Backend đang chạy tại cổng 3000!'));
