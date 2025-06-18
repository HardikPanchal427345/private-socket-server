import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*', // Or specify your frontend URL
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // socket.on('message', (data: string) => {
    //     console.log(`📩 Received: ${data}`);
    //     socket.broadcast.emit('message', data); // or io.emit for all clients
    // });

    socket.onAny((event, data) => {
        console.log(`📨 Received [${event}]:`, data);

        // Broadcast to all other clients (including those in other projects)
        socket.broadcast.emit(event, data);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`🚀 Socket.IO server running on http://localhost:${PORT}`);
});
