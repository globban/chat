// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const cron = require('node-cron');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL;

let db, messagesCol;

// Serve static files from public folder
app.use(express.static('public'));

async function connectDB() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db('chatdb'); // db name can be anything
  messagesCol = db.collection('messages');

  console.log('Connected to MongoDB');
}

// Delete unsaved messages older than 24 hours every hour
cron.schedule('0 * * * *', async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const res = await messagesCol.deleteMany({
    saved: false,
    createdAt: { $lt: cutoff }
  });
  if (res.deletedCount) {
    console.log(`Deleted ${res.deletedCount} unsaved old messages`);
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('joinRoom', async ({ roomCode, colorName }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.colorName = colorName;

    console.log(`Socket ${socket.id} joined room ${roomCode} with color ${colorName}`);

    // Load last 100 messages from this room, sorted by time
    const msgs = await messagesCol.find({ room: roomCode }).sort({ createdAt: 1 }).limit(100).toArray();

    // Send existing messages to client
    socket.emit('loadMessages', msgs);
  });

  socket.on('message', async ({ text }) => {
    if (!text || !socket.roomCode || !socket.colorName) return;

    const msg = {
      room: socket.roomCode,
      colorName: socket.colorName,
      text,
      saved: false,
      createdAt: new Date(),
      senderId: socket.id
    };

    // Insert message into DB
    const result = await messagesCol.insertOne(msg);
    msg._id = result.insertedId;

    // Broadcast to all in room
    io.to(socket.roomCode).emit('message', msg);
  });

  socket.on('saveMessage', async (id) => {
    try {
      const _id = new ObjectId(id);
      const msg = await messagesCol.findOne({ _id });

      if (!msg) return;

      // Only sender can save their message
      if (msg.senderId !== socket.id) return;

      await messagesCol.updateOne({ _id }, { $set: { saved: true } });

      socket.emit('messageSaved', id);
    } catch (e) {
      console.error('Error saving message:', e);
    }
  });

  socket.on('deleteMessage', async (id) => {
    try {
      const _id = new ObjectId(id);
      const msg = await messagesCol.findOne({ _id });

      if (!msg) return;

      // Only sender can delete their message
      if (msg.senderId !== socket.id) return;

      await messagesCol.deleteOne({ _id });

      // Notify everyone in room to remove the message
      io.to(socket.roomCode).emit('messageDeleted', id);
    } catch (e) {
      console.error('Error deleting message:', e);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Start server after DB connects
connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server listening on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
  });
