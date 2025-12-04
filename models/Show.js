const mongoose = require("mongoose");

const showSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    date: { type: String, required: true },
    place: { type: String, required: true },
    hours: { type: String, required: true },
    img: { type: String },
    alt: { type: String },
    numberOfPlaces: { type: Number, default: 1 },
  },
  { timestamps: true,
    collection: 'show'
   }
);

module.exports = mongoose.model("Show", showSchema);
