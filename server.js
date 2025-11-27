require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// ────────────────── CORS ──────────────────
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://modal-payment.vercel.app",
    /\.vercel\.app$/,
  ],
  credentials: true,
}));

// ────────────────── BODY PARSING ──────────────────
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ────────────────── MONGODB ──────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connecté"))
  .catch(err => { console.error("MongoDB erreur:", err); process.exit(1); });

// ────────────────── SCHEMA ORDER ──────────────────
const orderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, required: true, unique: true },
  orderNumber: { type: String, unique: true },
  paymentStatus: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "paid" },
  amountTotal: { type: Number, required: true },
  currency: { type: String, default: "eur" },
  customer: { name: String, email: { type: String, lowercase: true }, phone: String },
  type: { type: String, enum: ["traineeship", "show", "courses"], required: true },
  metadata: mongoose.Schema.Types.Mixed,
  event: { title: String, place: String, date: String, hours: String },
}, { timestamps: true });

orderSchema.pre("save", async function (next) {
  if (!this.orderNumber && this.isNew) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments({ createdAt: { $gte: new Date(`${year}-01-01`) } });
    this.orderNumber = `CMD-${year}-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

const Order = mongoose.model("Order", orderSchema);

// ────────────────── ROUTES ──────────────────
app.get("/", (req, res) => res.send("Backend OK"));

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;
    if (!priceId) return res.status(400).json({ error: "priceId manquant" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity }],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "https://modal-payment.vercel.app"}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || "https://modal-payment.vercel.app"}/cancel`,
      customer_email: customerEmail || undefined,
      metadata,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/retrieve-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "session_id manquant" });

    const order = await Order.findOne({ stripeSessionId: session_id });
    if (!order) return res.status(404).json({ error: "Commande non trouvée" });

    res.json({
      id: order.stripeSessionId,
      orderNumber: order.orderNumber,
      amount_total: order.amountTotal,
      currency: order.currency,
      customer_details: {
        name: order.customer.name || "Anonyme",
        email: order.customer.email,
        phone: order.customer.phone,
      },
      metadata: order.metadata || {},
      type: order.type,
      event: order.event || null,
    });
  } catch (error) {
    console.error("Erreur retrieve-session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ────────────────── WEBHOOK (LA SEULE LIGNE QUI MANQUAIT : async) ──────────────────
app.post("/webhook", async (req, res) => {          // ← async ici
  const sig = req.headers["stripe-signature"];

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("Webhook reçu →", session.id, "payment_status:", session.payment_status);

      try {
        const exists = await Order.findOne({ stripeSessionId: session.id });
        if (exists) {
          console.log("Déjà en base →", session.id);
          return res.json({ received: true });
        }

        const metadata = session.metadata || {};
        const eventData = metadata.eventData ? JSON.parse(metadata.eventData || "null") : null;
        const singleEvent = Array.isArray(eventData) ? eventData[0] : eventData;

        await new Order({
          stripeSessionId: session.id,
          amountTotal: session.amount_total || 0,
          currency: session.currency || "eur",
          paymentStatus: "paid",
          customer: {
            name: metadata.nom || session.customer_details?.name || "Anonyme",
            email: metadata.email || session.customer_details?.email || null,
            phone: metadata.telephone || session.customer_details?.phone || null,
          },
          type: metadata.type || "unknown",
          metadata,
          event: singleEvent ? {
            title: singleEvent.title,
            place: singleEvent.place,
            date: singleEvent.date,
            hours: singleEvent.hours,
          } : null,
        }).save();

        console.log("COMMANDE CRÉÉE EN BASE →", session.id);
      } catch (err) {
        console.error("ERREUR SAVE COMMANDE:", err.message);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ────────────────── LANCEMENT ──────────────────
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

module.exports = app;