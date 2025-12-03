const mongoose = require("mongoose");

const classicCourseSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    time: { type: String, required: true },
    place: { type: String, required: true },
    numberOfPlaces: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClassicCourse", classicCourseSchema);
