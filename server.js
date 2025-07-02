// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL;

let db, messagesCol;

// Keep track of active rooms with last join timestamp
const activeRooms = new Map();

app.use(express.static('public'));

async function connectDB() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db('chatdb');
  messagesCol = db.collection('messages');
  console.log('Connected to MongoDB');
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('joinRoom', async ({ roomCode, colorName }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.colorName = colorName || '#000000';

    // Mark room active now
    activeRooms.set(roomCode, new Date());

    console.log(`Socket ${socket.id} joined room ${roomCode} with color ${colorName}`);

    // Load last 100 messages from this room, sorted ascending by createdAt
    const msgs = await messagesCol
      .find({ room: roomCode })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    socket.emit('loadMessages', msgs);
  });

  socket.on('message', async ({ text }) => {
    if (!text || !socket.roomCode || !socket.colorName) return;

    const msg = {
      room: socket.roomCode,
      colorName: socket.colorName,
      text,
      createdAt: new Date(),
      senderId: socket.id,
      saved: false, // no saving anymore but keep false to maintain structure
    };

    const result = await messagesCol.insertOne(msg);
    msg._id = result.insertedId;

    io.to(socket.roomCode).emit('message', msg);
  });

  socket.on('deleteMessage', async (id) => {
    try {
      const _id = new ObjectId(id);
      const msg = await messagesCol.findOne({ _id });
      if (!msg) return;

      if (msg.senderId !== socket.id) return; // only sender can delete

      await messagesCol.deleteOne({ _id });

      io.to(socket.roomCode).emit('messageDeleted', id);
    } catch (e) {
      console.error('Error deleting message:', e);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Cleanup cron job every hour
cron.schedule('0 * * * *', async () => {
  const now = new Date();

  for (const [roomCode, lastJoin] of activeRooms.entries()) {
    const ageMs = now - lastJoin;

    if (ageMs > 24 * 60 * 60 * 1000) {
      // Room inactive for > 1 day
      const cutoff1d = new Date(now - 24 * 60 * 60 * 1000);
      const delRes = await messagesCol.deleteMany({
        room: roomCode,
        createdAt: { $lt: cutoff1d },
      });
      console.log(`Inactive room "${roomCode}": deleted ${delRes.deletedCount} messages older than 1 day`);

      // Remove from activeRooms to free memory
      activeRooms.delete(roomCode);
    } else {
      // Active room: delete unsaved messages older than 7 days
      const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const delRes = await messagesCol.deleteMany({
        room: roomCode,
        saved: false,
        createdAt: { $lt: cutoff7d },
      });
      if (delRes.deletedCount > 0) {
        console.log(`Active room "${roomCode}": deleted ${delRes.deletedCount} unsaved messages older than 7 days`);
      }
    }
  }
});

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
  });
