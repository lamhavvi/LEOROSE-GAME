const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 1. KẾT NỐI MONGODB
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://admin:matkhau123@cluster0.abcde.mongodb.net/duangua?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Đã kết nối MongoDB thành công!'))
    .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

// 2. TẠO SCHEMA LƯU DỰ LIỆU NGƯỜI DÙNG
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    pass: String,
    email: String,
    balance: { type: Number, default: 0 },
    isAdmin: { type: Boolean, default: false },
    betHistory: { type: Array, default: [] }
});

const User = mongoose.model('User', userSchema);

// Trạng thái cuộc đua
let raceState = {
    status: 'waiting',
    countdown: 60,
    positions: [0, 0, 0, 0, 0, 0],
    speeds: [0, 0, 0, 0, 0, 0]
};

let currentBets = {}; 
let adminFixedWinner = 'random'; 

// Hàm tạo số ngẫu nhiên an toàn bằng crypto chống đoán chu kỳ (Đã sửa lỗi crash)
function getSecureRandom() {
    return crypto.randomInt(0, 1000000) / 1000000;
}

io.on('connection', async (socket) => {
    // Gửi toàn bộ danh sách users từ MongoDB cho Client khi vừa kết nối
    try {
        let usersDocs = await User.find({});
        let usersMap = {};
        usersDocs.forEach(u => {
            usersMap[u.username] = {
                pass: u.pass,
                email: u.email,
                balance: u.balance,
                isAdmin: u.isAdmin,
                betHistory: u.betHistory
            };
        });
        socket.emit('initData', { users: usersMap });
    } catch(e) {}

    updateOnlineUsersList();

    // ĐĂNG NHẬP
    socket.on('login', async (data) => {
        let { user, pass } = data;
        let dbUser = await User.findOne({ username: user });

        if (!dbUser) {
            socket.emit('loginFail', 'Tài khoản không tồn tại!');
            return;
        }
        if (dbUser.pass !== pass) {
            socket.emit('loginFail', 'Sai mật khẩu!');
            return;
        }

        socket.username = user;
        socket.emit('loginSuccess', {
            username: user,
            userData: {
                pass: dbUser.pass,
                email: dbUser.email,
                balance: dbUser.balance,
                isAdmin: dbUser.isAdmin,
                betHistory: dbUser.betHistory
            },
            activeBet: currentBets[user] || null
        });

        updateOnlineUsersList();
    });

    // ĐĂNG KÝ MỚI
    socket.on('registerNewUser', async (data) => {
        let { user, email, pass } = data;
        let existUser = await User.findOne({ username: user });
        if (existUser) {
            socket.emit('registerFail', 'Tên tài khoản đã tồn tại!');
            return;
        }

        let totalUsers = await User.countDocuments();
        let newUser = new User({
            username: user,
            pass: pass,
            email: email,
            balance: 0,
            isAdmin: (totalUsers === 0), // Tài khoản đầu tiên làm Admin
            betHistory: []
        });

        await newUser.save();
        socket.emit('registerSuccess');

        // Phát lại dữ liệu mới nhất
        broadcastAllUsers();
    });

    // ĐẶT CƯỢC
    socket.on('placeBet', async (data) => {
        let { username, horseIdx, amount } = data;
        let dbUser = await User.findOne({ username: username });
        
        if (!dbUser) return;
        if (raceState.status !== 'waiting') {
            socket.emit('betFail', 'Đang trong cuộc đua, không thể đặt cược!');
            return;
        }
        if (amount <= 0 || dbUser.balance < amount) {
            socket.emit('betFail', 'Số dư không đủ hoặc tiền cược không hợp lệ!');
            return;
        }

        dbUser.balance -= amount;
        await dbUser.save();

        currentBets[username] = { horseIdx, amount };

        socket.emit('betSuccess', { balance: dbUser.balance });
        broadcastAllUsers();
        broadcastBetStats();
    });

    // THAO TÁC ADMIN (Nạp/Rút/Ép kết quả)
    socket.on('adminAction', async (data) => {
        let { adminUser, type, targetUser, amount, fixedWinner } = data;
        let adminDb = await User.findOne({ username: adminUser });
        if (!adminDb || !adminDb.isAdmin) return;

        if (type === 'deposit' || type === 'withdraw') {
            let targetDb = await User.findOne({ username: targetUser });
            if (targetDb) {
                if (type === 'deposit') targetDb.balance += amount;
                if (type === 'withdraw') targetDb.balance = Math.max(0, targetDb.balance - amount);
                await targetDb.save();
                broadcastAllUsers();
            }
        } else if (type === 'setWinner') {
            adminFixedWinner = fixedWinner;
        }
    });

    socket.on('disconnect', () => {
        updateOnlineUsersList();
    });
});

async function broadcastAllUsers() {
    let usersDocs = await User.find({});
    let usersMap = {};
    usersDocs.forEach(u => {
        usersMap[u.username] = {
            pass: u.pass,
            email: u.email,
            balance: u.balance,
            isAdmin: u.isAdmin,
            betHistory: u.betHistory
        };
    });
    io.emit('updateAllUsers', usersMap);
}

