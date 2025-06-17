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
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    transports: ["websocket"]
  },
  connectionStateRecovery: { maxDisconnectionDuration: 60000 }
});

// Simple in-memory rate limiter (5 events per 10 seconds per socket)
const rateLimitMap = new Map();
io.use((socket, next) => {
  const now = Date.now();
  const windowMs = 10000;
  const maxEvents = 5;

  const timestamps = rateLimitMap.get(socket.id) || [];
  const recent = timestamps.filter(ts => now - ts < windowMs);

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
const usersInRooms = {};       // { room: [{ username, socketId }] }
const roomMessages = {};       // { room: [messages] }
const roomPasswords = {};      // { room: "hashed_password" }
const typingUsers = {};        // { room: Set[usernames] }

// JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication required"));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Invalid token"));
    socket.user = decoded;
    next();
  });
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id} (${socket.user?.username || "Unknown"})`);

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
    usersInRooms[room].push({ username, socketId: socket.id });

    io.to(room).emit("room_users", usersInRooms[room]);
    if (roomMessages[room]) {
      socket.emit("message_history", roomMessages[room]);
    }

    console.log(`👤 ${username} joined ${room}`);
  });

  // Handle messages
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
      seen_by: [socket.user.username]
    };
    roomMessages[data.room].push(newMessage);

    io.to(data.room).emit("receive_message", newMessage);
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
    for (const room in usersInRooms) {
      usersInRooms[room] = usersInRooms[room].filter(u => u.socketId !== socket.id);
      io.to(room).emit("room_users", usersInRooms[room]);
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Login endpoint (returns JWT)
app.post("/login", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send("Username required");

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
    }
  }
}, 3600000);

server.listen(3005, () => {
  console.log("✅ Server running on http://localhost:3001");
});
