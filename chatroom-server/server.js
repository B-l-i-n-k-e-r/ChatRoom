const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const validator = require("validator");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://b-l-n-k-e-r.github.io"], // Ensure this is correct for your client
    methods: ["GET", "POST"],
    transports: ["websocket", "polling"],
    credentials: true,
  },
  connectionStateRecovery: { maxDisconnectionDuration: 60000 },
});

// Simple in-memory rate limiter (5 events per 10 seconds per socket)
const rateLimitMap = new Map();
io.use((socket, next) => {
  const now = Date.now();
  const windowMs = 10000;
  const maxEvents = 5;

  const timestamps = rateLimitMap.get(socket.id) || [];
  const recent = timestamps.filter((ts) => now - ts < windowMs);

  if (recent.length >= maxEvents) {
    console.log(`⚠️ Rate limit exceeded for socket: ${socket.id}`);
    return socket.disconnect();
  }

  recent.push(now);
  rateLimitMap.set(socket.id, recent);
  next();
});

// JWT secret (use .env for production)
const JWT_SECRET = "your_secret_key_here";

// In-memory storage
const usersInRooms = {}; // { room: [{ username, socketId }] }
const roomMessages = {}; // { room: [messages] }
const roomPasswords = {}; // { room: "hashed_password" }
const typingUsers = {}; // { room: Set[usernames] }

// NEW: Store active socket IDs by username for direct messaging
const userSocketMap = new Map(); // { username: socket.id }

// NEW: Store private message history
// Key format: "user1_user2" (always sorted usernames to keep consistent)
const privateMessages = {}; // { "userA_userB": [messages] }

// JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication required"));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
        console.error("Invalid token:", err.message); // Log the error
        return next(new Error("Invalid token"));
    }
    socket.user = decoded;
    next();
  });
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id} (${socket.user?.username || "Unknown"})`);

  // NEW: When a user connects and is authenticated, map their username to their socket ID
  if (socket.user && socket.user.username) {
    userSocketMap.set(socket.user.username, socket.id);
    console.log(`User ${socket.user.username} mapped to socket ID ${socket.id}`);
  }


  // Join room with optional password
  socket.on("join_room", ({ room, username, password }) => {
    if (!room || !username) {
      return socket.emit("error", "Room and username are required");
    }

    if (roomPasswords[room] && roomPasswords[room] !== password) {
      return socket.emit("error", "Incorrect room password");
    }

    socket.join(room);

    if (!usersInRooms[room]) usersInRooms[room] = [];
    // Ensure unique users per room (remove old socketId if user re-joins)
    usersInRooms[room] = usersInRooms[room].filter(u => u.username !== username);
    usersInRooms[room].push({ username, socketId: socket.id });

    io.to(room).emit("room_users", usersInRooms[room]);
    if (roomMessages[room]) {
      socket.emit("message_history", roomMessages[room]);
    }

    console.log(`👤 ${username} joined ${room}`);
  });

  // Handle public messages
  socket.on("send_message", (data) => {
    if (!data.room || !data.text) return;

    data.text = validator.escape(data.text.trim());
    if (data.text === "") return;

    if (!roomMessages[data.room]) roomMessages[data.room] = [];
    const newMessage = {
      id: Date.now(),
      text: data.text,
      username: socket.user.username,
      room: data.room,
      time: new Date().toLocaleTimeString(),
      seen_by: [socket.user.username],
    };
    roomMessages[data.room].push(newMessage);

    io.to(data.room).emit("receive_message", newMessage);
  });

  // NEW: Handle direct messages
  socket.on("send_private_message", ({ toUsername, text }) => {
    if (!toUsername || !text) return;

    const fromUsername = socket.user.username;
    const sanitizedText = validator.escape(text.trim());
    if (sanitizedText === "") return;

    // Get the recipient's socket ID
    const recipientSocketId = userSocketMap.get(toUsername);

    if (!recipientSocketId) {
      // If recipient is not online or not mapped, notify sender
      return socket.emit("private_message_error", `${toUsername} is not currently online.`);
    }

    // Generate a consistent conversation ID (sorted usernames)
    const conversationId = [fromUsername, toUsername].sort().join("_");

    if (!privateMessages[conversationId]) {
      privateMessages[conversationId] = [];
    }

    const newPrivateMessage = {
      id: Date.now(),
      text: sanitizedText,
      from: fromUsername,
      to: toUsername,
      time: new Date().toLocaleTimeString(),
      // You might add a 'seen' status here later
    };

    privateMessages[conversationId].push(newPrivateMessage);

    // Emit the message to the sender
    socket.emit("receive_private_message", newPrivateMessage);

    // Emit the message to the recipient
    if (recipientSocketId !== socket.id) { // Don't send twice if messaging self
      io.to(recipientSocketId).emit("receive_private_message", newPrivateMessage);
    }

    console.log(`💬 Private message from ${fromUsername} to ${toUsername}: ${sanitizedText}`);
  });

  // NEW: Request private message history
  socket.on("request_private_history", ({ otherUsername }) => {
    if (!otherUsername) return;

    const currentUsername = socket.user.username;
    const conversationId = [currentUsername, otherUsername].sort().join("_");

    const history = privateMessages[conversationId] || [];
    socket.emit("private_message_history", { otherUsername, history });
    console.log(`📖 Sent private history for ${currentUsername} - ${otherUsername}`);
  });


  // Typing indicator
  socket.on("typing", ({ room }) => {
    if (!typingUsers[room]) typingUsers[room] = new Set();
    typingUsers[room].add(socket.user.username);

    io.to(room).emit("typing_users", Array.from(typingUsers[room]));

    setTimeout(() => {
      typingUsers[room]?.delete(socket.user.username);
      io.to(room).emit("typing_users", Array.from(typingUsers[room] || []));
    }, 3000);
  });

  // Disconnect cleanup
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // NEW: Remove from userSocketMap on disconnect
    let disconnectedUsername = null;
    for (const [username, sockId] of userSocketMap.entries()) {
      if (sockId === socket.id) {
        disconnectedUsername = username;
        userSocketMap.delete(username);
        console.log(`User ${username} removed from socket map.`);
        break;
      }
    }

    for (const room in usersInRooms) {
      usersInRooms[room] = usersInRooms[room].filter(
        (u) => u.socketId !== socket.id
      );
      io.to(room).emit("room_users", usersInRooms[room]);
      if (disconnectedUsername) {
          // Also remove disconnected user from typing indicators
          typingUsers[room]?.delete(disconnectedUsername);
          io.to(room).emit("typing_users", Array.from(typingUsers[room] || []));
      }
    }
  });
});

// Login endpoint (returns JWT)
app.post("/login", (req, res) => {
  const { username, password } = req.body; // Added password for future use if you add server-side password checks
  if (!username) return res.status(400).send("Username required");

  // For this demo, we're not checking password against registeredUsers here.
  // Assuming username is enough for login to issue a token.
  // If you want to enforce password check here:
  // if (!registeredUsers[username] || registeredUsers[username] !== password) {
  //     return res.status(401).json({ error: "Invalid username or password" });
  // }


  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1d" });
  res.json({ token });
});

// Temporary in-memory user store
const registeredUsers = {}; // { username: password }

app.post("/signup", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  if (registeredUsers[username]) {
    return res.status(409).json({ error: "Username already exists" });
  }

  // Store the user (for demo purposes only — no hashing)
  registeredUsers[username] = password;

  // Optionally auto-login after signup:
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1d" });

  res.status(201).json({ message: "Signup successful", token });
});

// Cleanup empty rooms hourly
setInterval(() => {
  for (const room in usersInRooms) {
    if (usersInRooms[room].length === 0) {
      delete usersInRooms[room];
      delete roomMessages[room];
      delete roomPasswords[room];
      // Note: We don't clean privateMessages here as they are user-to-user, not room-specific.
    }
  }
}, 3600000);

server.listen(3005, () => {
  console.log("✅ Server running on http://localhost:3001");
});