function updateOnlineUsersList() {
    let onlineUsers = [];
    const sockets = io.sockets.sockets;
    sockets.forEach((s) => {
        if (s.username && !onlineUsers.includes(s.username)) {
            onlineUsers.push(s.username);
        }
    });
    io.emit('onlineUsersUpdate', onlineUsers);
}

function broadcastBetStats() {
    let betsArr = [];
    for (let u in currentBets) {
        betsArr.push({ username: u, horseIdx: currentBets[u].horseIdx, amount: currentBets[u].amount });
    }
    io.emit('betStatsUpdate', { bets: betsArr });
}

// BỘ ĐẾM VÁN ĐẤU
setInterval(() => {
    if (raceState.status === 'waiting') {
        raceState.countdown--;
        io.emit('timerUpdate', raceState.countdown);
        if (raceState.countdown <= 0) startRace();
    }
}, 1000);

// GAME LOOP (30 FPS) - Sử dụng getSecureRandom an toàn
setInterval(() => {
    if (raceState.status === 'racing') {
        for (let i = 0; i < 6; i++) {
            if (raceState.positions[i] < 1030) {
                let speed = getSecureRandom() * 5 + 2.5;
                if (adminFixedWinner !== 'random' && parseInt(adminFixedWinner) === i) {
                    speed += 1.2;
                }
                raceState.positions[i] += speed;
                if (raceState.positions[i] >= 1030) raceState.positions[i] = 1030;
            }
        }

        io.emit('horsePositions', raceState.positions);

        let activeHorses = [0, 1, 2, 3, 4, 5];
        activeHorses.sort((a, b) => raceState.positions[b] - raceState.positions[a]);

        if (raceState.positions[activeHorses[0]] >= 1030) {
            finishRace(activeHorses);
        }
    }
}, 1000 / 30);

function startRace() {
    raceState.status = 'racing';
    raceState.positions = [0, 0, 0, 0, 0, 0];
}

async function finishRace(rankingArray) {
    raceState.status = 'finished';

    let winnerIdx = rankingArray[0];
    let secondIdx = rankingArray[1];
    let thirdIdx = rankingArray[2];

    const horseNames = ["1. Xích Thố", "2. Bão Táp", "3. Sấm Sét", "4. Hỏa Tinh", "5. Bạch Long", "6. Hắc Phong"];

    let podium = {
        1: { num: winnerIdx + 1, name: horseNames[winnerIdx], rawIdx: winnerIdx },
        2: { num: secondIdx + 1, name: horseNames[secondIdx], rawIdx: secondIdx },
        3: { num: thirdIdx + 1, name: horseNames[thirdIdx], rawIdx: thirdIdx }
    };

    let roundSummary = [];

    for (let username in currentBets) {
        let bet = currentBets[username];
        let dbUser = await User.findOne({ username: username });
        if (!dbUser) continue;

        let payoutMultiplier = 0;
        let isWin = false;
        let netProfit = -bet.amount;

        if (bet.horseIdx === winnerIdx) payoutMultiplier = 0.9;
        else if (bet.horseIdx === secondIdx) payoutMultiplier = 0.7;
        else if (bet.horseIdx === thirdIdx) payoutMultiplier = 0.5;

        if (payoutMultiplier > 0) {
            let winBonus = Math.floor(bet.amount * payoutMultiplier);
            let totalReturn = bet.amount + winBonus;
            dbUser.balance += totalReturn;
            netProfit = winBonus;
            isWin = true;
        }

        if (!dbUser.betHistory) dbUser.betHistory = [];
        dbUser.betHistory.unshift({
            time: new Date().toLocaleTimeString('vi-VN'),
            horseName: horseNames[bet.horseIdx],
            amount: bet.amount,
            isWin: isWin,
            netProfit: netProfit
        });
        if (dbUser.betHistory.length > 20) dbUser.betHistory.pop();

        await dbUser.save();

        roundSummary.push({
            username: username,
            horseIdx: bet.horseIdx,
            amount: bet.amount,
            netProfit: netProfit
        });
    }

    let allDocs = await User.find({});
    let updatedUsersMap = {};
    allDocs.forEach(u => {
        updatedUsersMap[u.username] = {
            pass: u.pass,
            email: u.email,
            balance: u.balance,
            isAdmin: u.isAdmin,
            betHistory: u.betHistory
        };
    });

    io.emit('raceEnded', {
        podium: podium,
        roundSummary: roundSummary,
        updatedUsers: updatedUsersMap
    });

    setTimeout(async () => {
        currentBets = {};
        raceState.status = 'waiting';
        raceState.countdown = 60;
        raceState.positions = [0, 0, 0, 0, 0, 0];
        adminFixedWinner = 'random';
        
        let freshDocs = await User.find({});
        let freshUsersMap = {};
        freshDocs.forEach(u => {
            freshUsersMap[u.username] = {
                pass: u.pass,
                email: u.email,
                balance: u.balance,
                isAdmin: u.isAdmin,
                betHistory: u.betHistory
            };
        });

        io.emit('resetForNewRound', { users: freshUsersMap });
        broadcastBetStats();
    }, 8000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server đua ngựa đã chạy tại cổng ${PORT}`);
});
