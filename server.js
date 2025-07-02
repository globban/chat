const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const cron = require("node-cron");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const mongoUrl = process.env.MONGO_URL;
const client = new MongoClient(mongoUrl);
let messagesCollection;

async function connectDb() {
  await client.connect();
  const db = client.db("chatdb");
  messagesCollection = db.collection("messages");
  console.log("MongoDB connected");
}
connectDb();

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", async ({ roomCode, colorName }) => {
    socket.join(roomCode);

    const messages = await messagesCollection
      .find({ room: roomCode })
      .sort({ createdAt: 1 })
      .toArray();
    socket.emit("loadMessages", messages);
  });

  socket.on("sendMessage", async ({ roomCode, colorName, text }) => {
    const msg = {
      room: roomCode,
      colorName,
      text,
      saved: false,
      createdAt: new Date(),
      senderId: socket.id
    };
    const res = await messagesCollection.insertOne(msg);
    msg._id = res.insertedId;
    io.to(roomCode).emit("newMessage", msg);
  });

  socket.on("saveMessage", async (id) => {
    await messagesCollection.updateOne(
      { _id: new ObjectId(id), senderId: socket.id },
      { $set: { saved: true } }
    );
  });

  socket.on("deleteMessage", async (id) => {
    const msg = await messagesCollection.findOne({ _id: new ObjectId(id) });
    if (msg && msg.senderId === socket.id) {
      await messagesCollection.deleteOne({ _id: new ObjectId(id) });
      io.to(msg.room).emit("deleteMessage", id);
    }
  });
});

cron.schedule("0 * * * *", async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await messagesCollection.deleteMany({
    saved: false,
    createdAt: { $lt: cutoff }
  });
  console.log(`Deleted ${result.deletedCount} expired messages.`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
