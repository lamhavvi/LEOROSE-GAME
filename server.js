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

// 1. KẾT NỐI MONGODB VỚI CLUSTER THẬT CỦA BẠN
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://laquoc147_db_user:Abc12345@cluster0.rymgszf.mongodb.net/duangua?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Đã kết nối MongoDB thành công![cite: 7]'))
    .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

// 2. TẠO SCHEMA LƯU DỰ LIỆU NGƯỜI DÙNG
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    pass: String,
    email: String,
    balance: { type: Number, default: 0 },
    isAdmin: { type: Boolean, default: false },
    betHistory: { type: Array, default: [] },
    referralCode: { type: String, unique: true },          
    referredBy: { type: String, default: null },           
    onlineDays: { type: Number, default: 1 },              
    lastActiveDate: { type: String, default: "" },         
    totalBetAmount: { type: Number, default: 0 },          
    referralBonusClaimed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }           
});

const User = mongoose.model('User', userSchema);

let raceState = {
    status: 'waiting',
    countdown: 20,
    positions: [0, 0, 0, 0, 0, 0],
    speeds: [0, 0, 0, 0, 0, 0]
};

let currentBets = {}; 
let adminFixedWinner = 'random'; 

let maintenanceState = {
    isMaintenance: false,
    message: "Hệ thống đang bảo trì, vui lòng quay lại sau!",
    endTime: null
};

// ==========================================
// HỆ THỐNG QUẢN LÝ BOT ẨN DANH & TỰ ĐỘNG ĐỔI TÊN
// ==========================================
const masterBotPool = [
    "HoangNam99", "TuanKiet", "GiaHuy_Pro", "ThanhTruong", "MinhTuan_9x", 
    "HoangLan", "BaoNgoc_2k", "DucThinh", "TuanAnh_Pro", "PhuongLinh",
    "ThanhDat_99", "NgocMai_95", "QuangHuy_Vip", "DuyMinh_Sp", "ThuHa_Cute",
    "HoangLong_9x", "KhanhLinh_2k", "VietAnh_Sp", "ThaoVy_Pro", "DucMinh_Vip",
    "GiaBao_99", "MyDung_Sp", "ChiCuong_Pro", "QuocDat_9x", "KimOng_Vip",
    "TuanKhang", "BaoTram", "GiaKiet_99", "ThanhTung_Pro", "MinhThu_Sp"
];

let activeBots = [];

// Hàm làm mới và đổi danh tính các bot ngẫu nhiên
function refreshActiveBots() {
    let shuffled = [...masterBotPool].sort(() => 0.5 - Math.random());
    let count = Math.floor(Math.random() * 4) + 5; // Từ 5 đến 8 bot online mỗi đợt
    activeBots = shuffled.slice(0, count).map(name => ({
        name: name,
        balance: Math.floor(Math.random() * 30000000 + 5000000) // Số dư giả lập của bot từ 5M đến 35M
    }));
}

// Khởi tạo lần đầu
refreshActiveBots();

// Tự động thay đổi tên và làm mới bot ngẫu nhiên trong khoảng từ 5 đến 15 phút
setInterval(() => {
    refreshActiveBots();
    updateOnlineUsersList();
}, Math.floor(Math.random() * (15 - 5 + 1) + 5) * 60 * 1000);
// ------------------------------------------

function getSecureRandom() {
    return crypto.randomInt(0, 1000000) / 1000000;
}

