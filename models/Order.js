// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    // Stripe Session ID
    stripeSessionId: {
      type: String,
      required: true,
      unique: true,
    },

    // Command Number
    orderNumber: {
      type: String,
      unique: true,
      sparse: true, // Allow null for previous orders
    },

    // Payment status
    paymentStatus: {
      type: String,
      enum: ["pending", "succeeded", "failed", "refunded"],
      default: "succeeded",
    },

    // Cents total amount paid
    amountTotal: {
      type: Number,
      required: true,
    },

    currency: {
      type: String,
      default: "eur",
    },

    // === Customer Information ===
    customer: {
      name: { type: String, required: true },
      email: { type: String, required: true, lowercase: true },
      phone: { type: String, default: null },
    },

    // === Type of product purchased ===
    type: {
      type: String,
      enum: ["traineeship", "show", "courses"],
      required: true,
    },

    // === Common data ===
    metadata: {
      nom: String,
      email: String,
      telephone: String,
      nombreParticipants: Number,
      adultes: Number,
      enfants: Number,
      ageGroup: String,
      courseType: String, // "trial" | "classic"
      totalPrice: Number,
      // Keep JSON stringified if needed (or parse into sub-objects)
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

    // Creation date of the order
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Index for quick search by sessionId or orderNumber
orderSchema.index({ stripeSessionId: 1 });
orderSchema.index({ orderNumber: 1 });

// Generate a readable order number (ex: CMD-2025-00421)
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