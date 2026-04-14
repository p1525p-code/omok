const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let teacherSocketId = null;

const BOARD_SIZE = 15;
let board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0)); 
let currentTurn = 1; 
let studentVotes = {}; 
let voteTimer = null;
let isGameOver = false; 

// 💡 [변경됨] 고정되었던 시간을 변경 가능한 변수로 바꿉니다.
let currentVoteTimeLimit = 15; 

function checkWin(r, c, player) {
    const directions = [
        [[0, 1], [0, -1]],   
        [[1, 0], [-1, 0]],   
        [[1, 1], [-1, -1]],  
        [[1, -1], [-1, 1]]   
    ];

    for (let dir of directions) {
        let count = 1; 
        for (let d of dir) {
            let nr = r + d[0];
            let nc = c + d[1];
            while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === player) {
                count++;
                nr += d[0];
                nc += d[1];
            }
        }
        if (count >= 5) return true; 
    }
    return false;
}

function calculateCurrentVotes() {
    let voteCounts = {};
    for (const position of Object.values(studentVotes)) {
        voteCounts[position] = (voteCounts[position] || 0) + 1;
    }
    return voteCounts;
}

io.on('connection', (socket) => {
    const host = socket.handshake.headers.host || '';
    
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        teacherSocketId = socket.id;
        console.log('✅ 선생님 접속 완료 (localhost):', socket.id);
        socket.emit('roleConfirmed', 'teacher'); 
        // 💡 접속한 선생님에게 현재 설정된 시간을 알려줍니다.
        socket.emit('settingsUpdated', { voteTime: currentVoteTimeLimit });
    } else {
        console.log('🧑‍🎓 학생 접속 완료 (IP):', socket.id);
        socket.emit('roleConfirmed', 'student'); 
    }

    socket.emit('updateBoard', board);
    if (isGameOver) {
        socket.emit('gameOver', currentTurn === 2 ? 'teacher' : 'student'); 
    } else {
        socket.emit('turnChange', currentTurn);
    }

    // 💡 [추가됨] 선생님의 설정 변경 요청 처리
    socket.on('updateSettings', (data) => {
        if (socket.id !== teacherSocketId) return; 

        if (data.voteTime) {
            currentVoteTimeLimit = data.voteTime;
            console.log(`⚙️ 설정 변경됨 - 새로운 투표 시간: ${currentVoteTimeLimit}초`);
            // 선생님 화면에 설정이 잘 반영되었다고 알려줍니다.
            socket.emit('settingsUpdated', { voteTime: currentVoteTimeLimit });
        }
    });

    socket.on('teacherMove', (data) => {
        if (socket.id !== teacherSocketId || isGameOver) return; 

        const { row, col } = data;
        if (currentTurn === 1 && board[row][col] === 0) {
            board[row][col] = 1; 
            io.emit('updateBoard', board);

            if (checkWin(row, col, 1)) {
                isGameOver = true;
                io.emit('gameOver', 'teacher');
                console.log('🎉 선생님 승리!');
                return;
            }

            currentTurn = 2; 
            io.emit('turnChange', currentTurn);
            startStudentVote(); 
        }
    });

    socket.on('studentVote', (data) => {
        if (socket.id === teacherSocketId || isGameOver) return; 

        if (currentTurn === 2) {
            const { row, col } = data;
            const key = `${row},${col}`;
            
            if (board[row][col] === 0) {
                studentVotes[socket.id] = key;
                io.emit('updateVotes', calculateCurrentVotes()); 
            }
        }
    });

    socket.on('forceStopVote', () => {
        if (socket.id !== teacherSocketId || isGameOver) return; 

        if (currentTurn === 2 && voteTimer) {
            console.log('🛑 선생님이 투표를 조기 종료했습니다.');
            clearInterval(voteTimer); 
            voteTimer = null;
            processVoteResult(); 
        }
    });

    socket.on('resetGame', () => {
        if (socket.id !== teacherSocketId) return; 

        console.log('🔄 게임이 초기화되었습니다.');
        
        board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0));
        currentTurn = 1;
        studentVotes = {}; 
        isGameOver = false; 
        
        if (voteTimer) {
            clearInterval(voteTimer);
            voteTimer = null;
        }

        io.emit('updateBoard', board);
        io.emit('updateVotes', {});
        io.emit('gameReset'); 
        io.emit('turnChange', currentTurn);
        io.emit('timerUpdate', ''); 
    });

    socket.on('disconnect', () => {
        if (socket.id === teacherSocketId) {
            teacherSocketId = null;
        } else {
            if (studentVotes[socket.id]) {
                delete studentVotes[socket.id];
                if (!isGameOver) io.emit('updateVotes', calculateCurrentVotes());
            }
        }
    });
});

function startStudentVote() {
    studentVotes = {}; 
    io.emit('updateVotes', {});
    
    // 💡 투표가 시작될 때, 현재 설정된 시간(currentVoteTimeLimit)을 사용합니다.
    let timeLeft = currentVoteTimeLimit;
    io.emit('timerUpdate', timeLeft);

    voteTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(voteTimer);
            processVoteResult(); 
        }
    }, 1000);
}

function processVoteResult() {
    let maxVotes = 0;
    let bestMove = null;
    
    const finalVotes = calculateCurrentVotes();

    for (const [key, count] of Object.entries(finalVotes)) {
        if (count > maxVotes) {
            maxVotes = count;
            bestMove = key;
        }
    }

    if (bestMove) {
        const [row, col] = bestMove.split(',').map(Number);
        board[row][col] = 2; 
        io.emit('updateBoard', board);

        if (checkWin(row, col, 2)) {
            isGameOver = true;
            io.emit('gameOver', 'student');
            console.log('🎉 학생들 승리!');
            io.emit('updateVotes', {});
            return;
        }
    }

    currentTurn = 1; 
    io.emit('turnChange', currentTurn);
    io.emit('updateVotes', {}); 
}

server.listen(3000, () => {
    console.log('서버가 http://localhost:3000 에서 실행 중입니다.');
});