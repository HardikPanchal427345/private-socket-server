// import express from 'express';
// import http from 'http';
// import { Server, Socket } from 'socket.io';

// const app = express();
// const server = http.createServer(app);

// const io = new Server(server, {
//     cors: {
//         origin: '*', // Or specify your frontend URL
//         methods: ['GET', 'POST']
//     }
// });

// io.on('connection', (socket: Socket) => {
//     console.log(`🔌 Client connected: ${socket.id}`);

//     // socket.on('message', (data: string) => {
//     //     console.log(`📩 Received: ${data}`);
//     //     socket.broadcast.emit('message', data); // or io.emit for all clients
//     // });

//     socket.onAny((event, data) => {
//         console.log(`📨 Received [${event}]:`, data);

//         // Broadcast to all other clients (including those in other projects)
//         socket.broadcast.emit(event, data);
//     });

//     socket.on('disconnect', () => {
//         console.log(`❌ Client disconnected: ${socket.id}`);
//     });
// });


const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ============================================================
// STORAGE
// ============================================================

// userId -> Set<WebSocket>
// A user can have multiple browser tabs/devices connected.
const users = new Map();

// topic -> Set<WebSocket>
const topics = new Map();

// socket -> Set<topic>
const socketTopics = new Map();

// socket -> connection metadata
const connections = new Map();


// ============================================================
// HTTP SERVER
// ============================================================

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        status: "ok",
        users: users.size,
        connections: connections.size,
        topics: topics.size,
        uptime: process.uptime()
      })
    );

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});


// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({
  server: httpServer
});


// ============================================================
// HELPERS
// ============================================================

function generateId() {
  return crypto.randomUUID();
}


function send(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(
    JSON.stringify({
      ...message,
      timestamp: Date.now()
    })
  );

  return true;
}


function response(ws, requestId, type, data = {}) {
  send(ws, {
    type,
    requestId,
    ...data
  });
}


function broadcastToSockets(sockets, message, except = null) {
  for (const ws of sockets) {
    if (ws === except) {
      continue;
    }

    send(ws, message);
  }
}


// ============================================================
// USER MANAGEMENT
// ============================================================

function registerUser(ws, userId) {
  if (!userId) {
    return;
  }

  // Remove previous registration if any.
  unregisterUser(ws);

  if (!users.has(userId)) {
    users.set(userId, new Set());
  }

  users.get(userId).add(ws);

  const connection = connections.get(ws);

  if (connection) {
    connection.userId = userId;
  }

  console.log(`[REGISTER] ${userId}`);
}


function unregisterUser(ws) {
  const connection = connections.get(ws);

  if (!connection || !connection.userId) {
    return;
  }

  const userId = connection.userId;

  const userSockets = users.get(userId);

  if (!userSockets) {
    return;
  }

  userSockets.delete(ws);

  if (userSockets.size === 0) {
    users.delete(userId);

    console.log(`[OFFLINE] ${userId}`);
  }
}


function sendToUser(userId, message, except = null) {
  const userSockets = users.get(userId);

  if (!userSockets) {
    return 0;
  }

  let sent = 0;

  for (const ws of userSockets) {
    if (ws === except) {
      continue;
    }

    if (send(ws, message)) {
      sent++;
    }
  }

  return sent;
}


// ============================================================
// TOPIC / PUB SUB
// ============================================================

function subscribe(ws, topic) {
  if (!topic) {
    return false;
  }

  if (!topics.has(topic)) {
    topics.set(topic, new Set());
  }

  topics.get(topic).add(ws);

  if (!socketTopics.has(ws)) {
    socketTopics.set(ws, new Set());
  }

  socketTopics.get(ws).add(topic);

  console.log(`[SUBSCRIBE] ${getUserId(ws)} -> ${topic}`);

  return true;
}


