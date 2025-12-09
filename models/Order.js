// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    stripeSessionId: {
      type: String,
      required: true,
      unique: true,
    },
    orderNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "succeeded", "failed", "refunded"],
      default: "succeeded",
    },
    amountTotal: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "eur",
    },
    customer: {
      name: { type: String, required: true },
      email: { type: String, required: true, lowercase: true },
      phone: { type: String, default: null },
    },
    type: {
      type: String,
      enum: ["traineeship", "show", "courses"],
      required: true,
    },
    metadata: {
      nom: String,
      email: String,
      telephone: String,
      nombreParticipants: Number,
      adultes: Number,
      enfants: Number,
      ageGroup: String,
      courseType: String,
      totalPrice: Number,
      trialCourse: mongoose.Schema.Types.Mixed,
      classicCourses: mongoose.Schema.Types.Mixed,
    },

    // === Event / stage / spectacle details (if applicable) ===
    event: {
      title: String,
      place: String,
      date: String,
      hours: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

orderSchema.index({ stripeSessionId: 1 });
orderSchema.index({ orderNumber: 1 });

orderSchema.pre("save", async function (next) {
  if (!this.orderNumber && this.isNew) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments({
      createdAt: { $gte: new Date(`${year}-01-01`) },
    });

    this.orderNumber = `CMD-${year}-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);