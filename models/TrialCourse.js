const mongoose = require("mongoose");

const trialCourseSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    time: { type: String, required: true },
    place: { type: String, required: true },
    numberOfPlaces: { type: Number, default: 1 },
  },
  { timestamps: true,
    collection: 'trialCourses'
   }
);

module.exports = mongoose.model("TrialCourse", trialCourseSchema);