function unsubscribe(ws, topic) {
  const topicSubscribers = topics.get(topic);

  if (topicSubscribers) {
    topicSubscribers.delete(ws);

    if (topicSubscribers.size === 0) {
      topics.delete(topic);
    }
  }

  const subscribedTopics = socketTopics.get(ws);

  if (subscribedTopics) {
    subscribedTopics.delete(topic);
  }

  console.log(`[UNSUBSCRIBE] ${getUserId(ws)} -> ${topic}`);
}


function unsubscribeAll(ws) {
  const subscribedTopics = socketTopics.get(ws);

  if (!subscribedTopics) {
    return;
  }

  for (const topic of subscribedTopics) {
    const topicSubscribers = topics.get(topic);

    if (topicSubscribers) {
      topicSubscribers.delete(ws);

      if (topicSubscribers.size === 0) {
        topics.delete(topic);
      }
    }
  }

  socketTopics.delete(ws);
}


function publish(topic, event, data, sender = null) {
  const subscribers = topics.get(topic);

  if (!subscribers) {
    return 0;
  }

  const message = {
    type: "event",
    topic,
    event,
    data,
    sender: sender
      ? {
          userId: getUserId(sender)
        }
      : null
  };

  let sent = 0;

  for (const ws of subscribers) {
    if (send(ws, message)) {
      sent++;
    }
  }

  return sent;
}


// ============================================================
// BROADCAST
// ============================================================

function broadcast(event, data, except = null) {
  const message = {
    type: "broadcast",
    event,
    data
  };

  let sent = 0;

  for (const ws of connections.keys()) {
    if (ws === except) {
      continue;
    }

    if (send(ws, message)) {
      sent++;
    }
  }

  return sent;
}


// ============================================================
// UTILITIES
// ============================================================

function getUserId(ws) {
  const connection = connections.get(ws);

  return connection?.userId || null;
}


function getPresence() {
  const result = {};

  for (const [userId, sockets] of users.entries()) {
    result[userId] = {
      online: sockets.size > 0,
      connections: sockets.size
    };
  }

  return result;
}


// ============================================================
// CONNECTION
// ============================================================