io.on('connection', async (socket) => {
    try {
        let usersDocs = await User.find({});
        let usersMap = {};
        usersDocs.forEach(u => {
            usersMap[u.username] = {
                pass: u.pass,
                email: u.email,
                balance: u.balance,
                isAdmin: u.isAdmin,
                betHistory: u.betHistory,
                referralCode: u.referralCode || ""
            };
        });
        socket.emit('initData', { users: usersMap, maintenance: maintenanceState });
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

        let todayStr = new Date().toDateString();
        if (dbUser.lastActiveDate !== todayStr) {
            dbUser.lastActiveDate = todayStr;
            dbUser.onlineDays += 1;
            await dbUser.save();
        }

        socket.username = user;
        socket.emit('loginSuccess', {
            username: user,
            userData: {
                pass: dbUser.pass,
                email: dbUser.email,
                balance: dbUser.balance,
                isAdmin: dbUser.isAdmin,
                betHistory: dbUser.betHistory,
                referralCode: dbUser.referralCode || ""
            },
            activeBet: currentBets[user] || null
        });

        updateOnlineUsersList();
    });

    // LẤY DANH SÁCH BẠN BÈ ĐÃ GIỚI THIỆU TRONG THÁNG (GIỚI HẠN TỐI ĐA 5 NGƯỜI)
    socket.on('getReferralList', async (data) => {
        let { username } = data;
        let dbUser = await User.findOne({ username: username });
        if (!dbUser) return;

        let oneMonthAgo = new Date();
        oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);

        let invitedUsers = await User.find({ 
            referredBy: dbUser.referralCode,
            createdAt: { $gte: oneMonthAgo }
        });
        
        let list = invitedUsers.map(u => {
            let isCompleted = (u.onlineDays >= 2 && u.totalBetAmount >= 100000);
            return {
                username: u.username,
                onlineDays: u.onlineDays,
                totalBetAmount: u.totalBetAmount,
                isCompleted: isCompleted,
                bonusClaimed: dbUser.referralBonusClaimed
            };
        });

        socket.emit('referralListResponse', { list, totalInvitedThisMonth: invitedUsers.length });
    });

    // NHẬN THƯỞNG GIỚI THIỆU
    socket.on('claimReferralBonus', async (data) => {
        let { username, targetInvitee } = data;
        let dbUser = await User.findOne({ username: username });
        let inviteeUser = await User.findOne({ username: targetInvitee });

        if (!dbUser || !inviteeUser) return;
        
        // CHỐNG GIAN LẬN: Chặn tự mời chính mình
        if (dbUser.username === inviteeUser.username || inviteeUser.referredBy !== dbUser.referralCode) {
            socket.emit('betFail', 'Hành động không hợp lệ hoặc phát hiện gian lận!');
            return;
        }

        if (inviteeUser.onlineDays >= 2 && inviteeUser.totalBetAmount >= 100000 && !inviteeUser.referralBonusClaimed) {
            inviteeUser.referralBonusClaimed = true;
            await inviteeUser.save();

            dbUser.balance += 20000;
            if (!dbUser.betHistory) dbUser.betHistory = [];
            dbUser.betHistory.unshift({
                time: new Date().toLocaleTimeString('vi-VN'),
                horseName: "🎁 Thưởng Giới Thiệu Bạn",
                amount: 0,
                isWin: true,
                netProfit: 20000
            });
            await dbUser.save();

            socket.emit('balanceUpdated', { newBalance: dbUser.balance });
            socket.emit('claimBonusSuccess', { msg: `🎉 Bạn đã nhận thành công 20.000 🪙 từ bạn bè ${targetInvitee}!` });
            
            let oneMonthAgo = new Date();
            oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
            let invitedUsers = await User.find({ referredBy: dbUser.referralCode, createdAt: { $gte: oneMonthAgo } });
            
            let list = invitedUsers.map(u => ({
                username: u.username,
                onlineDays: u.onlineDays,
                totalBetAmount: u.totalBetAmount,
                isCompleted: (u.onlineDays >= 2 && u.totalBetAmount >= 100000),
                bonusClaimed: u.referralBonusClaimed
            }));
            socket.emit('referralListResponse', { list, totalInvitedThisMonth: invitedUsers.length });
        }
    });

    // ĐĂNG KÝ MỚI (CHỐNG GIAN LẬN TỐI ĐA 5 NGƯỜI/THÁNG)
    socket.on('registerNewUser', async (data) => {
        let { user, email, pass, refCode } = data;
        let existUser = await User.findOne({ username: user });
        if (existUser) {
            socket.emit('registerFail', 'Tên tài khoản đã tồn tại!');
            return;
        }

        let validRefCode = null;
        if (refCode) {
            let inviter = await User.findOne({ referralCode: refCode });
            if (inviter && inviter.username !== user) {
                let oneMonthAgo = new Date();
                oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
                let countThisMonth = await User.countDocuments({ referredBy: refCode, createdAt: { $gte: oneMonthAgo } });
                
                if (countThisMonth < 5) {
                    validRefCode = refCode; 
                }
            }
        }

        let uniqueRefCode = crypto.randomBytes(4).toString('hex');
        let totalUsers = await User.countDocuments();
        
        let newUser = new User({
            username: user,
            pass: pass,
            email: email,
            balance: 0,
            isAdmin: (totalUsers === 0),
            betHistory: [],
            referralCode: uniqueRefCode,
            referredBy: validRefCode,
            onlineDays: 1,
            lastActiveDate: new Date().toDateString(),
            totalBetAmount: 0,
            referralBonusClaimed: false
        });

        await newUser.save();
        socket.emit('registerSuccess');
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
        dbUser.totalBetAmount += amount;
        
        await dbUser.save();

        currentBets[username] = { horseIdx, amount };

        socket.emit('betSuccess', { balance: dbUser.balance });
        broadcastAllUsers();
        broadcastBetStats();
    });

    // THAO TÁC ADMIN
    socket.on('adminAction', async (data) => {
        let { adminUser, type, targetUser, amount, fixedWinner, maintenanceData } = data;
        let adminDb = await User.findOne({ username: adminUser });
        if (!adminDb || !adminDb.isAdmin) return;

        if (type === 'deposit' || type === 'withdraw') {
            let targetDb = await User.findOne({ username: targetUser });
            if (targetDb) {
                if (type === 'deposit') targetDb.balance += amount;
                if (type === 'withdraw') targetDb.balance = Math.max(0, targetDb.balance - amount);
                await targetDb.save();
                
                const sockets = io.sockets.sockets;
                for (let [id, s] of sockets) {
                    if (s.username === targetUser) {
                        s.emit('balanceUpdated', { newBalance: targetDb.balance });
                    }
                }
                broadcastAllUsers();
            }
        } else if (type === 'setWinner') {
            adminFixedWinner = fixedWinner;
        } else if (type === 'setMaintenance') {
            maintenanceState = maintenanceData;
            io.emit('maintenanceUpdate', maintenanceState);
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
            betHistory: u.betHistory,
            referralCode: u.referralCode || ""
        };
    });
    io.emit('updateAllUsers', usersMap);
}

