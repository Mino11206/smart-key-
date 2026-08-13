// Hàm gửi lệnh điều khiển xuống Servo qua Backend
function controlDoor(command) {
    fetch('http://localhost:3000/api/control-door', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command })
    })
    .then(res => res.json())
    .then(data => alert(data.status));
}

// Hàm lấy lịch sử từ Database SQL và cập nhật giao diện
function loadHistory() {
    fetch('http://localhost:3000/api/history')
    .then(res => res.json())
    .then(data => {
        const tbody = document.getElementById('historyBody');
        tbody.innerHTML = ''; // Xóa dữ liệu cũ
        
        data.forEach(log => {
            const row = `<tr>
                <td>${log.uid}</td>
                <td>${log.holder_name || 'Chưa đăng ký'}</td>
                <td>${log.status === 1 ? 'Cho phép' : 'Từ chối'}</td>
                <td>${new Date(log.access_time).toLocaleString('vi-VN')}</td>
                <td>${log.note || ''}</td>
            </tr>`;

            tbody.innerHTML += row;
        });

        // Gọi hàm vẽ biểu đồ sau khi có dữ liệu lịch sử
        renderChart(data);
    });
}

// Hàm vẽ biểu đồ Chart.js thống kê lượt quẹt (YCNC 5)
function renderChart(data) {
    const ctx = document.getElementById('accessChart').getContext('2d');
    
    // Logic đếm số lượt quẹt (Ví dụ đơn giản: đếm tổng số bản ghi)
    const totalScans = data.length;

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Tổng lượt truy cập'],
            datasets: [{
                label: 'Số lần quẹt thẻ',
                data: [totalScans],
                backgroundColor: 'rgba(54, 162, 235, 0.6)'
            }]
        },
        options: { responsive: true }
    });
}

// Tự động tải dữ liệu khi vừa vào trang
window.onload = loadHistory;