wss.on("connection", (ws, req) => {
  const connectionId = generateId();

  connections.set(ws, {
    id: connectionId,
    userId: null,
    isAlive: true,
    ip: req.socket.remoteAddress,
    connectedAt: Date.now()
  });

  socketTopics.set(ws, new Set());

  console.log(`[CONNECT] ${connectionId}`);

  // ----------------------------------------------------------
  // Initial connection response
  // ----------------------------------------------------------

  send(ws, {
    type: "connected",
    connectionId
  });


  // ----------------------------------------------------------
  // HEARTBEAT
  // ----------------------------------------------------------

  ws.on("pong", () => {
    const connection = connections.get(ws);

    if (connection) {
      connection.isAlive = true;
    }
  });


  // ----------------------------------------------------------
  // MESSAGE
  // ----------------------------------------------------------

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, {
        type: "error",
        code: "INVALID_JSON",
        message: "Invalid JSON"
      });

      return;
    }

    const {
      type,
      requestId,
      userId,
      to,
      topic,
      event,
      data
    } = message;


    // ========================================================
    // REGISTER
    // ========================================================

    if (type === "register") {
      if (!userId) {
        response(ws, requestId, "error", {
          code: "USER_ID_REQUIRED",
          message: "userId is required"
        });

        return;
      }

      registerUser(ws, userId);

      response(ws, requestId, "registered", {
        userId
      });

      return;
    }


    // ========================================================
    // GET PRESENCE
    // ========================================================

    if (type === "presence") {
      response(ws, requestId, "presence", {
        users: getPresence()
      });

      return;
    }


    // ========================================================
    // ONE TO ONE
    // ========================================================

    if (type === "direct") {
      if (!to) {
        response(ws, requestId, "error", {
          code: "RECIPIENT_REQUIRED",
          message: "to is required"
        });

        return;
      }

      const sender = getUserId(ws);

      const delivered = sendToUser(to, {
        type: "direct",
        event,
        from: sender,
        data
      });

      response(ws, requestId, "delivered", {
        to,
        delivered
      });

      return;
    }


    // ========================================================
    // MULTIPLE USERS
    // ========================================================

    if (type === "direct_many") {
      if (!Array.isArray(message.to)) {
        response(ws, requestId, "error", {
          code: "RECIPIENTS_REQUIRED",
          message: "to must be an array"
        });

        return;
      }

      const sender = getUserId(ws);

      let delivered = 0;

      for (const recipient of message.to) {
        delivered += sendToUser(
          recipient,
          {
            type: "direct",
            event,
            from: sender,
            data
          }
        );
      }

      response(ws, requestId, "delivered", {
        recipients: message.to,
        delivered
      });

      return;
    }


    // ========================================================
    // SUBSCRIBE
    // ========================================================

    if (type === "subscribe") {
      if (!topic) {
        response(ws, requestId, "error", {
          code: "TOPIC_REQUIRED",
          message: "topic is required"
        });

        return;
      }

      subscribe(ws, topic);

      response(ws, requestId, "subscribed", {
        topic
      });

      return;
    }


    // ========================================================
    // UNSUBSCRIBE
    // ========================================================

    if (type === "unsubscribe") {
      if (!topic) {
        response(ws, requestId, "error", {
          code: "TOPIC_REQUIRED",
          message: "topic is required"
        });

        return;
      }

      unsubscribe(ws, topic);

      response(ws, requestId, "unsubscribed", {
        topic
      });

      return;
    }


    // ========================================================
    // PUBLISH
    // ========================================================

    if (type === "publish") {
      if (!topic) {
        response(ws, requestId, "error", {
          code: "TOPIC_REQUIRED",
          message: "topic is required"
        });

        return;
      }

      const delivered = publish(
        topic,
        event,
        data,
        ws
      );

      response(ws, requestId, "published", {
        topic,
        delivered
      });

      return;
    }


    // ========================================================
    // GLOBAL BROADCAST
    // ========================================================

    if (type === "broadcast") {
      const sender = getUserId(ws);

      const delivered = broadcast(
        event,
        {
          from: sender,
          data
        },
        ws
      );

      response(ws, requestId, "broadcasted", {
        delivered
      });

      return;
    }


    // ========================================================
    // PING
    // ========================================================

    if (type === "ping") {
      response(ws, requestId, "pong");

      return;
    }


    // ========================================================
    // UNKNOWN MESSAGE
    // ========================================================

    send(ws, {
      type: "error",
      requestId,
      code: "UNKNOWN_MESSAGE_TYPE",
      message: `Unknown message type: ${type}`
    });
  });


  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------

  ws.on("close", () => {
    const userId = getUserId(ws);

    console.log(
      `[DISCONNECT] ${connectionId}` +
      (userId ? ` user=${userId}` : "")
    );

    unregisterUser(ws);
    unsubscribeAll(ws);

    connections.delete(ws);
  });


  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  ws.on("error", (error) => {
    console.error(
      `[WS ERROR] ${connectionId}`,
      error.message
    );
  });
});


// ============================================================
// HEARTBEAT LOOP
// ============================================================

const heartbeatInterval = setInterval(() => {
  for (const [ws, connection] of connections.entries()) {

    if (connection.isAlive === false) {
      console.log(
        `[TIMEOUT] ${connection.id}`
      );

      ws.terminate();

      continue;
    }

    connection.isAlive = false;

    ws.ping();
  }
}, 30000);


// ============================================================
// CLEANUP
// ============================================================

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});


// ============================================================
// START
// ============================================================

httpServer.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log(" Custom WebSocket Server");
  console.log("========================================");
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Health:    http://localhost:${PORT}/health`);
  console.log("========================================");
  console.log("");
});

// const PORT = process.env.PORT || 4000;
// server.listen(PORT, () => {
//     console.log(`🚀 Socket.IO server running on http://localhost:${PORT}`);
// });
