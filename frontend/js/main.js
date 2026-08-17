

// Hàm lấy lịch sử từ Database SQL và cập nhật giao diện
function loadHistory() {
    fetch('http://localhost:3000/api/history')
    .then(res => res.json())
    .then(data => {
        const tbody = document.getElementById('historyBody');
        tbody.innerHTML = ''; // Xóa dữ liệu cũ
        
        data.forEach(log => {
            const row = `<tr>
                <td>${log.card_uid}</td>
                <td>${log.status}</td>
                <td>${new Date(log.scanned_at).toLocaleString('vi-VN')}</td>
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