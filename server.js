const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const cron = require("node-cron");

// MongoDB connection
const mongoUrl = process.env.MONGO_URL || "YOUR_MONGODB_CONNECTION_STRING";
const client = new MongoClient(mongoUrl);
let messagesCol;

async function connectDb() {
  await client.connect();
  const db = client.db("chatapp");
  messagesCol = db.collection("messages");
  console.log("Connected to MongoDB");
}
connectDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static("public"));

// Serve index.html for any /:roomCode route (for direct room links)
app.get("/:roomCode", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Store last activity timestamp per room
const activeRooms = new Map();

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("joinRoom", async ({ roomCode, userName, color }) => {
    if (!roomCode) return;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.userName = userName || "Anonymous";
    socket.color = color || "#000000";

    activeRooms.set(roomCode, new Date());

    const msgs = await messagesCol
      .find({ room: roomCode })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    socket.emit("loadMessages", msgs);
  });

  socket.on("leaveRoom", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode) {
      socket.leave(roomCode);
      delete socket.data.roomCode;
    }
  });

  socket.on("message", async ({ text }) => {
    if (!socket.roomCode || !text) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    activeRooms.set(socket.roomCode, new Date());

    const msg = {
      room: socket.roomCode,
      userName: socket.userName,
      color: socket.color,
      text: trimmed.substring(0, 500),
      createdAt: new Date(),
      senderId: socket.id,
    };

    const res = await messagesCol.insertOne(msg);
    msg._id = res.insertedId;

    io.to(socket.roomCode).emit("message", msg);
  });

  socket.on("deleteMessage", async (id) => {
    if (!id) return;
    const msg = await messagesCol.findOne({ _id: new ObjectId(id) });
    if (!msg || msg.senderId !== socket.id) return;

    await messagesCol.deleteOne({ _id: new ObjectId(id) });
    io.to(socket.roomCode).emit("messageDeleted", id);
  });

  socket.on("clearMessages", async () => {
    const roomCode = socket.data.roomCode;
    if (roomCode) {
      await messagesCol.deleteMany({ room: roomCode });
      io.to(roomCode).emit("messagesCleared");
    }
  });
});

// Clean up inactive rooms every hour
cron.schedule("0 * * * *", async () => {
  const now = new Date();
  for (const [room, lastActive] of activeRooms) {
    const diffHours = (now - lastActive) / (1000 * 60 * 60);
    if (diffHours >= 12) {
      console.log(`Deleting messages in inactive room ${room}`);
      await messagesCol.deleteMany({ room });
      activeRooms.delete(room);
      io.to(room).emit("roomCleared");
    }
  }
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
