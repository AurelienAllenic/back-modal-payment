const mongoose = require("mongoose");

const eventCapacitySchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true }, // ex: "stage-2025-07-15"
  title: String,
  date: String,
  type: { type: String, enum: ["traineeship", "show", "courses"] },
  maxPlaces: { type: Number, required: true },
  bookedPlaces: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
});

module.exports = mongoose.model("EventCapacity", eventCapacitySchema);