async function updateOnlineUsersList() {
    let onlineUsers = [];
    const sockets = io.sockets.sockets;
    for (let [id, s] of sockets) {
        if (s.username) {
            let dbUser = await User.findOne({ username: s.username });
            onlineUsers.push({
                username: s.username,
                balance: dbUser ? dbUser.balance : 0
            });
        }
    }

    activeBots.forEach(bot => {
        onlineUsers.push({
            username: bot.name,
            balance: bot.balance
        });
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

setInterval(() => {
    if (raceState.status === 'waiting') {
        raceState.countdown--;

        if (raceState.countdown === 10) {
            triggerBotBets();
        }

        io.emit('timerUpdate', raceState.countdown);
        if (raceState.countdown <= 0) startRace();
    }
}, 1000);

// BOT ĐẶT CƯỢC NGẪU NHÂN TỪ 20.000 ĐẾN 45.000.000 🪙
function triggerBotBets() {
    activeBots.forEach(bot => {
        if (Math.random() < 0.85) {
            let randomHorseIdx = Math.floor(Math.random() * 6);
            
            let minAmount = 20000;
            let maxAmount = 45000000;
            let randomAmount = Math.floor(Math.random() * ((maxAmount - minAmount) / 1000 + 1)) * 1000 + minAmount;

            currentBets[bot.name] = {
                horseIdx: randomHorseIdx,
                amount: randomAmount
            };
        }
    });
    broadcastBetStats();
}

setInterval(() => {
    if (raceState.status === 'racing') {
        for (let i = 0; i < 6; i++) {
            if (raceState.positions[i] < 1030) {
                let randomFactor = getSecureRandom() * 4.5 + 1.8;
                let burstChance = getSecureRandom();
                
                if (burstChance > 0.85) {
                    randomFactor += getSecureRandom() * 3.5;
                } else if (burstChance < 0.15) {
                    randomFactor -= getSecureRandom() * 1.2;
                }

                let speed = Math.max(0.5, randomFactor);

                if (adminFixedWinner !== 'random' && parseInt(adminFixedWinner) === i) {
                    speed += 1.4;
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
        
        let isBot = activeBots.some(b => b.name === username);
        if (isBot) {
            let payoutMultiplier = 0;
            let netProfit = -bet.amount;
            if (bet.horseIdx === winnerIdx) payoutMultiplier = 0.9;
            else if (bet.horseIdx === secondIdx) payoutMultiplier = 0.7;
            else if (bet.horseIdx === thirdIdx) payoutMultiplier = 0.5;

            if (payoutMultiplier > 0) {
                netProfit = Math.floor(bet.amount * payoutMultiplier);
            }
            roundSummary.push({
                username: username,
                horseIdx: bet.horseIdx,
                amount: bet.amount,
                netProfit: netProfit
            });
            continue;
        }

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
            betHistory: u.betHistory,
            referralCode: u.referralCode || ""
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
        raceState.countdown = 20;
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
                betHistory: u.betHistory,
                referralCode: u.referralCode || ""
            };
        });

        io.emit('resetForNewRound', { users: freshUsersMap });
        broadcastBetStats();
        updateOnlineUsersList();
    }, 8000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server đua ngựa đã chạy tại cổng ${PORT}[cite: 7]`);
});