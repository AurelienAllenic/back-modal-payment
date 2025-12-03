const mongoose = require("mongoose");

const traineeshipSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    date: { type: String, required: true },
    place: { type: String, required: true },
    hours: { type: String, required: true },
    numberOfPlaces: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Traineeship", traineeshipSchema);
